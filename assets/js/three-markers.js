/**
 * NC Zoning Board — Three.js Pin/Marker Layer
 * Namespace: NCZ.ThreeMarkers
 *
 * Mirrors the Leaflet marker behaviour for the 3D view: pins read from the same
 * mods array, filters apply via the same visible-id Set computed by
 * NCZ.computeVisibleMods, popups reuse NCZ.buildPopupHtml.
 *
 * The shared "interface" both views satisfy:
 *   setMods(mods, nexusThumbs, tagsDict) — build pins from data
 *   applyFilters(visibleIdSet)           — toggle which pins render
 *   focusMod(modId)                       — open popup for a mod
 *   closePopup()                          — programmatic close
 *
 * Rendering uses CSS2DRenderer so each pin is a real DOM node — DOM events,
 * theme CSS, and the existing popup HTML all work without re-implementation.
 */

import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

window.NCZ = window.NCZ || {};

const ThreeMarkers = (() => {
  let scene = null;
  // Two camera references: the schema OrthographicCamera captured at attach
  // time, and an optional override active during the showcase flyover (the
  // PerspectiveCamera owned by flyover.js). Cluster math + fly-to-pin tween
  // assume orthographic fields and always use _schemaCamera; the popup
  // projection and the render call use whichever is active so pins follow
  // the cinematic camera during the showcase.
  let _schemaCamera = null;
  let _activeCamera = null;
  const getCam = () => _activeCamera || _schemaCamera;
  let container = null;
  let controls = null;
  let cssRenderer = null;
  let pinsLayer = null;
  let popup = null;
  let popupModId = null;
  const pins = new Map(); // modId → CSS2DObject (the pin)

  // Camera fly-to tween state. Active when non-null. Holds start/end targets,
  // start/end camera positions (XZ-plane only — height stays put), start/end
  // zoom, elapsed/total time, and an onComplete callback.
  let _flyTween = null;
  let _flyLastTime = 0;

  // Clustering — pool CSS2DObjects (cluster bubbles), recompute on filter
  // change or camera move. Filter-visible set is tracked separately from
  // pin.visible because clustering OVERRIDES pin.visible to hide grouped pins.
  let _clusterLayer = null;
  const _clusterPool = [];          // CSS2DObject[] — reused across recomputes
  let _filterVisibleIds = new Set();
  let _recomputeFrame = null;
  let _onClusterClick = null;       // cluster-click callback (set by app.js)
  let _onClustersChanged = null;    // recompute-fired callback (set by app.js)
  let _activeClusterMods = null;    // Set<modId> | null — mods of the cluster
                                    // whose contents the cluster panel is showing
  const _projectVec = new THREE.Vector3();

  // Tooltip — single reusable CSS2DObject created at attach time. Hidden by
  // default; show()/hide() toggle .visible and update text/position.
  let tooltipObj = null;
  let tooltipText = null;

  // Cached so focusMod can rebuild popups without re-passing data
  let _modsState = { mods: [], nexusThumbs: {}, tagsDict: {} };

  // Called from ThreeScene.init() once scene + camera are ready.
  function attach(_scene, _camera, _container, _controls) {
    if (cssRenderer) return; // idempotent
    scene = _scene;
    _schemaCamera = _camera;
    // Schema camera sees the static scene (layer 0) AND the marker overlay
    // (layer 1) by default — the "Pins" entry in the overlay-controls panel
    // toggles this membership.
    _schemaCamera.layers.enable(NCZ.LAYER_PINS);
    container = _container;
    controls = _controls || null;

    // Cancel any active fly-tween if the user starts a manual drag/zoom —
    // last-write-wins, user input always overrides an in-flight tween.
    if (controls) controls.addEventListener('start', () => { _flyTween = null; });

    cssRenderer = new CSS2DRenderer();
    cssRenderer.setSize(container.clientWidth, container.clientHeight);
    cssRenderer.domElement.style.position = 'absolute';
    cssRenderer.domElement.style.inset = '0';
    // Container itself ignores pointer events; individual pin/popup DOM opts back in.
    cssRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(cssRenderer.domElement);

    // Suppress the browser context menu only when the right-click was a
    // drag (i.e. a camera tilt that ended over a pin/cluster/popup), not
    // when it's a standalone right-click. Drag detection mirrors the
    // popup-close pattern: record right-pointerdown position, compare to
    // contextmenu's reported position, suppress only if movement exceeds
    // PIN_3D_DRAG_THRESHOLD_PX. Listeners live on the container so the
    // pointerdown fires whether the drag starts on the canvas or on a
    // CSS2D overlay element. OrbitControls handles canvas-only contextmenu
    // independently, so this is purely for the overlay-bubbled case.
    let _rightDownPos = null;
    container.addEventListener('pointerdown', (e) => {
      if (e.button === 2) _rightDownPos = { x: e.clientX, y: e.clientY };
    });
    container.addEventListener('contextmenu', (e) => {
      if (!_rightDownPos) return;
      const dist = Math.hypot(e.clientX - _rightDownPos.x, e.clientY - _rightDownPos.y);
      _rightDownPos = null;
      if (dist > NCZ.PIN_3D_DRAG_THRESHOLD_PX) e.preventDefault();
    });

    pinsLayer = new THREE.Group();
    pinsLayer.name = 'three-markers';
    scene.add(pinsLayer);

    // Cluster bubble layer — sibling of pinsLayer at scene root so buildPins
    // doesn't disturb it. Pool grows on demand and is reused across recomputes.
    _clusterLayer = new THREE.Group();
    _clusterLayer.name = 'three-clusters';
    scene.add(_clusterLayer);

    // Re-cluster on any camera move (rAF-debounced — at most one recompute
    // per frame, regardless of how often controls fires 'change').
    if (controls) controls.addEventListener('change', scheduleRecomputeClusters);

    // Tooltip — one persistent CSS2DObject, hidden by default. Shown on pin
    // hover with the mod's name. renderOrder=999 places it above pins
    // (default renderOrder=0) but below the popup (renderOrder=1000).
    //
    // Reuses the 2D Leaflet `.pin-tooltip` skin (content bubble + arrow +
    // direction class) so 2D and 3D hover tooltips render identically.
    // Always has the `.visible` class because CSS2DRenderer toggles real
    // display/hide via inline `style.display`, falling through to .pin-tooltip
    // CSS only when visible — without `.visible` the CSS would force display:none.
    //
    // Added to `scene` (not `pinsLayer`) on purpose: buildPins() rebuilds
    // pinsLayer's contents on every setMods call, which would otherwise
    // dispose the tooltip after first data load.
    const tooltipAnchor = document.createElement('div');
    tooltipAnchor.className = 'three-tooltip-anchor';
    const tooltipInner = document.createElement('div');
    tooltipInner.className = 'pin-tooltip dir-top visible';
    tooltipText = document.createElement('div');
    tooltipText.className = 'pin-tooltip-content';
    const tooltipArrow = document.createElement('div');
    tooltipArrow.className = 'pin-tooltip-arrow';
    tooltipArrow.setAttribute('aria-hidden', 'true');
    tooltipInner.append(tooltipText, tooltipArrow);
    tooltipAnchor.appendChild(tooltipInner);
    tooltipObj = new CSS2DObject(tooltipAnchor);
    tooltipObj.layers.set(NCZ.LAYER_PINS);
    tooltipObj.visible = false;
    tooltipObj.renderOrder = 999;
    scene.add(tooltipObj);

    // Click outside any pin closes the popup, matching Leaflet — but only on
    // a *true* click. Releasing an OrbitControls drag fires a click event too;
    // tracking pointerdown→pointerup distance lets us ignore drags.
    let pointerDown = null;
    container.addEventListener('pointerdown', (e) => {
      pointerDown = { x: e.clientX, y: e.clientY };
    });
    container.addEventListener('pointerup', (e) => {
      const start = pointerDown;
      pointerDown = null;
      if (!start || !popup) return;
      const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (dist > NCZ.PIN_3D_DRAG_THRESHOLD_PX) return;  // was a drag, not a click
      if (e.target.closest('.three-popup')) return;
      if (e.target.closest('.three-marker')) return;
      // Cluster click opens the cluster panel; matches Leaflet's behaviour
      // where clicking a cluster does NOT close an already-open popup.
      if (e.target.closest('.marker-cluster')) return;
      closePopup();
    });

    // Build pins from any data that arrived before attach.
    if (_modsState.mods.length) buildPins();
  }

  // CET Z is the gameplay surface — already in the right space (player position
  // including platforms, plazas, building tops). A small lift keeps the pin's
  // diamond visible above the player rather than overlapping it. The lift is
  // purely cosmetic — only used for pin rendering, never for any other Z read.
  function pinYFor(mod) {
    return (mod.coordinates[2] || 0) + NCZ.PIN_3D_GROUND_OFFSET;
  }

  function setMods(mods, nexusThumbs, tagsDict) {
    _modsState = {
      mods: mods || [],
      nexusThumbs: nexusThumbs || {},
      tagsDict: tagsDict || {},
    };
    if (pinsLayer) buildPins();
  }

  function buildPins() {
    // Clear existing pins
    while (pinsLayer.children.length) {
      const child = pinsLayer.children[0];
      pinsLayer.remove(child);
      if (child.element) child.element.remove();
    }
    pins.clear();
    closePopup({ silent: true });

    for (const mod of _modsState.mods) {
      const [cetX, cetY] = mod.coordinates;
      const tx = cetX, tz = -cetY;  // CET → Three world XZ
      const ty = pinYFor(mod);
      const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES['other'];

      const el = document.createElement('div');
      el.className = 'three-marker category-marker';
      el.dataset.modId = mod.id;
      el.innerHTML = `<div class="marker-pin ${catStyle.class}"></div>`;
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        // Toggle behaviour to match Leaflet: clicking the already-selected
        // pin deselects it. Sidebar item clicks (focusMod) deliberately
        // do NOT toggle — they always open, matching Leaflet's focusMarker.
        if (popupModId === mod.id) {
          closePopup();
        } else {
          openPopup(mod);
        }
      });
      el.addEventListener('mouseenter', () => showTooltip(mod));
      el.addEventListener('mouseleave', () => hideTooltip());

      const css = new CSS2DObject(el);
      css.layers.set(NCZ.LAYER_PINS);
      css.position.set(tx, ty, tz);
      css.userData.modData = mod;
      pinsLayer.add(css);
      pins.set(mod.id, css);
    }

    // Default filter set = all mods. app.js's applyFilters will overwrite
    // this once the user touches a filter, but seeding here makes the initial
    // SCHEMA load show clusters immediately rather than waiting for a click.
    _filterVisibleIds = new Set(_modsState.mods.map(m => m.id));
    recomputeClusters();
  }

  function setPulse(modId, on) {
    const pin = pins.get(modId);
    if (!pin) return;
    const inner = pin.element.querySelector('.marker-pin');
    if (inner) inner.classList.toggle('pulsing', on);
  }

  function showTooltip(mod) {
    if (!tooltipObj || !tooltipText) return;
    // Suppress when the popup is already open for this pin — popup contains
    // the same name plus the rest, tooltip would be redundant.
    if (popupModId === mod.id) return;
    const pin = pins.get(mod.id);
    if (!pin) return;
    tooltipText.textContent = mod.name;
    tooltipObj.position.copy(pin.position);
    tooltipObj.visible = true;
  }

  function hideTooltip() {
    if (tooltipObj) tooltipObj.visible = false;
  }

  function applyFilters(visibleIdSet) {
    _filterVisibleIds = visibleIdSet;
    for (const [id, obj] of pins) {
      obj.visible = visibleIdSet.has(id);
    }
    if (popupModId && !visibleIdSet.has(popupModId)) closePopup();
    // Re-cluster synchronously: filter changes affect which pins exist for
    // the proximity grouper, and the user expects immediate visual feedback.
    recomputeClusters();
  }

  // Returns mod IDs of pins that pass the active filter (regardless of cluster
  // grouping). Discover uses this to pick a random target — clustered pins
  // are valid choices because the fly-to tween zooms in past the cluster
  // radius, dissolving the cluster around the target by the time the fly ends.
  function getVisibleModIds() {
    return [..._filterVisibleIds];
  }

  // ── Clustering ────────────────────────────────────────────────────────
  // World-space proximity grouping. Cluster radius is computed in world units
  // from the equivalent pixel radius at current zoom — so clusters dissolve
  // as the user zooms in (matching Leaflet's behaviour) but stay invariant
  // to camera tilt and rotation (unlike the original screen-space approach,
  // which produced tilt-distorted "close on screen but far in world" pairs).
  //
  // Trigger: zoom changes or filter changes only. Pan and tilt don't shift
  // world distances, so they don't recompute. This makes clusters stable
  // while the user explores — no reshuffle on rotation. (Aki's UX call,
  // applied 2026-05-02. Earlier screen-space approach in git history if
  // you ever want to revisit.)
  let _lastZoomForCluster = null;

  function scheduleRecomputeClusters() {
    // Skip if zoom hasn't changed (pan/tilt only) — world clusters don't
    // move. Filter changes call recomputeClusters() synchronously and
    // bypass this guard.
    // Cluster math reads orthographic-only fields (zoom, right, left) so it
    // can only run against the schema camera. During the showcase the active
    // camera is the perspective fly camera — bail out and let clusters keep
    // their last-recomputed positions for the duration of the cinematic.
    if (_activeCamera) return;
    if (_lastZoomForCluster === _schemaCamera.zoom) return;
    _lastZoomForCluster = _schemaCamera.zoom;
    if (_recomputeFrame !== null) return;
    _recomputeFrame = requestAnimationFrame(() => {
      _recomputeFrame = null;
      recomputeClusters();
    });
  }

  function recomputeClusters() {
    if (!_clusterLayer || !_schemaCamera || !container) return;
    const w = container.clientWidth;
    if (!w) return;

    // Convert "PIN_3D_CLUSTER_RADIUS_PX equivalent at current zoom" into world
    // units. At zoom=2 this is roughly the same radius the screen-space
    // version used at top-down view; as the user zooms in, the world radius
    // shrinks proportionally so clusters dissolve at the same rate as Leaflet's.
    const worldPerPixel = (_schemaCamera.right - _schemaCamera.left) / (_schemaCamera.zoom * w);
    const radiusWorld = NCZ.PIN_3D_CLUSTER_RADIUS_PX * worldPerPixel;
    const radiusSq = radiusWorld * radiusWorld;

    // Build the filter-visible pin list with world XZ coords (Y intentionally
    // ignored — rooftop pins should still cluster with same-XZ ground pins).
    const points = [];
    for (const [id, pin] of pins) {
      if (!_filterVisibleIds.has(id)) continue;
      points.push({ id, pin, x: pin.position.x, z: pin.position.z, used: false });
    }

    // Greedy proximity grouping. For each unassigned pin, sweep all unassigned
    // pins and pull in any within radius. O(N²) — fine at our N (~207 max).
    const groups = [];
    for (const p of points) {
      if (p.used) continue;
      p.used = true;
      const group = [p];
      for (const q of points) {
        if (q.used) continue;
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        if (dx * dx + dz * dz < radiusSq) {
          q.used = true;
          group.push(q);
        }
      }
      groups.push(group);
    }

    // Render groups: singletons → show pin; multi → hide pins, show cluster bubble
    let poolIdx = 0;
    for (const group of groups) {
      if (group.length < 2) {
        group[0].pin.visible = true;
        continue;
      }
      for (const m of group) m.pin.visible = false;
      const cluster = getOrCreateClusterObj(poolIdx++);
      // Centroid in world space — CSS2DRenderer projects this each frame
      let cx = 0, cy = 0, cz = 0;
      for (const m of group) {
        cx += m.pin.position.x;
        cy += m.pin.position.y;
        cz += m.pin.position.z;
      }
      const n = group.length;
      cluster.position.set(cx / n, cy / n, cz / n);
      const count = group.length;
      const colorStep = Math.round(Math.max(0, Math.min(count, 100)) / 11);
      const root = cluster.element;
      root.className = `marker-cluster marker-cluster-step marker-cluster-step-${colorStep}`;
      root.querySelector('span').textContent = String(count);
      cluster.userData.modIds = group.map(g => g.id);
      cluster.visible = true;
    }
    // Hide unused pool entries from a previous larger cluster set
    for (let i = poolIdx; i < _clusterPool.length; i++) {
      _clusterPool[i].visible = false;
    }

    // Re-apply the active-cluster mark: pool DOM is reused, but visibility
    // and modIds change per recompute, so the previously-marked bubble may
    // not be the right one anymore.
    refreshActiveClusterMark();

    // Notify app.js so it can dismiss a stale cluster panel (one that was
    // opened for a cluster whose membership no longer matches any current
    // cluster after this recompute).
    if (_onClustersChanged) {
      const sets = [];
      for (let i = 0; i < poolIdx; i++) {
        sets.push(_clusterPool[i].userData.modIds || []);
      }
      _onClustersChanged(sets);
    }
  }

  // Mark the cluster bubble whose modIds best overlap _activeClusterMods.
  // When _activeClusterMods is null, clear all marks. Called after every
  // recompute (since pool membership changes) and via setActiveClusterMods().
  function refreshActiveClusterMark() {
    for (const obj of _clusterPool) {
      if (obj.element) obj.element.classList.remove('marker-cluster-active');
    }
    if (!_activeClusterMods || _activeClusterMods.size === 0) return;
    let bestObj = null;
    let bestOverlap = 0;
    for (const obj of _clusterPool) {
      if (!obj.visible) continue;
      const ids = obj.userData.modIds || [];
      let overlap = 0;
      for (const id of ids) if (_activeClusterMods.has(id)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestObj = obj;
      }
    }
    if (bestObj && bestObj.element) {
      bestObj.element.classList.add('marker-cluster-active');
    }
  }

  function setActiveClusterMods(modSet) {
    _activeClusterMods = modSet || null;
    refreshActiveClusterMark();
  }

  function getOrCreateClusterObj(idx) {
    if (idx < _clusterPool.length) return _clusterPool[idx];
    const root = document.createElement('div');
    root.className = 'marker-cluster marker-cluster-step';
    // Leaflet sets size via iconSize inline; for 3D we set it directly.
    root.style.width = '40px';
    root.style.height = '40px';
    root.style.pointerEvents = 'auto';
    root.style.cursor = 'pointer';
    root.innerHTML = '<div><span>0</span></div>';
    const obj = new CSS2DObject(root);
    obj.layers.set(NCZ.LAYER_PINS);
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      // userData.modIds is set by recomputeClusters each time the bubble is
      // assigned to a group; pass to whatever handler app.js registered.
      const ids = obj.userData.modIds || [];
      _onClusterClick?.(ids);
    });
    _clusterPool.push(obj);
    _clusterLayer.add(obj);
    return obj;
  }

  function setClusterClickHandler(fn) {
    _onClusterClick = fn;
  }

  function setClustersChangedHandler(fn) {
    _onClustersChanged = fn;
  }

  function openPopup(mod) {
    closePopup({ silent: true });
    hideTooltip();
    const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES['other'];
    const html = NCZ.buildPopupHtml(
      mod,
      catStyle,
      _modsState.nexusThumbs,
      _modsState.tagsDict,
    );

    // Anchor wrapper sits at the pin position (zero-size); inner card rises
    // above with an arrow pointing down — mirrors Leaflet's popup chrome.
    const anchor = document.createElement('div');
    anchor.className = 'three-popup-anchor';

    const card = document.createElement('div');
    // ncz-popup-top is the default direction: popup ABOVE pin, arrow points
    // down to the pin. Auto-flip toggles to `ncz-popup-bottom` when needed.
    // Direction class names match the 2D Leaflet popup so they share CSS.
    card.className = `three-popup ncz-dynamic-popup ncz-popup-top popup-${catStyle.class}`;
    card.innerHTML = html;
    anchor.appendChild(card);

    // Clipboard copy handler — same behaviour as Leaflet popup
    const copyBtn = card.querySelector('.ui-popup-action-link-copy-link');
    if (copyBtn) {
      let copyRevertTimer = null;
      copyBtn.addEventListener('click', () => {
        const url = copyBtn.dataset.copyUrl;
        clearTimeout(copyRevertTimer);
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = 'Copied!';
          copyRevertTimer = setTimeout(() => {
            copyBtn.innerHTML = '<span class="ui-popup-action-link-icon" aria-hidden="true"></span>';
          }, NCZ.COPY_FEEDBACK_MS);
        });
      });
    }

    popup = new CSS2DObject(anchor);
    popup.layers.set(NCZ.LAYER_PINS);
    // High renderOrder so CSS2DRenderer's depth-based zIndex sorter ranks the
    // popup above all pins. Backed up by a CSS `!important` z-index on
    // .three-popup-anchor so pins can never paint over the popup even if a
    // future Three.js release ignores renderOrder for CSS2DObjects.
    popup.renderOrder = 1000;
    const pin = pins.get(mod.id);
    if (pin) popup.position.copy(pin.position);
    pinsLayer.add(popup);
    popupModId = mod.id;
    syncUrlForMod(mod);
  }

  function closePopup({ silent = false } = {}) {
    if (!popup) return;
    pinsLayer.remove(popup);
    popup.element?.remove();
    popup = null;
    popupModId = null;
    if (!silent) clearUrlMod();
  }

  // URL deep-link sync — matches the Leaflet popupopen/popupclose handlers
  // so refreshing or switching views re-opens the same pin.
  function syncUrlForMod(mod) {
    const isNum = /^\d+$/.test(String(mod.nexus_id));
    const lid = isNum ? String(mod.nexus_id) : mod.id;
    const url = new URL(window.location.href);
    url.searchParams.set(NCZ.URL_PARAM_MOD, lid);
    history.replaceState(null, '', url.toString());
  }
  function clearUrlMod() {
    const url = new URL(window.location.href);
    url.searchParams.delete(NCZ.URL_PARAM_MOD);
    history.replaceState(null, '', url.toString());
  }

  function focusMod(modId) {
    const pin = pins.get(modId);
    if (!pin) return;
    // If we don't have controls (called before attach somehow), just open.
    if (!controls) {
      openPopup(pin.userData.modData);
      return;
    }
    flyTo(pin, () => openPopup(pin.userData.modData));
  }

  // Smooth ease-in-out so the camera doesn't jolt at start or stop.
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // Tween OrbitControls' target (XZ only — keep camera height) + camera.position
  // by the same delta (preserving the spherical offset) + camera.zoom. Runs in
  // the render loop via updateFlyTween().
  function flyTo(pin, onComplete) {
    const startTarget = controls.target.clone();
    // Target the pin's full world position INCLUDING height. With a tilted
    // camera, a ground-plane target leaves rooftop pins (e.g. Crystal Palace
    // Resort) off-centre after the fly. Tracking the pin's Y aligns it to
    // screen centre regardless of tilt or pin elevation.
    const endTarget = pin.position.clone();

    const offset = _schemaCamera.position.clone().sub(startTarget); // preserved
    const startCameraPos = _schemaCamera.position.clone();
    const endCameraPos   = endTarget.clone().add(offset);

    _flyTween = {
      startTarget, endTarget,
      startCameraPos, endCameraPos,
      startZoom: _schemaCamera.zoom,
      endZoom:   NCZ.PIN_3D_FLY_ZOOM,
      elapsed: 0,
      duration: NCZ.PIN_3D_FLY_DURATION_MS,
      onComplete,
    };
    _flyLastTime = performance.now();
  }

  function updateFlyTween() {
    if (!_flyTween) return;
    const now = performance.now();
    const dt = now - _flyLastTime;
    _flyLastTime = now;
    _flyTween.elapsed += dt;

    const u = Math.min(_flyTween.elapsed / _flyTween.duration, 1);
    const e = easeInOutCubic(u);

    controls.target.lerpVectors(_flyTween.startTarget, _flyTween.endTarget, e);
    _schemaCamera.position.lerpVectors(_flyTween.startCameraPos, _flyTween.endCameraPos, e);
    _schemaCamera.zoom = _flyTween.startZoom + (_flyTween.endZoom - _flyTween.startZoom) * e;
    _schemaCamera.updateProjectionMatrix();

    if (u >= 1) {
      const cb = _flyTween.onComplete;
      _flyTween = null;
      cb?.();
    }
  }

  // Cheap per-frame check: if the popup's anchor is too close to the viewport
  // top to fit the card above, flip it below the pin. Re-evaluates every render
  // so it stays correct as the user pans/tilts/zooms — costs one Vector3.project()
  // and a className toggle, which is negligible.
  const _projectV = new THREE.Vector3();
  function updatePopupPlacement() {
    if (!popup || !container) return;
    const card = popup.element.querySelector('.three-popup');
    if (!card) return;
    _projectV.copy(popup.position).project(getCam());
    const halfH = container.clientHeight / 2;
    // Convert NDC y ∈ [-1,1] to pixel y where 0 = top of viewport.
    const screenY = (1 - _projectV.y) * halfH;
    const cardH = card.offsetHeight;
    const flip = screenY < cardH + NCZ.PIN_3D_POPUP_FLIP_PADDING_PX;
    // Toggle the same direction classes Leaflet uses; CSS arrow geometry is
    // defined once in the shared .ncz-dynamic-popup chrome rules.
    card.classList.toggle('ncz-popup-top', !flip);
    card.classList.toggle('ncz-popup-bottom', flip);
  }

  function render() {
    if (!cssRenderer || !scene || !_schemaCamera) return;
    updateFlyTween();
    cssRenderer.render(scene, getCam());
    if (popup) updatePopupPlacement();
  }

  function onResize(w, h) {
    if (cssRenderer) cssRenderer.setSize(w, h);
  }

  // Swap the CSS2DRenderer's projection camera for the duration of the
  // showcase. Passing a camera (typically the flyover PerspectiveCamera)
  // makes pins, clusters, popup and tooltip track that camera's view; passing
  // null reverts to the schema OrthographicCamera. On revert we trigger a
  // cluster recompute so the orthographic-only math resyncs against the
  // current zoom (which may have changed during the showcase).
  function setActiveCamera(cam) {
    _activeCamera = cam || null;
    if (!cam) recomputeClusters();
  }

  // Toggle the marker overlay's membership of the schema camera's layer mask.
  // Off → CSS2DRenderer's per-object layers test sets each pin/cluster/popup/
  // tooltip DOM element's display to 'none' on the next render frame. On →
  // they reappear. Backs the "Pins" entry in #overlay-controls; orthogonal
  // to the showcase modal's "Show mod pins during showcase" option which
  // toggles the FLYOVER camera's layer mask instead.
  function setOverlayVisible(visible) {
    if (!_schemaCamera) return;
    if (visible) _schemaCamera.layers.enable(NCZ.LAYER_PINS);
    else         _schemaCamera.layers.disable(NCZ.LAYER_PINS);
  }
  function getOverlayVisible() {
    if (!_schemaCamera) return null;
    return _schemaCamera.layers.isEnabled(NCZ.LAYER_PINS);
  }

  // Cinematic mode: hide every cluster bubble and unhide every filter-passing
  // pin so the showcase shows individual mods instead of number-badges.
  //
  // CSS2DRenderer checks `object.visible` per-CSS2DObject (not on parent groups
  // — the renderer walks all children regardless of group.visible), so we have
  // to flip `visible` on each cluster bubble individually rather than on the
  // parent _clusterLayer Group.
  //
  // active=false leaves cluster restoration to the next recomputeClusters call
  // (typically issued by setActiveCamera(null) on showcase exit), which
  // rebuilds the correct visible/clustered state from scratch.
  function setUnclusteredMode(active) {
    if (active) {
      pins.forEach((pin, modId) => { pin.visible = _filterVisibleIds.has(modId); });
      if (_clusterLayer) _clusterLayer.children.forEach(c => { c.visible = false; });
    } else {
      // Defensive: if the caller doesn't follow up with a recompute, at least
      // make the active bubbles renderable again so users aren't left with a
      // half-state. recomputeClusters (when it runs) will overwrite this with
      // the authoritative grouped state.
      if (_clusterLayer) _clusterLayer.children.forEach(c => { c.visible = true; });
    }
  }

  return {
    attach,
    setMods,
    applyFilters,
    getVisibleModIds,
    focusMod,
    setPulse,
    setClusterClickHandler,
    setClustersChangedHandler,
    setActiveClusterMods,
    closePopup,
    render,
    onResize,
    setActiveCamera,
    setOverlayVisible,
    getOverlayVisible,
    setUnclusteredMode,
  };
})();

window.NCZ.ThreeMarkers = ThreeMarkers;
