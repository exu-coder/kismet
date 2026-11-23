/* In-call reveal identity button — appears on the chat page during a call. */
(() => {
  if (!/\/chat(\/|$)/.test(location.pathname)) return;
  // identity is hidden by default — reset any stale persisted reveal
  localStorage.setItem('kismet.reveal', '0');

  const btn = document.createElement('button');
  btn.className = 'kismet-reveal-btn';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    <span>Reveal identity</span>
  `;
  btn.title = 'Let the stranger see your name and send a friend request';
  document.body.appendChild(btn);

  const toast = document.createElement('div');
  toast.className = 'kismet-reveal-toast';
  toast.hidden = true;
  document.body.appendChild(toast);

  const show = (msg, type) => {
    toast.textContent = msg;
    toast.className = 'kismet-reveal-toast ' + (type || '');
    toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.hidden = true; }, 3500);
  };

  let revealed = false;
  btn.addEventListener('click', () => {
    if (revealed) { show('Already revealed this call.', 'info'); return; }
    const profile = (() => { try { return JSON.parse(localStorage.getItem('kismet.profile')); } catch { return null; } })();
    const name = profile?.name || 'Anonymous';
    revealed = true;
    localStorage.setItem('kismet.reveal', '1');
    btn.classList.add('revealed');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span>Identity revealed</span>
    `;
    show(`You revealed as "${name}". The stranger can now add you as a friend.`, 'success');
    // reset reveal on page unload (per-call)
    window.addEventListener('beforeunload', () => { localStorage.setItem('kismet.reveal', '0'); }, { once: true });
  });

  const st = document.createElement('style');
  st.textContent = `
    .kismet-reveal-btn{position:fixed;bottom:5.2rem;right:1rem;z-index:9997;display:flex;align-items:center;gap:.4rem;padding:.5rem .85rem;background:var(--color-bg-raised,#151b30);color:var(--color-text,#efe8d6);border:1px solid var(--color-border,#232b47);font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;clip-path:polygon(0 4px,2px 4px,2px 2px,4px 2px,4px 0,calc(100% - 4px) 0,calc(100% - 4px) 2px,calc(100% - 2px) 2px,calc(100% - 2px) 4px,100% 4px,100% calc(100% - 4px),calc(100% - 2px) calc(100% - 4px),calc(100% - 2px) calc(100% - 2px),calc(100% - 4px) calc(100% - 2px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 2px),2px calc(100% - 2px),2px calc(100% - 4px),0 calc(100% - 4px));filter:drop-shadow(3px 3px 0 #0000008c);transition:transform .15s ease,background .15s ease}
    .kismet-reveal-btn:hover{transform:translate(-1px,-1px);background:var(--color-bg-container,#0c101f)}
    .kismet-reveal-btn.revealed{background:var(--gradient-brand,#f59e0b);color:var(--color-on-primary,#0c101f);border-color:transparent}
    .kismet-reveal-btn svg{flex-shrink:0}
    .kismet-reveal-toast{position:fixed;bottom:7.5rem;left:50%;transform:translateX(-50%);padding:.6rem 1rem;background:var(--color-bg-raised,#151b30);border:1px solid var(--color-border,#232b47);border-left:3px solid var(--color-primary,#f59e0b);color:var(--color-text,#efe8d6);font-size:.85rem;clip-path:polygon(0 4px,2px 4px,2px 2px,4px 2px,4px 0,calc(100% - 4px) 0,calc(100% - 4px) 2px,calc(100% - 2px) 2px,calc(100% - 2px) 4px,100% 4px,100% calc(100% - 4px),calc(100% - 2px) calc(100% - 4px),calc(100% - 2px) calc(100% - 2px),calc(100% - 4px) calc(100% - 2px),calc(100% - 4px) 100%,4px 100%,4px calc(100% - 2px),2px calc(100% - 2px),2px calc(100% - 4px),0 calc(100% - 4px));filter:drop-shadow(4px 4px 0 #00000073);z-index:9999;max-width:calc(100vw-2rem);text-align:center;animation:kismet-in .3s steps(4,end) backwards}
    .kismet-reveal-toast.success{border-left-color:var(--color-success,#4fd68f)}
    .kismet-reveal-toast.info{border-left-color:var(--color-warning,#f5a623)}
  `;
  document.head.appendChild(st);
})();
EOF