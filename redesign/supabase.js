/* Supabase client for Kismet — loaded via script tag */
const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

let dbClient = null;

const loadSupabase = () => new Promise((resolve) => {
  if (window.supabase) {
    if (!dbClient) {
      dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      window.kismetSupabase = dbClient;
    }
    resolve(dbClient);
    return;
  }
  let attempts = 0;
  const check = setInterval(() => {
    if (window.supabase || attempts > 50) {
      clearInterval(check);
      if (window.supabase && !dbClient) {
        dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        window.kismetSupabase = dbClient;
      }
      resolve(dbClient);
    }
    attempts++;
  }, 100);
});

const auth = {
  async signUp(email, password) {
    const { data, error } = await dbClient.auth.signUp({ email, password });
    return { data, error };
  },
  async signIn(email, password) {
    const { data, error } = await dbClient.auth.signInWithPassword({ email, password });
    return { data, error };
  },
  async signInWithGitHub() {
    const { data, error } = await dbClient.auth.signInWithOAuth({ provider: 'github' });
    return { data, error };
  },
  async signOut() {
    const { error } = await dbClient.auth.signOut();
    return { error };
  },
  async getUser() {
    const { data: { user } } = await dbClient.auth.getUser();
    return user;
  },
  onAuthChange(callback) {
    return dbClient.auth.onAuthStateChange(callback);
  }
};

const profiles = {
  async get(userId) {
    const { data, error } = await dbClient.from('profiles').select('*').eq('user_id', userId).single();
    return { data, error };
  },
  async create(userId, name, friendCode, country, photoUrl) {
    const { data, error } = await dbClient.from('profiles').insert({
      user_id: userId, name, friend_code: friendCode, country, photo_url: photoUrl
    }).select().single();
    return { data, error };
  },
  async update(userId, updates) {
    const { data, error } = await dbClient.from('profiles').update(updates).eq('user_id', userId).select().single();
    return { data, error };
  },
  async findByCode(code) {
    const { data, error } = await dbClient.from('profiles').select('*').eq('friend_code', code).single();
    return { data, error };
  }
};

const friends = {
  async list(userId) {
    const { data, error } = await dbClient.from('friends').select('*').eq('user_id', userId);
    return { data, error };
  },
  async add(userId, friendId, friendName, friendCode) {
    const { data, error } = await dbClient.from('friends').insert({
      user_id: userId, friend_id: friendId, friend_name: friendName, friend_code: friendCode
    });
    return { data, error };
  }
};

const requests = {
  async listIncoming(userId) {
    const { data, error } = await dbClient.from('friend_requests').select('*').eq('to_user_id', userId).eq('status', 'pending');
    return { data, error };
  },
  async send(fromUserId, toUserId, fromName, fromCode) {
    const { data, error } = await dbClient.from('friend_requests').insert({
      from_user_id: fromUserId, to_user_id: toUserId, from_name: fromName, from_code: fromCode
    });
    return { data, error };
  },
  async accept(requestId) {
    const { data, error } = await dbClient.from('friend_requests').update({ status: 'accepted' }).eq('id', requestId);
    return { data, error };
  },
  async reject(requestId) {
    const { data, error } = await dbClient.from('friend_requests').update({ status: 'rejected' }).eq('id', requestId);
    return { data, error };
  }
};

const messages = {
  async list(userId, friendId) {
    const { data, error } = await dbClient.from('messages').select('*')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`)
      .order('created_at', { ascending: true });
    return { data, error };
  },
  async send(fromUserId, toUserId, content) {
    const { data, error } = await dbClient.from('messages').insert({
      from_user_id: fromUserId, to_user_id: toUserId, content
    });
    return { data, error };
  }
};

loadSupabase().then(() => {
  window.kismetDB = { auth, profiles, friends, requests, messages, supabase: dbClient };
  auth.getUser().then(user => {
    if (user) {
      window.kismetUser = user;
      document.dispatchEvent(new CustomEvent('kismet:auth', { detail: user }));
    }
  });
  auth.onAuthChange((event, session) => {
    window.kismetUser = session?.user || null;
    document.dispatchEvent(new CustomEvent('kismet:auth', { detail: session?.user }));
  });
});

window.loadKismetSupabase = loadSupabase;