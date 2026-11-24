/* Shared display helpers for revealed Kismet identities. */
(function () {
  const MAX_PHOTO_LENGTH = 1200000;

  const safePhotoUrl = (value) => {
    if (typeof value !== 'string' || !value || value.length > MAX_PHOTO_LENGTH) return '';
    const raw = value.trim();
    if (/^https:\/\/\S+$/i.test(raw)) {
      try {
        const url = new URL(raw);
        return url.protocol === 'https:' ? url.href : '';
      } catch (_) { return ''; }
    }
    if (/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
      return raw.replace(/\s/g, '');
    }
    return '';
  };

  const displayName = (person) => {
    const value = typeof person?.name === 'string' ? person.name.trim() : '';
    return value || 'Anonymous';
  };

  const initials = (person) => {
    const words = displayName(person).split(/\s+/).filter(Boolean);
    const letters = words.slice(0, 2).map(word => Array.from(word)[0] || '');
    return (letters.join('') || '?').toUpperCase().slice(0, 2);
  };

  const avatar = (person, size = 44) => {
    const wrap = document.createElement('span');
    wrap.className = 'km-avatar';
    wrap.style.setProperty('--km-avatar-size', size + 'px');
    wrap.setAttribute('aria-hidden', 'true');

    const fallback = document.createElement('span');
    fallback.className = 'km-avatar__initials';
    fallback.textContent = initials(person);
    wrap.appendChild(fallback);

    const photo = safePhotoUrl(person?.photo_url || person?.photo);
    if (photo) {
      const img = document.createElement('img');
      img.src = photo;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove(), { once: true });
      wrap.appendChild(img);
    }
    return wrap;
  };

  const timeLabel = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    try {
      return new Intl.DateTimeFormat(undefined, sameDay
        ? { hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric' }).format(date);
    } catch (_) {
      return sameDay ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString();
    }
  };

  window.kismetIdentity = { safePhotoUrl, displayName, initials, avatar, timeLabel };
})();
