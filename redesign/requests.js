/* Friend requests page logic */
(() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  let requests = load('kismet.requests', []);
  let friends = load('kismet.friends', []);

  const list = document.getElementById('req-list');
  const empty = document.getElementById('req-empty');

  const render = () => {
    const pending = requests.filter(r => r.status === 'pending');
    if (!pending.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = '';
    pending.forEach(r => {
      const el = document.createElement('div');
      el.className = 'ka-row';
      el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);';
      el.innerHTML = `<div><div style="font-weight:600;color:var(--color-text,#efe8d6)">${r.name}</div><div style="font-size:.75rem;color:var(--color-text-faint,#8e8aa2)">${r.code}</div></div>
        <div style="display:flex;gap:.4rem">
          <button class="ka-btn" data-act="accept">Accept</button>
          <button class="ka-btn danger" data-act="reject">Reject</button>
        </div>`;
      el.querySelector('[data-act="accept"]').addEventListener('click', () => {
        r.status = 'accepted';
        if (!friends.some(f => f.code === r.code)) friends.push({ id: r.id, name: r.name, code: r.code, status: 'accepted' });
        save('kismet.requests', requests); save('kismet.friends', friends);
        render();
      });
      el.querySelector('[data-act="reject"]').addEventListener('click', () => {
        r.status = 'rejected';
        save('kismet.requests', requests);
        render();
      });
      list.appendChild(el);
    });
  };
  render();
})();
EOF