/* Inbox / chat page logic — uses the shared Supabase client. */
(async () => {
  const list = document.getElementById('inbox-list');
  const chatView = document.getElementById('chat-view');
  const msgs = document.getElementById('messages');
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const backBtn = document.getElementById('back-btn');
  if (!list || !chatView || !msgs || !input || !sendBtn || !backBtn) return;

  const notify = message => {
    if (typeof window.showToast === 'function') window.showToast(message);
    else console.warn(message);
  };

  let sb;
  try {
    sb = await window.kismetReady;
  } catch (error) {
    list.textContent = 'Chat is temporarily unavailable. Please reload the page.';
    console.error(error);
    return;
  }

  const userId = window.kismetIdentity?.getAnonId() || localStorage.getItem('kismet.anonId');
  let friends = [];
  let active = null;
  let activeMessages = [];
  let loadingMessages = false;

  const friendUserId = friend => friend?.friend_id || null;

  const renderList = () => {
    list.replaceChildren();
    if (!friends.length) {
      list.textContent = 'No friends yet. Reveal your identity in a match to add friends.';
      list.style.color = 'var(--color-text-light,#b6b1c4)';
      return;
    }
    friends.forEach(friend => {
      const friendId = friendUserId(friend);
      const el = document.createElement('button');
      el.type = 'button';
      el.disabled = !friendId;
      el.style.cssText = 'width:100%;display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;text-align:left;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);color:inherit;cursor:pointer;';
      const info = document.createElement('span');
      const name = document.createElement('span');
      name.style.cssText = 'display:block;font-weight:600;color:var(--color-text,#efe8d6)';
      name.textContent = friend.friend_name || 'Anonymous';
      const code = document.createElement('span');
      code.style.cssText = 'display:block;font-size:.75rem;color:var(--color-text-faint,#8e8aa2)';
      code.textContent = friend.friend_code || '';
      info.append(name, code);
      const open = document.createElement('span');
      open.style.cssText = 'color:var(--color-primary,#f59e0b);font-size:.8rem;';
      open.textContent = friendId ? 'Open →' : 'Unavailable';
      el.append(info, open);
      if (friendId) el.addEventListener('click', () => showChat(friend));
      list.appendChild(el);
    });
  };

  const renderMessages = () => {
    msgs.replaceChildren();
    activeMessages.forEach(message => {
      const el = document.createElement('div');
      const mine = message.from_user_id === userId;
      el.style.cssText = 'max-width:80%;padding:.35rem .6rem;font-size:.85rem;line-height:1.4;' + (mine
        ? 'align-self:flex-end;background:var(--color-primary,#f59e0b);color:var(--color-on-primary,#0c101f)'
        : 'align-self:flex-start;background:var(--color-bg-container,#0c101f);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47)');
      el.textContent = message.content || '';
      msgs.appendChild(el);
    });
    msgs.scrollTop = msgs.scrollHeight;
  };

  const loadFriends = async () => {
    const { data, error } = await sb.from('friends').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (error) {
      console.error('Could not load friends:', error);
      notify('Could not load your friends. Please try again.');
      return;
    }
    friends = data || [];
    renderList();
  };

  const loadMessages = async () => {
    if (!active || !friendUserId(active) || loadingMessages) return;
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

  const showChat = friend => {
    if (!friendUserId(friend)) return;
    active = friend;
    list.style.display = 'none';
    chatView.style.display = 'block';
    document.getElementById('chat-name').textContent = friend.friend_name || 'Anonymous';
    loadMessages();
  };

  const send = async () => {
    const content = input.value.trim();
    const recipientId = friendUserId(active);
    if (!content || !recipientId || !userId || sendBtn.disabled) return;
    sendBtn.disabled = true;
    const { error } = await sb.from('messages').insert({
      from_user_id: userId,
      to_user_id: recipientId,
      content,
    });
    sendBtn.disabled = false;
    if (error) {
      console.error('Could not send message:', error);
      notify('Message could not be sent. Please try again.');
      return;
    }
    input.value = '';
    await loadMessages();
  };

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') send(); });
  backBtn.addEventListener('click', () => {
    chatView.style.display = 'none';
    list.style.display = 'block';
    active = null;
    activeMessages = [];
    renderList();
  });

  await loadFriends();
  sb.channel('inbox_' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => { if (active) loadMessages(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, loadFriends)
    .subscribe();
})();