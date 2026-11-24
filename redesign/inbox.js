/* Kismet chat screen — conversation list, profile tap-through and messenger. */
(async () => {
  const list = document.getElementById('inbox-list');
  const chatView = document.getElementById('chat-view');
  const messagesEl = document.getElementById('messages');
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const composeForm = document.getElementById('compose-form');
  const backBtn = document.getElementById('back-btn');
  const peerBtn = document.getElementById('peer-btn');
  const profileBtn = document.getElementById('profile-btn');
  const threadTitle = document.getElementById('thread-title');
  const jumpBtn = document.getElementById('jump-btn');
  const overlay = document.getElementById('profile-overlay');
  const profileAvatar = document.getElementById('profile-avatar');
  const profileName = document.getElementById('profile-name');
  const profileMeta = document.getElementById('profile-meta');
  const profileMessage = document.getElementById('profile-message');
  const profileClose = document.getElementById('profile-close');
  const profileCall = document.getElementById('profile-call');
  const callActions = document.getElementById('call-actions');
  const audioBtn = document.getElementById('audio-btn');
  const videoBtn = document.getElementById('video-btn');
  const calls = window.kismetCalls || {
    start: () => false, end: () => {}, isActive: () => false,
    setOnEnd: () => {}, state: () => 'idle'
  };
  if (!list || !chatView || !messagesEl || !input || !sendBtn || !composeForm ||
      !backBtn || !peerBtn || !profileBtn || !threadTitle || !jumpBtn ||
      !overlay || !profileAvatar || !profileName || !profileMeta ||
      !profileMessage || !profileClose) return;

  const notify = message => {
    if (typeof window.showToast === 'function') window.showToast(message);
    else console.warn(message);
  };
  const identity = window.kismetIdentity || {
    safePhotoUrl: () => '',
    displayName: person => person?.name || 'Anonymous',
    avatar: () => document.createElement('span'),
    timeLabel: () => ''
  };

  // Local visual test only: http://localhost:8080/inbox/?demo=1
  // Never active on a deployed hostname.
  const demo = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
    new URLSearchParams(location.search).has('demo');

  let sb = null;
  let userId = null;
  let friends = [];
  let profiles = new Map();
  let previews = new Map();
  let active = null;
  let activeMessages = [];
  let profileFriend = null;
  let loadingMessages = false;

  const DEMO_ME = '11111111-1111-4111-8111-111111111111';
  const DEMO_PEERS = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Amara', code: 'KS-7A3F92', country: 'Nigeria', photo: '',
      preview: 'That match was fun. Want to chat again?',
      messages: [
        { from: '22222222-2222-4222-8222-222222222222', text: 'Hey! That was a great match.', at: '2026-11-24T10:38:00Z' },
        { from: DEMO_ME, text: 'It really was. Your laugh made me miss the timer.', at: '2026-11-24T10:39:00Z' },
        { from: '22222222-2222-4222-8222-222222222222', text: 'That match was fun. Want to chat again?', at: '2026-11-24T10:42:00Z' }
      ]
    },
    {
      id: '33333333-3333-4333-8333-333333333343',
      name: 'Noah', code: 'KS-2C81B4', country: 'Canada', photo: '',
      preview: 'Send me the link when you have it.',
      messages: [
        { from: DEMO_ME, text: 'I found that page we were talking about.', at: '2026-11-23T18:10:00Z' },
        { from: '33333333-3333-4333-8333-333333333343', text: 'Send me the link when you have it.', at: '2026-11-23T18:12:00Z' }
      ]
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Demo Chat', code: 'KS-DEMO01', country: 'Demo', photo: '',
      preview: 'Try emoji or start a private call.',
      messages: [
        { from: '44444444-4444-4444-8444-444444444444', text: 'Welcome to the Kismet demo chat 😊', at: '2026-11-24T11:00:00Z' },
        { from: DEMO_ME, text: 'Tap the emoji button to add a reaction.', at: '2026-11-24T11:01:00Z' },
        { from: '44444444-4444-4444-8444-444444444444', text: 'You can also start a private audio or video call from the header or profile.', at: '2026-11-24T11:02:00Z' }
      ]
    }
  ];

  const isSafeUserId = value => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const friendUserId = friend => isSafeUserId(friend?.friend_id) ? friend.friend_id : null;
  const chunk = (items, size) => {
    const result = [];
    for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
    return result;
  };

  const mergeFriend = friend => {
    const id = friendUserId(friend) || friend?.user_id || '';
    const live = profiles.get(id) || {};
    return {
      user_id: id,
      name: live.name || friend.friend_name || 'Anonymous',
      friend_code: live.friend_code || friend.friend_code || '',
      photo_url: identity.safePhotoUrl(live.photo_url),
      country: live.country || ''
    };
  };

  const demoMessagesFor = friendId => {
    const peer = DEMO_PEERS.find(item => item.id === friendId);
    if (!peer) return [];
    return peer.messages.map(message => ({
      from_user_id: message.from,
      to_user_id: message.from === DEMO_ME ? friendId : DEMO_ME,
      content: message.text,
      created_at: message.at
    }));
  };

  const seedDemo = () => {
    userId = DEMO_ME;
    friends = DEMO_PEERS.map(peer => ({
      friend_id: peer.id,
      friend_name: peer.name,
      friend_code: peer.code,
      created_at: peer.messages[peer.messages.length - 1].at
    }));
    profiles = new Map(DEMO_PEERS.map(peer => [peer.id, {
      user_id: peer.id, name: peer.name, friend_code: peer.code,
      photo_url: peer.photo, country: peer.country
    }]));
    previews = new Map(DEMO_PEERS.map(peer => [peer.id, {
      content: peer.preview,
      created_at: peer.messages[peer.messages.length - 1].at,
      mine: false
    }]));
  };

  const loadProfiles = async () => {
    const ids = friends.map(friendUserId).filter(Boolean);
    const results = await Promise.all(chunk(ids, 20).map(async group => {
      const { data, error } = await sb.from('profiles')
        .select('user_id,name,friend_code,photo_url,country').in('user_id', group);
      if (error) { console.warn('Could not load friend profiles:', error); return []; }
      return data || [];
    }));
    profiles = new Map(results.flat().map(profile => [profile.user_id, profile]));
  };

  const loadPreviews = async () => {
    const ids = friends.map(friendUserId).filter(Boolean);
    const results = await Promise.all(chunk(ids, 20).map(async group => {
      const filter = group.flatMap(id => [
        `and(from_user_id.eq.${userId},to_user_id.eq.${id})`,
        `and(from_user_id.eq.${id},to_user_id.eq.${userId})`
      ]).join(',');
      const { data, error } = await sb.from('messages')
        .select('from_user_id,to_user_id,content,created_at')
        .or(filter).order('created_at', { ascending: false }).limit(500);
      if (error) { console.warn('Could not load conversation previews:', error); return []; }
      return data || [];
    }));

    const latest = new Map();
    results.flat().forEach(message => {
      const peerId = message.from_user_id === userId ? message.to_user_id : message.from_user_id;
      if (!ids.includes(peerId) || latest.has(peerId)) return;
      latest.set(peerId, {
        content: message.content || '',
        created_at: message.created_at,
        mine: message.from_user_id === userId
      });
    });
    previews = latest;
  };

  const loadFriends = async () => {
    const { data, error } = await sb.from('friends')
      .select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (error) {
      console.error('Could not load friends:', error);
      notify('Could not load your friends. Please try again.');
      return;
    }
    friends = data || [];
    await Promise.all([loadProfiles(), loadPreviews()]);
    renderList();
    openPendingChat();
  };

  const loadMessages = async () => {
    if (!active || !friendUserId(active) || loadingMessages || demo) return;
    loadingMessages = true;
    const friendId = friendUserId(active);
    const { data, error } = await sb.from('messages').select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    loadingMessages = false;
    if (error) {
      console.error('Could not load messages:', error);
      notify('Could not load messages. Please try again.');
      return;
    }
    if (active && friendUserId(active) === friendId) {
      activeMessages = data || [];
      renderMessages();
    }
  };

  const renderHeader = () => {
    if (!active) {
      backBtn.hidden = true;
      peerBtn.hidden = true;
      profileBtn.hidden = true;
      if (callActions) callActions.hidden = true;
      threadTitle.hidden = false;
      threadTitle.textContent = 'Messages';
      peerBtn.replaceChildren();
      return;
    }
    const person = mergeFriend(active);
    backBtn.hidden = false;
    profileBtn.hidden = false;
    peerBtn.hidden = false;
    if (callActions) callActions.hidden = false;
    threadTitle.hidden = true;

    peerBtn.replaceChildren();
    peerBtn.appendChild(identity.avatar(person, 30));
    const text = document.createElement('span');
    text.className = 'cs-identity__text';
    const name = document.createElement('span');
    name.className = 'cs-identity__name';
    name.textContent = identity.displayName(person);
    const meta = document.createElement('span');
    meta.className = 'cs-identity__meta';
    meta.textContent = [person.friend_code, person.country].filter(Boolean).join(' · ') || 'Revealed friend';
    text.append(name, meta);
    peerBtn.appendChild(text);
  };

  const renderList = () => {
    list.replaceChildren();
    if (!friends.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No friends yet. Reveal your identity in a match to add friends.';
      list.appendChild(empty);
      return;
    }

    const sorted = [...friends].sort((a, b) => {
      const aTime = previews.get(friendUserId(a))?.created_at || a.created_at || '';
      const bTime = previews.get(friendUserId(b))?.created_at || b.created_at || '';
      return String(bTime).localeCompare(String(aTime));
    });

    sorted.forEach(friend => {
      const friendId = friendUserId(friend);
      const person = mergeFriend(friend);
      const preview = previews.get(friendId);
      const row = document.createElement('div');
      row.className = 'cs-thread';

      const personBtn = document.createElement('button');
      personBtn.type = 'button';
      personBtn.className = 'cs-thread__person';
      personBtn.setAttribute('aria-label', 'View ' + identity.displayName(person) + "'s profile");
      personBtn.appendChild(identity.avatar(person, 40));
      const personBody = document.createElement('span');
      personBody.className = 'cs-thread__body';
      const name = document.createElement('span');
      name.className = 'cs-thread__name';
      name.textContent = identity.displayName(person);
      const code = document.createElement('span');
      code.className = 'cs-thread__code';
      code.textContent = person.friend_code || 'Revealed friend';
      personBody.append(name, code);
      personBtn.appendChild(personBody);

      const chatBtn = document.createElement('button');
      chatBtn.type = 'button';
      chatBtn.className = 'cs-thread__chat';
      chatBtn.disabled = !friendId;
      chatBtn.setAttribute('aria-label', 'Open chat with ' + identity.displayName(person));
      const side = document.createElement('span');
      side.className = 'cs-thread__side';
      const previewText = document.createElement('span');
      previewText.className = 'cs-thread__preview';
      previewText.textContent = preview
        ? (preview.mine ? 'You: ' : '') + preview.content
        : 'No messages yet — say hello.';
      const time = document.createElement('span');
      time.className = 'cs-thread__time';
      time.textContent = identity.timeLabel(preview?.created_at || friend.created_at);
      side.append(previewText, time);
      chatBtn.appendChild(side);
      const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chev.setAttribute('viewBox', '0 0 24 24');
      chev.setAttribute('fill', 'none');
      chev.setAttribute('stroke', 'currentColor');
      chev.setAttribute('stroke-width', '2');
      chev.setAttribute('stroke-linecap', 'round');
      chev.setAttribute('stroke-linejoin', 'round');
      chev.setAttribute('aria-hidden', 'true');
      chev.classList.add('cs-thread__chev');
      const chevPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chevPath.setAttribute('d', 'm9 18 6-6-6-6');
      chev.appendChild(chevPath);
      chatBtn.appendChild(chev);

      personBtn.addEventListener('click', () => openProfile(friend));
      if (friendId) chatBtn.addEventListener('click', () => showChat(friend));
      row.append(personBtn, chatBtn);
      list.appendChild(row);
    });
  };

  const renderMessages = () => {
    messagesEl.replaceChildren();
    if (!activeMessages.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No messages yet. Start the conversation.';
      messagesEl.appendChild(empty);
      return;
    }
    const person = mergeFriend(active);
    let lastDay = '';
    activeMessages.forEach(message => {
      if (message.system) {
        const system = document.createElement('div');
        system.className = 'cs-system';
        system.textContent = message.content || '';
        messagesEl.appendChild(system);
        return;
      }
      const date = new Date(message.created_at);
      const dayKey = Number.isNaN(date.getTime()) ? '' : date.toDateString();
      if (dayKey && dayKey !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'cs-day';
        try { divider.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date); }
        catch (_) { divider.textContent = date.toLocaleDateString(); }
        messagesEl.appendChild(divider);
        lastDay = dayKey;
      }

      const mine = message.from_user_id === userId;
      const row = document.createElement('div');
      row.className = 'cs-bubble-row ' + (mine ? 'mine' : 'them');
      if (mine) {
        const spacer = document.createElement('span');
        spacer.className = 'cs-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        row.appendChild(spacer);
      } else {
        const avatarBtn = document.createElement('button');
        avatarBtn.type = 'button';
        avatarBtn.className = 'cs-msg-avatar';
        avatarBtn.setAttribute('aria-label', 'View ' + identity.displayName(person) + "'s profile");
        avatarBtn.appendChild(identity.avatar(person, 26));
        avatarBtn.addEventListener('click', () => openProfile(active));
        row.appendChild(avatarBtn);
      }

      const bubble = document.createElement('div');
      bubble.className = 'cs-bubble ' + (mine ? 'mine' : 'them');
      const text = document.createElement('span');
      text.className = 'cs-bubble__text';
      text.textContent = message.content || '';
      const time = document.createElement('time');
      time.className = 'cs-bubble__time';
      time.dateTime = message.created_at || '';
      time.textContent = identity.timeLabel(message.created_at);
      bubble.append(text, time);
      row.appendChild(bubble);
      messagesEl.appendChild(row);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpBtn.hidden = true;
  };

  const openProfile = friend => {
    if (!friend) return;
    profileFriend = friend;
    const person = mergeFriend(friend);
    profileAvatar.replaceChildren(identity.avatar(person, 64));
    profileName.textContent = identity.displayName(person);
    profileMeta.textContent = [person.friend_code, person.country].filter(Boolean).join(' · ') || 'Revealed friend';
    overlay.hidden = false;
    profileMessage.focus();
  };

  const closeProfile = () => {
    profileFriend = null;
    overlay.hidden = true;
  };

  const showChat = friend => {
    if (!friendUserId(friend)) return;
    active = friend;
    activeMessages = demo ? demoMessagesFor(friendUserId(friend)) : [];
    list.hidden = true;
    chatView.hidden = false;
    renderHeader();
    renderMessages();
    loadMessages();
    input.focus();
  };

  const showThreads = () => {
    closeProfile();
    if (calls.isActive()) calls.end('closed');
    if (window.kismetEmoji && window.kismetEmoji.isOpen()) window.kismetEmoji.close();
    active = null;
    activeMessages = [];
    chatView.hidden = true;
    list.hidden = false;
    jumpBtn.hidden = true;
    renderHeader();
    renderList();
  };

  const openPendingChat = () => {
    let pendingId = null;
    try {
      pendingId = sessionStorage.getItem('kismet.openChat');
      sessionStorage.removeItem('kismet.openChat');
    } catch (_) {}
    if (!pendingId) return;
    const friend = friends.find(item => friendUserId(item) === pendingId);
    if (friend) showChat(friend);
  };

  const startCall = (kind, friend) => {
    if (!friend) return;
    closeProfile();
    calls.start(kind, mergeFriend(friend));
  };

  const send = async () => {
    const content = input.value.trim();
    if (window.kismetEmoji && window.kismetEmoji.isOpen()) window.kismetEmoji.close();
    const recipientId = friendUserId(active);
    if (!content || content.length > 4000 || !recipientId || sendBtn.disabled) {
      if (content.length > 4000) notify('Messages must be 4,000 characters or fewer.');
      return;
    }
    sendBtn.disabled = true;
    if (demo) {
      const at = new Date().toISOString();
      activeMessages.push({ from_user_id: userId, to_user_id: recipientId, content, created_at: at });
      previews.set(recipientId, { content, created_at: at, mine: true });
      input.value = '';
      renderMessages();
      renderList();
      sendBtn.disabled = false;
      input.focus();
      return;
    }
    const { error } = await sb.from('messages').insert({
      from_user_id: userId, to_user_id: recipientId, content
    });
    sendBtn.disabled = false;
    if (error) {
      console.error('Could not send message:', error);
      notify('Message could not be sent. Please try again.');
      return;
    }
    input.value = '';
    await Promise.all([loadMessages(), loadPreviews().then(renderList)]);
    input.focus();
  };

  backBtn.addEventListener('click', showThreads);
  peerBtn.addEventListener('click', () => openProfile(active));
  profileBtn.addEventListener('click', () => openProfile(active));
  profileClose.addEventListener('click', closeProfile);
  profileMessage.addEventListener('click', () => {
    const friend = profileFriend;
    closeProfile();
    if (friend) showChat(friend);
  });
  if (audioBtn) audioBtn.addEventListener('click', () => startCall('audio', active));
  if (videoBtn) videoBtn.addEventListener('click', () => startCall('video', active));
  if (profileCall) profileCall.addEventListener('click', () => startCall('video', profileFriend));
  calls.setOnEnd(({ kind, reason }) => {
    if (!active) return;
    const label = reason === 'ended' ? 'ended' : reason;
    activeMessages.push({
      from_user_id: '', to_user_id: '',
      content: '[' + kind + ' call ' + label + ']',
      created_at: new Date().toISOString(),
      system: true
    });
    renderMessages();
  });
  overlay.addEventListener('click', event => { if (event.target === overlay) closeProfile(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !overlay.hidden) closeProfile();
  });
  composeForm.addEventListener('submit', event => { event.preventDefault(); send(); });
  messagesEl.addEventListener('scroll', () => {
    jumpBtn.hidden = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  });
  jumpBtn.addEventListener('click', () => { messagesEl.scrollTop = messagesEl.scrollHeight; jumpBtn.hidden = true; });

  renderHeader();
  if (demo) {
    seedDemo();
    renderList();
    return;
  }

  try {
    sb = await window.kismetReady;
  } catch (error) {
    list.textContent = 'Chat is temporarily unavailable. Please reload the page.';
    list.className = 'cs-empty';
    console.error(error);
    return;
  }
  userId = window.kismetUser?.id;
  if (!isSafeUserId(userId)) {
    list.textContent = 'Your session ID is invalid. Please reload the page.';
    list.className = 'cs-empty';
    return;
  }

  await loadFriends();
  sb.channel('inbox_' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
      if (active) loadMessages();
      loadPreviews().then(renderList);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, loadFriends)
    .subscribe();
})();
