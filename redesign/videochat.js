/* Kismet video chat — WebRTC + Supabase Realtime signaling */
(async () => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

  const waitForSupabase = () => new Promise((resolve) => {
    if (window.supabase) { resolve(); return; }
    let attempts = 0;
    const check = setInterval(() => {
      if (window.supabase || attempts > 50) { clearInterval(check); resolve(); }
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
  let userId = 'user_' + Math.random().toString(36).slice(2, 10);
  let revealed = false;
  let isInitiator = false;

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
    onlineCount.textContent = count;
  });

  lobbyChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await lobbyChannel.track({ user_id: userId, online_at: new Date().toISOString() });
    }
  });

  // ---- Matchmaking via Realtime broadcast ----
  let matchChannel = null;

  const findMatch = async () => {
    if (isSearching) return;
    isSearching = true;
    setStatus('Searching for a stranger...');
    btnStart.disabled = true;

    // Subscribe to match notifications
    matchChannel = sb.channel('matchmaking', { config: { broadcast: { self: false } } });

    matchChannel.on('broadcast', { event: 'looking' }, ({ payload }) => {
      if (payload.from === userId || !isSearching) return;
      // Found a partner! The one with smaller ID initiates
      if (userId < payload.from) {
        // I am the initiator
        isSearching = false;
        partnerId = payload.from;
        partnerName = 'Stranger';
        currentCallId = 'call_' + [userId, partnerId].sort().join('_');
        isInitiator = true;
        // Notify the partner
        matchChannel.send({
          type: 'broadcast',
          event: 'matched',
          payload: { target: payload.from, caller_id: userId, call_id: currentCallId }
        });
        // Remove from searching
        matchChannel.send({ type: 'broadcast', event: 'stop-looking', payload: { from: userId } });
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
      matchChannel.send({ type: 'broadcast', event: 'stop-looking', payload: { from: userId } });
      startCall();
    });

    matchChannel.on('broadcast', { event: 'stop-looking' }, ({ payload }) => {
      // Partner found someone else, ignore
    });

    await new Promise((resolve) => {
      matchChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
      });
    });

    // Announce that we're looking
    matchChannel.send({
      type: 'broadcast',
      event: 'looking',
      payload: { from: userId }
    });

    // Keep announcing every 3 seconds in case the first was missed
    const announceInterval = setInterval(() => {
      if (!isSearching) { clearInterval(announceInterval); return; }
      matchChannel.send({
        type: 'broadcast',
        event: 'looking',
        payload: { from: userId }
      });
    }, 3000);

    // Store for cleanup
    window._matchChannel = matchChannel;
    window._announceInterval = announceInterval;
  };

  // ---- WebRTC ----
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
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
    micMuted = false;
    camOff = false;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (e) {
      showToast('Camera/mic access denied');
      setStatus('Camera access denied');
      return;
    }

    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      remoteLabel.textContent = partnerName;
      setStatus('Connected');
      // Ensure audio plays (handle autoplay policy)
      const playPromise = remoteVideo.play();
      if (playPromise !== undefined) {
        playPromise.catch(err => {
          console.log('Autoplay blocked, will retry on user interaction');
          // Retry on any user interaction
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

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') setStatus('Connected');
      else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') setStatus('Disconnected');
    };

    // Signaling channel
    const signalingChannel = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false } }
    });

    signalingChannel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
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
    });

    signalingChannel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === userId) return;
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) {}
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

    // If initiator, create and send offer after delay
    if (isInitiator) {
      await new Promise(r => setTimeout(r, 1500));
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
    if (window._announceInterval) { clearInterval(window._announceInterval); }
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
    btn.innerHTML = 'Send friend request to ' + name;
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

  // Mute mic toggle
  let micMuted = false;
  btnMute.addEventListener('click', () => {
    if (!localStream) return;
    micMuted = !micMuted;
    localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
    btnMute.textContent = micMuted ? 'Unmute mic' : 'Mute mic';
    btnMute.classList.toggle('danger', micMuted);
  });

  // Camera toggle
  let camOff = false;
  btnCam.addEventListener('click', () => {
    if (!localStream) return;
    camOff = !camOff;
    localStream.getVideoTracks().forEach(t => { t.enabled = !camOff; });
    btnCam.textContent = camOff ? 'Cam on' : 'Cam off';
    btnCam.classList.toggle('danger', camOff);
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