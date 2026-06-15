/**
 * NC Zoning Board — Flyover Showcase
 * Namespace: NCZ.Flyover
 *
 * Cinematic flyover tour synced to "Good Morning Night City" (57.417s per loop).
 * Uses a PerspectiveCamera rendered via NCZ.ThreeScene.renderFrame(), leaving
 * the main orthographic camera and OrbitControls untouched.
 *
 * To include or exclude this feature, add/remove flyover.js in index.html.
 * Requires NCZ.ThreeScene (three-scene.js) to be loaded first.
 */

import * as THREE from 'three';

window.NCZ = window.NCZ || {};

// ── Flyover constants ──────────────────────────────────────────────────────────
// Kept here (not in constants.js) — flyover.js is opt-in and removable.
const FLYOVER_DURATION_S    = 57.417;   // audio track length in seconds
const FLYOVER_FOV           = 55;       // perspective camera field of view (degrees)
const FLYOVER_CAM_NEAR      = 1;        // perspective camera near clip (CET units)
const FLYOVER_CAM_FAR       = 120000;   // perspective camera far clip
const FLYOVER_FADE_MS       = 2000;     // fade in / fade to black duration (ms)
const FLYOVER_BEAT_DISSOLVE = 938;      // theme cross-dissolve duration per beat (ms) — 70% of ~1340ms beat period
const FLYOVER_REVEAL_ROADS  = 1500;     // ms after WP0 to stagger roads in (only used when run opts revealLayers = true)
const FLYOVER_REVEAL_METRO  = 3000;     // ms after WP0 to stagger metro in
const FLYOVER_REVEAL_BLDGS  = 4500;     // ms after WP0 to stagger buildings in
const FLYOVER_REVEAL_PINS   = 6000;     // ms after WP0 to stagger pins in (only when revealLayers && showPins)
const MORRO_BAY = { lat: 35.370781, lng: -120.851173 }; // Night City's real-world location

