/* Shared Supabase client and anonymous identity for Kismet. */
const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

let dbClient = null;

const requireClient = () => {
  if (!dbClient) throw new Error('Supabase is not ready. Please reload and try again.');
  return dbClient;
};

const ensureAnonId = () => {
  let id = localStorage.getItem('kismet.anonId');
  if (!id) {
    const bytes = new Uint8Array(12);
    if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    id = 'user_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('kismet.anonId', id);
  }
  return id;
};

window.kismetIdentity = { getAnonId: ensureAnonId };

const loadSdk = () => new Promise((resolve, reject) => {
  if (window.supabase?.createClient) return resolve();
  const existing = document.querySelector('script[data-kismet-supabase-sdk]');
  if (existing) {
    existing.addEventListener('load', () => resolve(), { once: true });
    existing.addEventListener('error', () => reject(new Error('Could not load Supabase SDK')), { once: true });
    if (window.supabase?.createClient) resolve();
    return;
  }
  const script = document.createElement('script');
  script.src = '/redesign/supabase.min.js';
  script.async = true;
  script.dataset.kismetSupabaseSdk = 'true';
  script.onload = () => window.supabase?.createClient ? resolve() : reject(new Error('Supabase SDK loaded without createClient'));
  script.onerror = () => reject(new Error('Could not load Supabase SDK'));
  document.head.appendChild(script);
});

const loadSupabase = async () => {
  if (dbClient) return dbClient;
  await loadSdk();
  if (!dbClient) {
    dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    window.kismetSupabase = dbClient;
  }
  return dbClient;
};

const auth = {
  async signUp(email, password) {
    const { data, error } = await requireClient().auth.signUp({ email, password });
    return { data, error };
  },
  async signIn(email, password) {
    const { data, error } = await requireClient().auth.signInWithPassword({ email, password });
    return { data, error };
  },
  async signInWithGitHub() {
    const { data, error } = await requireClient().auth.signInWithOAuth({ provider: 'github' });
    return { data, error };
  },
  async signOut() {
    const { error } = await requireClient().auth.signOut();
    return { error };
  },
  async getUser() {
    const { data, error } = await requireClient().auth.getUser();
    if (error) throw error;
    return data.user;
  },
  onAuthChange(callback) {
    return requireClient().auth.onAuthStateChange(callback);
  }
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
    const { data, error } = await requireClient().from('profiles').select('*').eq('friend_code', code).single();
    return { data, error };
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
  async send(fromUserId, toUserId, fromName, fromCode) {
    const { data, error } = await requireClient().from('friend_requests').upsert({
      from_user_id: fromUserId, to_user_id: toUserId, from_name: fromName, from_code: fromCode, status: 'pending'
    }, { onConflict: 'from_user_id,to_user_id' });
    return { data, error };
  },
  async accept(requestId, recipientId) {
    const { data, error } = await requireClient().from('friend_requests').update({ status: 'accepted' })
      .eq('id', requestId).eq('to_user_id', recipientId).eq('status', 'pending').select('id').maybeSingle();
    return { data, error };
  },
  async reject(requestId, recipientId) {
    const { data, error } = await requireClient().from('friend_requests').update({ status: 'rejected' })
      .eq('id', requestId).eq('to_user_id', recipientId).eq('status', 'pending').select('id').maybeSingle();
    return { data, error };
  }
};

const messages = {
  async list(userId, friendId) {
    const { data, error } = await requireClient().from('messages').select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    return { data, error };
  },
  async send(fromUserId, toUserId, content) {
    const { data, error } = await requireClient().from('messages').insert({
      from_user_id: fromUserId, to_user_id: toUserId, content
    });
    return { data, error };
  }
};

window.kismetReady = loadSupabase().then(async client => {
  window.kismetDB = { auth, profiles, friends, requests, messages, supabase: client };
  try {
    const { data: { user } } = await client.auth.getUser();
    window.kismetUser = user || null;
  } catch (error) {
    console.warn('Could not restore Kismet auth session:', error);
    window.kismetUser = null;
  }
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
