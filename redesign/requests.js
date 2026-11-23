/* Friend requests page logic — uses the shared Supabase client. */
(async () => {
  const list = document.getElementById('req-list');
  const empty = document.getElementById('req-empty');
  if (!list || !empty) return;

  const notify = message => {
    if (typeof window.showToast === 'function') window.showToast(message);
    else console.warn(message);
  };

  let sb;
  try {
    sb = await window.kismetReady;
  } catch (error) {
    empty.textContent = 'Friend requests are temporarily unavailable. Please reload the page.';
    empty.style.display = 'block';
    console.error(error);
    return;
  }

  const userId = window.kismetUser?.id;
  const load = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  };
  const myProfile = load('kismet.profile', {});
  const myName = myProfile.name || 'Anonymous';
  const myCode = myProfile.code || localStorage.getItem('kismet.mycode') || 'KS-XXXX';
  let requests = [];

  const render = () => {
    list.replaceChildren();
    const pending = requests.filter(request => request.status === 'pending');
    empty.style.display = pending.length ? 'none' : 'block';
    pending.forEach(request => {
      const row = document.createElement('div');
      row.className = 'ka-row';
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.75rem;margin-bottom:.5rem;background:var(--color-bg-container,#0c101f);border:1px solid var(--color-border,#232b47);';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.style.cssText = 'font-weight:600;color:var(--color-text,#efe8d6)';
      name.textContent = request.from_name || 'Anonymous';
      const code = document.createElement('div');
      code.style.cssText = 'font-size:.75rem;color:var(--color-text-faint,#8e8aa2)';
      code.textContent = request.from_code || '';
      info.append(name, code);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:.4rem';
      const accept = document.createElement('button');
      accept.className = 'ka-btn';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => acceptRequest(request, accept));
      const reject = document.createElement('button');
      reject.className = 'ka-btn danger';
      reject.textContent = 'Reject';
      reject.addEventListener('click', () => rejectRequest(request, reject));
      actions.append(accept, reject);
      row.append(info, actions);
      list.appendChild(row);
    });
  };

  const loadRequests = async () => {
    const { data, error } = await sb.from('friend_requests').select('*')
      .eq('to_user_id', userId).eq('status', 'pending').order('created_at', { ascending: false });
    if (error) {
      console.error('Could not load friend requests:', error);
      notify('Could not load friend requests. Please try again.');
      return;
    }
    requests = data || [];
    render();
  };

  const acceptRequest = async (request, button) => {
    if (button.disabled) return;
    const row = button.closest('.ka-row');
    const buttons = row ? row.querySelectorAll('button') : [button];
    buttons.forEach(item => { item.disabled = true; });
    const { data, error } = await sb.rpc('kismet_respond_friend_request', {
      p_request_id: request.id, p_status: 'accepted'
    });
    if (error || data !== true) {
      console.error('Could not accept friend request:', error);
      notify('Could not accept this request. Please try again.');
      buttons.forEach(item => { item.disabled = false; });
      return;
    }
    request.status = 'accepted';
    render();
  };

  const rejectRequest = async (request, button) => {
    if (button.disabled) return;
    button.disabled = true;
    const { data, error } = await sb.rpc('kismet_respond_friend_request', {
      p_request_id: request.id, p_status: 'rejected'
    });
    if (error || data !== true) {
      console.error('Could not reject friend request:', error);
      notify('Could not reject this request. Please refresh and try again.');
      button.disabled = false;
      return;
    }
    request.status = 'rejected';
    render();
  };

  await loadRequests();
  sb.channel('requests_' + userId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, loadRequests)
    .subscribe();
})();