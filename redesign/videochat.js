/* Kismet video chat — WebRTC + Supabase Realtime signaling
   Hardened: track-state reset, awaited hangup + presence fallback,
   async cancel guards, single-offer handshake, mobile camera recovery. */
(async () => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

  // Use the shared client after its trusted anonymous session is ready.
  let sb;
  try { sb = await window.kismetReady; }
  catch (error) {
    console.error('Kismet secure session failed:', error);
    const status = document.getElementById('status-text');
    if (status) status.textContent = error.message || 'Secure session unavailable';
    return;
  }
  const userId = window.kismetUser?.id;
  if (!userId) return;
  const idKit = window.kismetIdentity || {
    safePhotoUrl: () => '',
    displayName: person => person?.name || 'Anonymous',
    avatar: () => document.createElement('span')
  };

  // ---- State ----
  let localStream = null;
  let mediaRequestGeneration = 0;
  let peerConnection = null;
  let signalingChannel = null;
  let currentCallId = null;
  let partnerId = null;
  let partnerName = 'Stranger';
  let isSearching = false;
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
  // A leave request fired by endCall() must land before the next join(), or the
  // late leave can delete the fresh queue row / clear a brand-new match.
  let pendingLeave = Promise.resolve();

  const MEDIA_LEAVE_TIMEOUT = 3000;
  const waitForLeave = (promise) => Promise.race([
    promise.catch(() => {}),
    new Promise(resolve => setTimeout(resolve, MEDIA_LEAVE_TIMEOUT)),
  ]);

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
  const lobbyChannel = sb.channel('lobby', { config: { private: true, presence: { key: userId } } });
  lobbyChannel.on('presence', { event: 'sync' }, () => {
    if (onlineCount) onlineCount.textContent = Object.keys(lobbyChannel.presenceState()).length;
  });
  lobbyChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await lobbyChannel.track({ online_at: new Date().toISOString() });
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

    // Serialize with the previous call's leave so a late leave cannot delete
    // the queue row this search is about to create.
    await waitForLeave(pendingLeave);
    if (!isSearching) return;

    setStatus('Searching for a stranger...');

    const poll = async () => {
      if (!isSearching) return;
      try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session?.access_token) throw new Error('Secure session is not available yet');
        const res = await fetch(SUPABASE_URL + '/functions/v1/matchmake', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + session.access_token,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ action: 'join' }),
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
    let timer;
    try {
      await Promise.race([
        chan.send({ type: 'broadcast', event: 'hangup', payload: { from: userId } }),
        new Promise(resolve => { timer = setTimeout(resolve, 1200); }),
      ]);
    } catch (e) {
      console.warn('hangup send failed', e);
    } finally {
      clearTimeout(timer);
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
          endCall(true);
          findMatch();
        }, 1200);
      }
    };

    const chan = sb.channel('signal_' + currentCallId, {
      config: { private: true, broadcast: { self: false }, presence: { key: userId } }
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
      const code = String(payload.code || '').slice(0, 24);
      const photo = idKit.safePhotoUrl(payload.photo_url);
      remoteLabel.textContent = name;
      showToast(name + ' revealed their identity!');
      showRevealedIdentity(name, code, photo);
      showFriendRequestButton(name, payload.from, code, photo);
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
        endCall(true);
        findMatch();
      }
    }, 15000);
  };

  const leaveQueue = async (keepalive = false, callId = null) => {
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session?.access_token) return;
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session.access_token,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ action: 'leave', callId }),
      };
      if (keepalive) init.keepalive = true;
      return await fetch(SUPABASE_URL + '/functions/v1/matchmake', init);
    } catch (error) { console.warn('Could not leave matchmaking queue:', error); }
  };

  const endCall = (notify = true) => {
    callGeneration++;
    mediaRequestGeneration++; // invalidate any camera permission request still in flight
    callActive = false;

    // Capture the call this teardown belongs to before clearing it. The leave
    // is scoped to that call, so it can never delete or unmatch a newer search.
    const callIdToLeave = currentCallId;
    currentCallId = null;

    if (connectionTimeout) { clearTimeout(connectionTimeout); connectionTimeout = null; }
    if (peerGoneTimeout) { clearTimeout(peerGoneTimeout); peerGoneTimeout = null; }
    if (readyInterval) { clearInterval(readyInterval); readyInterval = null; }
    offerSent = false;

    // All state/UI teardown is synchronous. The hangup is fire-and-forget so a
    // slow mobile network can't delay a following findMatch() — otherwise the
    // tail of this function would reset isSearching after the new search started.
    const chanToClose = signalingChannel;
    signalingChannel = null;

    // Release camera/mic as soon as the call ends (PR #2), but keep teardown
    // synchronous so a following findMatch() cannot be raced by this function.
    if (localStream) {
      localStream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
      localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    if (pollTimeout) { clearTimeout(pollTimeout); pollTimeout = null; }
    pendingLeave = leaveQueue(false, callIdToLeave);

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
    btnStop.textContent = 'Stop';
    btnNext.disabled = true;
    btnMute.disabled = true;
    btnCam.disabled = true;
    revealSection.style.display = 'none';
    chatSection.style.display = 'none';
    const frBtn = document.getElementById('friend-request-btn');
    if (frBtn) frBtn.remove();
    const revealCard = document.getElementById('revealed-identity');
    if (revealCard) revealCard.remove();
    revealed = false;
    btnReveal.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> <span>Reveal identity</span>';
    btnReveal.classList.remove('revealed');
    revealStatus.textContent = '';
    vcMessages.replaceChildren();
    vcMsgInput.value = '';
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

  // Save the local profile without ever replacing a friend code already stored
  // in the account. A different device must not silently rotate the code that
  // existing friends and reveals already reference.
  const syncProfile = async () => {
    let profile = {};
    try { profile = JSON.parse(localStorage.getItem('kismet.profile') || '{}'); } catch (_) {}
    const newCode = () => {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      return 'KS-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    };
    const fallbackCode = profile.code || localStorage.getItem('kismet.mycode') || newCode();
    const { data: existing, error: readError } = await sb.from('profiles')
      .select('name,friend_code,photo_url').eq('user_id', userId).maybeSingle();
    if (readError) console.warn('Could not read the saved profile:', readError);
    const name = profile.name || existing?.name || 'Anonymous';
    const code = existing?.friend_code || fallbackCode;
    const photo = idKit.safePhotoUrl(profile.photo) || idKit.safePhotoUrl(existing?.photo_url) || null;
    const { error } = await sb.from('profiles').upsert({
      user_id: userId,
      name,
      friend_code: code,
      photo_url: photo,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) throw error;
    try {
      localStorage.setItem('kismet.profile', JSON.stringify({ ...profile, name, code, photo }));
      localStorage.setItem('kismet.mycode', code);
    } catch (_) {}
    return { name, code, photo };
  };

  // Realtime payloads stay small; the full saved photo is loaded from profiles
  // on the requests/inbox pages, where RLS permits it for revealed friends.
  const broadcastPhoto = (photo) => {
    const safe = idKit.safePhotoUrl(photo);
    return safe && safe.length <= 120000 ? safe : '';
  };

  const showRevealedIdentity = (name, code, photo) => {
    let card = document.getElementById('revealed-identity');
    if (card) card.remove();
    card = document.createElement('div');
    card.id = 'revealed-identity';
    card.className = 'km-reveal-card';
    card.appendChild(idKit.avatar({ name, photo_url: photo }, 48));
    const text = document.createElement('div');
    text.className = 'km-reveal-card__text';
    const label = document.createElement('span');
    label.className = 'km-reveal-card__name';
    label.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'km-reveal-card__meta';
    meta.textContent = code || 'Revealed in this call';
    text.append(label, meta);
    card.appendChild(text);
    revealSection.insertBefore(card, btnReveal);
  };

  const showFriendRequestButton = (name, fromId, fromCode, photo) => {
    let btn = document.getElementById('friend-request-btn');
    if (btn) btn.remove();

    btn = document.createElement('button');
    btn.id = 'friend-request-btn';
    btn.className = 'vc-btn primary';
    btn.style.marginTop = '.5rem';
    btn.textContent = 'Send friend request to ' + name;

    btn.addEventListener('click', async () => {
      let identity;
      try {
        identity = await syncProfile();
      } catch (profileError) {
        console.error('Could not sync profile before friend request:', profileError);
        showToast('Could not save your profile. Try again.');
        return;
      }

      const { error } = await sb.rpc('kismet_send_friend_request', { p_to_user_id: fromId });

      if (error) {
        console.error(error);
        showToast('Could not send request');
        return;
      }
      if (signalingChannel) {
        signalingChannel.send({
          type: 'broadcast',
          event: 'friend-request',
          payload: { from: userId, name: identity.name, code: identity.code, photo_url: broadcastPhoto(identity.photo) },
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
    let identity;
    try {
      identity = await syncProfile();
    } catch (profileError) {
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
        payload: { name: identity.name, from: userId, code: identity.code, photo_url: broadcastPhoto(identity.photo) },
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
    endCall(true);
    findMatch();
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
    leaveQueue(true, currentCallId);
    currentCallId = null;
    lobbyChannel.unsubscribe();
  };
  window.addEventListener('pagehide', handlePageExit);
  window.addEventListener('beforeunload', handlePageExit);
  // A bfcache restore resurrects the stopped camera/dead presence with a stale UI.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
  });

  setStatus('Ready to match');
})();
