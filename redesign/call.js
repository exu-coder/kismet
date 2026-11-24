/* Private call overlay — adapted from FF-PV-MASG/chat.html.
   Local demo/signaling-free call UI: rings, then connects. Audio/video uses
   the browser's own camera/mic for the local tile when permission is granted.
   No public/anonymous calling: inbox.js only passes revealed friends. */
(function () {
  const overlay = document.getElementById('call-overlay');
  if (!overlay) return;

  const identity = window.kismetIdentity || {
    avatar: () => document.createElement('span'),
    displayName: person => person?.name || 'Friend',
    initials: () => 'F'
  };
  const el = id => document.getElementById(id);
  const timerEl = el('call-timer');
  const stageEl = el('call-stage');
  const avatarEl = el('call-avatar');
  const nameEl = el('call-name');
  const statusEl = el('call-status');
  const gridEl = el('call-grid');
  const localVideo = el('call-video-me');
  const remoteVideo = el('call-video-peer');
  const peerAvatar = el('call-peer-avatar');
  const peerName = el('call-peer-name');
  const incomingEl = el('call-incoming');
  const liveEl = el('call-live');
  const muteBtn = el('call-mute');
  const camBtn = el('call-cam');
  const endBtn = el('call-end');
  const acceptBtn = el('call-accept');
  const rejectBtn = el('call-reject');

  let state = 'idle';
  let kind = 'audio';
  let peer = null;
  let startedAt = 0;
  let ticker = null;
  let localStream = null;
  let muted = false;
  let camOff = false;
  let onEnd = null;

  const fmt = ms => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
             : `${m}:${String(s).padStart(2, '0')}`;
  };

  const setAvatar = (target, size) => {
    if (target) target.replaceChildren(identity.avatar(peer, size));
  };

  const stopTimer = () => {
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
  };

  const stopMedia = () => {
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null;
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
  };

  const updateMuteUI = () => {
    if (!muteBtn) return;
    muteBtn.classList.toggle('kc-off', muted);
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  };

  const updateCamUI = () => {
    if (!camBtn) return;
    camBtn.classList.toggle('kc-off', camOff);
    camBtn.setAttribute('aria-pressed', String(camOff));
    camBtn.setAttribute('aria-label', camOff ? 'Turn camera on' : 'Turn camera off');
    camBtn.title = camOff ? 'Camera on' : 'Camera off';
    if (camBtn.hidden) return;
  };

  const setRinging = incoming => {
    state = incoming ? 'incoming' : 'ringing';
    overlay.hidden = false;
    if (stageEl) stageEl.style.display = 'flex';
    if (gridEl) gridEl.hidden = true;
    if (incomingEl) incomingEl.hidden = !incoming;
    if (liveEl) liveEl.hidden = true;
    if (camBtn) camBtn.hidden = kind !== 'video';
    if (timerEl) timerEl.textContent = 'Connecting…';
    if (statusEl) statusEl.textContent = incoming ? 'Incoming call — answer?' : 'Ringing…';
    const label = identity.displayName(peer || {});
    if (nameEl) nameEl.textContent = label;
    if (peerName) peerName.textContent = label;
    setAvatar(avatarEl, 96);
    setAvatar(peerAvatar, 82);
  };

  const setLive = () => {
    if (state !== 'ringing' && state !== 'incoming') return;
    state = 'live';
    if (statusEl) statusEl.textContent = 'Connected';
    if (incomingEl) incomingEl.hidden = true;
    if (liveEl) liveEl.hidden = false;
    if (camBtn) camBtn.hidden = kind !== 'video';
    if (kind === 'video') {
      if (stageEl) stageEl.style.display = 'none';
      if (gridEl) gridEl.hidden = false;
    } else {
      if (stageEl) stageEl.style.display = 'flex';
      if (gridEl) gridEl.hidden = true;
    }
    startedAt = Date.now();
    stopTimer();
    if (timerEl) timerEl.textContent = '0:00';
    ticker = setInterval(() => {
      if (timerEl) timerEl.textContent = fmt(Date.now() - startedAt);
    }, 500);
    updateMuteUI();
    updateCamUI();
  };

  const getLocalMedia = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    try {
      const constraints = kind === 'video'
        ? { audio: true, video: { facingMode: 'user' } }
        : { audio: true, video: false };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (localVideo) localVideo.srcObject = localStream;
      return true;
    } catch (error) {
      console.warn('Call media unavailable:', error);
      if (statusEl) statusEl.textContent = 'Camera/mic unavailable — connecting…';
      return false;
    }
  };

  const start = async (callKind, person, options = {}) => {
    if (state !== 'idle' || !person) return false;
    kind = callKind === 'video' ? 'video' : 'audio';
    peer = person;
    muted = false;
    camOff = false;
    setRinging(false);
    if (kind === 'video') await getLocalMedia();
    const delay = Number.isFinite(options.delay) ? options.delay : 2500;
    setTimeout(() => { if (state === 'ringing') setLive(); }, Math.max(0, delay));
    return true;
  };

  const incoming = (callKind, person) => {
    if (state !== 'idle' || !person) return false;
    kind = callKind === 'video' ? 'video' : 'audio';
    peer = person;
    muted = false;
    camOff = false;
    setRinging(true);
    return true;
  };

  const end = reason => {
    if (state === 'idle') return;
    const ended = { kind, reason: reason || 'ended', peer, durationMs: Date.now() - startedAt };
    stopTimer();
    stopMedia();
    overlay.hidden = true;
    state = 'idle';
    peer = null;
    startedAt = 0;
    muted = false;
    camOff = false;
    updateMuteUI();
    updateCamUI();
    if (typeof onEnd === 'function') onEnd(ended);
  };

  const toggleMute = () => {
    if (state !== 'live') return;
    muted = !muted;
    if (localStream) localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
    updateMuteUI();
  };

  const toggleCam = () => {
    if (state !== 'live' || kind !== 'video') return;
    camOff = !camOff;
    if (localStream) localStream.getVideoTracks().forEach(track => { track.enabled = !camOff; });
    if (gridEl) gridEl.classList.toggle('novid', camOff);
    updateCamUI();
  };

  const attachRemote = stream => {
    if (!remoteVideo) return;
    remoteVideo.srcObject = stream || null;
    remoteVideo.hidden = !stream;
    if (peerAvatar) peerAvatar.hidden = !!stream;
  };

  if (muteBtn) muteBtn.addEventListener('click', toggleMute);
  if (camBtn) camBtn.addEventListener('click', toggleCam);
  if (endBtn) endBtn.addEventListener('click', () => end('ended'));
  if (acceptBtn) acceptBtn.addEventListener('click', async () => {
    if (kind === 'video') await getLocalMedia();
    setLive();
  });
  if (rejectBtn) rejectBtn.addEventListener('click', () => end('rejected'));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || overlay.hidden) return;
    const profile = document.getElementById('profile-overlay');
    if (profile && !profile.hidden) return;
    end('closed');
  });

  window.kismetCalls = {
    start,
    incoming,
    end,
    attachRemote,
    isActive: () => state !== 'idle',
    state: () => state,
    setOnEnd: fn => { onEnd = typeof fn === 'function' ? fn : null; }
  };
})();
