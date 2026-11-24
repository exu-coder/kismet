/* Profile page logic */
(() => {
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (error) { console.error('Could not save profile locally:', error); showToast('Storage is full. Choose a smaller photo.'); return false; } };

  const countries = [
    'Afghanistan','Albania','Algeria','Argentina','Australia','Austria','Bangladesh','Belgium','Bolivia','Brazil','Canada','Chile','China','Colombia','Costa Rica','Cuba','Czech Republic','Denmark','Dominican Republic','Ecuador','Egypt','El Salvador','Finland','France','Germany','Greece','Guatemala','Honduras','Hungary','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Japan','Jordan','Kenya','Malaysia','Mexico','Morocco','Netherlands','New Zealand','Nicaragua','Nigeria','Norway','Pakistan','Panama','Paraguay','Peru','Philippines','Poland','Portugal','Romania','Russia','Saudi Arabia','South Africa','South Korea','Spain','Sweden','Switzerland','Thailand','Turkey','Ukraine','United Kingdom','United States','Uruguay','Venezuela','Vietnam'
  ];

  let profile = load('kismet.profile', { name: 'Anonymous', code: null, photo: null, country: '' });
  if (profile.code) localStorage.setItem('kismet.mycode', profile.code);

  const getUserId = () => window.kismetUser?.id || null;

  // Stable friend code: deterministic per account, never random once an id is known.
  const ensureCode = () => {
    if (profile.code) return profile.code;
    const id = getUserId();
    if (!id) return null;
    profile.code = 'KS-' + id.replace(/-/g, '').slice(0, 6).toUpperCase();
    save('kismet.profile', profile);
    localStorage.setItem('kismet.mycode', profile.code);
    return profile.code;
  };

  const refreshStats = async () => {
    const elFriends = document.getElementById('stat-friends');
    const elReqs = document.getElementById('stat-reqs');
    if (!elFriends || !elReqs || !window.kismetSupabase) return;
    const userId = getUserId();
    if (!userId) return;
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
  document.getElementById('code-display').textContent = ensureCode() || '…';
  // identity is hidden by default; reveal happens per-call, not here

  const photoImg = document.getElementById('photo-img');
  const photoPlaceholder = document.getElementById('photo-placeholder');
  const showPhoto = (src) => {
    const overlay = document.getElementById('photo-overlay');
    if (src) { photoImg.src = src; photoImg.style.display = 'block'; photoImg.style.borderRadius = '50%'; photoPlaceholder.style.display = 'none'; if (overlay) overlay.style.display = 'none'; }
    else { photoImg.style.display = 'none'; photoPlaceholder.style.display = 'block'; if (overlay) overlay.style.display = 'block'; }
    updatePreview();
  };

  const updatePreview = () => {
    const namePreview = document.getElementById('profile-name-preview');
    if (namePreview) namePreview.textContent = profile.name || 'Anonymous';
    const checks = [profile.name && profile.name !== 'Anonymous', profile.country, profile.photo].filter(Boolean).length;
    const pct = Math.round((checks / 3) * 100);
    const label = document.getElementById('completeness-label');
    const bar = document.getElementById('completeness-bar');
    const meter = document.querySelector('.meter');
    if (label) label.textContent = pct + '%';
    if (bar) bar.style.width = pct + '%';
    if (meter) meter.setAttribute('aria-valuenow', String(pct));
  };

  ['name-input', 'country-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => {
      profile.name = document.getElementById('name-input').value.trim() || 'Anonymous';
      profile.country = document.getElementById('country-select').value;
      updatePreview();
    });
  });

  document.getElementById('copy-code')?.addEventListener('click', async () => {
    const code = document.getElementById('code-display')?.textContent?.trim();
    if (!code || code === '…') return;
    try {
      await navigator.clipboard.writeText(code);
      showToast('Friend code copied!');
    } catch (error) {
      showToast('Could not copy automatically. Your code is ' + code);
    }
  });

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
    if (el) el.addEventListener('change', (e) => { const file = e.target.files[0]; handlePhoto(file); e.target.value = ''; });
  });

  document.getElementById('remove-photo').addEventListener('click', () => {
    profile.photo = null;
    save('kismet.profile', profile);
    showPhoto(null);
  });

  // ---- Remote profile hydration ----
  let hasRemoteProfile = false;
  let hydratePromise = Promise.resolve();

  const applyProfileToUI = () => {
    document.getElementById('name-input').value = profile.name || '';
    const sel = document.getElementById('country-select');
    if (sel && profile.country && [...sel.options].some(opt => opt.value === profile.country)) {
      sel.value = profile.country;
    }
    document.getElementById('code-display').textContent = profile.code || '…';
    showPhoto(profile.photo);
    updatePreview();
  };

  const hydrateProfile = async () => {
    const id = getUserId();
    if (!id || !window.kismetSupabase) { ensureCode(); applyProfileToUI(); return; }
    try {
      const { data, error } = await window.kismetSupabase
        .from('profiles')
        .select('*')
        .eq('user_id', id)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        hasRemoteProfile = true;
        if (data.name) profile.name = data.name;
        if (data.friend_code) profile.code = data.friend_code;
        if (data.country) profile.country = data.country;
        // Never wipe a photo the user just picked locally with an empty DB value.
        if (data.photo_url) profile.photo = data.photo_url;
      }
      ensureCode();
      save('kismet.profile', profile);
      if (profile.code) localStorage.setItem('kismet.mycode', profile.code);
      applyProfileToUI();
    } catch (error) {
      console.warn('Could not load saved profile from the account:', error);
      ensureCode();
      applyProfileToUI();
    }
  };

  const saveBtn = document.getElementById('save-btn');
  const setSaving = (busy) => {
    if (!saveBtn) return;
    saveBtn.disabled = busy;
    const label = saveBtn.querySelector('span');
    if (label) label.textContent = busy ? 'Saving…' : 'Save profile';
  };

  saveBtn?.addEventListener('click', async () => {
    profile.name = document.getElementById('name-input').value.trim() || 'Anonymous';
    profile.country = document.getElementById('country-select').value;
    if (!hasRemoteProfile) ensureCode();
    if (!save('kismet.profile', profile)) return;
    setSaving(true);
    try {
      await window.kismetReady;
      await hydratePromise;
      if (!profile.code) ensureCode();
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
        localStorage.setItem('kismet.mycode', profile.code);
        document.getElementById('code-display').textContent = profile.code;
      }
      updatePreview();
      await refreshStats();
      showToast('Profile saved successfully!');
    } catch (error) {
      console.error('Profile sync failed:', error);
      showToast('Saved on this device, but account sync failed.');
    } finally {
      setSaving(false);
    }
  });

  // Load the saved profile first, then stats, once the anonymous session is ready.
  hydratePromise = window.kismetReady.then(hydrateProfile).catch(error => {
    console.warn('Profile sync unavailable until the secure session is ready:', error);
    ensureCode();
    applyProfileToUI();
  });

  window.kismetReady.then(refreshStats).catch(error => {
    console.warn('Profile stats unavailable until the secure session is ready:', error);
  });
})();
