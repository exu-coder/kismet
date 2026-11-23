/* Kismet video chat — WebRTC + Supabase Realtime signaling
   Hardened: track-state reset, awaited hangup + presence fallback,
   async cancel guards, single-offer handshake, mobile camera recovery. */
(async () => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

  // ---- Wait for Supabase ----
  const waitForSupabase = () => new Promise((resolve) => {
    if (window.supabase) { resolve(); return; }
    let attempts = 0;
    const check = setInterval(() => {
      if (window.supabase || attempts > 100) { clearInterval(check); resolve(); }
      attempts++;
    }, 100);
  });
  await waitForSupabase();
  if (!window.supabase) return;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---- State ----
  let localStream = null;
  let mediaRequestGeneration = 0;
  let peerConnection = null;
  let signalingChannel = null;
  let currentCallId = null;
  let partnerId = null;
  let partnerName = 'Stranger';
  let isSearching = false;
  const userId = window.kismetIdentity?.getAnonId() || localStorage.getItem('kismet.anonId') || ('user_' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('kismet.anonId', userId);
  let revealed = false;
  let isInitiator = false;
  let readyInterval = null;
  let offerSent = false;
  let connectionTimeout = null;
  let peerGoneTimeout = null;
  let pollTimeout = null;
  let iceCandidateQueue = [];
  let remoteDescriptionSet = false;
  let micMuted = false;
  let camOff = false;
  let callGeneration = 0;   // incremented on every start/end to invalidate stale async work
  let callActive = false;
  let peerPresent = false;

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const statusText = $('status-text');
  const onlineCount = $('online-count');
  const localVideo = $('local-video');
  const remoteVideo = $('remote-video');
  const remoteLabel = $('remote-label');
  const btnStart = $('btn-start');
  const btnStop = $('btn-stop');
  const btnNext = $('btn-next');
  const btnMute = $('btn-mute');
  const btnCam = $('btn-cam');
  const revealSection = $('reveal-section');
  const btnReveal = $('btn-reveal');
  const revealStatus = $('reveal-status');
  const chatSection = $('chat-section');
  const vcMessages = $('vc-messages');
  const vcMsgInput = $('vc-msg-input');
  const vcSend = $('vc-send');
  const vcToast = $('vc-toast');

  const showToast = (msg) => {
    vcToast.textContent = msg;
    vcToast.style.opacity = '1';
    clearTimeout(vcToast._t);
    vcToast._t = setTimeout(() => { vcToast.style.opacity = '0'; }, 3000);
  };
  const setStatus = (text) => { statusText.textContent = text; };

  // ---- Presence (online counter) ----
  const lobbyChannel = sb.channel('lobby', { config: { presence: { key: userId } } });
  lobbyChannel.on('presence', { event: 'sync' }, () => {
    if (onlineCount) onlineCount.textContent = Object.keys(lobbyChannel.presenceState()).length;
  });
  lobbyChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await lobbyChannel.track({ user_id: userId, online_at: new Date().toISOString() });
    }
  });

  // ---- Camera / track helpers ----
  const hasLiveVideo = (s) => !!(s && s.getVideoTracks().some(t => t.readyState === 'live'));

  const applyTrackStates = (s) => {
    if (!s) return;
    s.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    s.getVideoTracks().forEach(t => { t.enabled = !camOff; });
  };

  const ensureCamera = async () => {
    // FIX #5: a stream can exist while its tracks have ended (mobile backgrounding)
    if (hasLiveVideo(localStream)) return true;
    if (localStream) {
      localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      localStream = null;
    }
    const requestGeneration = ++mediaRequestGeneration;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      if (requestGeneration !== mediaRequestGeneration) {
        stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
        return false;
      }
      localStream = stream;
      localVideo.srcObject = localStream;
      applyTrackStates(localStream);
      window.dispatchEvent(new CustomEvent('kismet:camera-ready', { detail: { stream: localStream } }));
      return true;
    } catch (e) {
      showToast('Camera/mic access is required');
      setStatus('Camera access denied');
      return false;
    }
  };

  const replaceMediaTracks = () => {
    if (!peerConnection || !localStream) return;
    peerConnection.getSenders().forEach(sender => {
      if (!sender.track) return;
      const fresh = localStream.getTracks().find(t => t.kind === sender.track.kind && t.readyState === 'live');
      if (fresh) sender.replaceTrack(fresh).catch(() => {});
    });
  };

  // Recover a dead camera when the app comes back to the foreground
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !localStream || hasLiveVideo(localStream)) return;
    const ok = await ensureCamera();
    if (ok) replaceMediaTracks();
  });

  // ---- Matchmaking via Supabase Edge Function ----
  const findMatch = async () => {
    if (isSearching || callActive) return;
    isSearching = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnStop.textContent = 'Cancel search';
    setStatus('Requesting camera access...');
    const ok = await ensureCamera();
    if (!isSearching) return; // Stop may have been pressed while the permission prompt was open.
    if (!ok) { await endCall(false); return; }

    setStatus('Searching for a stranger...');

    const poll = async () => {
      if (!isSearching) return;
      try {
        const res = await fetch(SUPABASE_URL + '/functions/v1/matchmake', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ userId, action: 'join' }),
        });
        if (!res.ok) throw new Error('Matchmaking returned HTTP ' + res.status);
        const data = await res.json();
        if (!isSearching) return;

        if (data.status === 'matched') {
          if (!data.partnerId || !data.callId) {
            throw new Error('Matchmaking returned an incomplete match response');
          }
          isSearching = false;
          btnStop.textContent = 'Stop';
          partnerId = data.partnerId;
          partnerName = 'Stranger';
          currentCallId = data.callId;
          isInitiator = data.role === 'initiator';
          if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
          window.dispatchEvent(new CustomEvent('kismet:call-started', {
            detail: { partnerId, callId: currentCallId },
          }));
          startCall();
          return;
        }
        if (isSearching) pollTimeout = setTimeout(poll, 1500);
      } catch (err) {
        console.error('Match error', err);
        if (isSearching) {
          setStatus('Match service unavailable — retrying...');
          pollTimeout = setTimeout(poll, 2500);
        }
      }
    };
    poll();
  };

  // ---- WebRTC ----
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ]
  };

  const flushIceCandidates = async (gen) => {
    while (iceCandidateQueue.length > 0) {
      if (gen !== callGeneration || !peerConnection) return;
      const candidate = iceCandidateQueue.shift();
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('ICE flush error:', e.message);
      }
    }
  };

  const sendHangup = async (chan) => {
    if (!chan) return;
    try {
      await Promise.race([chan.send({ type: 'broadcast', event: 'hangup', payload: { from: userId } }), new Promise(resolve => setTimeout(resolve, 1200))]);
    } catch (e) {
      console.warn('hangup send failed', e);
    }
  };

  const startCall = async () => {
    const gen = ++callGeneration;
    callActive = true;
    offerSent = false;                 // FIX #4: reset BEFORE handlers are registered
    const alive = () => gen === callGeneration && callActive;

    setStatus('Connecting...');
    revealSection.style.display = 'block';
    chatSection.style.display = 'flex';
    btnStop.disabled = false;
    btnNext.disabled = false;
    btnMute.disabled = false;
    btnCam.disabled = false;

    // FIX #1: reset flags AND the actual track states from any previous mute/cam-off
    micMuted = false;
    camOff = false;
    applyTrackStates(localStream);
    btnMute.textContent = 'Mute mic';
    btnCam.textContent = 'Cam off';

    iceCandidateQueue = [];
    remoteDescriptionSet = false;
    peerPresent = false;

    if (!hasLiveVideo(localStream)) {
      const ok = await ensureCamera();
      if (!alive()) return;            // FIX #3: cancel guard after await
      if (!ok) { endCall(false); return; }
    }

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (e) => {
      if (!alive()) return;
      remoteVideo.srcObject = e.streams?.[0] || new MediaStream([e.track]);
      remoteLabel.textContent = partnerName;
      setStatus('Connected');
      if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
      const playPromise = remoteVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch(() => {
          const retryPlay = () => {
            remoteVideo.play().catch(() => {});
            document.removeEventListener('click', retryPlay);
            document.removeEventListener('touchstart', retryPlay);
          };
          document.addEventListener('click', retryPlay, { once: true });
          document.addEventListener('touchstart', retryPlay, { once: true });
        });
      }
    };

    peerConnection.onicecandidate = (e) => {
      if (e.candidate && alive() && signalingChannel) {
        signalingChannel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: e.candidate, from: userId }
        }).catch(() => {});
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (!alive() || !peerConnection) return;
      const state = peerConnection.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        setStatus('Connected');
        if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
      } else if (state === 'disconnected') {
        setStatus('Reconnecting...');
      } else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Connection failed — trying ICE restart...');
        try { peerConnection.restartIce(); } catch (_) {}
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (!alive() || !peerConnection) return;
      const state = peerConnection.connectionState;
      if (state === 'connected') setStatus('Connected');
      else if (state === 'disconnected') setStatus('Reconnecting...');
      else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Could not connect. Hitting Next...');
        setTimeout(async () => {
          if (!alive()) return;
          await endCall(true);
          await findMatch();
        }, 1200);
      }
    };

    const chan = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false }, presence: { key: userId } }
    });
    signalingChannel = chan;

    // Peer-ready handshake — offer only once both peers are subscribed.
    chan.on('broadcast', { event: 'ready' }, async ({ payload }) => {
      if (!payload || payload.from === userId || !alive()) return;
      if (!isInitiator || offerSent || !peerConnection) return;
      offerSent = true;
      try {
        const offer = await peerConnection.createOffer();
        if (!alive()) return;
        await peerConnection.setLocalDescription(offer);
        if (!alive()) return;
        await chan.send({
          type: 'broadcast',
          event: 'offer',
          payload: { offer, from: userId }
        }).catch(() => {});
      } catch (error) {
        console.error('WebRTC offer negotiation failed:', error);
        if (alive()) {
          showToast('Could not start the video connection.');
          await endCall(false);
        }
      }
    });

    // Presence fallback: detect a partner who closed the tab without hangup.
    chan.on('presence', { event: 'sync' }, () => {
      if (!alive()) return;
      const peers = Object.keys(chan.presenceState()).filter(k => k !== userId);
      if (peers.length > 0) {
        peerPresent = true;
        if (peerGoneTimeout) { clearTimeout(peerGoneTimeout); peerGoneTimeout = null; }
      } else if (peerPresent && !peerGoneTimeout) {
        peerGoneTimeout = setTimeout(() => {
          peerGoneTimeout = null;
          if (!alive()) return;
          const now = Object.keys(chan.presenceState()).filter(k => k !== userId);
          if (now.length === 0) {
            showToast('Partner left the call');
            endCall(false);
          }
        }, 2500);
      }
    });

    chan.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (!payload?.offer || payload.from === userId || !alive() || !peerConnection) return;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
        if (!alive()) return;
        remoteDescriptionSet = true;
        if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
        await flushIceCandidates(gen);
        const answer = await peerConnection.createAnswer();
        if (!alive()) return;
        await peerConnection.setLocalDescription(answer);
        if (!alive()) return;
        await chan.send({
          type: 'broadcast',
          event: 'answer',
          payload: { answer, from: userId }
        }).catch(() => {});
      } catch (error) {
        console.error('WebRTC answer negotiation failed:', error);
        if (alive()) {
          showToast('Could not complete the video connection.');
          await endCall(false);
        }
      }
    });

    chan.on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (!payload?.answer || payload.from === userId || !alive() || !peerConnection) return;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
        if (!alive()) return;
        remoteDescriptionSet = true;
        if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
        await flushIceCandidates(gen);
      } catch (error) {
        console.error('WebRTC remote answer failed:', error);
        if (alive()) {
          showToast('The other browser could not complete the connection.');
          await endCall(false);
        }
      }
    });

    chan.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (!payload?.candidate || payload.from === userId || !alive() || !peerConnection) return;
      if (remoteDescriptionSet) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
          console.warn('ICE error:', e.message);
        }
      } else {
        iceCandidateQueue.push(payload.candidate);
      }
    });

    chan.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (!payload || payload.from === userId || !alive()) return;
      if (typeof payload.text === 'string') addMessage(payload.text, false);
    });

    chan.on('broadcast', { event: 'reveal' }, ({ payload }) => {
      if (!payload?.from || payload.from === userId || !alive()) return;
      const name = String(payload.name || 'Stranger').slice(0, 80);
      remoteLabel.textContent = name;
      showToast(name + ' revealed their identity!');
      showFriendRequestButton(name, payload.from, String(payload.code || '').slice(0, 24));
    });

    chan.on('broadcast', { event: 'hangup' }, () => {
      if (!alive()) return;
      showToast('Partner ended the call');
      endCall(false);
    });

    chan.on('broadcast', { event: 'friend-request' }, ({ payload }) => {
      if (!payload || payload.from === userId || !alive()) return;
      showToast(String(payload.name || 'Someone') + ' sent you a friend request!');
    });

    // FIX #3: guard the subscription await and everything after it
    const subStatus = await new Promise((resolve) => {
      let settled = false;
      const finish = (s) => {
        if (settled) return;
        settled = true;
        clearTimeout(subTimer);
        resolve(s);
      };
      const subTimer = setTimeout(() => finish('TIMED_OUT'), 10000);
      chan.subscribe(finish);
    });
    if (!alive() || subStatus !== 'SUBSCRIBED') {
      if (signalingChannel === chan) signalingChannel = null;
      sb.removeChannel(chan);
      return;
    }
    await chan.track({ user_id: userId });
    if (!alive()) {
      if (signalingChannel === chan) signalingChannel = null;
      sb.removeChannel(chan);
      return;
    }

    const announceReady = () => {
      if (!alive() || !peerConnection || remoteDescriptionSet) return;
      chan.send({ type: 'broadcast', event: 'ready', payload: { from: userId } }).catch(() => {});
    };
    announceReady();
    readyInterval = setInterval(announceReady, 500);

    connectionTimeout = setTimeout(async () => {
      if (alive() && peerConnection && peerConnection.connectionState !== 'connected') {
        showToast('Could not connect — trying next person...');
        await endCall(true);
        await findMatch();
      }
    }, 15000);
  };

  const leaveQueue = (keepalive = false) => {
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ userId, action: 'leave' }),
    };
    if (keepalive) init.keepalive = true;
    return fetch(SUPABASE_URL + '/functions/v1/matchmake', init).catch(() => {});
  };

  const endCall = async (notify = true) => {
    callGeneration++;
    mediaRequestGeneration++; // invalidate any camera permission request still in flight
    callActive = false;

    if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
    if (peerGoneTimeout) { clearTimeout(peerGoneTimeout); peerGoneTimeout = null; }
    if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
    offerSent = false;

    // FIX #2: detach the channel reference BEFORE awaiting the hangup broadcast,
    // so a fast "Next" can't have its new channel removed by this cleanup.
    const chanToClose = signalingChannel;
    signalingChannel = null;
    if (localStream) {
      localStream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
      localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (notify && chanToClose) await sendHangup(chanToClose);
    if (chanToClose) sb.removeChannel(chanToClose);

    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    leaveQueue();

    remoteVideo.srcObject = null;
    remoteLabel.textContent = 'Stranger';
    setStatus('Ready to match');
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnStop.textContent = 'Stop';
    btnNext.disabled = true;
    btnMute.disabled = true;
    btnCam.disabled = true;
    revealSection.style.display = 'none';
    chatSection.style.display = 'none';
    const frBtn = document.getElementById('friend-request-btn');
    if (frBtn) frBtn.remove();
    revealed = false;
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> <span>Reveal identity</span>';
    btnReveal.classList.remove('revealed');
    partnerId = null;
    iceCandidateQueue = [];
    remoteDescriptionSet = false;
    peerPresent = false;
    isSearching = false;
    window.dispatchEvent(new CustomEvent('kismet:call-ended'));
  };

  const addMessage = (text, isMe) => {
    const el = document.createElement('div');
    el.className = 'vc-msg ' + (isMe ? 'me' : 'them');
    el.textContent = text;
    vcMessages.appendChild(el);
    vcMessages.scrollTop = vcMessages.scrollHeight;
  };

  const showFriendRequestButton = (name, fromId, fromCode) => {
    let btn = document.getElementById('friend-request-btn');
    if (btn) btn.remove();

    btn = document.createElement('button');
    btn.id = 'friend-request-btn';
    btn.className = 'vc-btn primary';
    btn.style.marginTop = '.5rem';
    btn.textContent = 'Send friend request to ' + name;

    btn.addEventListener('click', async () => {
      let profile = {};
      try { profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}'); } catch (_) {}
      const myName = profile.name || 'Anonymous';
      const myCode = profile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';

      const { error: profileError } = await sb.from('profiles').upsert({
        user_id: userId,
        name: myName,
        friend_code: myCode,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (profileError) {
        console.error('Could not sync profile before friend request:', profileError);
        showToast('Could not save your profile. Try again.');
        return;
      }

      const { error } = await sb.from('friend_requests').upsert({
        from_user_id: userId,
        to_user_id: fromId,
        from_name: myName,
        from_code: myCode,
        status: 'pending',
      }, { onConflict: 'from_user_id,to_user_id' });

      if (error) {
        console.error(error);
        showToast('Could not send request');
        return;
      }
      if (signalingChannel) {
        signalingChannel.send({
          type: 'broadcast',
          event: 'friend-request',
          payload: { from: userId, name: myName, code: myCode },
        }).catch(() => {});
      }
      showToast('Friend request sent!');
      btn.disabled = true;
      btn.textContent = 'Request sent';
    });

    revealSection.appendChild(btn);
  };

  // ---- Event listeners ----
  btnStart.addEventListener('click', findMatch);
  btnStop.addEventListener('click', () => {
    if (isSearching) showToast('Search cancelled');
    endCall(true);
  });
  btnNext.addEventListener('click', async () => {
    await endCall(true);
    await findMatch();
  });

  btnMute.addEventListener('click', () => {
    if (!localStream) return;
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    btnMute.textContent = micMuted ? 'Unmute mic' : 'Mute mic';
  });
  btnCam.addEventListener('click', () => {
    if (!localStream) return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach(t => { t.enabled = !camOff; });
    btnCam.textContent = camOff ? 'Cam on' : 'Cam off';
  });

  btnReveal.addEventListener('click', async () => {
    if (revealed) { showToast('Already revealed'); return; }
    revealed = true;
    let profile = {};
    try { profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}'); } catch (_) {}
    const name = profile.name || 'Anonymous';
    const code = profile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';

    const { error: profileError } = await sb.from('profiles').upsert({
      user_id: userId,
      name,
      friend_code: code,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (profileError) {
      console.error('Could not save profile before reveal:', profileError);
      revealed = false;
      showToast('Could not reveal identity. Please try again.');
      return;
    }

    btnReveal.classList.add('revealed');
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> <span>Revealed</span>';
    revealStatus.textContent = 'Identity revealed!';
    if (signalingChannel) {
      signalingChannel.send({
        type: 'broadcast',
        event: 'reveal',
        payload: { name, from: userId, code },
      }).catch(() => {});
    }
    showToast('You revealed your identity!');
  });

  vcSend.addEventListener('click', async () => {
    const text = vcMsgInput.value.trim();
    const channel = signalingChannel;
    if (!text || !channel || vcSend.disabled) return;
    vcSend.disabled = true;
    try {
      const status = await channel.send({
        type: 'broadcast',
        event: 'chat',
        payload: { text, from: userId }
      });
      if (status !== 'ok') throw new Error('Realtime message delivery status: ' + status);
      if (channel === signalingChannel) {
        addMessage(text, true);
        vcMsgInput.value = '';
      }
    } catch (error) {
      console.error('Could not send in-call message:', error);
      showToast('Message could not be sent. Try again.');
    } finally {
      vcSend.disabled = false;
    }
  });
  vcMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') vcSend.click();
  });

  // Safety UI hook — report submitted by redesign/safety.js
  window.addEventListener('kismet:report', async () => {
    showToast('Report submitted — moving on');
    await endCall(true);
    await findMatch();
  });

  // FIX #2: pagehide uses best-effort send + keepalive fetch (survives unload)
  let pageExited = false;
  const handlePageExit = () => {
    if (pageExited) return;
    pageExited = true;
    callGeneration++;
    mediaRequestGeneration++;
    callActive = false;
    if (localStream) {
      localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (signalingChannel) {
      signalingChannel.send({
        type: 'broadcast',
        event: 'hangup',
        payload: { from: userId },
      }).catch(() => {});
    }
    leaveQueue(true);
    lobbyChannel.unsubscribe();
  };
  window.addEventListener('pagehide', handlePageExit);
  window.addEventListener('beforeunload', handlePageExit);

  setStatus('Ready to match');
  console.log('Videochat ready. User ID:', userId);
})();
