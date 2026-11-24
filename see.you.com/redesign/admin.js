/* Kismet admin panel — moderator email/password sign-in; all data via server-side RPCs. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const gate = $('admin-gate');
  const dashboard = $('admin-dashboard');
  const gateIcon = $('gate-icon') || gate.querySelector('.gate-icon');
  const gateTitle = $('gate-title');
  const gateText = $('gate-text');
  const gateSpinner = $('gate-spinner');
  const gateHome = $('gate-home');
  const retryBtn = $('admin-retry');
  const refreshBtn = $('admin-refresh');
  const refreshLabel = $('admin-refresh-label');
  const updatedLabel = $('admin-updated');
  const searchInput = $('profile-search');
  const panels = { stats: $('stats-grid'), reports: $('reports-body'), bans: $('bans-body'), profiles: $('profiles-body') };
  const loadLabels = { reports: 'Loading reports…', bans: 'Loading bans…', profiles: 'Loading profiles…' };
  const loaders = {};

  let refreshing = false;
  let profilesCache = [];
  let emailInput = null;
  let passwordInput = null;
  let loginForm = null;
  let loginError = null;
  let loginSubmit = null;
  let loginBuilt = false;

  const toast = (message) => {
    if (typeof window.showToast === 'function') window.showToast(message);
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const icon = (paths) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ['viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']
      .forEach((name, index) => svg.setAttribute(name, ['0 0 24 24', 'none', 'currentColor', '2', 'round', 'round'][index]));
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach((path) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('d', path);
      svg.appendChild(node);
    });
    return svg;
  };

  const rpc = async (name, params) => {
    const sb = window.kismetSupabase;
    if (!sb || typeof sb.rpc !== 'function') throw new Error('Supabase client unavailable');
    const { data, error } = params === undefined ? await sb.rpc(name) : await sb.rpc(name, params);
    if (error) throw error;
    return data;
  };

  const rowsOf = (data) => Array.isArray(data) ? data : [];

  const text = (value, fallback = '—') => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && value.trim()) return value.trim();
    return fallback;
  };

  const shortId = (value) => {
    const id = text(value, '');
    return id ? id.slice(0, 8) : '—';
  };

  const displayName = (name, code) => text(name, 'Anonymous') + (code ? ' (' + text(code) + ')' : '');

  const formatTime = (value) => {
    if (!value) return 'Unknown time';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown time';
    try {
      return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  };

  const durationText = (row) => {
    if (!row.expires_at) return 'Permanent';
    const expires = new Date(row.expires_at);
    if (Number.isNaN(expires.getTime())) return 'Until ' + text(row.expires_at);
    const ms = expires.getTime() - Date.now();
    if (ms <= 0) return 'Expired · ' + formatTime(row.expires_at);
    const minutes = Math.ceil(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    const left = days ? days + 'd ' + hours + 'h left' : hours ? hours + 'h ' + rest + 'm left' : rest + 'm left';
    return left + ' · ' + formatTime(row.expires_at);
  };

  // Only well-formed http(s) URLs (or same-origin relative paths) become image sources.
  const safePhotoUrl = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim(), window.location.href);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (_) {
      return '';
    }
  };

  const avatar = (photo, name) => {
    const src = safePhotoUrl(photo);
    if (!src) {
      const fallback = el('span', 'avatar-fallback', (text(name, '?').charAt(0) || '?').toUpperCase());
      fallback.setAttribute('aria-hidden', 'true');
      return fallback;
    }
    const img = el('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    return img;
  };

  const person = (role, name, code, photo) => {
    const wrap = el('div', 'person');
    wrap.appendChild(avatar(photo, name));
    const info = el('div', 'person-text');
    info.appendChild(el('span', 'person-role', role));
    info.appendChild(el('span', 'person-name', text(name, 'Anonymous')));
    if (code) info.appendChild(el('span', 'person-code', text(code)));
    wrap.appendChild(info);
    return wrap;
  };

  const cell = (label, content) => {
    const td = el('td');
    td.dataset.label = label;
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content === undefined || content === null ? '—' : String(content);
    return td;
  };

  const table = (headers, buildRow) => {
    const wrap = el('div', 'table-wrap');
    const node = el('table', 'data-table');
    const thead = el('thead');
    const headRow = el('tr');
    headers.forEach((heading) => {
      const th = el('th', '', heading);
      th.scope = 'col';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = el('tbody');
    buildRow(tbody);
    node.append(thead, tbody);
    wrap.appendChild(node);
    return wrap;
  };

  const loadingState = (label) => {
    const box = el('div', 'state');
    box.setAttribute('role', 'status');
    box.appendChild(el('span', 'spinner'));
    box.appendChild(el('strong', '', label));
    return box;
  };

  const emptyState = (title, detail) => {
    const box = el('div', 'state');
    box.appendChild(el('span', 'state-icon', '✓'));
    box.appendChild(el('strong', '', title));
    box.appendChild(el('p', '', detail));
    return box;
  };

  const errorState = (retry) => {
    const box = el('div', 'state');
    box.appendChild(el('span', 'state-icon error', '!'));
    box.appendChild(el('strong', '', 'Could not load this section'));
    box.appendChild(el('p', '', 'Check your connection and try again.'));
    const button = el('button', 'abtn small', 'Try again');
    button.type = 'button';
    button.addEventListener('click', retry);
    box.appendChild(button);
    return box;
  };

  const busy = (item, isBusy) => {
    item.querySelectorAll('button').forEach((button) => { button.disabled = isBusy; });
  };

  const setGate = (title, message, options = {}) => {
    $('gate-title').textContent = title;
    $('gate-text').textContent = message;
    gateIcon.hidden = false;
    gateTitle.hidden = false;
    gateText.hidden = false;
    gateSpinner.hidden = !options.spinner;
    gateHome.hidden = !options.home;
    retryBtn.hidden = !options.retry;
    const login = $('admin-login');
    if (login) login.hidden = true;
    gate.hidden = false;
  };

  const closeGate = () => {
    gate.hidden = true;
    if (dashboard) dashboard.hidden = false;
  };

  const leaveClosed = (title, message, options) => {
    if (dashboard) dashboard.remove();
    setGate(title, message, options);
  };

  const clearDashboard = () => {
    if (!dashboard) return;
    Object.keys(panels).forEach((key) => panels[key].replaceChildren());
    dashboard.querySelectorAll('[data-stat]').forEach((node) => { node.textContent = '—'; });
    ['reports-count', 'bans-count', 'profiles-count'].forEach((id) => {
      const node = $(id);
      if (node) node.textContent = '—';
    });
    updatedLabel.textContent = 'Not loaded yet';
    searchInput.value = '';
    profilesCache = [];
    dashboard.hidden = true;
  };

  // ---- Moderator sign in ----

  const ensureLoginStyles = () => {
    if (document.getElementById('admin-page-style') || document.getElementById('admin-login-style')) return;
    const style = document.createElement('style');
    style.id = 'admin-login-style';
    style.textContent = [
      '.login-form{display:grid;gap:.8rem;text-align:left}',
      '.login-mark{width:52px;height:52px;margin:0 auto .1rem;border-radius:15px;display:grid;place-items:center;background:rgba(245,158,11,.12);color:#f59e0b}',
      '.login-mark svg{width:25px;height:25px}',
      '.login-form h1{font-size:1.45rem;line-height:1.2;margin:0;text-align:center;color:#efe8d6}',
      '.login-lead{font-size:.82rem;line-height:1.55;color:#b6b1c4;margin:0 0 .3rem;text-align:center}',
      '.login-field{display:block;text-align:left}',
      '.login-field>span{display:block;font-size:.7rem;font-weight:800;color:#b6b1c4;margin-bottom:.3rem}',
      '.login-field input{width:100%;min-height:2.65rem;padding:.55rem .75rem;border-radius:10px;border:1px solid #232b47;background:#151b30;color:#efe8d6;font:inherit;font-size:.86rem}',
      '.login-field input:focus{outline:none;border-color:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.14)}',
      '.login-field input:focus-visible{outline:2px solid #f59e0b;outline-offset:1px}',
      '.login-error{margin:0;padding:.55rem .7rem;border-radius:9px;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.3);color:#fda4af;font-size:.76rem;line-height:1.45;text-align:left}',
      '.login-submit{width:100%;margin-top:.2rem}',
      '.abtn .mini-spinner{width:13px;height:13px;border:2px solid rgba(0,0,0,.25);border-top-color:currentColor;border-radius:50%;animation:admin-spin .7s linear infinite}',
      '@keyframes admin-spin{to{transform:rotate(360deg)}}'
    ].join('');
    document.head.appendChild(style);
  };

  const clearLoginError = () => {
    if (!loginError) return;
    loginError.textContent = '';
    loginError.hidden = true;
  };

  const setLoginError = (message) => {
    if (!loginError) return;
    loginError.textContent = message;
    loginError.hidden = !message;
  };

  const setLoginBusy = (isBusy) => {
    if (!loginSubmit) return;
    loginSubmit.disabled = isBusy;
    if (isBusy) {
      const spinner = el('span', 'mini-spinner');
      spinner.setAttribute('aria-hidden', 'true');
      loginSubmit.replaceChildren(spinner, document.createTextNode(' Signing in…'));
    } else {
      loginSubmit.textContent = 'Sign in';
    }
  };

  const showLogin = () => {
    ensureLoginStyles();
    let wrap = $('admin-login');
    if (!wrap) {
      wrap = el('div');
      wrap.id = 'admin-login';
      gate.querySelector('.gate-card')?.appendChild(wrap);
    }
    if (!loginBuilt) {
      loginForm = el('form', 'login-form');
      loginForm.noValidate = true;
      const mark = el('span', 'login-mark');
      mark.appendChild(icon(['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4']));

      emailInput = el('input');
      emailInput.type = 'email';
      emailInput.id = 'admin-email';
      emailInput.name = 'email';
      emailInput.autocomplete = 'username';
      emailInput.inputMode = 'email';
      emailInput.placeholder = 'you@example.com';
      emailInput.required = true;
      const emailField = el('label', 'login-field');
      emailField.append(el('span', '', 'Email'), emailInput);

      passwordInput = el('input');
      passwordInput.type = 'password';
      passwordInput.id = 'admin-password';
      passwordInput.name = 'password';
      passwordInput.autocomplete = 'current-password';
      passwordInput.placeholder = '••••••••';
      passwordInput.required = true;
      const passwordField = el('label', 'login-field');
      passwordField.append(el('span', '', 'Password'), passwordInput);

      loginError = el('p', 'login-error');
      loginError.id = 'login-error';
      loginError.setAttribute('role', 'alert');
      loginError.hidden = true;

      loginSubmit = el('button', 'abtn primary login-submit', 'Sign in');
      loginSubmit.type = 'submit';

      loginForm.append(
        mark,
        el('h1', '', 'Moderator sign in'),
        el('p', 'login-lead', 'Use the email and password assigned to you by the Kismet team. This area is for moderators only.'),
        emailField,
        passwordField,
        loginError,
        loginSubmit
      );

      emailInput.addEventListener('input', clearLoginError);
      passwordInput.addEventListener('input', clearLoginError);
      loginForm.addEventListener('submit', handleLogin);
      wrap.appendChild(loginForm);
      loginBuilt = true;
    }

    gate.hidden = false;
    if (dashboard && !dashboard.hidden) dashboard.hidden = true;
    gateIcon.hidden = true;
    gateTitle.hidden = true;
    gateText.hidden = true;
    gateSpinner.hidden = true;
    gateHome.hidden = true;
    retryBtn.hidden = true;
    wrap.hidden = false;
    clearLoginError();
    try { emailInput.focus(); } catch (_) { /* focus is a nicety */ }
  };

  const applyRealtimeAuth = (session) => {
    try {
      const sb = window.kismetSupabase;
      if (session?.access_token && typeof sb?.realtime?.setAuth === 'function') {
        sb.realtime.setAuth(session.access_token);
      }
    } catch (error) {
      console.error('[admin] realtime auth update failed:', error?.message || error);
    }
  };

  const isEmailSession = (session) => {
    const user = session?.user;
    return Boolean(user && user.email && !user.is_anonymous);
  };

  const signOutQuiet = async () => {
    try {
      if (window.kismetSupabase?.auth) await window.kismetSupabase.auth.signOut();
    } catch (error) {
      console.error('[admin] sign out failed:', error?.message || error);
    }
  };

  const verifyAdmin = async () => {
    try {
      const isAdmin = await rpc('kismet_is_admin');
      if (isAdmin !== true) {
        await signOutQuiet();
        leaveClosed('Admin access required', 'This account is not a Kismet moderator. Head back home to keep chatting.', { home: true });
        return;
      }
    } catch (error) {
      console.error('[admin] access check failed:', error?.message || error);
      showLogin('Could not verify admin access. Check your connection and try again.');
      toast('Could not verify admin access. Try again.');
      return;
    }
    closeGate();
    await refreshAll();
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    if (!emailInput || !passwordInput) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value; // never displayed, logged or stored
    if (!email || !password) {
      setLoginError('Enter both your email and password.');
      toast('Enter your email and password.');
      return;
    }

    clearLoginError();
    setLoginBusy(true);
    try {
      const sb = window.kismetSupabase;
      if (!sb?.auth?.signInWithPassword) throw new Error('Authentication is unavailable');
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const session = data?.session;
      if (!session?.user) throw new Error('Sign in did not return a session');
      applyRealtimeAuth(session);
      await verifyAdmin();
    } catch (error) {
      const reason = error?.message || '';
      const networkError = /network|fetch|offline|timeout|econn|unavailable/i.test(reason);
      setLoginError(networkError
        ? 'Could not reach the server. Check your connection and try again.'
        : 'That email and password did not work. Check them and try again.');
      toast(networkError ? 'Network error — please try again.' : 'Sign in failed. Check your email and password.');
      console.error('[admin] sign-in failed:', reason || 'unknown error');
    } finally {
      setLoginBusy(false);
      passwordInput.value = '';
    }
  };

  // ---- Data loaders (each owns its panel's success state) ----

  loaders.stats = async () => {
    const data = await rpc('kismet_admin_stats');
    const stats = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const values = {
      pending: stats.reports_pending,
      reports: stats.reports_total,
      bans: stats.bans_active,
      users: stats.users_total,
      calls: stats.calls_active,
      profiles: stats.profiles_total
    };
    Object.keys(values).forEach((key) => {
      const node = dashboard.querySelector('[data-stat="' + key + '"]');
      if (!node) return;
      const value = Number(values[key]);
      node.textContent = Number.isFinite(value) ? value.toLocaleString() : '0';
    });
  };

  const reportCard = (row) => {
    const item = el('article', 'report');
    const top = el('div', 'report-top');
    const idWrap = el('div');
    idWrap.appendChild(el('span', 'report-id', 'Report ' + shortId(row.id)));
    if (row.status) {
      const chip = el('span', 'chip', text(row.status));
      chip.style.marginLeft = '.4rem';
      idWrap.appendChild(chip);
    }
    const time = el('time', 'time', formatTime(row.created_at));
    if (row.created_at) time.dateTime = String(row.created_at);
    top.append(idWrap, time);

    const people = el('div', 'people');
    people.append(
      person('Reporter', row.reporter_name, row.reporter_code, row.reporter_photo),
      el('span', 'people-arrow', '→'),
      person('Reported', row.reported_name, row.reported_code, row.reported_photo)
    );

    const reason = el('div', 'reason');
    reason.appendChild(el('span', 'reason-label', 'Reason'));
    reason.appendChild(el('p', '', text(row.reason, 'No reason provided')));

    item.append(top, people, reason);

    if (row.call_id) {
      const meta = el('div', 'meta');
      meta.appendChild(el('span', '', 'Call '));
      meta.appendChild(el('code', '', shortId(row.call_id)));
      item.appendChild(meta);
    }

    const actions = el('div', 'report-actions');
    [['dismiss', 'Dismiss', 'abtn small ghost'], ['warn', 'Warn', 'abtn small warn'], ['ban', 'Ban', 'abtn small danger']].forEach(([action, label, className]) => {
      const button = el('button', className, label);
      button.type = 'button';
      button.addEventListener('click', () => resolveReport(row, action, item));
      actions.appendChild(button);
    });
    item.appendChild(actions);
    return item;
  };

  loaders.reports = async () => {
    const rows = rowsOf(await rpc('kismet_admin_list_reports'));
    $('reports-count').textContent = String(rows.length);
    if (!rows.length) {
      panels.reports.replaceChildren(emptyState('Queue is clear', 'New reports will appear here as soon as they are submitted.'));
      return;
    }
    const list = el('div', 'report-list');
    rows.forEach((row) => list.appendChild(reportCard(row)));
    panels.reports.replaceChildren(list);
  };

  const banUser = async (userId, reason, successMessage) => {
    const ok = await rpc('kismet_admin_ban_user', {
      p_user_id: userId,
      p_reason: String(reason).slice(0, 500),
      p_duration_minutes: null
    });
    if (!ok) throw new Error('Ban was not applied');
    if (successMessage) toast(successMessage);
  };

  const resolveReport = async (row, action, item) => {
    if (!row.id || !row.reported_id) {
      toast('This report is missing an ID. It cannot be actioned.');
      return;
    }
    if (action === 'ban' && !window.confirm('Permanently ban ' + displayName(row.reported_name, row.reported_code) + ' from Kismet?\n\nThis will also resolve the report.')) return;

    busy(item, true);
    try {
      if (action === 'ban') {
        const reason = 'Report ' + shortId(row.id) + ': ' + text(row.reason, 'No reason provided');
        await banUser(row.reported_id, reason, '');
        let resolved = true;
        try {
          await rpc('kismet_admin_resolve_report', { p_report_id: row.id, p_action: 'ban', p_note: 'Banned from report queue.' });
        } catch (error) {
          console.error('[admin] could not resolve banned report:', error?.message || error);
          resolved = false;
        }
        toast(resolved ? 'User banned. Report resolved.' : 'User banned, but the report could not be resolved.');
        await refreshAll(['reports', 'bans', 'stats', 'profiles']);
      } else {
        await rpc('kismet_admin_resolve_report', { p_report_id: row.id, p_action: action, p_note: '' });
        toast(action === 'dismiss' ? 'Report dismissed.' : 'Warning issued.');
        await refreshAll(['reports', 'stats']);
      }
    } catch (error) {
      console.error('[admin] report action failed:', error?.message || error);
      toast('That action could not be completed. Try again.');
    } finally {
      busy(item, false);
    }
  };

  loaders.bans = async () => {
    const rows = rowsOf(await rpc('kismet_admin_list_bans'));
    $('bans-count').textContent = String(rows.length);
    if (!rows.length) {
      panels.bans.replaceChildren(emptyState('No active bans', 'Bans will show up here with their reason and remaining time.'));
      return;
    }
    panels.bans.replaceChildren(table(['User', 'Reason', 'Duration', 'Status', 'Action'], (tbody) => {
      rows.forEach((row) => {
        const tr = el('tr');
        const user = el('div', 'cell-user');
        user.append(avatar(row.reported_photo, row.reported_name || row.user_id));
        const info = el('div', 'person-text');
        info.appendChild(el('span', 'person-name', text(row.reported_name, 'Anonymous')));
        if (row.reported_code) info.appendChild(el('span', 'person-code', text(row.reported_code)));
        info.appendChild(el('span', 'uid', shortId(row.user_id)));
        user.appendChild(info);

        const status = el('span', 'chip ' + (row.active === false ? 'expired' : 'active'), row.active === false ? 'Inactive' : 'Active');
        const button = el('button', 'abtn small danger', 'Unban');
        button.type = 'button';
        button.addEventListener('click', () => unban(row, button));

        tr.append(
          cell('User', user),
          cell('Reason', text(row.reason, 'No reason given')),
          cell('Duration', durationText(row)),
          cell('Status', status),
          cell('Action', button)
        );
        tbody.appendChild(tr);
      });
    }));
  };

  const unban = async (row, button) => {
    const who = displayName(row.reported_name || shortId(row.user_id), row.reported_code);
    if (!window.confirm('Unban ' + who + '? They will be able to use Kismet again.')) return;
    if (!row.user_id) {
      toast('This ban is missing a user ID.');
      return;
    }
    button.disabled = true;
    try {
      const ok = await rpc('kismet_admin_unban_user', { p_user_id: row.user_id });
      if (!ok) throw new Error('Unban was not applied');
      toast('User unbanned.');
      await refreshAll(['bans', 'stats', 'profiles']);
    } catch (error) {
      console.error('[admin] unban failed:', error?.message || error);
      toast('Could not unban this user. Try again.');
    } finally {
      button.disabled = false;
    }
  };

  const renderProfiles = () => {
    const query = (searchInput.value || '').trim().toLowerCase();
    const matches = query
      ? profilesCache.filter((row) => [row.user_id, row.name, row.friend_code, row.country].some((value) => String(value ?? '').toLowerCase().includes(query)))
      : profilesCache;

    if (!matches.length) {
      panels.profiles.replaceChildren(emptyState(
        query ? 'No matching profiles' : 'No profiles yet',
        query ? 'Try another name, friend code, country or user ID.' : 'Profiles will appear here once people create them.'
      ));
      return;
    }

    panels.profiles.replaceChildren(table(['User', 'Friend code', 'Country', 'Joined', 'Status', 'Action'], (tbody) => {
      matches.forEach((row) => {
        const tr = el('tr');
        const user = el('div', 'cell-user');
        user.append(avatar(row.photo_url, row.name || row.user_id));
        const info = el('div', 'person-text');
        info.appendChild(el('span', 'person-name', text(row.name, 'Anonymous')));
        info.appendChild(el('span', 'uid', shortId(row.user_id)));
        user.appendChild(info);

        const button = el('button', 'abtn small danger', row.banned ? 'Banned' : 'Ban');
        button.type = 'button';
        button.disabled = Boolean(row.banned);
        if (!row.banned) button.addEventListener('click', () => banProfile(row, button));

        tr.append(
          cell('User', user),
          cell('Friend code', row.friend_code ? el('span', 'cell-code', text(row.friend_code)) : '—'),
          cell('Country', text(row.country)),
          cell('Joined', formatTime(row.created_at)),
          cell('Status', el('span', 'chip ' + (row.banned ? 'banned' : 'active'), row.banned ? 'Banned' : 'Active')),
          cell('Action', button)
        );
        tbody.appendChild(tr);
      });
    }));
  };

  loaders.profiles = async () => {
    profilesCache = rowsOf(await rpc('kismet_admin_list_profiles', { p_limit: 100 }));
    $('profiles-count').textContent = String(profilesCache.length);
    renderProfiles();
  };

  const banProfile = async (row, button) => {
    const who = displayName(row.name, row.friend_code);
    if (!window.confirm('Permanently ban ' + who + ' from Kismet?\n\nThis cannot be undone from here without an explicit unban.')) return;
    if (!row.user_id) {
      toast('This profile is missing a user ID.');
      return;
    }
    button.disabled = true;
    try {
      await banUser(row.user_id, 'Banned by moderator from admin panel.', 'User banned.');
      await refreshAll(['profiles', 'bans', 'stats']);
    } catch (error) {
      console.error('[admin] profile ban failed:', error?.message || error);
      toast('Could not ban this user. Try again.');
      button.disabled = false;
    }
  };

  // ---- Refresh orchestration ----

  const loadSection = async (key) => {
    const panel = panels[key];
    panel.setAttribute('aria-busy', 'true');
    if (key === 'stats') {
      // Keep the six cards in place; only their values change while loading.
      panel.querySelectorAll('[data-stat]').forEach((node) => { node.textContent = '…'; });
    } else {
      panel.replaceChildren(loadingState(loadLabels[key]));
    }
    try {
      await loaders[key]();
    } catch (error) {
      console.error('[admin] ' + key + ' load failed:', error?.message || error);
      if (key === 'stats') {
        panel.querySelectorAll('[data-stat]').forEach((node) => { node.textContent = '—'; });
        toast('Statistics could not be loaded. Use Refresh to try again.');
      } else if (panels[key] === panel) {
        panel.replaceChildren(errorState(() => loadSection(key)));
      }
    } finally {
      panel.setAttribute('aria-busy', 'false');
    }
  };

  const refreshAll = async (keys = Object.keys(loaders), announce = false) => {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.setAttribute('aria-busy', 'true');
    const spinner = el('span', 'mini-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    refreshLabel.replaceChildren(spinner, document.createTextNode(' Refreshing…'));
    try {
      await Promise.all(keys.map(loadSection));
      updatedLabel.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      if (announce) toast('Dashboard refreshed');
    } finally {
      refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute('aria-busy');
      refreshLabel.textContent = 'Refresh';
    }
  };

  // ---- Boot ----

  const boot = async () => {
    let signOutBtn = $('admin-signout');
    if (!signOutBtn) {
      signOutBtn = el('button', 'abtn ghost', 'Sign out');
      signOutBtn.id = 'admin-signout';
      signOutBtn.type = 'button';
      dashboard?.querySelector('.top-actions')?.appendChild(signOutBtn);
    }
    signOutBtn.addEventListener('click', async () => {
      await signOutQuiet();
      clearDashboard();
      showLogin();
      toast('Signed out.');
    });

    retryBtn.addEventListener('click', () => window.location.reload());
    refreshBtn.addEventListener('click', () => refreshAll(Object.keys(loaders), true));
    searchInput.addEventListener('input', renderProfiles);

    if (!window.kismetReady) {
      leaveClosed('Admin panel unavailable', 'We could not start a secure session. Please try again in a moment.', { retry: true });
      return;
    }

    try {
      await window.kismetReady;
    } catch (error) {
      console.error('[admin] session unavailable:', error?.message || error);
      leaveClosed('Admin panel unavailable', 'We could not start a secure session. Please try again in a moment.', { retry: true });
      return;
    }

    const sb = window.kismetSupabase;
    if (!sb?.auth?.getSession) {
      leaveClosed('Admin panel unavailable', 'Authentication is not available right now. Please try again.', { retry: true });
      return;
    }

    let session = null;
    try {
      session = (await sb.auth.getSession())?.data?.session || null;
    } catch (error) {
      console.error('[admin] could not restore session:', error?.message || error);
    }

    if (isEmailSession(session)) {
      applyRealtimeAuth(session);
      await verifyAdmin();
      return;
    }

    // The shared helper may have created an anonymous session; the login below
    // replaces it with the moderator's email/password session.
    showLogin();
  };

  boot();
})();
