/* Kismet safety UI — 18+ gate, camera check, anonymous one-press reporting */
(() => {
  const SUPABASE_URL = 'https://xjckwcvwssuadqkxgumt.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqY2t3Y3Z3c3N1YWRxa3hndW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0MzMyODUsImV4cCI6MjExMTAwOTI4NX0.tJQx1OTv49cci97EcWv82JjToif-CJvcvWDLsRV6ac0';

  const $ = (id) => document.getElementById(id);
  const ageGate = $('age-gate');
  const reportModal = $('report-modal');
  const reportBtn = $('btn-report');
  const warning = $('camera-warning');
  let sb = null;
  let current = { partnerId: null, callId: null };

  // ---- 18+ gate ----
  let isAdult = localStorage.getItem('kismet.age18') === 'yes';
  const showAgeGate = () => { if (ageGate) ageGate.hidden = false; };
  if (!isAdult) showAgeGate();

  $('age-accept')?.addEventListener('click', () => {
    localStorage.setItem('kismet.age18', 'yes');
    isAdult = true;
    if (ageGate) ageGate.hidden = true;
  });
  $('age-leave')?.addEventListener('click', () => { window.location.href = '/'; });

  // Intercept Start before videochat.js sees it when the gate is not accepted.
  document.addEventListener('click', (e) => {
    if (isAdult || !e.target?.closest) return;
    if (e.target.closest('#btn-start')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showAgeGate();
    }
  }, true);

  // ---- Call lifecycle ----
  window.addEventListener('kismet:call-started', (e) => {
    current = e.detail || {};
    if (reportBtn) reportBtn.disabled = false;
  });
  window.addEventListener('kismet:call-ended', () => {
    current = { partnerId: null, callId: null };
    if (reportBtn) reportBtn.disabled = true;
    if (reportModal) reportModal.hidden = true;
  });

  // ---- Camera check (dark / covered / frozen) ----
  const snapshot = (video) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, 64, 48);
    return ctx.getImageData(0, 0, 64, 48).data;
  };
  const brightness = (d) => {
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  };
  const showWarning = (text) => {
    if (!warning) return;
    warning.textContent = text;
    warning.hidden = false;
    clearTimeout(showWarning._t);
    showWarning._t = setTimeout(() => { warning.hidden = true; }, 8000);
  };

  window.addEventListener('kismet:camera-ready', (e) => {
    const stream = e.detail?.stream;
    if (!stream || !stream.getVideoTracks().length || !warning) return;
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.addEventListener('loadedmetadata', () => {
      video.play().then(() => {
        setTimeout(() => {
          try {
            const first = snapshot(video);
            if (brightness(first) < 18) {
              showWarning('Your camera looks dark or blocked. Check your light and lens, then try again.');
              return;
            }
            setTimeout(() => {
              try {
                const second = snapshot(video);
                let diff = 0;
                for (let i = 0; i < first.length; i += 4) diff += Math.abs(first[i] - second[i]);
                if (diff / (first.length / 4) < 1.5) {
                  showWarning('Your camera looks frozen. Check that your camera is connected.');
                }
              } catch (_) {}
            }, 1000);
          } catch (_) {}
        }, 700);
      }).catch(() => {});
    }, { once: true });
  });

  // ---- Reporting ----
  const waitForSupabase = () => new Promise((resolve) => {
    if (window.supabase) { resolve(); return; }
    let n = 0;
    const t = setInterval(() => {
      if (window.supabase || n > 100) { clearInterval(t); resolve(); }
      n++;
    }, 100);
  });

  reportBtn?.addEventListener('click', () => {
    if (!current.partnerId) return;
    if (reportModal) reportModal.hidden = false;
  });
  $('report-cancel')?.addEventListener('click', () => {
    if (reportModal) reportModal.hidden = true;
  });
  $('report-submit')?.addEventListener('click', async () => {
    if (!current.partnerId) return;
    const checked = document.querySelector('input[name="report-reason"]:checked');
    const reason = checked?.value || 'other';
    await waitForSupabase();
    if (!window.supabase) return;
    if (!sb) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const reporterId = localStorage.getItem('kismet.anonId') || '';
    const { error } = await sb.from('reports').insert({
      reporter_id: reporterId,
      reported_id: current.partnerId,
      reason,
      call_id: current.callId,
    });
    if (reportModal) reportModal.hidden = true;
    if (error) {
      console.error(error);
      window.dispatchEvent(new Event('kismet:report-failed'));
      return;
    }
    window.dispatchEvent(new Event('kismet:report'));
  });

  // Surface a failed report through the existing toast element
  window.addEventListener('kismet:report-failed', () => {
    const toast = $('vc-toast');
    if (!toast) return;
    toast.textContent = 'Could not submit report — please try again';
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
  });
})();
