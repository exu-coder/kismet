/* Kismet video chat — WebRTC + Supabase Realtime signaling */
(async () => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

  // Wait for Supabase to load (loaded via script tag)
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

  // ---- Matchmaking ----
  const findMatch = async () => {
    if (isSearching) return;
    isSearching = true;
    setStatus('Searching for a stranger...');
    btnStart.disabled = true;

    // Insert into waiting queue
    const { data: waiting, error } = await sb.from('waiting_queue').insert({
      user_id: userId,
      user_name: 'Anonymous'
    }).select().single();

    if (error) { showToast('Matchmaking error: ' + error.message); isSearching = false; btnStart.disabled = false; return; }

    // Listen for a match
    const matchChannel = sb.channel('match_' + userId);
    matchChannel.on('broadcast', { event: 'matched' }, ({ payload }) => {
      if (payload.partner_id === userId) {
        partnerId = payload.user_id;
        partnerName = payload.user_name || 'Stranger';
        currentCallId = payload.call_id;
        isSearching = false;
        // Remove from waiting queue
        sb.from('waiting_queue').delete().eq('user_id', userId);
        // Start WebRTC
        startCall(true);
      }
    });
    matchChannel.subscribe();

    // Check for existing waiting users
    const checkMatch = async () => {
      const { data: waiters } = await sb.from('waiting_queue')
        .select('*')
        .neq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(1);

      if (waiters && waiters.length > 0) {
        const partner = waiters[0];
        // Create a call
        const { data: call } = await sb.from('active_calls').insert({
          user1_id: userId,
          user2_id: partner.user_id
        }).select().single();

        if (call) {
          currentCallId = call.id;
          partnerId = partner.user_id;
          partnerName = partner.user_name || 'Stranger';
          // Notify partner
          const partnerChannel = sb.channel('match_' + partner.user_id);
          partnerChannel.subscribe(() => {
            partnerChannel.send({
              type: 'broadcast',
              event: 'matched',
              payload: { user_id: userId, user_name: 'Anonymous', partner_id: partner.user_id, call_id: call.id }
            });
          });
          // Remove both from queue
          await sb.from('waiting_queue').delete().eq('user_id', userId);
          await sb.from('waiting_queue').delete().eq('user_id', partner.user_id);
          isSearching = false;
          startCall(false);
        }
      }
    };

    // Poll for match every 2 seconds
    const pollInterval = setInterval(async () => {
      if (!isSearching) { clearInterval(pollInterval); return; }
      await checkMatch();
    }, 2000);

    // Also check immediately
    await checkMatch();
  };

  // ---- WebRTC ----
  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const startCall = async (isInitiator) => {
    setStatus('Connecting...');
    revealSection.style.display = 'block';
    chatSection.style.display = 'flex';
    btnStop.disabled = false;
    btnNext.disabled = false;

    // Get local media
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
    } catch (e) {
      showToast('Camera/mic access denied');
      setStatus('Camera access denied');
      return;
    }

    // Create peer connection
    peerConnection = new RTCPeerConnection(ICE_SERVERS);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
      remoteLabel.textContent = partnerName;
      setStatus('Connected');
    };

    peerConnection.onicecandidate = (e) => {
      if (e.candidate) {
        signalingChannel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: e.candidate, from: userId }
        });
      }
    };

    // Signaling channel
    const signalingChannel = sb.channel('signal_' + currentCallId, {
      config: { broadcast: { self: false } }
    });

    signalingChannel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      if (payload.from === userId) return;
      console.log('Received offer');
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
      console.log('Received answer');
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
    });

    signalingChannel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      if (payload.from === userId) return;
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { console.log('ICE error:', e.message); }
    });

    signalingChannel.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (payload.from === userId) return;
      addMessage(payload.text, false);
    });

    signalingChannel.on('broadcast', { event: 'reveal' }, ({ payload }) => {
      if (payload.from === userId) return;
      remoteLabel.textContent = payload.name;
      showToast(payload.name + ' revealed their identity!');
    });

    signalingChannel.on('broadcast', { event: 'hangup' }, () => {
      endCall(false);
    });

    // Wait for subscription before sending
    await new Promise((resolve) => {
      signalingChannel.subscribe((status) => {
        console.log('Signaling channel status:', status);
        if (status === 'SUBSCRIBED') resolve();
      });
    });

    // Store signaling channel globally
    window._signalingChannel = signalingChannel;

    if (isInitiator) {
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
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    remoteLabel.textContent = 'Stranger';
    setStatus('Ready to match');
    btnStart.disabled = false;
    btnStop.disabled = true;
    btnNext.disabled = true;
    revealSection.style.display = 'none';
    chatSection.style.display = 'none';
    revealed = false;
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> <span>Reveal identity</span>';
    btnReveal.classList.remove('revealed');
    // Update call ended
    if (currentCallId) {
      await sb.from('active_calls').update({ ended_at: new Date().toISOString() }).eq('id', currentCallId);
      currentCallId = null;
    }
    partnerId = null;
  };

  const addMessage = (text, isMe) => {
    const el = document.createElement('div');
    el.className = 'vc-msg ' + (isMe ? 'me' : 'them');
    el.textContent = text;
    vcMessages.appendChild(el);
    vcMessages.scrollTop = vcMessages.scrollHeight;
  };

  // ---- Event listeners ----
  btnStart.addEventListener('click', findMatch);
  btnStop.addEventListener('click', () => endCall(true));
  btnNext.addEventListener('click', () => { endCall(true); setTimeout(findMatch, 500); });

  btnReveal.addEventListener('click', () => {
    if (revealed) { showToast('Already revealed'); return; }
    revealed = true;
    const name = (window.kismetUser?.user_metadata?.name) || 'Kismet User';
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

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (isSearching) sb.from('waiting_queue').delete().eq('user_id', userId);
    endCall(false);
    lobbyChannel.unsubscribe();
  });

  setStatus('Ready to match');
})();