/* Inbox / chat page logic */
(() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let friends = load('kismet.friends', []);
  let chats = load('kismet.chats', {});
  let active = null;

  const list = document.getElementById('inbox-list');
  const chatView = document.getElementById('chat-view');
  const msgs = document.getElementById('messages');

  const renderList = () => {
    const accepted = friends.filter(f => f.status !== 'rejected' && f.status !== 'pending');
    if (!accepted.length) { list.innerHTML = '<p style="color:var(--color-text-light,#b6b1c4)">No friends yet. Reveal your identity in a match to add friends.</p>'; return; }
    list.innerHTML = '';
    accepted.forEach(f => {
      const m = chats[f.id] || [];
      const last = m.length ? m[m.length-1].text : 'No messages yet';
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);cursor:pointer;';
      el.innerHTML = `<div><div style="font-weight:600;color:var(--color-text,#efe8d6)">${f.name}</div><div style="font-size:.75rem;color:var(--color-text-faint,#8e8aa2)">${last}</div></div><span style="color:var(--color-primary,#f59e0b);font-size:.8rem;">Open →</span>`;
      el.addEventListener('click', () => { active = f.id; showChat(f); });
      list.appendChild(el);
    });
  };

  const showChat = (f) => {
    list.style.display = 'none';
    chatView.style.display = 'block';
    document.getElementById('chat-name').textContent = f.name;
    renderMsgs();
  };

  const renderMsgs = () => {
    const m = chats[active] || [];
    msgs.innerHTML = '';
    m.forEach(msg => {
      const el = document.createElement('div');
      el.style.cssText = `max-width:80%;padding:.35rem .6rem;font-size:.85rem;line-height:1.4;${msg.me ? 'align-self:flex-end;background:var(--color-primary,#f59e0b);color:var(--color-on-primary,#0c101f)' : 'align-self:flex-start;background:var(--color-bg-container,#0c101f);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47)'}`;
      el.textContent = msg.text;
      msgs.appendChild(el);
    });
    msgs.scrollTop = msgs.scrollHeight;
  };

  const send = () => {
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text || !active) return;
    if (!chats[active]) chats[active] = [];
    chats[active].push({ text, me: true, t: Date.now() });
    save('kismet.chats', chats);
    input.value = '';
    renderMsgs();
  };

  document.getElementById('send-btn').addEventListener('click', send);
  document.getElementById('msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  document.getElementById('back-btn').addEventListener('click', () => {
    chatView.style.display = 'none';
    list.style.display = 'block';
    active = null;
    renderList();
  });

  renderList();
})();
EOF