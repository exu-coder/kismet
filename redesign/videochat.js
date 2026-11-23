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
  let peerConnection = null;
  let signalingChannel = null;
  let currentCallId = null;
  let partnerId = null;
  let partnerName = 'Stranger';
  let isSearching = false;
  const userId = localStorage.getItem('kismet.anonId') || ('user_' + Math.random().toString(36).slice(2, 10));
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
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
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
    if (isSearching) return;
    const ok = await ensureCamera();
    if (!ok) return;

    isSearching = true;
    setStatus('Searching for a stranger...');
    btnStart.disabled = true;

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
        const data = await res.json();

        if (data.status === 'matched') {
          isSearching = false;
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
        if (isSearching) pollTimeout = setTimeout(poll, 2000);
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
      await chan.send({ type: 'broadcast', event: 'hangup', payload: { from: userId } });
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
      remoteVideo.srcObject = e.streams[0];
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
        setTimeout(() => {
          if (!alive()) return;
          endCall(true);
          findMatch();
        }, 1200);
      }
    };

    const chan = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false }, presence: { key: userId } }
    });
    signalingChannel = chan;

    // Peer-ready handshake — offer only once both peers are subscribed.
    chan.on('broadcast', { event: 'ready' }, async ({ payload }) => {
      if (payload.from === userId || !alive()) return;
      if (!isInitiator || offerSent || !peerConnection) return;
      offerSent = true;
      const offer = await peerConnection.createOffer();
      if (!alive()) return;
      await peerConnection.setLocalDescription(offer);
      await chan.send({
        type: 'broadcast',
        event: 'offer',
        payload: { offer, from: userId }
      }).catch(() => {});
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
      if (payload.from === userId || !alive() || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
      if (!alive()) return;
      remoteDescriptionSet = true;
      if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
      await flushIceCandidates(gen);
      const answer = await peerConnection.createAnswer();
      if (!alive()) return;
      await peerConnection.setLocalDescription(answer);
      await chan.send({
        type: 'broadcast',
        event: 'answer',
        payload: { answer, from: userId }
      }).catch(() => {});
    });

    chan.on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (payload.from === userId || !alive() || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
      if (!alive()) return;
      remoteDescriptionSet = true;
      if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
      await flushIceCandidates(gen);
    });

    chan.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === userId || !alive() || !peerConnection) return;
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
      if (payload.from === userId || !alive()) return;
      addMessage(payload.text, false);
    });

    chan.on('broadcast', { event: 'reveal' }, ({ payload }) => {
      if (payload.from === userId || !alive()) return;
      remoteLabel.textContent = payload.name;
      showToast(payload.name + ' revealed their identity!');
      showFriendRequestButton(payload.name, payload.from, payload.code);
    });

    chan.on('broadcast', { event: 'hangup' }, () => {
      if (!alive()) return;
      showToast('Partner ended the call');
      endCall(false);
    });

    chan.on('broadcast', { event: 'friend-request' }, ({ payload }) => {
      if (payload.from === userId || !alive()) return;
      showToast(payload.name + ' sent you a friend request!');
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

    connectionTimeout = setTimeout(() => {
      if (alive() && peerConnection && peerConnection.connectionState !== 'connected') {
        showToast('Could not connect — trying next person...');
        endCall(true);
        findMatch();
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

  const endCall = (notify = true) => {
    callGeneration++;
    callActive = false;

    if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
    if (peerGoneTimeout) { clearTimeout(peerGoneTimeout); peerGoneTimeout = null; }
    if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
    offerSent = false;

    // All state/UI teardown is synchronous. The hangup is fire-and-forget so a
    // slow mobile network can't delay a following findMatch() — otherwise the
    // tail of this function would reset isSearching after the new search started.
    const chanToClose = signalingChannel;
    signalingChannel = null;
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    leaveQueue();

    if (chanToClose) {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        sb.removeChannel(chanToClose);
      };
      // Never leave the channel subscribed if the broadcast hangs.
      setTimeout(cleanup, 3000);
      if (notify) sendHangup(chanToClose).then(cleanup, cleanup);
      else cleanup();
    }

    remoteVideo.srcObject = null;
    remoteLabel.textContent = 'Stranger';
    setStatus('Ready to match');
    btnStart.disabled = false;
    btnStop.disabled = true;
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
      const profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}');
      const myName = profile.name || 'Anonymous';
      const myCode = profile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';

      await sb.from('profiles').upsert({
        user_id: userId,
        name: myName,
        friend_code: myCode,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

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
  btnStop.addEventListener('click', () => endCall(true));
  btnNext.addEventListener('click', () => {
    endCall(true);
    findMatch();
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
    const profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}');
    const name = profile.name || 'Anonymous';
    const code = profile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';

    await sb.from('profiles').upsert({
      user_id: userId,
      name,
      friend_code: code,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

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

  vcSend.addEventListener('click', () => {
    const text = vcMsgInput.value.trim();
    if (!text || !signalingChannel) return;
    addMessage(text, true);
    signalingChannel.send({
      type: 'broadcast',
      event: 'chat',
      payload: { text, from: userId }
    }).catch(() => {});
    vcMsgInput.value = '';
  });
  vcMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') vcSend.click();
  });

  // Safety UI hook — report submitted by redesign/safety.js
  window.addEventListener('kismet:report', () => {
    showToast('Report submitted — moving on');
    endCall(true);
    findMatch();
  });

  // FIX #2: pagehide uses best-effort send + keepalive fetch (survives unload)
  let pageExited = false;
  const handlePageExit = () => {
    if (pageExited) return;
    pageExited = true;
    callGeneration++;
    callActive = false;
    if (localStream) localStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
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
  // A bfcache restore resurrects the stopped camera/dead presence with a stale UI.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
  });

  setStatus('Ready to match');
  console.log('Videochat ready. User ID:', userId);
})();
