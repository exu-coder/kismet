/* Shared Supabase client and anonymous identity for Kismet. */
const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

let dbClient = null;

const requireClient = () => {
  if (!dbClient) throw new Error('Supabase is not ready. Please reload and try again.');
  return dbClient;
};

const loadSdk = () => new Promise((resolve, reject) => {
  if (window.supabase?.createClient) return resolve();
  const script = document.createElement('script');
  let settled = false;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => finish(new Error('Timed out loading Supabase SDK')), 10000);
  script.src = '/redesign/supabase.min.js';
  script.async = true;
  script.dataset.kismetSupabaseSdk = 'true';
  script.onload = () => window.supabase?.createClient
    ? finish()
    : finish(new Error('Supabase SDK loaded without createClient'));
  script.onerror = () => finish(new Error('Could not load Supabase SDK'));
  document.head.appendChild(script);
});

let initPromise = null;

// Last-resort identity when the project has Anonymous Sign-Ins turned off.
// The session function (service role, rate-limited) creates a throwaway guest
// user and returns a normal session, so auth.uid() and RLS still apply.
const createFallbackSession = async () => {
  const res = await fetch(SUPABASE_URL + '/functions/v1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token || !data.refresh_token) {
    throw new Error(data.error || 'Could not create a secure session. Please reload.');
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token };
};

const loadSupabase = () => {
  if (dbClient && window.kismetUser) return Promise.resolve(dbClient);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await loadSdk();
    if (!dbClient) {
      dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
      });
      window.kismetSupabase = dbClient;
    }
    const { data: { session }, error } = await dbClient.auth.getSession();
    if (error) throw error;
    if (!session?.user) {
      const { data, error: signInError } = await dbClient.auth.signInAnonymously();
      if (signInError) {
        if (!/anonymous/i.test(signInError.message)) throw new Error(signInError.message);
        // Anonymous Sign-Ins are disabled on this project: use the fallback.
        const fallback = await createFallbackSession();
        const { data: established, error: sessionError } = await dbClient.auth.setSession(fallback);
        if (sessionError) throw sessionError;
        if (!established.user) throw new Error('Could not create a secure anonymous session.');
        window.kismetUser = established.user;
      } else {
        if (!data.user) throw new Error('Could not create a secure anonymous session.');
        window.kismetUser = data.user;
      }
    } else window.kismetUser = session.user;
    const { data: current } = await dbClient.auth.getSession();
    if (current.session?.access_token) dbClient.realtime.setAuth(current.session.access_token);
    return dbClient;
  })().catch(error => { initPromise = null; throw error; });
  return initPromise;
};

const profiles = {
  async get(userId) {
    const { data, error } = await requireClient().from('profiles').select('*').eq('user_id', userId).single();
    return { data, error };
  },
  async create(userId, name, friendCode, country, photoUrl) {
    const { data, error } = await requireClient().from('profiles').insert({
      user_id: userId, name, friend_code: friendCode, country, photo_url: photoUrl
    }).select().single();
    return { data, error };
  },
  async update(userId, updates) {
    const { data, error } = await requireClient().from('profiles').update(updates).eq('user_id', userId).select().single();
    return { data, error };
  },
  async findByCode(code) {
    const { data, error } = await requireClient().rpc('kismet_find_profile_by_code', { p_friend_code: code });
    return { data: Array.isArray(data) ? data[0] || null : data, error };
  }
};

const friends = {
  async list(userId) {
    const { data, error } = await requireClient().from('friends').select('*').eq('user_id', userId);
    return { data, error };
  },
  async add(userId, friendId, friendName, friendCode) {
    const { data, error } = await requireClient().from('friends').upsert({
      user_id: userId, friend_id: friendId, friend_name: friendName, friend_code: friendCode
    }, { onConflict: 'user_id,friend_id' });
    return { data, error };
  }
};

const requests = {
  async listIncoming(userId) {
    const { data, error } = await requireClient().from('friend_requests').select('*').eq('to_user_id', userId).eq('status', 'pending');
    return { data, error };
  },
  async send(_fromUserId, toUserId) {
    const { data, error } = await requireClient().rpc('kismet_send_friend_request', { p_to_user_id: toUserId });
    return { data, error };
  },
  async accept(requestId) {
    const { data, error } = await requireClient().rpc('kismet_respond_friend_request', { p_request_id: requestId, p_status: 'accepted' });
    return { data, error };
  },
  async reject(requestId) {
    const { data, error } = await requireClient().rpc('kismet_respond_friend_request', { p_request_id: requestId, p_status: 'rejected' });
    return { data, error };
  }
};

const messages = {
  async list(userId, friendId) {
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!validId(userId) || !validId(friendId)) throw new Error('Invalid message participant ID');
    const { data, error } = await requireClient().from('messages').select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    return { data, error };
  },
  async send(fromUserId, toUserId, content) {
    const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!validId(fromUserId) || !validId(toUserId)) throw new Error('Invalid message participant ID');
    if (typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('Message must contain 1–4,000 characters');
    const { data, error } = await requireClient().from('messages').insert({
      from_user_id: fromUserId, to_user_id: toUserId, content
    });
    return { data, error };
  }
};

window.kismetReady = loadSupabase().then(async client => {
  // Trust the session already established above. A transient getUser() failure
  // must not wipe a valid anonymous identity (that silently disabled the app).
  if (!window.kismetUser) {
    try {
      const { data: { session } } = await client.auth.getSession();
      window.kismetUser = session?.user || null;
    } catch (error) {
      console.warn('Could not restore Kismet auth session:', error);
    }
  }
  window.kismetDB = { profiles, friends, requests, messages, supabase: client };
  client.auth.onAuthStateChange((_event, session) => {
    window.kismetUser = session?.user || null;
    document.dispatchEvent(new CustomEvent('kismet:auth', { detail: session?.user || null }));
  });
  document.dispatchEvent(new CustomEvent('kismet:ready', { detail: { client } }));
  return client;
}).catch(error => {
  console.error('Kismet Supabase initialization failed:', error);
  document.dispatchEvent(new CustomEvent('kismet:error', { detail: error }));
  throw error;
});

window.loadKismetSupabase = loadSupabase;
