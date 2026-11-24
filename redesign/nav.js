/* Kismet bottom nav — links to separate pages, not overlays. */
(() => {
  // Don't show on the age-gate-only chat page before acceptance? Show everywhere.
  const nav = document.createElement('nav');
  nav.className = 'kismet-nav';
  nav.innerHTML = `
    <a href="/chat/" class="kn-tab" data-page="match">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/><path d="M9 15 3 21"/></svg>
      <span>Match</span>
    </a>
    <a href="/requests/" class="kn-tab" data-page="requests">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      <span>Requests</span>
    </a>
    <a href="/inbox/" class="kn-tab" data-page="inbox">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Chat</span>
    </a>
    <a href="/profile/" class="kn-tab" data-page="profile">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span>Profile</span>
    </a>
    <a href="/support/" class="kn-tab" data-page="support">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/></svg>
      <span>Support</span>
    </a>
  `;
  document.body.appendChild(nav);

  // highlight active page
  const path = location.pathname.replace(/\/$/, '') || '/';
  nav.querySelectorAll('.kn-tab').forEach(t => {
    const pg = t.dataset.page;
    const isActive = (pg === 'match' && (path === '' || path === '/' || path === '/chat' || path === '/match')) ||
                     (pg === 'requests' && path === '/requests') ||
                     (pg === 'inbox' && path === '/inbox') ||
                     (pg === 'profile' && path === '/profile') ||
                     (pg === 'support' && path === '/support');
    t.classList.toggle('active', isActive);
  });

  const st = document.createElement('style');
  st.textContent = `
    .kismet-nav{position:fixed !important;bottom:1rem !important;left:50% !important;transform:translateX(-50%) !important;z-index:9998;display:flex;justify-content:space-around;align-items:center;gap:.25rem;padding:.5rem .75rem;background:rgba(21,27,48,.55);border:1px solid rgba(255,255,255,.08);backdrop-filter:blur(24px) saturate(1.4);-webkit-backdrop-filter:blur(24px) saturate(1.4);border-radius:1.5rem;box-shadow:0 8px 32px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06);font-family:var(--font-body,serif);width:calc(100% - 2rem);max-width:24rem;height:3.5rem;flex-shrink:0;min-height:3.5rem}
    .kn-tab{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:.15rem;padding:.4rem .3rem;background:none;border:none;color:var(--color-text-light,#b6b1c4);cursor:pointer;font:inherit;font-size:.62rem;text-decoration:none;position:relative;border-radius:.75rem;transition:color .15s ease,background .15s ease,transform .12s ease;min-width:0}
    .kn-tab:hover{background:rgba(255,255,255,.06);color:var(--color-text,#efe8d6)}
    .kn-tab.active{color:var(--color-primary,#f59e0b);background:rgba(245,158,11,.1)}
    .kn-tab:active{transform:scale(.92)}
    .kn-tab span{font-size:.58rem;letter-spacing:.04em}
    .kn-tab .kn-badge{position:absolute;top:.05rem;right:calc(50% - .6rem);min-width:.8rem;height:.8rem;padding:0 .15rem;border-radius:999px;background:var(--color-danger,#f5585f);color:#fff;font-size:.45rem;font-weight:700;display:grid;place-items:center}
    body{padding-bottom:6rem !important}
    html{scroll-padding-bottom:6rem}
  `;
  document.head.appendChild(st);
})();