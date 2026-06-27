/*
 * trailer-capture.js  --  NOT a node script.
 *
 * Browser DevTools console snippet for capturing trailer / promo footage of the
 * 3D map. Paste the whole file into the console on the dev build
 * (http://localhost:3210 or dev.nczoning.net), then drive shots with number keys
 * while you record with OBS. No console needed after pasting.
 *
 * Setup: open the app, dismiss the welcome modal, paste this, close DevTools,
 * press 1 to clean the UI, F11 for fullscreen, then record.
 *
 * Keys (ignored while typing in an input):
 *   1  toggle clean UI (hide chrome, fill the screen)
 *   2  wide hero pose (tilted, looking north over the city)
 *   3  low dramatic pose
 *   4  sun sweep, sunrise -> dusk over 8s
 *   5  theme cycle, all 7 themes (Night Corp, Game, Preem, Arasaka, Militech, Aldecaldos, Synthwave)
 *   6  closer "city" pose
 *   7  slow orbit over 10s
 *   8  pull-back to wide over 7s (closing hero move)
 *   0  reset (Night Corp, wide, UI back)
 *
 * Tuning lives in POSES and the per-move start/end values below. All poses orbit
 * the city-centre target [-800, 0, 500] in three-space. sunSlider is minutes of day
 * (360 ~ sunrise, 1216 ~ sunset, 480 = 08:00).
 */
(() => {
  const TS = window.NCZ.ThreeScene;
  const TARGET = [-800, 0, 500];
  const pose = (polar, r, az = 0) => {
    const y = r * Math.cos(polar), h = r * Math.sin(polar);
    return { target: TARGET, position: [TARGET[0] + h * Math.sin(az), y, TARGET[2] + h * Math.cos(az)], polar, azimuth: az };
  };
  const apply = (p, sun) => { TS.setCameraState(Object.assign({}, p, sun != null ? { sunSlider: String(sun) } : {})); TS.requestRender(); };
  const POSES = { wide: pose(0.52, 11200), low: pose(0.92, 11000), city: pose(0.62, 9000) };
  let styleEl;
  const T = {
    clean(on = true) {
      if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'ncztrailer-clean'; document.head.appendChild(styleEl); }
      styleEl.textContent = on ? 'header,#header-main,#header-status-bar,#sidebar,#sidebar-open,#discover-location-btn,#overlay-controls,#map-view-toggle,#scene-controls,#scene-scale,#cluster-panel{display:none!important}#map-container,#map-3d,#map{top:0!important;height:100vh!important}' : '';
      document.querySelector('#welcome-modal')?.classList.add('hidden');
      window.dispatchEvent(new Event('resize')); TS.requestRender();
    },
    wide() { apply(POSES.wide, 480); },
    low() { apply(POSES.low, 480); },
    city() { apply(POSES.city, 480); },
    sweepSun(secs = 8) {
      apply(POSES.city, 360);
      const t0 = performance.now(), from = 360, to = 1216, dur = secs * 1000;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); TS.setCameraState(Object.assign({}, POSES.city, { sunSlider: String(Math.round(from + (to - from) * k)) })); TS.requestRender(); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
    cycleThemes(holdMs = 1600, ids = ['night-corp', 'game', 'preem', 'arasaka', 'militech', 'aldecaldos', 'synthwave']) {
      apply(POSES.wide, 600); let i = 0;
      const next = () => { if (i >= ids.length) return; window.NCZ.applyTheme(ids[i++]); TS.requestRender(); setTimeout(next, holdMs); };
      next();
    },
    orbit(secs = 10) {
      const t0 = performance.now(), dur = secs * 1000, a0 = -0.28, a1 = 0.28;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); apply(pose(0.6, 10500, a0 + (a1 - a0) * k), 480); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
    pullback(secs = 7) {
      const t0 = performance.now(), dur = secs * 1000, p0 = 0.62, p1 = 0.50, r0 = 8800, r1 = 12500;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); apply(pose(p0 + (p1 - p0) * k, r0 + (r1 - r0) * k, 0), 480); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    },
    reset() { window.NCZ.applyTheme('night-corp'); apply(POSES.wide, 480); this.clean(false); },
  };
  window.NCZTRAILER = T;
  let _clean = false;
  const KEY = { '1': () => { _clean = !_clean; T.clean(_clean); }, '2': () => T.wide(), '3': () => T.low(), '4': () => T.sweepSun(8), '5': () => T.cycleThemes(), '6': () => T.city(), '7': () => T.orbit(10), '8': () => T.pullback(7), '0': () => { _clean = false; T.reset(); } };
  if (window.__nczTrailerKeyHandler) window.removeEventListener('keydown', window.__nczTrailerKeyHandler);
  window.__nczTrailerKeyHandler = (e) => { const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return; const fn = KEY[e.key]; if (fn) { e.preventDefault(); fn(); } };
  window.addEventListener('keydown', window.__nczTrailerKeyHandler);
  console.log('%cNCZTRAILER ready', 'color:#00f0ff;font-weight:bold;font-size:14px');
  console.log('Keys: 1 clean  2 wide  3 low  4 sun  5 themes  6 closer  7 orbit  8 pull-back  0 reset');
})();