const Flyover = (() => {

  // ── Waypoints ─────────────────────────────────────────────────────────────
  // [camX, camY, camZ, tarX, tarY, tarZ, durationMs]
  // GLB space: X = CET_X, Y = elevation, Z = -CET_Y.
  // durationMs = travel time TO this waypoint (0 = start position).
  //
  // Synced to "Good Morning Night City" (57.417 s total).
  // Audacity label → waypoint map:
  //
  //   WP  Time (s)  Location          Note
  //    0    0.000   Ocean             build-up music, bare terrain
  //    1    6.948   Coastline    ★    "Good Morning Night City"
  //    2   10.948   Watson            low sweep
  //    3   14.842   Heywood      ★    top-down
  //    4   20.842   City Center       low / between towers
  //    5   26.977   Santo Domingo ★   top-down
  //    6   34.743   Westbrook    ★    top-down
  //    7   43.377   Pacifica     ★    top-down
  //    8   48.077   Dogtown           low sweep
  //    9   52.747   Badlands          rising, looking east — districts off here
  //   10   57.417   Rocky Ridge       high, looking back west at the city

  const FLYOVER_WAYPOINTS = [
    //  #   cam position (GLB)        look-at target (GLB)         dur(ms)
    //  0 — Open ocean, sea-level, city glowing on the horizon
    [  -5800,   250,     400,        -2500,    200,      400,          0],
    //  1 — Skim the coastline as "Good Morning Night City" hits  @6.948s
    [  -3200,   150,     500,          800,    300,      800,       6948],
    //  2 — Watson: near-ground sweep south, city core on the horizon ahead  @10.948s
    //      Low and nearly horizontal — unnamed flythrough, no top-down
    [  -1000,   120,   -3000,          600,    120,     -900,       4000],
    //  3 — HEYWOOD top-down  @14.842s  ★ district beat
    //      CET ≈ (200, -1500) → GLB target (200, 0, 1500); camera offset north
    [    200,  2800,    1100,          200,      0,     1500,       3894],
    //  4 — City Center: banking sweep west across the skyline  @20.842s
    //      Medium height — enough to clear terrain, shallow horizontal gaze
    [    700,   600,    -500,         -400,    300,    -1400,       6000],
    //  5 — Santo Domingo: near-ground south, looking north — city skyline ahead  @26.977s
    //      Flat terrain reads as industrial outskirts; city visible in the distance
    [    600,   250,    4000,          300,    300,     1200,       6135],
    //  6 — Westbrook: sweeping in from the east, city grid visible to the west  @34.743s
    [   3000,   600,   -2000,          500,    200,    -1000,       7766],
    //  7 — PACIFICA top-down  @43.377s
    //      CET ≈ (-3200, -2000) → GLB target (-3200, 0, 2000)
    [  -3200,  2800,    1600,        -3200,      0,     2000,       8634],
    //  8 — Dogtown: low sweep through the stadium district  @48.077s
    [  -3000,   250,    2500,        -1500,    200,     1500,       4700],
    //  9 — Badlands: rising, camera looking east (city behind) — districts off  @52.747s
    [   2500,   500,    2000,         4500,    200,     3500,       4670],
    // 10 — Rocky Ridge: high, full city silhouette on the western horizon  @57.417s
    [   4500,  1500,    4000,            0,    100,        0,       4670],
  ];

  // ── Layer events ──────────────────────────────────────────────────────────
  // Fired the instant a waypoint is reached.
  // Opening reveal: staggered via scheduleLayerReveal() during the ocean approach.
  // Closing:        districts only — turned off at WP9 while city is behind camera.

  // ── Theme cross-dissolve ──────────────────────────────────────────────────
  // Captures scene colors before the theme changes, then lerps all materials
  // from the old values to the new ones over ~1 second — no black flash,
  // just a smooth meld from one palette to the next.

  function applyThemeSmooth(themeId, durationMs = 1000) {
    if (!NCZ.applyTheme || !NCZ.ThreeScene?.captureColors) {
      NCZ.applyTheme?.(themeId);
      return;
    }
    const from = NCZ.ThreeScene.captureColors();  // snapshot current colors
    NCZ.applyTheme(themeId);                      // CSS class + materials snap
    NCZ.ThreeScene.transitionMaterials(from, durationMs); // lerp back from old
  }

  const FLYOVER_EVENTS = {
    // WP 0 — Ocean: snap to opening theme; showcase always controls its own layer state.
    // _runOpts.revealLayers=true  → hide everything, stagger layers back in over 6.9s
    // _runOpts.revealLayers=false → all layers on from frame 1 (immediate shadows)
    // Districts honour _runOpts.districts in both branches.
    // Either way, exit always restores the user's pre-showcase layer state.
    0: () => {
      const showDistricts = !!_runOpts?.districts;
      if (_runOpts?.revealLayers) {
        NCZ.ThreeScene.setLayerVisibility('roads',     false);
        NCZ.ThreeScene.setLayerVisibility('metro',     false);
        NCZ.ThreeScene.setLayerVisibility('buildings', false);
        NCZ.ThreeScene.setLayerVisibility('districts', showDistricts);
      } else {
        NCZ.ThreeScene.setLayerVisibility('roads',     true);
        NCZ.ThreeScene.setLayerVisibility('metro',     true);
        NCZ.ThreeScene.setLayerVisibility('buildings', true);
        NCZ.ThreeScene.setLayerVisibility('districts', showDistricts);
      }
      const lockedTheme = _runOpts?.theme && _runOpts.theme !== 'cycle' ? _runOpts.theme : 'night-corp';
      NCZ.applyTheme?.(lockedTheme);
    },
    // WP 9 — Badlands sweep: drop districts so the city behind camera reads cleaner.
    // Skipped when the user opted to keep districts visible.
    9: () => { if (!_runOpts?.districts) NCZ.ThreeScene.setLayerVisibility('districts', false); },
  };

  // ── Beat-cycle visualiser ─────────────────────────────────────────────────
  // Exact beat timestamps from the Audacity beat finder (cluster-start beats,
  // ~1.34s apart — the track's bass pulse). Checked each animation frame
  // against audio.currentTime so theme changes lock to the actual audio.

  const BEAT_TIMESTAMPS_MS = [
     7019,  8405,  9703, 11069, 12386, 13736, 15070, 16441, 17719,
    19071, 20405, 21755, 23054, 24422, 25719, 27071, 28421, 29774,
    31088, 32341, 33674, 35054, 36386, 39107, 40386, 41684, 43071,
    44421, 45738, 47088, 48386, 49722, 52403,
  ];

  // Read all scene colors for a theme directly from CSS custom properties.
  // Temporarily swaps the theme class on <html>, reads computed styles, then restores.
  // No visual flash — requestAnimationFrame doesn't fire during synchronous execution.
  function readThemeColors(themeId) {
    const html     = document.documentElement;
    const prevCls  = Array.from(html.classList).filter(c => c.startsWith('theme-'));
    prevCls.forEach(c => html.classList.remove(c));
    html.classList.add(`theme-${themeId}`);
    const s = getComputedStyle(html);
    const c = v => new THREE.Color(s.getPropertyValue(v).trim());
    // Auto-derive from ThreeScene registry — no manual updates needed when materials change
    const colors = {};
    for (const { key, cssVar, fallback } of (NCZ.ThreeScene?.getSceneColorVars() ?? [])) {
      const raw = s.getPropertyValue(cssVar).trim();
      colors[key] = new THREE.Color(raw || fallback);
    }
    html.classList.remove(`theme-${themeId}`);
    prevCls.forEach(c => html.classList.add(c));
    return colors;
  }

  // Derived from CSS at first use — stays in sync with theme.css automatically.
  // Order matches NCZ.THEMES rotation sequence.
  let _beatColors = null;
  function getBeatColors() {
    if (!_beatColors) _beatColors = NCZ.THEMES.map(t => readThemeColors(t.id));
    return _beatColors;
  }

  // Per-theme render-toggle defaults (--scene-grade / --scene-edge-glow), read
  // from CSS the same way as the colours. Lets the beat cycle apply each
  // theme's LUT-grade + edge-glow defaults as it sweeps palettes — otherwise
  // those gates (which live in updateMaterials, bypassed by the colour-tween
  // path) would freeze at the opening theme's state for the whole showcase.
  let _beatToggles = null;
  function getBeatToggles() {
    if (!_beatToggles) {
      const html = document.documentElement;
      const prevCls = Array.from(html.classList).filter(c => c.startsWith('theme-'));
      _beatToggles = NCZ.THEMES.map(t => {
        prevCls.forEach(c => html.classList.remove(c));
        html.classList.add(`theme-${t.id}`);
        const s = getComputedStyle(html);
        const flag = v => parseFloat(s.getPropertyValue(v)) > 0;
        const r = { grade: flag('--scene-grade'), glow: flag('--scene-edge-glow') };
        html.classList.remove(`theme-${t.id}`);
        return r;
      });
      prevCls.forEach(c => html.classList.add(c));
    }
    return _beatToggles;
  }

  let _beatColorIndex = 0; // which palette fires next (continues across loops)
  let _lastBeatIndex  = 0; // which timestamp we've last checked (resets each loop)
  let _audio          = null;
  let _runOpts        = null; // per-run options captured at startFlyover (null when idle)

  // ── Flyover sun animation ─────────────────────────────────────────────────
  // Maps audio.currentTime to real sunrise→sunset at Morro Bay, CA —
  // the real-world location of Night City. Computed once per flyover start.

  // MORRO_BAY defined as module-level constant above the IIFE
  let _sunriseMs = null; // epoch ms of today's sunrise
  let _sunsetMs  = null; // epoch ms of today's sunset

  function initFlyoverSun() {
    if (typeof SunCalc === 'undefined') return;
    // Use summer solstice — longest day, widest sun arc, most dramatic hillshading.
    // Year doesn't affect the solar geometry meaningfully at this precision.
    const solstice = new Date(new Date().getFullYear(), 5, 21); // June 21
    const times = SunCalc.getTimes(solstice, MORRO_BAY.lat, MORRO_BAY.lng);
    _sunriseMs = times.sunrise.getTime();
    _sunsetMs  = times.sunset.getTime();
  }

  function updateFlyoverSun(audioCurrentTime) {
    if (!_sunriseMs || !_sunsetMs || !NCZ.ThreeScene?.setSunPosition) return;
    const t = Math.min(1, Math.max(0, audioCurrentTime / FLYOVER_DURATION_S));
    const epochMs = _sunriseMs + (_sunsetMs - _sunriseMs) * t;
    const pos = SunCalc.getPosition(new Date(epochMs), MORRO_BAY.lat, MORRO_BAY.lng);
    NCZ.ThreeScene.setSunPosition(pos.azimuth, pos.altitude);
    // Drive exposure off the same elevation curve as the slider — the flyover
    // animates the sun directly (bypassing applySunTime), so without this the
    // exposure froze at its pre-showcase value and the whole flyover rendered
    // at one brightness. See NCZ.exposureForSunElevation.
    NCZ.ThreeScene.setSceneExposure?.(NCZ.exposureForSunElevation(pos.altitude));
  }

  function triggerBeat() {
    if (!NCZ.ThreeScene?.captureColors || !NCZ.ThreeScene?.transitionToColors) return;
    const from   = NCZ.ThreeScene.captureColors();
    const colors = getBeatColors();
    const idx    = _beatColorIndex % colors.length;
    const to     = colors[idx];
    _beatColorIndex++;
    NCZ.ThreeScene.transitionToColors(from, to, FLYOVER_BEAT_DISSOLVE);
    // Apply this theme's grade + edge-glow defaults so the cycle honours each
    // palette's render toggles (binary — they snap on the beat; the colours
    // cross-dissolve). Restored to the user's theme default at showcase end.
    const tog = getBeatToggles()[idx];
    NCZ.ThreeScene.setGradeEnabled?.(tog.grade);
    NCZ.ThreeScene.setEdgeGlowEnabled?.(tog.glow);
  }

  function checkBeats() {
    if (!_audio) return;
    const audioMs = _audio.currentTime * 1000;
    while (_lastBeatIndex < BEAT_TIMESTAMPS_MS.length &&
           audioMs >= BEAT_TIMESTAMPS_MS[_lastBeatIndex]) {
      triggerBeat();
      _lastBeatIndex++;
    }
  }

  // ── Layer reveal ──────────────────────────────────────────────────────────
  // Stagger Roads → Metro → Buildings → Districts across the 6.948s ocean
  // approach so all four are visible before "Good Morning" is announced.

  let _layerRevealTimers = [];

  function scheduleLayerReveal() {
    _layerRevealTimers.forEach(clearTimeout);
    _layerRevealTimers = [
      setTimeout(() => NCZ.ThreeScene.setLayerVisibility('roads',     true), FLYOVER_REVEAL_ROADS),
      setTimeout(() => NCZ.ThreeScene.setLayerVisibility('metro',     true), FLYOVER_REVEAL_METRO),
      setTimeout(() => NCZ.ThreeScene.setLayerVisibility('buildings', true), FLYOVER_REVEAL_BLDGS),
      // Districts omitted — cleaner showcase without boundary lines
    ];
    // Pins reveal happens after buildings so they don't pop up against an empty
    // grey scene. Only scheduled when the user opted into both revealLayers and
    // showPins; otherwise the layer is enabled (or not) at WP0 by startFlyover.
    if (_runOpts?.showPins) {
      _layerRevealTimers.push(
        setTimeout(() => flyCamera?.layers.enable(NCZ.LAYER_PINS), FLYOVER_REVEAL_PINS)
      );
    }
  }

  function clearLayerReveal() {
    _layerRevealTimers.forEach(clearTimeout);
    _layerRevealTimers = [];
  }

  // ── Fade overlay ─────────────────────────────────────────────────────────
  // Created on demand when showcase starts, removed from the DOM entirely on exit.

  let _fadeEl = null;

  function createFade() {
    const map3d = document.getElementById('map-3d');
    if (!map3d || _fadeEl) return;
    _fadeEl = document.createElement('div');
    Object.assign(_fadeEl.style, {
      position: 'absolute', inset: '0',
      background: '#000', opacity: '1',
      pointerEvents: 'none', zIndex: '9', transition: 'none',
    });
    map3d.appendChild(_fadeEl);
  }

  function fadeIn() {
    if (!_fadeEl) return;
    // Element starts at opacity:1 — transition to transparent
    void _fadeEl.offsetWidth; // force reflow so transition fires from 1 not 0
    _fadeEl.style.transition = `opacity ${FLYOVER_FADE_MS}ms ease`;
    _fadeEl.style.opacity    = '0';
  }

  function fadeToBlack(callback) {
    if (!_fadeEl) { if (callback) callback(); return; }
    _fadeEl.style.transition = `opacity ${FLYOVER_FADE_MS}ms ease`;
    _fadeEl.style.opacity    = '1';
    if (callback) setTimeout(callback, FLYOVER_FADE_MS);
  }

  function resetFade() {
    if (_fadeEl) { _fadeEl.remove(); _fadeEl = null; }
  }

  // ── Start screen ──────────────────────────────────────────────────────────
  // Opening title card — shown during the fade-in at the start of the showcase.

  let _startScreenEl    = null;
  let _startScreenTimer = null;

  function showStartScreen() {
    if (!_startScreenEl) _startScreenEl = document.getElementById('flyover-start-screen');
    if (!_startScreenEl) return;

    if (_startScreenTimer !== null) { clearTimeout(_startScreenTimer); _startScreenTimer = null; }

    _startScreenEl.classList.remove('hidden');
    void _startScreenEl.offsetWidth;
    _startScreenEl.style.animation = 'none';
    void _startScreenEl.offsetWidth;
    _startScreenEl.style.animation = '';

    _startScreenTimer = setTimeout(() => {
      _startScreenEl.classList.add('hidden');
      _startScreenTimer = null;
    }, 3000);
  }

  function hideStartScreen() {
    if (_startScreenTimer !== null) { clearTimeout(_startScreenTimer); _startScreenTimer = null; }
    if (_startScreenEl) _startScreenEl.classList.add('hidden');
  }

  // ── Camera & state ────────────────────────────────────────────────────────

  let flyCamera       = null;
  let flyActive       = false;
  let flyFrameId      = null;
  let flySeg          = 0;
  let flySegStart     = 0;
  let _savedTheme     = null; // theme ID active when showcase started
  let _savedState     = null; // overlay checkbox + sun slider state to restore on exit
  let _onAudioEnded   = null; // reference kept so we can remove it on early exit

  const _flyPos = new THREE.Vector3();
  const _flyTar = new THREE.Vector3();
  let _lastShadowTraceMs = 0; // throttle anchor for the `__shadowTrace` debug logger (10 Hz cap)
  let _shadowTraceMarkerN = 0; // sequential marker id; user-pressed Space during shadow trace push a marker into the buffer

  // Space-bar marker for the shadow trace. When `NCZ.__shadowTrace` is true
  // and the showcase is running, pressing Space pushes a fully-decorated
  // trace entry into `window.__shadowTraceBuffer` with a `marker: N` field,
  // capturing the EXACT moment the user sees a visual issue. Lets us
  // correlate "shadows turned off here" complaints with the per-frame state
  // — much sharper than guessing from audio timestamps.
  window.addEventListener('keydown', (e) => {
    if (!flyActive || !NCZ.__shadowTrace) return;
    if (e.code !== 'Space' && e.key !== ' ') return;
    e.preventDefault();
    _shadowTraceMarkerN++;
    const lastEntry = (window.__shadowTraceBuffer || [])[(window.__shadowTraceBuffer || []).length - 1] || {};
    const entry = {
      marker: _shadowTraceMarkerN,
      at:    _audio ? +_audio.currentTime.toFixed(2) : null,
      seg:   flySeg,
      segT:  +(((performance.now() - flySegStart) / (FLYOVER_WAYPOINTS[flySeg + 1]?.[6] || 1)).toFixed(3)),
      cam:   _flyPos.toArray().map(v => Math.round(v)),
      tar:   _flyTar.toArray().map(v => Math.round(v)),
      ...NCZ.ThreeScene.getShadowSnapshot?.(),
    };
    (window.__shadowTraceBuffer ||= []).push(entry);
    console.log(`[shadow-trace-MARK#${_shadowTraceMarkerN}]`, JSON.stringify(entry));
  });

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  // ── Public API ────────────────────────────────────────────────────────────

  function startFlyover(opts = {}) {
    if (flyActive) return;
    flyActive = true;

    // Capture per-run options. Defaults preserve today's behaviour (zero-arg call
    // from any old caller is identical to the previous fixed configuration).
    _runOpts = {
      theme:        typeof opts.theme === 'string' ? opts.theme : 'cycle',
      showPins:     !!opts.showPins,
      revealLayers: !!opts.revealLayers,
      districts:    !!opts.districts,
      audio:        opts.audio !== false, // default true
      loop:         !!opts.loop,
    };

    NCZ.ThreeScene.stopRenderLoop();
    NCZ.ThreeScene.setControlsEnabled(false);

    if (!flyCamera) {
      const canvas = NCZ.ThreeScene.getCanvasElement();
      flyCamera = new THREE.PerspectiveCamera(FLYOVER_FOV, canvas.clientWidth / canvas.clientHeight, FLYOVER_CAM_NEAR, FLYOVER_CAM_FAR);
      flyCamera.name = 'flyover-camera';
    }

    // Hand the marker overlay's CSS2DRenderer the flyover camera so pins,
    // clusters, popup and tooltip project against the cinematic camera. The
    // flyover camera's layer mask gates whether they're actually visible:
    // LAYER_PINS enabled → pins ride along; disabled → CSS2DRenderer's
    // per-object layer test sets each DOM element's display to 'none'.
    //
    // When revealLayers is also on, the layer is enabled later by
    // scheduleLayerReveal (after buildings) so pins don't pop in against
    // bare terrain. Otherwise enable immediately.
    if (_runOpts.showPins && !_runOpts.revealLayers) {
      flyCamera.layers.enable(NCZ.LAYER_PINS);
    } else {
      flyCamera.layers.disable(NCZ.LAYER_PINS);
    }
    NCZ.ThreeMarkers?.setActiveCamera?.(flyCamera);
    // During the showcase we want individual mod pins, not cluster bubbles —
    // big number badges sweeping past in a cinematic read as visual noise.
    // setUnclusteredMode(true) hides the cluster layer and unhides every
    // filter-passing pin; setUnclusteredMode(false) on stop triggers a
    // recompute that restores the normal clustered state.
    if (_runOpts.showPins) NCZ.ThreeMarkers?.setUnclusteredMode?.(true);

    // Save active theme + all overlay checkbox states + sun slider value
    _savedTheme = Array.from(document.documentElement.classList)
      .find(c => c.startsWith('theme-'))?.replace('theme-', '') ?? 'night-corp';
    _savedState = {
      sunSlider: document.getElementById('scene-sun-slider')?.value ?? null,
      overlays:  Array.from(document.querySelectorAll('[data-overlay]'))
                   .map(cb => ({ cb, checked: cb.checked })),
    };

    // Start audio — beats and sun position are driven by audio.currentTime each frame.
    // When _runOpts.audio === false, mute the element rather than skip play(): the
    // currentTime clock and 'ended' event still fire on muted media in Chromium and
    // Firefox, so beats / sun / end-of-showcase fade stay locked to the same timeline.
    _audio = document.getElementById('flyover-audio');
    _lastBeatIndex  = 0;
    _beatColorIndex = 0;
    if (_audio) {
      _audio.muted = !_runOpts.audio;
      _audio.currentTime = 0;
      _audio.play().catch(() => {});
      _audio.addEventListener('ended', _onAudioEnded = () => {
        if (!flyActive) return;
        if (_runOpts?.loop) {
          // Restart the run. _beatColorIndex deliberately NOT reset — the colour
          // cycle is meant to continue across loops (per CHANGELOG).
          _audio.currentTime = 0;
          _lastBeatIndex = 0;
          flySeg = 0;
          flySegStart = performance.now();
          _audio.play().catch(() => {});
          _audio.addEventListener('ended', _onAudioEnded, { once: true });
          return;
        }
        if (flyFrameId !== null) { cancelAnimationFrame(flyFrameId); flyFrameId = null; }
        fadeToBlack(() => {
          document.dispatchEvent(new CustomEvent('flyover:ended'));
          resetFade();
        });
      }, { once: true });
    }

    initFlyoverSun();
    NCZ.ThreeScene.setShadowsEnabled?.(true);    // always on during showcase
    NCZ.ThreeScene.setSunSphereVisible?.(true);  // show the sun in the sky
    FLYOVER_EVENTS[0]();
    if (_runOpts.revealLayers) scheduleLayerReveal();
    // Create fade overlay, show title card, then fade the scene in from black
    createFade();
    showStartScreen();
    fadeIn();

    const [cx, cy, cz, tx, ty, tz] = FLYOVER_WAYPOINTS[0];
    flyCamera.position.set(cx, cy, cz);
    flyCamera.up.set(0, 1, 0);
    flyCamera.lookAt(tx, ty, tz);

    flySeg      = 0;
    flySegStart = performance.now();
    flyoverLoop();
  }

  // Short fade-out/in across the camera swap. The showcase camera renders at
  // FOV 55° and the schema camera at 25°; cutting from one to the other is a
  // jarring perspective snap. Dipping the 3D container's opacity for a moment
  // bridges them — feels like an intentional transition, not a glitch.
  const EXIT_FADE_MS = 150;

  function stopFlyover() {
    if (!flyActive) return;
    flyActive = false;
    if (flyFrameId !== null) { cancelAnimationFrame(flyFrameId); flyFrameId = null; }

    const canvas    = NCZ.ThreeScene.getCanvasElement?.();
    const container = canvas?.parentElement || null;

    const doRestore = () => {
      // Restore clusters before swapping the camera back, so the recompute
      // triggered by setActiveCamera(null) sees the cluster layer visible
      // again and rebuilds the clustered state cleanly.
      NCZ.ThreeMarkers?.setUnclusteredMode?.(false);
      // Hand the marker overlay back to the schema camera so pins project
      // against the perspective FOV-25° view again. setActiveCamera(null)
      // also re-runs cluster recompute (suppressed while a non-schema camera
      // is active).
      NCZ.ThreeMarkers?.setActiveCamera?.(null);
      clearLayerReveal();
      if (_audio) {
        _audio.pause();
        _audio.currentTime = 0;
        if (_onAudioEnded) { _audio.removeEventListener('ended', _onAudioEnded); _onAudioEnded = null; }
      }
      hideStartScreen();
      resetFade();
      NCZ.ThreeScene.setControlsEnabled(true);
      NCZ.ThreeScene.startRenderLoop();
      NCZ.ThreeScene.setSunSphereVisible?.(false);

      // Restore whichever theme the user had before showcase started
      if (_savedTheme) { applyThemeSmooth(_savedTheme); _savedTheme = null; }

      _runOpts = null;

      // Restore all overlay checkboxes + sun slider to exactly what they were.
      // Dispatching the native events ensures the app.js handlers run —
      // layer visibility, shadow state, and UI all stay in sync.
      if (_savedState) {
        _savedState.overlays.forEach(({ cb, checked }) => {
          cb.checked = checked;
          cb.dispatchEvent(new Event('change'));
        });
        const slider = document.getElementById('scene-sun-slider');
        if (slider && _savedState.sunSlider !== null) {
          slider.value = _savedState.sunSlider;
          slider.dispatchEvent(new Event('input'));
        }
        _savedState = null;
      }
    };

    if (!container || document.hidden) {
      doRestore();
      return;
    }

    container.style.transition = `opacity ${EXIT_FADE_MS}ms ease-out`;
    container.style.opacity = '0';
    setTimeout(() => {
      doRestore();
      // Two-rAF gate so the swap's first render lands while we're still at
      // opacity 0, then we fade back up. requestAnimationFrame alone races
      // some browsers' commit timing.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        container.style.opacity = '1';
      }));
      setTimeout(() => {
        container.style.transition = '';
        container.style.opacity = '';
      }, EXIT_FADE_MS + 50);
    }, EXIT_FADE_MS);
  }

  function flyoverLoop() {
    if (!flyActive) return;
    flyFrameId = requestAnimationFrame(flyoverLoop);

    const now     = performance.now();
    const nextSeg = flySeg + 1;

    if (nextSeg >= FLYOVER_WAYPOINTS.length) {
      // Last waypoint reached — hold this frame and wait for audio.ended to trigger the fade.
      // If audio isn't available, fall back to fading immediately.
      if (!_audio) {
        cancelAnimationFrame(flyFrameId);
        flyFrameId = null;
        fadeToBlack(() => { document.dispatchEvent(new CustomEvent('flyover:ended')); resetFade(); });
      }
      // With audio: just keep rendering the last frame; audio.ended fires the fade.
      return;
    }

    const dur  = FLYOVER_WAYPOINTS[nextSeg][6];
    const rawT = Math.min((now - flySegStart) / dur, 1);
    const t    = smoothstep(rawT);

    const [ax, ay, az, atx, aty, atz] = FLYOVER_WAYPOINTS[flySeg];
    const [bx, by, bz, btx, bty, btz] = FLYOVER_WAYPOINTS[nextSeg];

    _flyPos.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    _flyTar.set(atx + (btx - atx) * t, aty + (bty - aty) * t, atz + (btz - atz) * t);

    if (_runOpts?.theme === 'cycle') checkBeats();
    if (_audio) updateFlyoverSun(_audio.currentTime);

    flyCamera.position.copy(_flyPos);
    flyCamera.up.set(0, 1, 0);
    flyCamera.lookAt(_flyTar);
    NCZ.ThreeScene.renderFrame(flyCamera);
    // Reproject the marker overlay every frame so pins (or their hidden
    // placeholders, if showPins=false) track the cinematic camera. CSS2DRenderer's
    // layer-test handles visibility based on the flyCamera's mask.
    NCZ.ThreeMarkers?.render?.();

    // Shadow trace logger — gated on `NCZ.__shadowTrace` (set via devtools:
    // `NCZ.__shadowTrace = true` before clicking Showcase). Throttled to ~10 Hz
    // and tagged `[shadow-trace]` so Needle's `console_read` filter can pull
    // just these entries. Logged per-frame data: audio time, waypoint segment
    // + t, cam/look positions, plus the full shadow snapshot from
    // getShadowSnapshot() — light pose, shadow camera bounds, fit state
    // (incl. degeneration fallback flag), renderer flags, hemisphere fill.
    if (NCZ.__shadowTrace && now - _lastShadowTraceMs > 100) {
      _lastShadowTraceMs = now;
      const entry = {
        at:    _audio ? +_audio.currentTime.toFixed(2) : null,
        seg:   flySeg,
        segT:  +rawT.toFixed(3),
        cam:   _flyPos.toArray().map(v => Math.round(v)),
        tar:   _flyTar.toArray().map(v => Math.round(v)),
        ...NCZ.ThreeScene.getShadowSnapshot?.(),
      };
      // Push to a global buffer too — Needle MCP's console capture is flaky;
      // this lets the user copy the entire trace via devtools with one call:
      //   copy(JSON.stringify(window.__shadowTraceBuffer))
      // and paste back here for offline analysis.
      (window.__shadowTraceBuffer ||= []).push(entry);
      console.log('[shadow-trace]', JSON.stringify(entry));
    }

    if (rawT >= 1) {
      flySeg++;
      flySegStart = now;
      FLYOVER_EVENTS[flySeg]?.();
    }
  }

  // Resize handler — keeps flyCamera aspect correct if window is resized during showcase
  window.addEventListener('resize', () => {
    if (!flyCamera || !flyActive) return;
    const canvas = NCZ.ThreeScene.getCanvasElement();
    if (!canvas) return;
    flyCamera.aspect = canvas.clientWidth / canvas.clientHeight;
    flyCamera.updateProjectionMatrix();
  });

  return { startFlyover, stopFlyover };

})();

window.NCZ.Flyover = Flyover;
