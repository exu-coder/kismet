/* Kismet safety UI — 18+ gate, camera check, anonymous one-press reporting */
(() => {
  const $ = (id) => document.getElementById(id);
  const ageGate = $('age-gate');
  const reportModal = $('report-modal');
  const reportBtn = $('btn-report');
  const warning = $('camera-warning');
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
  // Uses the shared window.kismetReady client from redesign/supabase.js
  reportBtn?.addEventListener('click', () => {
    if (!current.partnerId) return;
    if (reportModal) reportModal.hidden = false;
  });
  $('report-cancel')?.addEventListener('click', () => {
    if (reportModal) reportModal.hidden = true;
  });
  $('report-submit')?.addEventListener('click', async (event) => {
    // Capture the call identity BEFORE any await — the call may end while the
    // dialog is open, which clears `current` via kismet:call-ended.
    const reportTarget = { ...current };
    if (!reportTarget.partnerId) return;
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = 'Submitting…';
    try {
      const client = await window.kismetReady;
      const reporterId = window.kismetUser?.id;
      if (!reporterId) throw new Error('Could not identify this session');
      const checked = document.querySelector('input[name="report-reason"]:checked');
      const reason = checked?.value || 'other';
      const { error } = await client.from('reports').insert({
        reporter_id: reporterId,
        reported_id: reportTarget.partnerId,
        reason,
        call_id: reportTarget.callId,
      });
      if (error) throw error;
      if (reportModal) reportModal.hidden = true;
      window.dispatchEvent(new Event('kismet:report'));
    } catch (error) {
      console.error('Report submission failed:', error);
      const toast = $('vc-toast');
      if (toast) {
        toast.textContent = 'Could not submit report — please try again';
        toast.style.opacity = '1';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
      }
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
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
