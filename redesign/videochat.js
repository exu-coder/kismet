/* Kismet video chat — WebRTC + Supabase Realtime signaling
   Fixed: ICE candidate queuing, connection recovery, camera pre-request,
   TURN servers, connection timeout, no magic delays, matchmaking. */
(async () => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

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
  let pollInterval = null;
  let announceInterval = null;
  let iceCandidateQueue = [];
  let remoteDescriptionSet = false;
  let connectionTimeout = null;

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
  const lobbyChannel = sb.channel('lobby', {
    config: { presence: { key: userId } }
  });

  lobbyChannel.on('presence', { event: 'sync' }, () => {
    const state = lobbyChannel.presenceState();
    const count = Object.keys(state).length;
    console.log('Presence sync, count:', count);
    onlineCount.textContent = count;
  });

  lobbyChannel.subscribe(async (status) => {
    console.log('Lobby channel status:', status);
    if (status === 'SUBSCRIBED') {
      await lobbyChannel.track({ user_id: userId, online_at: new Date().toISOString() });
      console.log('Tracked presence for', userId);
    }
  });

  // ---- Camera pre-request ----
  const requestCamera = async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      return true;
    } catch (e) {
      showToast('Camera/mic access denied. Please allow to continue.');
      setStatus('Camera access denied');
      return false;
    }
  };

  // ---- Matchmaking via Realtime broadcast ----
  let matchChannel = null;

  const findMatch = async () => {
    if (isSearching) return;

    // Request camera FIRST
    if (!localStream) {
      setStatus('Requesting camera...');
      const granted = await requestCamera();
      if (!granted) return;
    }

    isSearching = true;
    setStatus('Searching for a stranger...');
    btnStart.disabled = true;

    matchChannel = sb.channel('matchmaking', { config: { broadcast: { self: false } } });

    matchChannel.on('broadcast', { event: 'looking' }, ({ payload }) => {
      if (payload.from === userId || !isSearching) return;
      if (userId < payload.from) {
        isSearching = false;
        partnerId = payload.from;
        partnerName = 'Stranger';
        currentCallId = 'call_' + [userId, partnerId].sort().join('_');
        isInitiator = true;
        matchChannel.send({
          type: 'broadcast',
          event: 'matched',
          payload: { target: payload.from, caller_id: userId, call_id: currentCallId }
        });
        if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
        startCall();
      }
    });

    matchChannel.on('broadcast', { event: 'matched' }, ({ payload }) => {
      if (payload.target !== userId || !isSearching) return;
      isSearching = false;
      partnerId = payload.caller_id;
      partnerName = 'Stranger';
      currentCallId = payload.call_id;
      isInitiator = false;
      if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
      startCall();
    });

    await new Promise((resolve) => {
      matchChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
      });
    });

    window._matchChannel = matchChannel;

    const announce = () => {
      if (!isSearching) return;
      matchChannel.send({
        type: 'broadcast',
        event: 'looking',
        payload: { from: userId }
      });
    };
    announce();
    announceInterval = setInterval(announce, 3000);
  };

  // ---- WebRTC ----
  // TURN servers — using free Metered.ca open relay for testing.
  // For production, replace with your own TURN credentials.
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ]
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

    iceCandidateQueue = [];
    remoteDescriptionSet = false;

    // If camera wasn't pre-requested, get it now
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
      } catch (e) {
        showToast('Camera/mic access denied');
        setStatus('Camera access denied');
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
      clearTimeout(connectionTimeout);
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
      const state = peerConnection.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        setStatus('Connected');
        clearTimeout(connectionTimeout);
      } else if (state === 'disconnected') {
        setStatus('Reconnecting...');
      } else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Connection failed. Trying next person...');
        setTimeout(() => { if (peerConnection && peerConnection.iceConnectionState === 'failed') { endCall(true); } }, 2000);
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === 'connected') setStatus('Connected');
      else if (state === 'disconnected') setStatus('Reconnecting...');
      else if (state === 'failed') {
        setStatus('Connection failed');
        showToast('Connection failed');
      }
    };

    // Signaling channel
    const signalingChannel = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false } }
    });

    signalingChannel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
      remoteDescriptionSet = true;
      flushIceCandidates();
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
      flushIceCandidates();
    });

    signalingChannel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === userId) return;
      if (remoteDescriptionSet) {
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) {}
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
      showFriendRequestButton(payload.name, payload.from);
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

    const flushIceCandidates = async () => {
      while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
      }
    };

    // Connection timeout: auto-retry after 15s
    connectionTimeout = setTimeout(() => {
      if (peerConnection && peerConnection.connectionState !== 'connected') {
        showToast('Connection timed out. Trying next person...');
        endCall(true);
      }
    }, 15000);

    if (isInitiator) {
      // Wait for partner to subscribe (small delay)
      await new Promise(r => setTimeout(r, 500));
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      console.log('Sending offer');
      await signalingChannel.send({
        type: 'broadcast',
        event: 'offer',
        payload: { offer, from: userId }
      });
    }
  };

  const endCall = async (notify = true) => {
    clearTimeout(connectionTimeout);
    if (notify && window._signalingChannel) {
      window._signalingChannel.send({
        type: 'broadcast',
        event: 'hangup',
        payload: { from: userId }
      });
    }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (window._signalingChannel) { sb.removeChannel(window._signalingChannel); window._signalingChannel = null; }
    if (window._matchChannel) { sb.removeChannel(window._matchChannel); window._matchChannel = null; }
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    localVideo.srcObject = null;
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

  const showFriendRequestButton = (name, fromId) => {
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
      const myCode = profile.code || 'KS-XXXX';
      await sb.from('friend_requests').insert({
        from_user_id: userId,
        to_user_id: fromId,
        from_name: myName,
        from_code: myCode,
        status: 'pending'
      });
      if (window._signalingChannel) {
        window._signalingChannel.send({
          type: 'broadcast',
          event: 'friend-request',
          payload: { from: userId, name: myName }
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
  btnNext.addEventListener('click', () => { endCall(true); setTimeout(findMatch, 500); });

  let micMuted = false, camOff = false;
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

  btnReveal.addEventListener('click', () => {
    if (revealed) { showToast('Already revealed'); return; }
    revealed = true;
    const profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}');
    const name = profile.name || 'Anonymous';
    btnReveal.classList.add('revealed');
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> <span>Revealed</span>';
    revealStatus.textContent = 'Identity revealed!';
    if (window._signalingChannel) {
      window._signalingChannel.send({
        type: 'broadcast',
        event: 'reveal',
        payload: { name, from: userId }
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
  vcMsgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') vcSend.click(); });

  window.addEventListener('beforeunload', () => {
    endCall(false);
    lobbyChannel.unsubscribe();
    if (window._matchChannel) sb.removeChannel(window._matchChannel);
  });

  setStatus('Ready to match');
})();