/* Shadow animation — replaces the pixel starfield.
   Floating shadow orbs that pulse, glow, and breathe.
   Responds to mouse movement with parallax. */
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "shadow-field";
  document.body.prepend(canvas);

  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, orbs = [], raf = 0, last = 0;
  let mx = 0, my = 0, px = 0, py = 0;

  const css = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  const ACCENT = pick("--color-primary", "#f59e0b");
  const ACCENT2 = pick("--cyan-400", "#6fd3e7");
  const DIM = pick("--star-500", "#8e8aa2");

  const ORB_COUNT = 28;

  function resize() {
    W = canvas.width = Math.max(1, innerWidth);
    H = canvas.height = Math.max(1, innerHeight);
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
  }

  function spawn(o, init) {
    o.x = Math.random() * W;
    o.y = Math.random() * H;
    o.r = 40 + Math.random() * 120;
    o.vx = (Math.random() - 0.5) * 0.3;
    o.vy = (Math.random() - 0.5) * 0.3;
    o.phase = Math.random() * Math.PI * 2;
    o.speed = 0.3 + Math.random() * 0.7;
    o.color = Math.random() > 0.7 ? ACCENT2 : (Math.random() > 0.4 ? ACCENT : DIM);
    o.alpha = 0.08 + Math.random() * 0.12;
    if (init) o.life = 1;
    return o;
  }

  function init() {
    resize();
    orbs = Array.from({ length: ORB_COUNT }, () => spawn({}, true));
  }

  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    // smooth parallax
    px += (mx * 15 - px) * 0.03;
    py += (my * 10 - py) * 0.03;

    for (const o of orbs) {
      o.x += o.vx + px * 0.002;
      o.y += o.vy + py * 0.002;
      o.phase += dt * o.speed;
      // wrap around
      if (o.x < -o.r) o.x = W + o.r;
      if (o.x > W + o.r) o.x = -o.r;
      if (o.y < -o.r) o.y = H + o.r;
      if (o.y > H + o.r) o.y = -o.r;

      const pulse = 0.7 + 0.3 * Math.sin(o.phase);
      const r = o.r * pulse;
      const alpha = o.alpha * pulse;

      // draw soft shadow orb
      const grad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, r);
      grad.addColorStop(0, hexAlpha(o.color, alpha * 1.5));
      grad.addColorStop(0.4, hexAlpha(o.color, alpha * 0.6));
      grad.addColorStop(1, hexAlpha(o.color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(o.x - r, o.y - r, r * 2, r * 2);

      // inner bright core
      const coreR = r * 0.15;
      const coreGrad = ctx.createRadialGradient(o.x, o.y, 0, o.x, o.y, coreR);
      coreGrad.addColorStop(0, hexAlpha("#ffffff", alpha * 2));
      coreGrad.addColorStop(1, hexAlpha(o.color, 0));
      ctx.fillStyle = coreGrad;
      ctx.fillRect(o.x - coreR, o.y - coreR, coreR * 2, coreR * 2);
    }

    // connection lines between nearby orbs (shadow web)
    ctx.strokeStyle = hexAlpha(ACCENT, 0.06);
    ctx.lineWidth = 1;
    for (let i = 0; i < orbs.length; i++) {
      for (let j = i + 1; j < orbs.length; j++) {
        const a = orbs[i], b = orbs[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 250) {
          ctx.globalAlpha = (1 - dist / 250) * 0.15;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function hexAlpha(hex, a) {
    hex = hex.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
    last = t;
    draw(dt);
  }

  function start() {
    if (reduced.matches) { draw(0); return; }
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  addEventListener("resize", () => { resize(); if (reduced.matches) draw(0); });
  document.addEventListener("visibilitychange", () => document.hidden ? stop() : start());
  reduced.addEventListener?.("change", () => { stop(); start(); });
  document.addEventListener("pointermove", (e) => {
    mx = (e.clientX / innerWidth - 0.5) * 2;
    my = (e.clientY / innerHeight - 0.5) * 2;
  });

  init();
  start();
})();