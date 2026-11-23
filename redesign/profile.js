/* Profile page logic */
(() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const countries = [
    'Afghanistan','Albania','Algeria','Argentina','Australia','Austria','Bangladesh','Belgium','Bolivia','Brazil','Canada','Chile','China','Colombia','Costa Rica','Cuba','Czech Republic','Denmark','Dominican Republic','Ecuador','Egypt','El Salvador','Finland','France','Germany','Greece','Guatemala','Honduras','Hungary','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Japan','Jordan','Kenya','Malaysia','Mexico','Morocco','Netherlands','New Zealand','Nicaragua','Nigeria','Norway','Pakistan','Panama','Paraguay','Peru','Philippines','Poland','Portugal','Romania','Russia','Saudi Arabia','South Africa','South Korea','Spain','Sweden','Switzerland','Thailand','Turkey','Ukraine','United Kingdom','United States','Uruguay','Venezuela','Vietnam'
  ];

  let profile = load('kismet.profile', { name: 'Anonymous', code: null, photo: null, country: '' });
  if (!profile.code) { profile.code = 'KS-' + Math.random().toString(36).slice(2,6).toUpperCase(); save('kismet.profile', profile); }
  if (!localStorage.getItem('kismet.mycode')) localStorage.setItem('kismet.mycode', profile.code);

  const sel = document.getElementById('country-select');
  countries.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    if (c === profile.country) opt.selected = true;
    sel.appendChild(opt);
  });

  document.getElementById('name-input').value = profile.name || '';
  document.getElementById('code-display').textContent = profile.code;
  // identity is hidden by default; reveal happens per-call, not here

  const photoImg = document.getElementById('photo-img');
  const photoPlaceholder = document.getElementById('photo-placeholder');
  const showPhoto = (src) => {
    const overlay = document.getElementById('photo-overlay');
    if (src) { photoImg.src = src; photoImg.style.display = 'block'; photoImg.style.borderRadius = '50%'; photoPlaceholder.style.display = 'none'; if (overlay) overlay.style.display = 'none'; }
    else { photoImg.style.display = 'none'; photoPlaceholder.style.display = 'block'; if (overlay) overlay.style.display = 'block'; }
  };
  showPhoto(profile.photo);

  const handlePhoto = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      profile.photo = ev.target.result;
      showPhoto(profile.photo);
      save('kismet.profile', profile);
    };
    reader.readAsDataURL(file);
  };

  // photo wrap click triggers file input
  document.getElementById('photo-wrap').addEventListener('click', () => {
    document.getElementById('photo-input').click();
  });

  // both file inputs
  ['photo-input', 'photo-input2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', (e) => handlePhoto(e.target.files[0]));
  });

  document.getElementById('remove-photo').addEventListener('click', () => {
    profile.photo = null;
    showPhoto(null);
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    profile.name = document.getElementById('name-input').value.trim() || 'Anonymous';
    profile.country = document.getElementById('country-select').value;
    save('kismet.profile', profile);

    // Sync to Supabase if authenticated
    if (window.kismetDB && window.kismetUser) {
      const db = window.kismetDB;
      const user = window.kismetUser;
      const existing = await db.profiles.get(user.id);
      if (existing.data) {
        await db.profiles.update(user.id, { name: profile.name, country: profile.country, photo_url: profile.photo });
      } else {
        await db.profiles.create(user.id, profile.name, profile.code, profile.country, profile.photo);
      }
    }

    // update stats
    const friends = load('kismet.friends', []);
    const requests = load('kismet.requests', []);
    document.getElementById('stat-friends').textContent = friends.filter(f => f.status !== 'rejected' && f.status !== 'pending').length;
    document.getElementById('stat-reqs').textContent = requests.filter(r => r.status === 'pending').length;
    showToast('Profile saved successfully!');
  });

  // ---- Auth handling ----
  const authLoggedOut = document.getElementById('auth-logged-out');
  const authLoggedIn = document.getElementById('auth-logged-in');
  const authEmail = document.getElementById('auth-user-email');

  const updateAuthUI = (user) => {
    if (user) {
      authLoggedOut.style.display = 'none';
      authLoggedIn.style.display = 'block';
      authEmail.textContent = user.email || user.id;
    } else {
      authLoggedOut.style.display = 'block';
      authLoggedIn.style.display = 'none';
    }
  };

  // Wait for Supabase to load
  const waitForSupabase = () => new Promise((resolve) => {
    if (window.kismetSupabase) { resolve(); return; }
    const check = setInterval(() => {
      if (window.kismetSupabase) { clearInterval(check); resolve(); }
    }, 200);
  });

  waitForSupabase().then(() => {
    const db = window.kismetDB;
    db.auth.getUser().then(user => updateAuthUI(user));
    db.auth.onAuthChange((event, session) => updateAuthUI(session?.user));

    document.getElementById('btn-signin').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value;
      const password = document.getElementById('auth-password').value;
      const { data, error } = await db.auth.signIn(email, password);
      if (error) showToast('Sign in failed: ' + error.message);
      else { showToast('Signed in!'); updateAuthUI(data.user); }
    });

    document.getElementById('btn-signup').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value;
      const password = document.getElementById('auth-password').value;
      const { data, error } = await db.auth.signUp(email, password);
      if (error) showToast('Sign up failed: ' + error.message);
      else showToast('Check your email to confirm your account!');
    });

    document.getElementById('btn-github').addEventListener('click', async () => {
      const { error } = await db.auth.signInWithGitHub();
      if (error) showToast('GitHub sign in failed: ' + error.message);
    });

    document.getElementById('btn-signout').addEventListener('click', async () => {
      const { error } = await db.auth.signOut();
      if (error) showToast('Sign out failed: ' + error.message);
      else { showToast('Signed out'); updateAuthUI(null); }
    });
  });

  // stats on load
  const friends = load('kismet.friends', []);
  const requests = load('kismet.requests', []);
  document.getElementById('stat-friends').textContent = friends.filter(f => f.status !== 'rejected' && f.status !== 'pending').length;
  document.getElementById('stat-reqs').textContent = requests.filter(r => r.status === 'pending').length;
})();
EOF