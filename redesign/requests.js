/* Friend requests page logic — uses the shared Supabase client. */
(async () => {
  const list = document.getElementById('req-list');
  const empty = document.getElementById('req-empty');
  if (!list || !empty) return;

  const notify = message => {
    if (typeof window.showToast === 'function') window.showToast(message);
    else console.warn(message);
  };
  const identity = window.kismetIdentity || {
    safePhotoUrl: () => '',
    displayName: person => person?.name || 'Anonymous',
    avatar: () => document.createElement('span'),
    timeLabel: () => ''
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
  const isSafeUserId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  if (!isSafeUserId(userId)) {
    empty.textContent = 'Your session ID is invalid. Please reload the page.';
    empty.style.display = 'block';
    return;
  }

  let requests = [];
  let peers = new Map();

  const loadPeers = async () => {
    const ids = [...new Set(requests.map(request => request.from_user_id).filter(isSafeUserId))];
    if (!ids.length) { peers = new Map(); return; }
    const { data, error } = await sb.from('profiles')
      .select('user_id,name,friend_code,photo_url,country')
      .in('user_id', ids);
    if (error) {
      // Fall back to the snapshot saved with each request. Profiles are only
      // readable while a request is pending, so this can legitimately be empty.
      console.warn('Could not load request profile photos:', error);
      peers = new Map();
      return;
    }
    peers = new Map((data || []).map(profile => [profile.user_id, profile]));
  };

  const mergePeer = request => {
    const live = peers.get(request.from_user_id) || {};
    return {
      name: live.name || request.from_name || 'Anonymous',
      friend_code: live.friend_code || request.from_code || '',
      photo_url: identity.safePhotoUrl(live.photo_url),
      country: live.country || ''
    };
  };

  const makeAction = (label, variant, svg) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'km-action' + (variant ? ' ' + variant : '');
    button.innerHTML = svg;
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    return button;
  };

  const render = () => {
    list.replaceChildren();
    const pending = requests.filter(request => request.status === 'pending');
    empty.style.display = pending.length ? 'none' : 'block';

    pending.forEach(request => {
      const peer = mergePeer(request);
      const row = document.createElement('div');
      row.className = 'km-row';

      const main = document.createElement('div');
      main.className = 'km-row__main';
      main.appendChild(identity.avatar(peer, 48));

      const body = document.createElement('div');
      body.className = 'km-row__body';
      const line = document.createElement('div');
      line.className = 'km-row__line';
      const name = document.createElement('span');
      name.className = 'km-row__name';
      name.textContent = identity.displayName(peer);
      const time = document.createElement('time');
      time.className = 'km-row__time';
      time.dateTime = request.created_at || '';
      time.textContent = identity.timeLabel(request.created_at);
      line.append(name, time);

      const meta = document.createElement('div');
      meta.className = 'km-row__meta';
      meta.textContent = [peer.friend_code, peer.country].filter(Boolean).join(' · ');
      body.append(line, meta);
      main.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'km-actions';
      const accept = makeAction('Accept', 'primary',
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>');
      const reject = makeAction('Reject', 'danger',
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>');
      accept.addEventListener('click', () => acceptRequest(request, row));
      reject.addEventListener('click', () => rejectRequest(request, row));
      actions.append(accept, reject);

      row.append(main, actions);
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
    await loadPeers();
    render();
  };

  const setBusy = (row, busy) => {
    row.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  };

  const acceptRequest = async (request, row) => {
    const buttons = row.querySelectorAll('button');
    if (buttons[0]?.disabled) return;
    setBusy(row, true);
    const { data, error } = await sb.rpc('kismet_respond_friend_request', {
      p_request_id: request.id, p_status: 'accepted'
    });
    if (error || data !== true) {
      console.error('Could not accept friend request:', error);
      notify('Could not accept this request. Please try again.');
      setBusy(row, false);
      return;
    }
    request.status = 'accepted';
    try { sessionStorage.setItem('kismet.openChat', request.from_user_id); } catch (_) {}
    notify('Friend added. Opening your chat…');
    setTimeout(() => { window.location.assign('/inbox/'); }, 250);
  };

  const rejectRequest = async (request, row) => {
    const buttons = row.querySelectorAll('button');
    if (buttons[1]?.disabled) return;
    setBusy(row, true);
    const { data, error } = await sb.rpc('kismet_respond_friend_request', {
      p_request_id: request.id, p_status: 'rejected'
    });
    if (error || data !== true) {
      console.error('Could not reject friend request:', error);
      notify('Could not reject this request. Please refresh and try again.');
      setBusy(row, false);
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
