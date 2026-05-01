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
  let camera = null;
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
    camera = _camera;
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

    pinsLayer = new THREE.Group();
    pinsLayer.name = 'three-markers';
    scene.add(pinsLayer);

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
      css.position.set(tx, ty, tz);
      css.userData.modData = mod;
      pinsLayer.add(css);
      pins.set(mod.id, css);
    }
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
    for (const [id, obj] of pins) {
      obj.visible = visibleIdSet.has(id);
    }
    if (popupModId && !visibleIdSet.has(popupModId)) closePopup();
  }

  // Returns mod IDs of pins whose CSS2DObject is currently visible (i.e. passed
  // the active filters). Used by the Discover button to pick a random
  // unfiltered pin in 3D mode.
  function getVisibleModIds() {
    const ids = [];
    for (const [id, pin] of pins) {
      if (pin.visible) ids.push(id);
    }
    return ids;
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

    const offset = camera.position.clone().sub(startTarget); // preserved
    const startCameraPos = camera.position.clone();
    const endCameraPos   = endTarget.clone().add(offset);

    _flyTween = {
      startTarget, endTarget,
      startCameraPos, endCameraPos,
      startZoom: camera.zoom,
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
    camera.position.lerpVectors(_flyTween.startCameraPos, _flyTween.endCameraPos, e);
    camera.zoom = _flyTween.startZoom + (_flyTween.endZoom - _flyTween.startZoom) * e;
    camera.updateProjectionMatrix();

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
    _projectV.copy(popup.position).project(camera);
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
    if (!cssRenderer || !scene || !camera) return;
    updateFlyTween();
    cssRenderer.render(scene, camera);
    if (popup) updatePopupPlacement();
  }

  function onResize(w, h) {
    if (cssRenderer) cssRenderer.setSize(w, h);
  }

  return {
    attach,
    setMods,
    applyFilters,
    getVisibleModIds,
    focusMod,
    setPulse,
    closePopup,
    render,
    onResize,
  };
})();

window.NCZ.ThreeMarkers = ThreeMarkers;
