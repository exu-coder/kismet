/* Kismet toast notification system — slides up from bottom, auto-fades after 3s */
(() => {
  const container = document.createElement('div');
  container.className = 'kismet-toast-container';
  document.body.appendChild(container);

  const st = document.createElement('style');
  st.textContent = `
    .kismet-toast-container{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;align-items:center;gap:.5rem;pointer-events:none}
    .kismet-toast{background:#1a1a2e;color:#fff;padding:.75rem 1.25rem;border-radius:12px;font-size:.9rem;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:auto;opacity:0;transform:translateY(20px);transition:opacity .3s ease,transform .3s ease;max-width:calc(100vw - 2rem);text-align:center}
    .kismet-toast.show{opacity:1;transform:translateY(0)}
    .kismet-toast.hide{opacity:0;transform:translateY(20px)}
  `;
  document.head.appendChild(st);

  window.showToast = (message, duration) => {
    duration = duration || 3000;
    const toast = document.createElement('div');
    toast.className = 'kismet-toast';
    toast.textContent = message;
    container.appendChild(toast);
    // trigger show
    requestAnimationFrame(() => { toast.classList.add('show'); });
    // auto-hide
    setTimeout(() => {
      toast.classList.remove('show');
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  };
})();
