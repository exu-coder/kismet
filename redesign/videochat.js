/* Kismet video chat — WebRTC + Supabase Realtime signaling
   Fixes: ICE candidate queuing, pre-request camera, no magic delays,
   connection timeout, TURN-ready, better recovery & cleanup. */
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
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // ---- State ----
  let localStream = null;
  let peerConnection = null;
  let currentCallId = null;
  let partnerId = null;
  let partnerName = 'Stranger';
  let isSearching = false;
  let userId = localStorage.getItem('kismet.anonId') || ('user_' + Math.random().toString(36).slice(2, 10));
  localStorage.setItem('kismet.anonId', userId);
  let revealed = false;
  let isInitiator = false;
  let readyInterval = null;
  let offerSent = false;
  let connectionTimeout = null;
  let iceCandidateQueue = [];
  let remoteDescriptionSet = false;
  let micMuted = false;
  let camOff = false;

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

  // ---- Presence ----
  const lobbyChannel = sb.channel('lobby', {
    config: { presence: { key: userId } }
  });

  lobbyChannel.on('presence', { event: 'sync' }, () => {
    const state = lobbyChannel.presenceState();
    onlineCount.textContent = Object.keys(state).length;
  });

  lobbyChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await lobbyChannel.track({ user_id: userId, online_at: new Date().toISOString() });
    }
  });

  // ---- Pre-request camera ----
  const ensureCamera = async () => {
    if (localStream) return true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      return true;
    } catch (e) {
      showToast('Camera/mic access is required');
      setStatus('Camera access denied');
      return false;
    }
  };

  // ---- Matchmaking via Supabase Edge Function ----
  let pollTimeout = null;

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
        const res = await fetch(
          SUPABASE_URL + '/functions/v1/matchmake',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ userId, action: 'join' }),
          }
        );
        const data = await res.json();

        if (data.status === 'matched') {
          isSearching = false;
          partnerId = data.partnerId;
          partnerName = 'Stranger';
          currentCallId = data.callId;
          isInitiator = data.role === 'initiator';
          if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
          startCall();
          return;
        }

        if (isSearching) {
          pollTimeout = setTimeout(poll, 1500);
        }
      } catch (err) {
        console.error('Match error', err);
        if (isSearching) {
          pollTimeout = setTimeout(poll, 2000);
        }
      }
    };

    poll();
  };

  // ---- WebRTC ----
  // IMPORTANT: Add your real TURN credentials here (Metered, Cloudflare, Twilio, or self-hosted)
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Free TURN from Metered.ca (open relay)
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ]
  };

  const flushIceCandidates = async () => {
    while (iceCandidateQueue.length > 0) {
      const candidate = iceCandidateQueue.shift();
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.warn('ICE flush error:', e.message);
      }
    }
  };

  const startCall = async () => {
    setStatus('Connecting...');
    revealSection.style.display = 'block';
    chatSection.style.display = 'flex';
    btnStop.disabled = false;
    btnNext.disabled = false;
    btnMute.disabled = false;
    btnCam.disabled = false;
    btnMute.textContent = 'Mute mic';
    btnCam.textContent = 'Cam off';
    micMuted = false;
    camOff = false;

    iceCandidateQueue = [];
    remoteDescriptionSet = false;

    if (!localStream) {
      const ok = await ensureCamera();
      if (!ok) {
        endCall(false);
        return;
      }
    }

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      remoteLabel.textContent = partnerName;
      setStatus('Connected');
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
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
      if (e.candidate && window._signalingChannel) {
        window._signalingChannel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: e.candidate, from: userId }
        });
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection?.iceConnectionState;
      console.log('ICE state:', state);
      if (state === 'connected' || state === 'completed') {
        setStatus('Connected');
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
      } else if (state === 'disconnected') {
        setStatus('Reconnecting...');
      } else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Connection failed — trying ICE restart...');
        try { peerConnection.restartIce(); } catch (_) {}
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection?.connectionState;
      if (state === 'connected') setStatus('Connected');
      else if (state === 'disconnected') setStatus('Reconnecting...');
      else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Could not connect. Hitting Next...');
        setTimeout(() => {
          endCall(true);
          setTimeout(findMatch, 400);
        }, 1200);
      }
    };

    // Signaling
    const signalingChannel = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false } }
    });

    // Peer-ready handshake: both sides announce until a remote description arrives.
    // This prevents the initiator's offer being broadcast before the responder subscribes.
    signalingChannel.on('broadcast', { event: 'ready' }, async ({ payload }) => {
      if (payload.from === userId) return;
      if (!isInitiator || offerSent || !peerConnection) return;
      offerSent = true;
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      console.log('Sending offer (peer ready)');
      await signalingChannel.send({
        type: 'broadcast',
        event: 'offer',
        payload: { offer, from: userId }
      });
    });

    signalingChannel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
      remoteDescriptionSet = true;
      if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
      await flushIceCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await signalingChannel.send({
        type: 'broadcast',
        event: 'answer',
        payload: { answer, from: userId }
      });
    });

    signalingChannel.on('broadcast', { event: 'answer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
      remoteDescriptionSet = true;
      if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
      await flushIceCandidates();
    });

    signalingChannel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === userId) return;
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

    signalingChannel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (payload.from === userId) return;
      addMessage(payload.text, false);
    });

    signalingChannel.on('broadcast', { event: 'reveal' }, ({ payload }) => {
      if (payload.from === userId) return;
      remoteLabel.textContent = payload.name;
      showToast(payload.name + ' revealed their identity!');
      showFriendRequestButton(payload.name, payload.from, payload.code);
    });

    signalingChannel.on('broadcast', { event: 'hangup' }, () => {
      endCall(false);
    });

    signalingChannel.on('broadcast', { event: 'friend-request' }, ({ payload }) => {
      if (payload.from === userId) return;
      showToast(payload.name + ' sent you a friend request!');
    });

    await new Promise((resolve) => {
      signalingChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
      });
    });

    window._signalingChannel = signalingChannel;

    offerSent = false;
    const announceReady = () => {
      if (window._signalingChannel && peerConnection && !remoteDescriptionSet) {
        signalingChannel.send({
          type: 'broadcast',
          event: 'ready',
          payload: { from: userId }
        });
      }
    };
    announceReady();
    readyInterval = setInterval(announceReady, 500);

    // Connection timeout — if not connected in 15s, auto Next
    connectionTimeout = setTimeout(() => {
      if (peerConnection && peerConnection.connectionState !== 'connected') {
        showToast('Could not connect — trying next person...');
        endCall(true);
        setTimeout(findMatch, 500);
      }
    }, 15000);
  };

  const endCall = async (notify = true) => {
    if (connectionTimeout) {
      clearTimeout(connectionTimeout);
      connectionTimeout = null;
    }
    if (readyInterval) {
      clearInterval(readyInterval);
      readyInterval = null;
    }
    offerSent = false;
    if (notify && window._signalingChannel) {
      window._signalingChannel.send({
        type: 'broadcast',
        event: 'hangup',
        payload: { from: userId }
      });
    }
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    // Keep localStream alive so Next is faster (stop only on full page leave)
    if (window._signalingChannel) {
      sb.removeChannel(window._signalingChannel);
      window._signalingChannel = null;
    }
    if (pollTimeout) {
      clearTimeout(pollTimeout);
      pollTimeout = null;
    }
    // Leave the match queue
    fetch(SUPABASE_URL + '/functions/v1/matchmake', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ userId, action: 'leave' }),
    }).catch(() => {});

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
    isSearching = false;
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

      // 1. Ensure my profile exists
      await sb.from('profiles').upsert({
        user_id: userId,
        name: myName,
        friend_code: myCode,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });

      // 2. Send friend request (upsert = idempotent)
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

      // 3. Notify via signaling
      if (window._signalingChannel) {
        window._signalingChannel.send({
          type: 'broadcast',
          event: 'friend-request',
          payload: { from: userId, name: myName, code: myCode },
        });
      }

      showToast('Friend request sent!');
      btn.disabled = true;
      btn.textContent = 'Request sent';
    });

    revealSection.appendChild(btn);
  };

  btnStart.addEventListener('click', findMatch);
  btnStop.addEventListener('click', () => endCall(true));
  btnNext.addEventListener('click', () => {
    endCall(true);
    setTimeout(findMatch, 400);
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

    // Save / update my profile
    await sb.from('profiles').upsert({
      user_id: userId,
      name,
      friend_code: code,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    btnReveal.classList.add('revealed');
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> <span>Revealed</span>';
    revealStatus.textContent = 'Identity revealed!';
    if (window._signalingChannel) {
      window._signalingChannel.send({
        type: 'broadcast',
        event: 'reveal',
        payload: { name, from: userId, code },
      });
    }
    showToast('You revealed your identity!');
  });

  vcSend.addEventListener('click', () => {
    const text = vcMsgInput.value.trim();
    if (!text || !window._signalingChannel) return;
    addMessage(text, true);
    window._signalingChannel.send({
      type: 'broadcast',
      event: 'chat',
      payload: { text, from: userId }
    });
    vcMsgInput.value = '';
  });
  vcMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') vcSend.click();
  });

  window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    endCall(false);
    lobbyChannel.unsubscribe();
  });

  setStatus('Ready to match');
  console.log('Videochat ready. User ID:', userId);
})();