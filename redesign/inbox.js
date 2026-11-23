/* Inbox / chat page logic — Supabase-backed */
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
  if (!window.supabase) return;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const userId = localStorage.getItem('kismet.anonId') || '';

  const list = document.getElementById('inbox-list');
  const chatView = document.getElementById('chat-view');
  const msgs = document.getElementById('messages');
  if (!list || !chatView || !msgs) return;

  let friends = [];
  let active = null;
  let activeMessages = [];

  const renderList = () => {
    if (!friends.length) {
      list.textContent = 'No friends yet. Reveal your identity in a match to add friends.';
      list.style.color = 'var(--color-text-light,#b6b1c4)';
      return;
    }
    list.innerHTML = '';
    friends.forEach(f => {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);cursor:pointer;';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:600;color:var(--color-text,#efe8d6)';
      name.textContent = f.friend_name || 'Anonymous';
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:.75rem;color:var(--color-text-faint,#8e8aa2)';
      sub.textContent = f.friend_code || '';
      info.append(name, sub);

      const open = document.createElement('span');
      open.style.cssText = 'color:var(--color-primary,#f59e0b);font-size:.8rem;';
      open.textContent = 'Open →';

      el.append(info, open);
      el.addEventListener('click', () => showChat(f));
      list.appendChild(el);
    });
  };

  const loadFriends = async () => {
    if (!userId) { friends = []; renderList(); return; }
    const { data, error } = await sb
      .from('friends')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) { console.error(error); return; }
    friends = data || [];
    renderList();
  };

  const loadMessages = async () => {
    if (!active || !userId) { activeMessages = []; renderMsgs(); return; }
    const { data, error } = await sb
      .from('messages')
      .select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${active.id}),and(from_user_id.eq.${active.id},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    if (error) { console.error(error); return; }
    activeMessages = data || [];
    renderMsgs();
  };

  const renderMsgs = () => {
    msgs.innerHTML = '';
    activeMessages.forEach(msg => {
      const el = document.createElement('div');
      const mine = msg.from_user_id === userId;
      el.style.cssText = 'max-width:80%;padding:.35rem .6rem;font-size:.85rem;line-height:1.4;' + (mine
        ? 'align-self:flex-end;background:var(--color-primary,#f59e0b);color:var(--color-on-primary,#0c101f)'
        : 'align-self:flex-start;background:var(--color-bg-container,#0c101f);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47)');
      el.textContent = msg.content;
      msgs.appendChild(el);
    });
    msgs.scrollTop = msgs.scrollHeight;
  };

  const showChat = (f) => {
    active = f;
    list.style.display = 'none';
    chatView.style.display = 'block';
    document.getElementById('chat-name').textContent = f.friend_name || 'Anonymous';
    loadMessages();
  };

  const send = async () => {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text || !active || !userId) return;
    input.value = '';
    const { error } = await sb.from('messages').insert({
      from_user_id: userId,
      to_user_id: active.id,
      content: text,
    });
    if (error) { console.error(error); return; }
    loadMessages();
  };

  document.getElementById('send-btn').addEventListener('click', send);
  document.getElementById('msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  document.getElementById('back-btn').addEventListener('click', () => {
    chatView.style.display = 'none';
    list.style.display = 'block';
    active = null;
    renderList();
  });

  await loadFriends();

  sb.channel('inbox_' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => { if (active) loadMessages(); })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friends' }, () => loadFriends())
    .subscribe();
})();
