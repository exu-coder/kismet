/* Kismet app shell — anonymous chat, friend requests, inbox, profile.
   Client-side demo (localStorage). Real cross-user sync needs a backend. */
(() => {
  const STORE = {
    profile: 'kismet.profile',
    friends: 'kismet.friends',
    requests: 'kismet.requests',
    chats: 'kismet.chats',
    reveal: 'kismet.reveal',
    mycode: 'kismet.mycode',
  };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (error) { console.error('Could not save Kismet widget data:', error); return false; }
  };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  // ---- state ----
  let profile = load(STORE.profile, { name: 'Anonymous', code: null });
  let friends = load(STORE.friends, []);
  let requests = load(STORE.requests, []);
  let chats = load(STORE.chats, {});
  let reveal = localStorage.getItem(STORE.reveal) === '1';
  if (!profile.code) { profile.code = 'KS-' + Math.random().toString(36).slice(2,6).toUpperCase(); save(STORE.profile, profile); }
  if (!localStorage.getItem(STORE.mycode)) localStorage.setItem(STORE.mycode, profile.code);

  let activeTab = 'match';
  let activeChat = null;
  let panelOpen = false;

  // ---- DOM ----
  const host = document.createElement('div');
  host.className = 'kismet-app';
  host.innerHTML = `
    <nav class="ka-nav">
      <button class="ka-tab active" data-tab="match"><span class="ka-ico">MATCH</span><span class="ka-lbl">Match</span></button>
      <button class="ka-tab" data-tab="requests"><span class="ka-ico">REQ</span><span class="ka-lbl">Requests</span><span class="ka-badge" hidden>0</span></button>
      <button class="ka-tab" data-tab="chat"><span class="ka-ico">CHAT</span><span class="ka-lbl">Chat</span><span class="ka-badge" hidden>0</span></button>
      <button class="ka-tab" data-tab="profile"><span class="ka-ico">ME</span><span class="ka-lbl">Profile</span></button>
    </nav>
    <div class="ka-panel" hidden>
      <div class="ka-head"><span class="ka-title"></span><button class="ka-close">×</button></div>
      <div class="ka-body"></div>
    </div>
  `;
  document.body.appendChild(host);

  // ---- styles ----
  const st = document.createElement('style');
  st.textContent = `
    .kismet-app{position:fixed;bottom:0;left:0;right:0;z-index:9998;font-family:var(--font-body,serif)}
    .ka-nav{display:flex;justify-content:space-around;align-items:center;padding:.4rem .5rem .5rem;background:var(--color-bg-raised,#151b30);border-top:1px solid var(--color-border,#232b47);backdrop-filter:blur(8px)}
    .ka-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:.15rem;padding:.35rem .25rem;background:none;border:none;color:var(--color-text-light,#b6b1c4);cursor:pointer;font:inherit;font-size:.65rem;position:relative}
    .ka-tab.active{color:var(--color-primary,#f59e0b)}
    .ka-ico{font-size:.7rem;font-weight:700;letter-spacing:.05em}
    .ka-lbl{font-size:.62rem}
    .ka-badge{position:absolute;top:.15rem;right:calc(50% - 1.1rem);min-width:.9rem;height:.9rem;padding:0 .2rem;border-radius:999px;background:var(--color-danger,#f5585f);color:#fff;font-size:.55rem;font-weight:700;display:grid;place-items:center}
    .ka-panel{position:fixed;bottom:4.2rem;left:.75rem;right:.75rem;max-height:62vh;background:var(--color-bg-raised,#151b30);border:1px solid var(--color-border,#232b47);clip-path:polygon(0 6px,3px 6px,3px 3px,6px 3px,6px 0,calc(100% - 6px) 0,calc(100% - 6px) 3px,calc(100% - 3px) 3px,calc(100% - 3px) 6px,100% 6px,100% calc(100% - 6px),calc(100% - 3px) calc(100% - 6px),calc(100% - 3px) calc(100% - 3px),calc(100% - 6px) calc(100% - 3px),calc(100% - 6px) 100%,6px 100%,6px calc(100% - 3px),3px calc(100% - 3px),3px calc(100% - 6px),0 calc(100% - 6px));filter:drop-shadow(5px 5px 0 #00000073);overflow:hidden;display:flex;flex-direction:column}
    .ka-head{display:flex;justify-content:space-between;align-items:center;padding:.6rem .9rem;border-bottom:1px solid var(--color-border,#232b47)}
    .ka-title{font-weight:700;font-size:.95rem;color:var(--color-text,#efe8d6)}
    .ka-close{background:none;border:none;color:var(--color-text-light,#b6b1c4);font-size:1.2rem;cursor:pointer}
    .ka-body{flex:1;overflow-y:auto;padding:.75rem .9rem;display:flex;flex-direction:column;gap:.5rem}
    .ka-card{padding:.6rem .7rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47)}
    .ka-row{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.5rem .6rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47)}
    .ka-name{font-weight:600;font-size:.9rem;color:var(--color-text,#efe8d6)}
    .ka-sub{font-size:.72rem;color:var(--color-text-faint,#8e8aa2)}
    .ka-btn{padding:.35rem .6rem;background:var(--gradient-brand,#f59e0b);color:var(--color-on-primary,#0c101f);border:none;font:inherit;font-size:.75rem;font-weight:700;cursor:pointer;clip-path:polygon(0 3px,2px 3px,2px 1px,3px 1px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 1px,calc(100% - 2px) 1px,calc(100% - 2px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 2px) calc(100% - 3px),calc(100% - 2px) calc(100% - 1px),calc(100% - 3px) calc(100% - 1px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 1px),2px calc(100% - 1px),2px calc(100% - 3px),0 calc(100% - 3px))}
    .ka-btn.ghost{background:var(--color-bg-container,#0c101f);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47)}
    .ka-btn.danger{background:var(--color-danger,#f5585f);color:#fff}
    .ka-input{width:100%;padding:.4rem .6rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);color:var(--color-text,#efe8d6);font:inherit;font-size:.85rem;box-sizing:border-box}
    .ka-msgs{flex:1;min-height:10rem;max-height:16rem;overflow-y:auto;display:flex;flex-direction:column;gap:.35rem;padding:.5rem 0}
    .ka-msg{max-width:80%;padding:.35rem .6rem;font-size:.85rem;line-height:1.4}
    .ka-msg.me{align-self:flex-end;background:var(--color-primary,#f59e0b);color:var(--color-on-primary,#0c101f)}
    .ka-msg.them{align-self:flex-start;background:var(--color-bg-container,#0c101f);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47)}
    .ka-compose{display:flex;gap:.4rem;margin-top:.4rem}
    .ka-empty{font-size:.82rem;color:var(--color-text-light,#b6b1c4);text-align:center;padding:1rem 0}
    .ka-profile-row{display:flex;justify-content:space-between;align-items:center;padding:.4rem 0;border-bottom:1px solid var(--color-border,#232b47)}
    .ka-profile-row:last-child{border:none}
    .ka-profile-label{font-size:.8rem;color:var(--color-text-light,#b6b1c4)}
    .ka-profile-val{font-size:.85rem;color:var(--color-text,#efe8d6);font-weight:600}
    .ka-code{font-family:var(--font-mono,monospace);font-size:.9rem;color:var(--color-primary,#f59e0b);padding:.4rem;background:var(--color-bg-container,#0c101f);border:1px dashed var(--color-primary,#f59e0b);text-align:center;margin:.5rem 0;word-break:break-all}
    .ka-reveal-toggle{display:flex;align-items:center;gap:.6rem;padding:.6rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);cursor:pointer;margin:.5rem 0}
    .ka-reveal-toggle input{width:1.1rem;height:1.1rem;accent-color:var(--color-primary,#f59e0b)}
    .ka-status{font-size:.8rem;padding:.4rem .6rem;background:var(--color-bg-container,#0c101f);border-left:3px solid var(--color-primary,#f59e0b);color:var(--color-text-light,#b6b1c4);margin-top:.4rem}
    .ka-hint{font-size:.78rem;color:var(--color-text-faint,#8e8aa2);font-style:italic;margin:.3rem 0}
  `;
  document.head.appendChild(st);

  const $ = (s) => host.querySelector(s);
  const saveAll = () => {
    try {
      save(STORE.profile, profile);
      save(STORE.friends, friends);
      save(STORE.requests, requests);
      save(STORE.chats, chats);
      localStorage.setItem(STORE.reveal, reveal ? '1' : '0');
    } catch (error) {
      console.error('Could not persist Kismet widget state:', error);
      if (typeof window.showToast === 'function') window.showToast('Storage is full. Some changes may not be saved.');
    }
  };

  // ---- tabs ----
  const tabTitles = { match: 'Random match', requests: 'Friend requests', chat: 'Chat', profile: 'Profile' };
  const openPanel = (tab) => {
    activeTab = tab;
    host.querySelectorAll('.ka-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('.ka-panel').hidden = false;
    $('.ka-title').textContent = tabTitles[tab];
    render();
  };
  const closePanel = () => { $('.ka-panel').hidden = true; };
  host.querySelectorAll('.ka-tab').forEach(t => t.addEventListener('click', () => {
    if (activeTab === t.dataset.tab && !$('.ka-panel').hidden) { closePanel(); return; }
    openPanel(t.dataset.tab);
  }));
  $('.ka-close').addEventListener('click', closePanel);

  // ---- renderers ----
  const render = () => {
    const body = $('.ka-body');
    body.innerHTML = '';
    if (activeTab === 'match') renderMatch(body);
    else if (activeTab === 'requests') renderRequests(body);
    else if (activeTab === 'chat') renderChat(body);
    else if (activeTab === 'profile') renderProfile(body);
    updateBadges();
  };

  const renderMatch = (body) => {
    body.innerHTML = `
      <div class="ka-card">
        <p style="margin:0 0 .5rem;font-weight:700;color:var(--color-text,#efe8d6)">Random video match</p>
        <p class="ka-hint">Press start to be paired with one real stranger. You can talk for the length of the call. Reveal your identity to add them as a friend.</p>
        <a href="/chat" class="ka-btn" style="display:inline-block;text-decoration:none;margin-top:.4rem">Start matching</a>
      </div>
      <div class="ka-card">
        <p style="margin:0 0 .4rem;font-weight:700;color:var(--color-text,#efe8d6)">How it works</p>
        <p class="ka-hint" style="font-style:normal">1. Match with a stranger — talk anonymously for the call.</p>
        <p class="ka-hint" style="font-style:normal">2. Reveal your identity to send a friend request.</p>
        <p class="ka-hint" style="font-style:normal">3. Once they accept, chat anytime in your inbox.</p>
        <p class="ka-hint" style="font-style:normal">4. If you never reveal, the conversation ends with the call.</p>
      </div>
      <div class="ka-card">
        <p style="margin:0 0 .4rem;font-weight:700;color:var(--color-text,#efe8d6)">Reveal status</p>
        <div class="ka-reveal-toggle">
          <input type="checkbox" class="ka-reveal-cb" ${reveal ? 'checked' : ''} />
          <span>${reveal ? 'Visible to strangers' : 'Anonymous'}</span>
        </div>
        <p class="ka-hint">${reveal ? 'Strangers can see your name and send friend requests.' : 'Strangers see no identity. Talk ends when the call ends.'}</p>
      </div>
    `;
    body.querySelector('.ka-reveal-cb').addEventListener('change', (e) => { reveal = e.target.checked; saveAll(); render(); });
  };

  const renderRequests = (body) => {
    const pending = requests.filter(r => r.status === 'pending');
    if (!pending.length) { body.innerHTML = '<p class="ka-empty">No pending friend requests.</p>'; return; }
    pending.forEach(r => {
      const el = document.createElement('div');
      el.className = 'ka-row';
      el.innerHTML = `<div><div class="ka-name">${escapeHTML(r.name)}</div><div class="ka-sub">${escapeHTML(r.code)}</div></div>
        <div style="display:flex;gap:.3rem">
          <button class="ka-btn" data-act="accept" data-id="${escapeHTML(r.id)}">Accept</button>
          <button class="ka-btn danger" data-act="reject" data-id="${escapeHTML(r.id)}">Reject</button>
        </div>`;
      el.querySelector('[data-act="accept"]').addEventListener('click', () => acceptRequest(r.id));
      el.querySelector('[data-act="reject"]').addEventListener('click', () => rejectRequest(r.id));
      body.appendChild(el);
    });
  };

  const acceptRequest = (id) => {
    const r = requests.find(x => x.id === id);
    if (!r) return;
    r.status = 'accepted';
    if (!friends.some(f => f.code === r.code)) friends.push({ id: r.id, name: r.name, code: r.code, status: 'accepted' });
    saveAll(); render();
  };
  const rejectRequest = (id) => {
    const r = requests.find(x => x.id === id);
    if (r) r.status = 'rejected';
    saveAll(); render();
  };

  const renderChat = (body) => {
    if (!activeChat) {
      const accepted = friends.filter(f => f.status === 'accepted' || !f.status);
      if (!accepted.length) { body.innerHTML = '<p class="ka-empty">No friends yet. Reveal your identity in a match to add friends.</p>'; return; }
      accepted.forEach(f => {
        const msgs = chats[f.id] || [];
        const last = msgs.length ? msgs[msgs.length-1].text : 'No messages yet';
        const el = document.createElement('div');
        el.className = 'ka-row';
        el.innerHTML = `<div><div class="ka-name">${escapeHTML(f.name)}</div><div class="ka-sub">${escapeHTML(last)}</div></div><button class="ka-btn ghost" data-id="${escapeHTML(f.id)}">Open</button>`;
        el.querySelector('button').addEventListener('click', () => { activeChat = f.id; render(); });
        body.appendChild(el);
      });
      return;
    }
    const f = friends.find(x => x.id === activeChat);
    if (!f) { activeChat = null; render(); return; }
    const msgs = chats[f.id] || [];
    body.innerHTML = `
      <button class="ka-btn ghost" id="ka-back" style="align-self:flex-start;margin-bottom:.4rem">← Back</button>
      <div class="ka-name" style="margin-bottom:.3rem">${escapeHTML(f.name)}</div>
      <div class="ka-msgs" id="ka-msgs"></div>
      <div class="ka-compose">
        <input class="ka-input" id="ka-msginput" placeholder="Type a message…" />
        <button class="ka-btn" id="ka-send">Send</button>
      </div>
    `;
    const box = body.querySelector('#ka-msgs');
    msgs.forEach(m => {
      const el = document.createElement('div');
      el.className = 'ka-msg ' + (m.me ? 'me' : 'them');
      el.textContent = m.text;
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
    body.querySelector('#ka-back').addEventListener('click', () => { activeChat = null; render(); });
    const send = () => {
      const input = body.querySelector('#ka-msginput');
      const text = input.value.trim();
      if (!text) return;
      if (!chats[f.id]) chats[f.id] = [];
      chats[f.id].push({ text, me: true, t: Date.now() });
      saveAll(); input.value = '';
      render();
    };
    body.querySelector('#ka-send').addEventListener('click', send);
    body.querySelector('#ka-msginput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  };

  const renderProfile = (body) => {
    body.innerHTML = `
      <div class="ka-card">
        <div class="ka-profile-row"><span class="ka-profile-label">Name</span><span class="ka-profile-val">${escapeHTML(profile.name)}</span></div>
        <div class="ka-profile-row"><span class="ka-profile-label">Friend code</span><span class="ka-profile-val">${escapeHTML(profile.code)}</span></div>
        <div class="ka-profile-row"><span class="ka-profile-label">Status</span><span class="ka-profile-val">${reveal ? 'Visible' : 'Anonymous'}</span></div>
        <div class="ka-profile-row"><span class="ka-profile-label">Friends</span><span class="ka-profile-val">${friends.filter(f=>f.status!=='rejected').length}</span></div>
        <div class="ka-profile-row"><span class="ka-profile-label">Pending requests</span><span class="ka-profile-val">${requests.filter(r=>r.status==='pending').length}</span></div>
      </div>
      <div class="ka-code">${escapeHTML(profile.code)}</div>
      <p class="ka-hint">Share this code with a stranger after revealing your identity. They enter it to add you as a friend.</p>
      <button class="ka-btn ghost" id="ka-rename">Change name</button>
      <button class="ka-btn ghost" id="ka-demo-req" style="margin-top:.3rem">Simulate incoming request (demo)</button>
    `;
    body.querySelector('#ka-rename').addEventListener('click', () => {
      const n = prompt('New display name:', profile.name);
      if (n) { profile.name = n; saveAll(); render(); }
    });
    body.querySelector('#ka-demo-req').addEventListener('click', () => {
      const demo = { id: 'r_' + Date.now(), name: 'Stranger #' + Math.floor(Math.random()*900+100), code: 'KS-' + Math.random().toString(36).slice(2,6).toUpperCase(), status: 'pending' };
      requests.push(demo); saveAll(); render();
      // switch to requests tab
      openPanel('requests');
    });
  };

  const updateBadges = () => {
    const pending = requests.filter(r => r.status === 'pending').length;
    const reqBadge = host.querySelector('.ka-tab[data-tab="requests"] .ka-badge');
    if (pending > 0) { reqBadge.textContent = pending; reqBadge.hidden = false; } else reqBadge.hidden = true;
    // chat badge: friends with unread? simple: count of accepted friends
    const accepted = friends.filter(f => f.status !== 'rejected' && f.status !== 'pending').length;
    const chatBadge = host.querySelector('.ka-tab[data-tab="chat"] .ka-badge');
    if (accepted > 0) { chatBadge.textContent = accepted; chatBadge.hidden = false; } else chatBadge.hidden = true;
  };

  // expose API for chat page to hook friend requests on reveal
  window.kismetApp = {
    reveal: () => reveal,
    setReveal: (v) => { reveal = v; saveAll(); },
    addFriend: (name, code) => { if (!friends.some(f => f.code === code)) { friends.push({ id: 'f_' + Date.now(), name, code, status: 'accepted' }); saveAll(); } },
    sendRequest: (name, code) => { if (!requests.some(r => r.code === code)) { requests.push({ id: 'r_' + Date.now(), name, code, status: 'pending' }); saveAll(); updateBadges(); } },
    profile: () => profile,
  };

  // ---- init: auto-open panel on first visit? No, stay collapsed ----
  updateBadges();
})();
