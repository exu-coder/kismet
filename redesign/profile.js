/* Profile page logic */
(() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (error) { console.error('Could not save profile locally:', error); showToast('Storage is full. Choose a smaller photo.'); return false; } };

  const countries = [
    'Afghanistan','Albania','Algeria','Argentina','Australia','Austria','Bangladesh','Belgium','Bolivia','Brazil','Canada','Chile','China','Colombia','Costa Rica','Cuba','Czech Republic','Denmark','Dominican Republic','Ecuador','Egypt','El Salvador','Finland','France','Germany','Greece','Guatemala','Honduras','Hungary','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Japan','Jordan','Kenya','Malaysia','Mexico','Morocco','Netherlands','New Zealand','Nicaragua','Nigeria','Norway','Pakistan','Panama','Paraguay','Peru','Philippines','Poland','Portugal','Romania','Russia','Saudi Arabia','South Africa','South Korea','Spain','Sweden','Switzerland','Thailand','Turkey','Ukraine','United Kingdom','United States','Uruguay','Venezuela','Vietnam'
  ];

  let profile = load('kismet.profile', { name: 'Anonymous', code: null, photo: null, country: '' });
  if (!profile.code) { profile.code = 'KS-' + Math.random().toString(36).slice(2,6).toUpperCase(); save('kismet.profile', profile); }
  if (!localStorage.getItem('kismet.mycode')) localStorage.setItem('kismet.mycode', profile.code);

  // Stable anonymous identity shared across all pages (chat, requests, inbox)
  if (!localStorage.getItem('kismet.anonId')) {
    localStorage.setItem('kismet.anonId', 'user_' + Math.random().toString(36).slice(2, 10));
  }
  const userId = localStorage.getItem('kismet.anonId');

  const refreshStats = async () => {
    const elFriends = document.getElementById('stat-friends');
    const elReqs = document.getElementById('stat-reqs');
    if (!elFriends || !elReqs || !window.kismetSupabase) return;
    const sb = window.kismetSupabase;
    const [{ count: friendCount }, { count: reqCount }] = await Promise.all([
      sb.from('friends').select('*', { count: 'exact', head: true }).eq('user_id', userId),
      sb.from('friend_requests').select('*', { count: 'exact', head: true }).eq('to_user_id', userId).eq('status', 'pending'),
    ]);
    elFriends.textContent = friendCount ?? 0;
    elReqs.textContent = reqCount ?? 0;
  };

  const sel = document.getElementById('country-select');
  if (!sel) return;
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

  const handlePhoto = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please choose an image file.'); return; }
    if (file.size > 10 * 1024 * 1024) { showToast('Photo must be 10 MB or smaller.'); return; }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read image'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('Invalid image file'));
          image.onload = () => {
            const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/webp', 0.82));
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
      const previous = profile.photo;
      profile.photo = dataUrl;
      if (!save('kismet.profile', profile)) { profile.photo = previous; return; }
      showPhoto(dataUrl);
    } catch (error) {
      console.error('Photo processing failed:', error);
      showToast('Could not process this photo. Try another image.');
    }
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
    save('kismet.profile', profile);
    showPhoto(null);
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    profile.name = document.getElementById('name-input').value.trim() || 'Anonymous';
    profile.country = document.getElementById('country-select').value;
    save('kismet.profile', profile);

    if (!save('kismet.profile', profile)) return;
    try {
      if (window.kismetDB && window.kismetUser) {
        const db = window.kismetDB;
        const user = window.kismetUser;
        const { error } = await db.supabase.from('profiles').upsert({
          user_id: user.id,
          name: profile.name,
          friend_code: profile.code,
          country: profile.country,
          photo_url: profile.photo,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        if (error) throw error;
      }
      await refreshStats();
      showToast('Profile saved successfully!');
    } catch (error) {
      console.error('Profile sync failed:', error);
      showToast('Saved on this device, but account sync failed.');
    }
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

  // Auth UI waits for the shared client and fails gracefully instead of polling forever.
  window.kismetReady.then(() => {
    const db = window.kismetDB;
    db.auth.getUser().then(updateAuthUI).catch(error => {
      console.error('Could not restore signed-in user:', error);
      updateAuthUI(null);
    });
    db.auth.onAuthChange((_event, session) => updateAuthUI(session?.user || null));

    document.getElementById('btn-signin').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      if (!email || !password) { showToast('Enter your email and password.'); return; }
      const { data, error } = await db.auth.signIn(email, password);
      if (error) showToast('Sign in failed: ' + error.message);
      else { showToast('Signed in!'); updateAuthUI(data.user); }
    });

    document.getElementById('btn-signup').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value;
      if (!email || password.length < 8) { showToast('Enter an email and a password with at least 8 characters.'); return; }
      const { data, error } = await db.auth.signUp(email, password);
      if (error) showToast('Sign up failed: ' + error.message);
      else if (data.session) { showToast('Account created!'); updateAuthUI(data.user); }
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
  }).catch(error => {
    console.error('Supabase auth unavailable:', error);
    showToast('Account features are unavailable. Reload to retry.');
    updateAuthUI(null);
  });

  // stats on load (wait for Supabase client)
  const waitForClient = () => new Promise((resolve) => {
    if (window.kismetSupabase) { resolve(); return; }
    let n = 0;
    const t = setInterval(() => {
      if (window.kismetSupabase || n > 100) { clearInterval(t); resolve(); }
      n++;
    }, 100);
  });
  waitForClient().then(refreshStats);
})();
