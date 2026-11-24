/* Emoji picker for the Kismet chat composer.
   Uses FF-PV-MASG/emoji.js data: window.EMOJI_CATEGORIES / window.searchEmoji. */
(function () {
  const picker = document.getElementById('emoji-picker');
  const button = document.getElementById('emoji-btn');
  const input = document.getElementById('msg-input');
  const tabs = document.getElementById('emoji-tabs');
  const grid = document.getElementById('emoji-grid');
  const search = document.getElementById('emoji-search');
  const hint = document.getElementById('emoji-hint');
  const closeBtn = document.getElementById('emoji-close');
  const categories = window.EMOJI_CATEGORIES || [];
  if (!picker || !button || !input || !tabs || !grid || !search || !hint || !closeBtn || !categories.length) return;

  let activeCat = categories[0].id;
  let searchTimer = null;
  const cache = new Map();
  const isOpen = () => picker.classList.contains('on');

  const emojiButton = ch => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ke-emoji';
    b.dataset.emoji = ch;
    b.textContent = ch;
    b.setAttribute('aria-label', 'Insert ' + ch);
    return b;
  };

  categories.forEach((cat, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.cat = cat.id;
    tab.title = cat.name;
    tab.textContent = cat.icon;
    tab.setAttribute('aria-label', cat.name);
    if (index === 0) tab.classList.add('on');
    tab.addEventListener('click', () => {
      activeCat = cat.id;
      tabs.querySelectorAll('button').forEach(item => item.classList.toggle('on', item === tab));
      search.value = '';
      hint.textContent = cat.name;
      renderActive();
      grid.scrollTop = 0;
    });
    tabs.appendChild(tab);
  });

  const buildCategory = cat => {
    if (cache.has(cat.id)) return cache.get(cat.id);
    const fragment = document.createDocumentFragment();
    cat.emojis.forEach(ch => fragment.appendChild(emojiButton(ch)));
    cache.set(cat.id, fragment);
    return fragment;
  };

  const renderActive = () => {
    const cat = categories.find(item => item.id === activeCat) || categories[0];
    grid.replaceChildren(buildCategory(cat).cloneNode(true));
  };

  const runSearch = () => {
    const query = search.value.trim();
    if (!query) {
      hint.textContent = 'Pick an emoji';
      renderActive();
      return;
    }
    const list = typeof window.searchEmoji === 'function'
      ? window.searchEmoji(query)
      : categories.find(cat => cat.name.toLowerCase().includes(query.toLowerCase()))?.emojis || [];
    const fragment = document.createDocumentFragment();
    list.forEach(ch => fragment.appendChild(emojiButton(ch)));
    if (!list.length) {
      const none = document.createElement('div');
      none.className = 'ke-none';
      none.textContent = 'No emoji found for “' + query + '”';
      fragment.appendChild(none);
    }
    hint.textContent = list.length ? list.length + ' results' : 'No results';
    grid.replaceChildren(fragment);
    grid.scrollTop = 0;
  };

  const insertEmoji = ch => {
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;
    if (start + ch.length > input.maxLength && input.maxLength > 0) return;
    input.value = input.value.slice(0, start) + ch + input.value.slice(end);
    const caret = start + ch.length;
    try { input.setSelectionRange(caret, caret); } catch (_) {}
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const positionPicker = () => {
    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(vw * 0.94, 360);
    const height = Math.min(vh * 0.6, 400);
    const gap = 8;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(gap, Math.min(left, vw - width - gap));
    let top = rect.top - height - gap;
    if (top < gap) top = rect.bottom + gap;
    if (top + height > vh - gap) top = Math.max(gap, vh - height - gap);
    picker.style.left = left + 'px';
    picker.style.top = top + 'px';
    picker.style.width = width + 'px';
    picker.style.height = height + 'px';
  };

  const open = () => {
    picker.classList.add('on');
    button.classList.add('act');
    positionPicker();
    renderActive();
    grid.scrollTop = 0;
    search.value = '';
    hint.textContent = 'Pick an emoji';
    window.setTimeout(() => search.focus({ preventScroll: true }), 40);
  };

  const close = () => {
    picker.classList.remove('on');
    button.classList.remove('act');
    window.clearTimeout(searchTimer);
  };

  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(runSearch, 120);
  });
  search.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  grid.addEventListener('click', event => {
    const target = event.target.closest('button[data-emoji]');
    if (target) insertEmoji(target.dataset.emoji);
  });
  button.addEventListener('click', event => {
    event.stopPropagation();
    isOpen() ? close() : open();
  });
  closeBtn.addEventListener('click', close);
  document.addEventListener('click', event => {
    if (!isOpen()) return;
    if (picker.contains(event.target) || button.contains(event.target)) return;
    close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && isOpen()) close(); });
  window.addEventListener('resize', () => { if (isOpen()) positionPicker(); });
  window.addEventListener('scroll', () => { if (isOpen()) positionPicker(); }, true);

  window.kismetEmoji = { open, close, isOpen, insert: insertEmoji };
})();
