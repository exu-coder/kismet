/* Friend requests page logic — Supabase-backed */
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

  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const userId = localStorage.getItem('kismet.anonId') || '';
  const myProfile = load('kismet.profile', {});
  const myName = myProfile.name || 'Anonymous';
  const myCode = myProfile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';

  const list = document.getElementById('req-list');
  const empty = document.getElementById('req-empty');
  if (!list || !empty) return;

  let requests = [];

  const render = () => {
    const pending = requests.filter(r => r.status === 'pending');
    if (!pending.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    list.innerHTML = '';
    pending.forEach(r => {
      const el = document.createElement('div');
      el.className = 'ka-row';
      el.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);';

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:600;color:var(--color-text,#efe8d6)';
      name.textContent = r.from_name || 'Anonymous';
      const code = document.createElement('div');
      code.style.cssText = 'font-size:.75rem;color:var(--color-text-faint,#8e8aa2)';
      code.textContent = r.from_code || '';
      info.append(name, code);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:.4rem';

      const accept = document.createElement('button');
      accept.className = 'ka-btn';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => acceptRequest(r, accept));

      const reject = document.createElement('button');
      reject.className = 'ka-btn danger';
      reject.textContent = 'Reject';
      reject.addEventListener('click', () => rejectRequest(r, reject));

      actions.append(accept, reject);
      el.append(info, actions);
      list.appendChild(el);
    });
  };

  const loadRequests = async () => {
    if (!userId) { render(); return; }
    const { data, error } = await sb
      .from('friend_requests')
      .select('*')
      .eq('to_user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) { console.error(error); render(); return; }
    requests = data || [];
    render();
  };

  const acceptRequest = async (request, btn) => {
    btn.disabled = true;
    // 1. Mark request accepted
    const { error: updateError } = await sb
      .from('friend_requests')
      .update({ status: 'accepted' })
      .eq('id', request.id);
    if (updateError) { console.error(updateError); btn.disabled = false; return; }

    // 2. Create mutual friend entries
    const { error: friendError } = await sb.from('friends').upsert([
      {
        user_id: userId,
        friend_id: request.from_user_id,
        friend_name: request.from_name,
        friend_code: request.from_code,
      },
      {
        user_id: request.from_user_id,
        friend_id: userId,
        friend_name: myName,
        friend_code: myCode,
      },
    ], { onConflict: 'user_id,friend_id' });
    if (friendError) { console.error(friendError); btn.disabled = false; return; }

    request.status = 'accepted';
    render();
  };

  const rejectRequest = async (request, btn) => {
    btn.disabled = true;
    const { error } = await sb
      .from('friend_requests')
      .update({ status: 'rejected' })
      .eq('id', request.id);
    if (error) { console.error(error); btn.disabled = false; return; }
    request.status = 'rejected';
    render();
  };

  await loadRequests();

  // Live updates while the page is open
  sb.channel('requests_' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, () => loadRequests())
    .subscribe();
})();
