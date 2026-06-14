/**
 * NC Zoning Board — Main Application Logic
 * DOM manipulation, map initialization, event handlers, sidebar, modals, image gallery.
 * Depends on: constants.js, utils.js, services.js (via NCZ namespace).
 */

document.addEventListener("DOMContentLoaded", () => {
  // Terminal header close buttons — delegates to each modal's existing close button
  document.querySelectorAll(".terminal-close-btn[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = document.getElementById(btn.dataset.closeModal);
      if (modal) modal.classList.add("hidden");
      // Preserve welcome modal session flag
      if (btn.dataset.closeModal === "welcome-modal") {
        sessionStorage.setItem("nc_zoning_board_visited", "true");
      }
    });
  });

  // Welcome Modal Logic — runs immediately, independent of map loading
  const welcomeModal = document.getElementById("welcome-modal");
  const closeModalBtn = document.getElementById("close-modal");

  if (!sessionStorage.getItem("nc_zoning_board_visited")) {
    welcomeModal.classList.remove("hidden");
  } else {
    welcomeModal.classList.add("hidden");
  }

  closeModalBtn.addEventListener("click", () => {
    welcomeModal.classList.add("hidden");
    sessionStorage.setItem("nc_zoning_board_visited", "true");
  });

  // About Modal Logic
  const aboutBtn = document.getElementById("about-btn");
  const aboutModal = document.getElementById("about-modal");
  const closeAboutBtn = document.getElementById("close-about-modal");
  const aboutOpenBbcodeLink = document.getElementById("about-open-bbcode-link");
  const sidebarOpenBbcodeLink = document.getElementById("sidebar-open-bbcode-link");

  aboutBtn.addEventListener("click", () => {
    aboutModal.classList.remove("hidden");
  });

  closeAboutBtn.addEventListener("click", () => {
    aboutModal.classList.add("hidden");
  });

  // WebGPU-unsupported notice — footer button. The header X is handled by the
  // delegated .terminal-close-btn[data-close-modal] listener above.
  const closeWebgpuModalBtn = document.getElementById("close-webgpu-unsupported-modal");
  if (closeWebgpuModalBtn) {
    closeWebgpuModalBtn.addEventListener("click", () => {
      document.getElementById("webgpu-unsupported-modal").classList.add("hidden");
    });
  }

// Parameters Modal Logic
  const parametersBtn = document.getElementById("parameters-btn");
  const parametersModal = document.getElementById("parameters-modal");
  const closeParametersModalBtn = document.getElementById("close-parameters-modal");
  const themeSelect = document.getElementById("theme-select");
  const headerLogoImg = document.getElementById("header-logo-img");
  const themedModalHeaderLabels = document.querySelectorAll(".terminal-header-theme-label[data-modal-title]");
  const themes = Array.isArray(NCZ.THEMES) && NCZ.THEMES.length
    ? NCZ.THEMES
    : [{
      id: "night-corp",
      label: "Night Corp",
      className: "theme-night-corp",
      logo: "assets/img/nightcorp-logo.webp",
      logoAlt: "Night Corp",
    }];

  function openParametersModal() {
    if (parametersModal) parametersModal.classList.remove("hidden");
  }

  function closeParametersModal() {
    if (parametersModal) parametersModal.classList.add("hidden");
  }

  if (parametersBtn) parametersBtn.addEventListener("click", openParametersModal);
  if (closeParametersModalBtn) closeParametersModalBtn.addEventListener("click", closeParametersModal);

  function findThemeById(themeId) {
    return themes.find((theme) => theme.id === themeId) || themes[0];
  }

  function findThemeByClassName(themeClassName) {
    return themes.find((theme) => theme.className === themeClassName) || themes[0];
  }

  function getStoredThemeId() {
    try {
      const storedThemeId = localStorage.getItem(NCZ.THEME_PREFERENCE_KEY);
      if (!storedThemeId) return null;
      return themes.some((theme) => theme.id === storedThemeId) ? storedThemeId : null;
    } catch (_) {
      return null;
    }
  }

  function findActiveThemeClassName() {
    return Array.from(document.documentElement.classList).find((cls) =>
      cls.startsWith("theme-")
    );
  }

  function getInitialThemeId() {
    const storedThemeId = getStoredThemeId();
    if (storedThemeId) return storedThemeId;

    const activeThemeClass = findActiveThemeClassName();
    return activeThemeClass ? findThemeByClassName(activeThemeClass).id : themes[0].id;
  }

  function applyHeaderThemeBranding(theme) {
    if (!headerLogoImg || !theme) return;
    if (theme.logo) headerLogoImg.src = theme.logo;
    headerLogoImg.alt = theme.logoAlt || theme.label || "Header logo";
  }

  function applyModalHeaderThemeBranding(theme) {
    const themePrefix = (theme?.label || "Night Corp").toUpperCase();
    themedModalHeaderLabels.forEach((label) => {
      const modalTitle = label.dataset.modalTitle || "";
      label.textContent = `${themePrefix} // ${modalTitle}`;
    });
  }

  function applyThemeById(themeId, { persist = true } = {}) {
    const theme = findThemeById(themeId);
    const targetClass = theme.className || `theme-${theme.id}`;
    const root = document.documentElement;

    Array.from(root.classList)
      .filter((cls) => cls.startsWith("theme-"))
      .forEach((cls) => root.classList.remove(cls));
    root.classList.add(targetClass);

    applyHeaderThemeBranding(theme);
    applyModalHeaderThemeBranding(theme);
    if (themeSelect) themeSelect.value = theme.id;

    if (persist) {
      try {
        localStorage.setItem(NCZ.THEME_PREFERENCE_KEY, theme.id);
      } catch (_) {
        // Ignore storage write failures (private mode / restricted browsers).
      }
    }

    // Update Three.js scene materials and clear the 2D overlay tile cache
    // so both renderers pick up the new CSS custom properties immediately.
    NCZ.ThreeScene?.updateMaterials();
    // A theme switch resets the LUT grade to the new theme's default — reflect
    // that in the Settings toggle.
    const lutToggle = document.getElementById('lut-grade-toggle');
    if (lutToggle) lutToggle.checked = NCZ.ThreeScene?.getGradeEnabled?.() ?? false;
    NCZ._clearOverlayCache?.();
  }

  // Expose for flyover.js — persist:false so showcase changes don't overwrite
  // the user's saved preference in localStorage.
  NCZ.applyTheme = (id) => applyThemeById(id, { persist: false });

  const initialThemeId = getInitialThemeId();

  if (themeSelect) {
    themeSelect.innerHTML = "";
    themes.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.label;
      themeSelect.appendChild(option);
    });

    applyThemeById(initialThemeId, { persist: false });

    themeSelect.addEventListener("change", () => {
      applyThemeById(themeSelect.value);
    });
  } else {
    applyThemeById(initialThemeId, { persist: false });
  }

  // BBCode Generator Modal Logic
  const bbcodeBtn = document.getElementById("bbcode-btn");
  const bbcodeModal = document.getElementById("bbcode-modal");
  const closeBbcodeModalBtn = document.getElementById("close-bbcode-modal");

  function openBbcodeModal() {
    bbcodeModal.classList.remove("hidden");
  }
  function closeBbcodeModal() {
    bbcodeModal.classList.add("hidden");
  }

  if (aboutOpenBbcodeLink) {
    aboutOpenBbcodeLink.addEventListener("click", (event) => {
      event.preventDefault();
      aboutModal.classList.add("hidden");
      openBbcodeModal();
    });
  }

  if (sidebarOpenBbcodeLink) {
    sidebarOpenBbcodeLink.addEventListener("click", (event) => {
      event.preventDefault();
      openBbcodeModal();
    });
  }

  if (bbcodeBtn) bbcodeBtn.addEventListener("click", openBbcodeModal);
  if (closeBbcodeModalBtn) closeBbcodeModalBtn.addEventListener("click", closeBbcodeModal);

  const bbcodeGenerateBtn = document.getElementById("bbcode-generate-btn");
  if (bbcodeGenerateBtn) {
    bbcodeGenerateBtn.addEventListener("click", () => {
      const x = document.getElementById("bbcode-coord-x").value.trim();
      const y = document.getElementById("bbcode-coord-y").value.trim();
      const z = document.getElementById("bbcode-coord-z").value.trim();
      const yaw = document.getElementById("bbcode-yaw").value.trim();
      const category = document.getElementById("bbcode-category").value;
      const credits = document.getElementById("bbcode-credits").value.trim();
      const authors = document.getElementById("bbcode-authors").value.trim();
      const spoiler = document.getElementById("bbcode-spoiler").checked;

      const xNum = parseFloat(x);
      const yNum = parseFloat(y);
      const zNum = parseFloat(z);
      if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) {
        alert("Please enter valid X and Y coordinates.");
        return;
      }
      if (Math.abs(xNum) > 5000 || Math.abs(yNum) > 5000) {
        alert("Coordinates appear out of range. Night City CET coords are typically within \u00b14000. Check your values.");
        return;
      }
      if (!Number.isFinite(zNum)) {
        alert("Please enter a valid Z coordinate.");
        return;
      }
      if (Math.abs(zNum) > 1000) {
        alert("Z coordinate appears out of range. Night City Z coords are typically within \u00b1300. Check your value.");
        return;
      }
      if (!category) {
        alert("Please select a category.");
        return;
      }

      const selectedTags = Array.from(
        document.querySelectorAll("#bbcode-tag-checkboxes input:checked"),
      ).map((cb) => cb.value).join(",");

      const lines = [`NCZoning:`, `coords=${x},${y},${z}`, `category=${category}`];
      if (selectedTags) lines.push(`tags=${selectedTags}`);
      if (yaw && Number.isFinite(parseFloat(yaw))) lines.push(`yaw=${yaw}`);
      if (credits) lines.push(`credits=${credits}`);
      if (authors) lines.push(`authors=${authors}`);

      let block = `[code]\n${lines.join("\n")}\n[/code]`;
      if (spoiler) block = `[spoiler]\n${block}\n[/spoiler]`;

      document.getElementById("bbcode-output").value = block;
      document.getElementById("bbcode-output-section").classList.remove("hidden");
    });
  }

  const bbcodeCopyBtn = document.getElementById("bbcode-copy-btn");
  if (bbcodeCopyBtn) {
    bbcodeCopyBtn.addEventListener("click", () => {
      const output = document.getElementById("bbcode-output").value;
      navigator.clipboard.writeText(output).then(() => {
        const original = bbcodeCopyBtn.textContent;
        bbcodeCopyBtn.textContent = "[ COPIED! ]";
        setTimeout(() => {
          bbcodeCopyBtn.textContent = original;
        }, NCZ.COPY_FEEDBACK_MS);
      }).catch(() => {
        bbcodeCopyBtn.textContent = "[ COPY FAILED ]";
        setTimeout(() => {
          bbcodeCopyBtn.textContent = "[ COPY TO CLIPBOARD ]";
        }, NCZ.COPY_FEEDBACK_MS);
      });
    });
  }

  const bbcodeResetBtn = document.getElementById("bbcode-reset-btn");
  if (bbcodeResetBtn) {
    bbcodeResetBtn.addEventListener("click", () => {
      document.getElementById("bbcode-coord-x").value = "";
      document.getElementById("bbcode-coord-y").value = "";
      document.getElementById("bbcode-coord-z").value = "";
      document.getElementById("bbcode-yaw").value = "";
      document.getElementById("bbcode-category").value = "";
      document.getElementById("bbcode-credits").value = "";
      document.getElementById("bbcode-authors").value = "";
      document.getElementById("bbcode-spoiler").checked = false;
      document.querySelectorAll("#bbcode-tag-checkboxes input:checked").forEach((cb) => (cb.checked = false));
      document.getElementById("bbcode-output-section").classList.add("hidden");
      document.getElementById("bbcode-output").value = "";
    });
  }

  const bbcodeCopyCetBtn = document.getElementById("bbcode-copy-cet-btn");
  if (bbcodeCopyCetBtn) {
    let cetCopyRevertTimer = null;
    const revertCetBtn = () => {
      bbcodeCopyCetBtn.innerHTML = '<span class="ui-popup-action-link-icon" aria-hidden="true"></span>';
    };
    bbcodeCopyCetBtn.addEventListener("click", () => {
      const command = document.getElementById("bbcode-cet-command").textContent;
      clearTimeout(cetCopyRevertTimer);
      navigator.clipboard.writeText(command).then(() => {
        bbcodeCopyCetBtn.textContent = "Copied!";
        cetCopyRevertTimer = setTimeout(revertCetBtn, NCZ.COPY_FEEDBACK_MS);
      }).catch(() => {
        bbcodeCopyCetBtn.textContent = "Failed";
        cetCopyRevertTimer = setTimeout(revertCetBtn, NCZ.COPY_FEEDBACK_MS);
      });
    });
  }

  // Sync Offset Telemetry Animation
  const statusLed = document.querySelector(".status-led");
  const statusLabel = document.querySelector(".status-label");
  const statusTelemetry = document.querySelector(".status-telemetry");

  if (statusLed && statusLabel && statusTelemetry) {
    setInterval(() => {
      // Generate mostly low values with occasional spikes
      let offset;
      const roll = Math.random();
      if (roll < 0.85) {
        offset = Math.random() * 200; // Normal: 0–200ms
      } else if (roll < 0.95) {
        offset = 200 + Math.random() * 600; // Elevated: 200–800ms
      } else {
        offset = 800 + Math.random() * 1000; // Critical: >800ms
      }

      statusTelemetry.textContent = `SYNC_OFFSET: ${offset.toFixed(2)}ms`;

      // Update LED and status based on thresholds
      statusLed.classList.remove("led-amber", "led-red");
      statusLabel.classList.remove("status-elevated", "status-critical");

      if (offset > 800) {
        statusLed.classList.add("led-red");
        statusLabel.classList.add("status-critical");
        statusLabel.textContent = "[SYSTEM_STATUS: CRITICAL]";
      } else if (offset > 200) {
        statusLed.classList.add("led-amber");
        statusLabel.classList.add("status-elevated");
        statusLabel.textContent = "[SYSTEM_STATUS: ELEVATED]";
      } else {
        statusLabel.textContent = "[SYSTEM_STATUS: NOMINAL]";
      }
    }, 2000);
  }

  initMap();
});

/** Controls pin hover tooltip placement and visibility inside map bounds. */
function createPinTooltipController(map) {
  // Create one tooltip element we reuse for every marker.
  const container = map.getContainer();
  const tooltipEl = document.createElement("div");
  tooltipEl.className = "pin-tooltip";
  tooltipEl.innerHTML = `
    <div class="pin-tooltip-content"></div>
    <div class="pin-tooltip-arrow" aria-hidden="true"></div>
  `;
  container.appendChild(tooltipEl);

  const contentEl = tooltipEl.querySelector(".pin-tooltip-content");
  let activeMarker = null;

  function clearDirectionClasses() {
    tooltipEl.classList.remove("dir-top", "dir-bottom", "dir-left", "dir-right");
  }

  function measureTooltip() {
    // Temporarily show tooltip to get its current size.
    tooltipEl.classList.add("visible", "measure");
    const rect = contentEl.getBoundingClientRect();
    tooltipEl.classList.remove("measure");
    return {
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height)),
    };
  }

  function positionTooltip() {
    const markerEl = activeMarker?.getElement?.();
    if (!activeMarker || !markerEl) {
      hide();
      return;
    }

    const point = map.latLngToContainerPoint(activeMarker.getLatLng());
    const mapWidth = container.clientWidth;
    const mapHeight = container.clientHeight;
    const size = measureTooltip();
    const { direction, left, top, arrowX, arrowY } = NCZ.pickDirectionAndPosition(
      point,
      size,
      { x: mapWidth, y: mapHeight },
      {
        marginPx: NCZ.PIN_TOOLTIP_MARGIN_PX,
        gapPx: NCZ.PIN_TOOLTIP_GAP_PX,
        arrowSizePx: NCZ.PIN_TOOLTIP_ARROW_SIZE_PX,
        arrowEdgePaddingPx: NCZ.PIN_TOOLTIP_ARROW_EDGE_PADDING_PX,
      },
    );

    clearDirectionClasses();
    tooltipEl.classList.add(`dir-${direction}`);

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.setProperty("--pin-tooltip-arrow-x", `${arrowX}px`);
    tooltipEl.style.setProperty("--pin-tooltip-arrow-y", `${arrowY}px`);
  }

  function show(marker, text) {
    activeMarker = marker;
    contentEl.textContent = text;
    tooltipEl.classList.add("visible");
    positionTooltip();
  }

  function hide(marker = null) {
    if (marker && marker !== activeMarker) return;
    activeMarker = null;
    tooltipEl.classList.remove("visible");
  }

  return {
    show,
    hide,
    reposition: positionTooltip,
  };
}

/** Repositions an open popup so it stays visible and points to its pin. */
function positionDynamicPopup(map, popup) {
  if (!popup) return;

  const popupEl = popup.getElement?.();
  if (!popupEl) return;

  const wrapperEl = popupEl.querySelector(".leaflet-popup-content-wrapper");
  if (!wrapperEl) return;

  popupEl.classList.add("ncz-dynamic-popup");

  const imageEl = popupEl.querySelector(".custom-popup-header.has-image");
  const titleEl = popupEl.querySelector(".custom-popup-title");
  const imageHeight = imageEl ? Math.ceil(imageEl.getBoundingClientRect().height) : 0;
  const titleHeight = titleEl ? Math.ceil(titleEl.getBoundingClientRect().height) : 0;
  const gradientTopStopPx = imageHeight + titleHeight;
  const gradientBottomStopPx = gradientTopStopPx + 20;
  popupEl.style.setProperty("--ncz-popup-gradient-top-stop", `${gradientTopStopPx}px`);
  popupEl.style.setProperty("--ncz-popup-gradient-bottom-stop", `${gradientBottomStopPx}px`);

  // Read popup size and marker anchor position.
  const size = {
    width: Math.max(1, Math.ceil(wrapperEl.offsetWidth)),
    height: Math.max(1, Math.ceil(wrapperEl.offsetHeight)),
  };
  const mapSize = map.getSize();
  const anchor = map.latLngToContainerPoint(popup.getLatLng());
  const { direction, left, top, arrowX, arrowY } = NCZ.pickDirectionAndPosition(
    anchor,
    size,
    mapSize,
    {
      marginPx: NCZ.PIN_POPUP_MARGIN_PX,
      gapPx: NCZ.PIN_POPUP_GAP_PX,
      arrowSizePx: NCZ.PIN_POPUP_ARROW_SIZE_PX,
      arrowEdgePaddingPx: NCZ.PIN_POPUP_ARROW_EDGE_PADDING_PX,
    },
  );

  const layerPos = map.containerPointToLayerPoint(L.point(left, top));
  L.DomUtil.setPosition(popupEl, layerPos);
  popupEl.style.left = "0px";
  popupEl.style.top = "0px";
  popupEl.style.bottom = "auto";
  popupEl.style.margin = "0";
  popupEl.style.setProperty("--ncz-popup-arrow-x", `${arrowX}px`);
  popupEl.style.setProperty("--ncz-popup-arrow-y", `${arrowY}px`);

  popupEl.classList.remove("ncz-popup-top", "ncz-popup-bottom", "ncz-popup-left", "ncz-popup-right");
  popupEl.classList.add(`ncz-popup-${direction}`);
}

// isRecentlyUpdated moved to NCZ.isRecentlyUpdated in utils.js

async function initMap() {
  const calibratedSimpleCrs = L.extend({}, L.CRS.Simple, {
    distance(latlngA, latlngB) {
      return NCZ.leafletDistanceMeters(latlngA, latlngB);
    },
  });

  // 1. Setup Map
  const map = L.map("map", {
    crs: calibratedSimpleCrs,
    minZoom: 0,
    maxZoom: 8,
    maxBoundsViscosity: 1.0,
    attributionControl: false,
    zoomControl: false, // Disable default top-left zoom control
  });

  // Add distance scale line control (Leaflet native control class: .leaflet-control-scale-line).
  L.control.scale({
    position: "bottomright",
    metric: true,
    imperial: false,
    maxWidth: 160,
    updateWhenIdle: true,
  }).addTo(map);

  // Add zoom control manually to the bottom right
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const maxNativeZoom = 6;
  const southWest = map.unproject([0, 16384], maxNativeZoom);
  const northEast = map.unproject([16384, 0], maxNativeZoom);
  const mapBounds = new L.LatLngBounds(southWest, northEast);
  const panEdgeFraction = 0.5; // Let each map edge travel about halfway toward screen center.

  function updatePannableBounds() {
    const size = map.getSize();
    const scaleToMaxZoom = map.getZoomScale(maxNativeZoom, map.getZoom());
    const padX = size.x * panEdgeFraction * scaleToMaxZoom;
    const padY = size.y * panEdgeFraction * scaleToMaxZoom;
    const mapSouthWestPoint = map.project(mapBounds.getSouthWest(), maxNativeZoom);
    const mapNorthEastPoint = map.project(mapBounds.getNorthEast(), maxNativeZoom);

    const pannableSouthWest = L.point(mapSouthWestPoint.x - padX, mapSouthWestPoint.y + padY);
    const pannableNorthEast = L.point(mapNorthEastPoint.x + padX, mapNorthEastPoint.y - padY);
    const pannableBounds = L.latLngBounds(
      map.unproject(pannableSouthWest, maxNativeZoom),
      map.unproject(pannableNorthEast, maxNativeZoom),
    );
    map.setMaxBounds(pannableBounds);
  }

  L.tileLayer("assets/tiles/{z}/{x}/{y}.webp", {
    minZoom: 0,
    maxNativeZoom: 6,
    maxZoom: 8,
    tileSize: 256,
    noWrap: true,
    bounds: mapBounds,
  }).addTo(map);

  map.invalidateSize();
  map.fitBounds(mapBounds);
  updatePannableBounds();
  map.on("zoomend resize", updatePannableBounds);

  // Initialise SAT district overlay
  NCZ.Overlay.init(map);

  // View switching (SAT ↔ SCHEMA)
  const mapEl   = document.getElementById("map");
  const map3dEl = document.getElementById("map-3d");
  // Set inside the data-load try block once mods + markers are available.
  // switchView calls it after toggling so the open popup persists across views.
  let onViewSwitched = null;
  // Set false once WebGPU is known unavailable (forceSatFallback). Blocks any
  // re-entry into the broken 3D view — deep link, keyboard, stray call.
  let threeDAvailable = true;
  let webgpuFallbackDone = false;
  // ?gamelight — calibration reference mode. Pins the 3D scene to the decoded
  // in-game 3D-map lighting state: sun fixed at the 3dmap.envparam
  // GlobalLightOverride (azimuth 107.12°, elevation 7°), time-of-day slider
  // frozen, and the Districts/Pins overlays stripped so the terrain/buildings
  // can be colour-matched against the in-game SDR capture without obstruction.
  // A reproducible reference frame — same URL always yields the identical
  // lighting state. Debug/calibration only; not linked from the UI.
  const GAMELIGHT = new URLSearchParams(window.location.search).has('gamelight');
  function switchView(viewName) {
    if (viewName === "schema" && !threeDAvailable) return;
    document.querySelectorAll(".map-view-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === viewName);
    });

    // Dim SCHEMA-only overlay toggles when in SAT mode
    document.querySelectorAll(".overlay-toggle.schema-only").forEach(el => {
      el.classList.toggle("sat-active", viewName === "sat");
    });

    if (viewName === "schema") {
      mapEl.style.display   = "none";
      map3dEl.style.display = "block";
      // ThreeScene.init() is async under WebGPURenderer (await renderer.init()).
      // Chain startRenderLoop so the loop only ticks once the renderer is ready.
      // First-call goes through full async init; subsequent calls early-out
      // synchronously (initialized guard) and the chain still resolves immediately.
      Promise.resolve(NCZ.ThreeScene.init("map-3d"))
        .then(() => {
          // init() aborts early (no render loop wired) when the renderer fell
          // back to WebGL2 — buildings can't run there. Don't show a broken
          // 3D scene: drop the user onto the 2D Leaflet map instead.
          if (NCZ.ThreeScene.isWebGPUActive()) {
            NCZ.ThreeScene.startRenderLoop();
            // Sync the Settings LUT toggle to the scene's grade state now that
            // init() has applied the active theme's --scene-grade default.
            const lt = document.getElementById('lut-grade-toggle');
            if (lt) lt.checked = NCZ.ThreeScene.getGradeEnabled?.() ?? false;
            if (GAMELIGHT) applyGameLightRef();
          } else {
            forceSatFallback();
          }
        });
    } else {
      map3dEl.style.display = "none";
      mapEl.style.display   = "block";
      NCZ.ThreeScene.stopRenderLoop();
      map.invalidateSize();
    }
    onViewSwitched?.(viewName);
  }

  // WebGPU unavailable → the 3D view can't render correctly. Lock it off and
  // present the fully-functional 2D Leaflet map plus a one-time notice.
  // Idempotent: only the first call does anything.
  function forceSatFallback() {
    if (webgpuFallbackDone) return;
    webgpuFallbackDone = true;
    threeDAvailable = false;
    switchView("sat");
    const schemaBtn = document.querySelector('.map-view-btn[data-view="schema"]');
    if (schemaBtn) {
      schemaBtn.disabled = true;
      schemaBtn.classList.add("unavailable");
      schemaBtn.title = "3D view unavailable — WebGPU not supported";
    }
    const modal = document.getElementById("webgpu-unsupported-modal");
    if (modal) modal.classList.remove("hidden");
  }

  document.querySelectorAll(".map-view-btn").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  document.getElementById("scene-reset-btn").addEventListener("click", () => {
    NCZ.ThreeScene.resetCamera();
  });

  // ── Sun slider — time of day at Morro Bay, CA (Night City's real-world location)
  // Slider values are always in Morro Bay PDT (UTC-7, the summer offset).
  // All conversions use UTC internally so the browser's local timezone never
  // affects the sun position calculation.
  const SUN_LAT  = 35.370781, SUN_LNG = -120.851173;
  const PDT_OFFSET = -7; // Morro Bay summer (PDT) = UTC-7
  // June 21 at UTC midnight — year doesn't matter for sun geometry
  const SOLSTICE = new Date(Date.UTC(new Date().getFullYear(), 5, 21));

  const sunSlider      = document.getElementById("scene-sun-slider");
  const sunTimeDisplay = document.getElementById("scene-sun-time");

  // The decoded 3dmap.envparam GlobalLightOverride sun — fixed, no time of day.
  const GAMELIGHT_SUN_AZIMUTH   = 107.121956 * Math.PI / 180;
  const GAMELIGHT_SUN_ELEVATION = 7 * Math.PI / 180;

  function applySunTime(morroMinutes) {
    // ?gamelight — pin to the decoded reference sun, ignore the slider value.
    // Gating here (not just at the call sites) means every path that drives the
    // sun — slider setup, terrain-loaded apply, the UI-sync poll — keeps it
    // pinned, so the reference frame can't drift.
    if (GAMELIGHT) {
      NCZ.ThreeScene?.setSunPosition?.(GAMELIGHT_SUN_AZIMUTH, GAMELIGHT_SUN_ELEVATION);
      if (sunTimeDisplay) sunTimeDisplay.textContent = 'REF';
      return;
    }
    // morroMinutes = Morro Bay PDT (e.g. 600 = 10:00 AM PDT)
    if (typeof SunCalc === 'undefined' || !NCZ.ThreeScene?.setSunPosition) return;
    const date = new Date(SOLSTICE);
    // Convert PDT → UTC: PDT = UTC-7, so UTC = PDT + 7
    date.setUTCHours((Math.floor(morroMinutes / 60) - PDT_OFFSET) % 24, morroMinutes % 60, 0, 0);
    const pos = SunCalc.getPosition(date, SUN_LAT, SUN_LNG);
    NCZ.ThreeScene.setSunPosition(pos.azimuth, pos.altitude);
    // Time-of-day exposure — floor the dark ends without flattening the natural
    // day/night variation. Keyed on elevation so the flyover shares it. See
    // NCZ.SCENE_EXPOSURE_CURVE + NCZ.exposureForSunElevation.
    NCZ.ThreeScene?.setSceneExposure?.(NCZ.exposureForSunElevation(pos.altitude));
    const h = String(Math.floor(morroMinutes / 60)).padStart(2, '0');
    const m = String(morroMinutes % 60).padStart(2, '0');
    if (sunTimeDisplay) sunTimeDisplay.textContent = `${h}:${m}`;
  }

  if (sunSlider) {
    sunSlider.addEventListener("input", () => applySunTime(parseInt(sunSlider.value)));

    if (typeof SunCalc !== 'undefined') {
      // Compute solstice sunrise/sunset in UTC minutes, then convert to Morro Bay PDT
      const times      = SunCalc.getTimes(SOLSTICE, SUN_LAT, SUN_LNG);
      const utcToMorro = (date) => ((date.getUTCHours() * 60 + date.getUTCMinutes()) + PDT_OFFSET * 60 + 1440) % 1440;
      sunSlider.min    = utcToMorro(times.sunrise); // ~353 min = 05:53 PDT
      sunSlider.max    = utcToMorro(times.sunset);  // ~1216 min = 20:16 PDT
    } else {
      sunSlider.min = 353;
      sunSlider.max = 1216;
    }

    // Default: 8:00 AM PDT — sun ~24° elevation from the east. The high-noon
    // default (10am, el 48°) over-lights building tops under the new photometric
    // lighting; a moderate morning sun reads as 3D-massed city without blasting.
    const DEFAULT_SUN_MINUTES = 480;
    sunSlider.value = DEFAULT_SUN_MINUTES;
    applySunTime(DEFAULT_SUN_MINUTES);
  }

  // ── Shadows toggle
  document.getElementById("overlay-shadows")?.addEventListener("change", e => {
    NCZ.ThreeScene?.setShadowsEnabled?.(e.target.checked);
  });

  // Settings → "Colour grade (LUT)" toggle. Overrides the active theme's
  // --scene-grade default for the session; a theme switch resets it (see
  // applyThemeById). Initial state synced from the scene once it's live.
  const lutToggle = document.getElementById("lut-grade-toggle");
  if (lutToggle) {
    lutToggle.addEventListener("change", e => {
      NCZ.ThreeScene?.setGradeEnabled?.(e.target.checked);
    });
  }

  // ?gamelight — apply the calibration reference state once the 3D scene is
  // live (called from switchView's schema branch). The sun is already pinned
  // by applySunTime()'s GAMELIGHT gate; here we freeze the slider and strip the
  // Districts/Pins overlays so they don't obscure the surfaces being matched
  // against the in-game capture. Shadows default off, so no action needed there.
  function applyGameLightRef() {
    applySunTime(0); // GAMELIGHT-gated → pins the decoded reference sun
    if (sunSlider) {
      sunSlider.disabled = true;
      sunSlider.title = '?gamelight — sun pinned to the decoded in-game reference';
    }
    document.querySelectorAll('[data-overlay]').forEach(cb => {
      const overlay = cb.dataset.overlay;
      if ((overlay === 'districts' || overlay === 'pins') && cb.checked) {
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
      }
    });
    console.info('[NCZ] ?gamelight — calibration reference: sun az 107.12°/el 7°, overlays stripped.');
  }

  const flyoverBtn = document.getElementById("scene-flyover-btn");
  // Elements to hide during showcase. We save each one's inline display value
  // so we can restore it exactly — this handles elements that JS may have
  // already toggled (e.g. sidebar-open uses a .visible class, not display).
  const _showcaseEls = [];

  // ── Showcase Options modal ──────────────────────────────────────────────
  const showcaseModal           = document.getElementById("showcase-modal");
  const showcaseStartBtn        = document.getElementById("showcase-start-btn");
  const showcaseResetBtn        = document.getElementById("showcase-reset-btn");
  const showcaseCancelBtn       = document.getElementById("close-showcase-modal");
  const showcaseThemeSelect     = document.getElementById("showcase-theme");
  const showcaseShowPinsCb      = document.getElementById("showcase-show-pins");
  const showcaseRevealLayersCb  = document.getElementById("showcase-reveal-layers");
  const showcaseDistrictsCb     = document.getElementById("showcase-districts");
  const showcaseAudioCb         = document.getElementById("showcase-audio");
  const showcaseLoopCb          = document.getElementById("showcase-loop");

  // Populate the theme dropdown from NCZ.THEMES so it stays the single source
  // of truth. "Cycle" is preserved as the first option from the markup.
  if (showcaseThemeSelect && Array.isArray(NCZ.THEMES)) {
    NCZ.THEMES.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label;
      showcaseThemeSelect.appendChild(opt);
    });
  }

  const SHOWCASE_DEFAULTS = Object.freeze({
    theme: "cycle",
    showPins: false,
    revealLayers: false,
    districts: false,
    audio: true,
    loop: false,
  });

  function readStoredShowcaseOptions() {
    try {
      const raw = localStorage.getItem(NCZ.SHOWCASE_OPTIONS_KEY);
      if (!raw) return { ...SHOWCASE_DEFAULTS };
      const parsed = JSON.parse(raw);
      const validThemes = new Set(["cycle", ...(NCZ.THEMES || []).map(t => t.id)]);
      return {
        theme:        validThemes.has(parsed.theme) ? parsed.theme : SHOWCASE_DEFAULTS.theme,
        showPins:     typeof parsed.showPins     === "boolean" ? parsed.showPins     : SHOWCASE_DEFAULTS.showPins,
        revealLayers: typeof parsed.revealLayers === "boolean" ? parsed.revealLayers : SHOWCASE_DEFAULTS.revealLayers,
        districts:    typeof parsed.districts    === "boolean" ? parsed.districts    : SHOWCASE_DEFAULTS.districts,
        audio:        typeof parsed.audio        === "boolean" ? parsed.audio        : SHOWCASE_DEFAULTS.audio,
        loop:         typeof parsed.loop         === "boolean" ? parsed.loop         : SHOWCASE_DEFAULTS.loop,
      };
    } catch (_) {
      return { ...SHOWCASE_DEFAULTS };
    }
  }

  function openShowcaseModal() {
    const opts = readStoredShowcaseOptions();
    if (showcaseThemeSelect)    showcaseThemeSelect.value      = opts.theme;
    if (showcaseShowPinsCb)     showcaseShowPinsCb.checked     = opts.showPins;
    if (showcaseRevealLayersCb) showcaseRevealLayersCb.checked = opts.revealLayers;
    if (showcaseDistrictsCb)    showcaseDistrictsCb.checked    = opts.districts;
    if (showcaseAudioCb)        showcaseAudioCb.checked        = opts.audio;
    if (showcaseLoopCb)         showcaseLoopCb.checked         = opts.loop;
    showcaseModal?.classList.remove("hidden");
  }

  function closeShowcaseModal() {
    showcaseModal?.classList.add("hidden");
  }

  function enterShowcase(opts) {
    ['header', '#sidebar-open', '#discover-location-btn',
     '#overlay-controls', '#map-view-toggle', '#scene-controls', '#scene-scale']
      .forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        _showcaseEls.push({ el, display: el.style.display });
        el.style.display = 'none';
      });

    // Marker-overlay visibility during the showcase is owned by flyover.js:
    // it sets the flyCamera's layer mask based on opts.showPins and swaps
    // ThreeMarkers' active camera reference so projection lands correctly.
    document.getElementById('map-3d').classList.add('showcase-fullscreen');
    NCZ.Flyover.startFlyover(opts); // creates and manages the fade overlay internally
    flyoverBtn.classList.add("active");
    flyoverBtn.textContent = "Exit showcase";
    // Request native browser fullscreen — must be called from a user gesture (button click)
    document.documentElement.requestFullscreen().catch(() => {});
    setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
  }

  function exitShowcase() {
    try { NCZ.Flyover.stopFlyover(); } catch (e) { console.error('[NCZ] stopFlyover error:', e); }

    _showcaseEls.forEach(({ el }) => el.style.removeProperty('display'));
    _showcaseEls.length = 0;

    document.getElementById('map-3d').classList.remove('showcase-fullscreen');
    flyoverBtn.classList.remove("active");
    flyoverBtn.textContent = "Showcase";
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
  }

  flyoverBtn.addEventListener("click", () => {
    if (flyoverBtn.classList.contains("active")) { exitShowcase(); return; }
    openShowcaseModal();
  });

  showcaseStartBtn?.addEventListener("click", () => {
    const opts = {
      theme:        showcaseThemeSelect?.value ?? SHOWCASE_DEFAULTS.theme,
      showPins:     !!showcaseShowPinsCb?.checked,
      revealLayers: !!showcaseRevealLayersCb?.checked,
      districts:    !!showcaseDistrictsCb?.checked,
      audio:        !!showcaseAudioCb?.checked,
      loop:         !!showcaseLoopCb?.checked,
    };
    try { localStorage.setItem(NCZ.SHOWCASE_OPTIONS_KEY, JSON.stringify(opts)); } catch (_) {}
    closeShowcaseModal();
    enterShowcase(opts); // synchronous → fullscreen request stays inside the user-gesture task
  });

  showcaseCancelBtn?.addEventListener("click", closeShowcaseModal);

  // Reset rewinds the form inputs to SHOWCASE_DEFAULTS and persists them
  // immediately. Closing the modal (or hitting Cancel) after a Reset still
  // leaves defaults as the saved preference, so "Reset" reads as a complete
  // "wipe to defaults" action rather than a Start-gated form reset.
  showcaseResetBtn?.addEventListener("click", () => {
    if (showcaseThemeSelect)    showcaseThemeSelect.value      = SHOWCASE_DEFAULTS.theme;
    if (showcaseShowPinsCb)     showcaseShowPinsCb.checked     = SHOWCASE_DEFAULTS.showPins;
    if (showcaseRevealLayersCb) showcaseRevealLayersCb.checked = SHOWCASE_DEFAULTS.revealLayers;
    if (showcaseDistrictsCb)    showcaseDistrictsCb.checked    = SHOWCASE_DEFAULTS.districts;
    if (showcaseAudioCb)        showcaseAudioCb.checked        = SHOWCASE_DEFAULTS.audio;
    if (showcaseLoopCb)         showcaseLoopCb.checked         = SHOWCASE_DEFAULTS.loop;
    try { localStorage.setItem(NCZ.SHOWCASE_OPTIONS_KEY, JSON.stringify(SHOWCASE_DEFAULTS)); } catch (_) {}
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // Auto-exit when flyover reaches the end naturally (fires after the fade-to-black)
  document.addEventListener("flyover:ended", () => {
    if (flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // If the user exits native fullscreen manually (Escape / F11), also exit the showcase
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && flyoverBtn.classList.contains("active")) exitShowcase();
  });

  // Overlay toggles — delegate to the right renderer based on active view
  document.querySelectorAll("[data-overlay]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      const overlay = checkbox.dataset.overlay;
      const visible = checkbox.checked;
      if (overlay === "districts") {
        NCZ.Overlay.setDistricts(visible);           // SAT: Leaflet GeoJSON
        NCZ.ThreeScene.setLayerVisibility("districts", visible); // SCHEMA: THREE.Line
      } else {
        NCZ.ThreeScene.setLayerVisibility(overlay, visible);     // SCHEMA only
      }
    });
  });

  // UI sync — keep overlay checkboxes and sun slider in sync with actual scene state.
  // Runs at 200ms so console commands (setLayerVisibility, setCameraState etc.)
  // are reflected immediately in the UI. Cost: negligible (boolean reads + DOM writes
  // that short-circuit when unchanged).
  let _lastPolledSunEl = null;
  setInterval(() => {
    if (!NCZ.ThreeScene?.getLayerVisibility) return;

    // ?gamelight — hold the calibration reference state. Districts and the
    // shadow pass initialise asynchronously (after terrain load), so the
    // one-shot applyGameLightRef() can't catch them; re-assert here. The
    // checkbox sync below then unticks them to match. Guarded so it's a no-op
    // once settled (no per-tick shadow-map invalidation).
    if (GAMELIGHT) {
      if (NCZ.ThreeScene.getLayerVisibility('districts')) {
        NCZ.ThreeScene.setLayerVisibility('districts', false);
      }
      if (NCZ.ThreeScene.getShadowsEnabled?.()) {
        NCZ.ThreeScene.setShadowsEnabled(false);
      }
    }

    // Overlay checkboxes
    document.querySelectorAll("[data-overlay]").forEach(cb => {
      const vis = NCZ.ThreeScene.getLayerVisibility(cb.dataset.overlay);
      if (vis !== null && cb.checked !== vis) cb.checked = vis;
    });

    // Sun slider — reverse-map scene elevation back to morroMinutes via SunCalc scan
    if (sunSlider && typeof SunCalc !== 'undefined') {
      const el = NCZ.ThreeScene.getSunElevation?.();
      if (el !== undefined && el !== _lastPolledSunEl) {
        _lastPolledSunEl = el;
        let bestMin = 0, bestDiff = Infinity;
        for (let m = 0; m < 1440; m++) {
          const d = new Date(SOLSTICE);
          d.setUTCHours((Math.floor(m / 60) - PDT_OFFSET + 24) % 24, m % 60, 0, 0);
          const diff = Math.abs(SunCalc.getPosition(d, SUN_LAT, SUN_LNG).altitude - el);
          if (diff < bestDiff) { bestDiff = diff; bestMin = m; }
        }
        if (Number(sunSlider.value) !== bestMin) {
          sunSlider.value = bestMin;
          if (sunTimeDisplay) {
            const h = String(Math.floor(bestMin / 60)).padStart(2, '0');
            const m = String(bestMin % 60).padStart(2, '0');
            sunTimeDisplay.textContent = `${h}:${m}`;
          }
        }
      }
    }
  }, 200);

  switchView("schema");

  // 2. State & UI Elements
  const markerClusterGroup = L.markerClusterGroup({
    spiderfyOnMaxZoom: false,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,
    maxClusterRadius: 40,
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      // Color ramp uses 10 steps across a bounded 0..100 count range.
      const boundedCount = Math.max(0, Math.min(count, 100));
      const colorStep = Math.round(boundedCount / 11);

      return L.divIcon({
        html: `<div><span>${count}</span></div>`,
        className: `marker-cluster marker-cluster-step marker-cluster-step-${colorStep}`,
        iconSize: L.point(40, 40),
      });
    },
    polygonOptions: {
      fillColor: "#00f0ff",
      color: "#00f0ff",
      weight: 1,
      opacity: 1,
      fillOpacity: 0.1,
    },
  }).addTo(map);

  const pinTooltip = createPinTooltipController(map);
  let activePopup = null;
  let popupRepositionFrame = null;
  let focusedMarker = null;
  let isZoomTransitioning = false;
  let focusedRestoreFrame = null;
  // The single non-panel marker currently pulled out of the cluster group
  // for focus (Discover / sidebar / deep-link). The 2D analogue of 3D's
  // "popupModId is excluded from the clusterer" rule — replaces spiderfy as
  // the way a clustered-but-focused pin stays visible. Panel-set markers are
  // owned by applyPanelPinFocus instead; this is only for the lone-pin paths.
  let soloFocusMarker = null;

  // ?mod= deep-link sync. Mirrors NCZ.ThreeMarkers.syncUrlForMod so the two
  // views stay coherent. Called EAGERLY when focus is initiated (not only
  // from popupopen) — the popup now opens deferred (on flyTo's moveend), so
  // waiting for popupopen left a window where switching views lost the
  // pin (the "shared camera/popup broken on clustered pins" bug: clustered
  // pins go through the deferred path, unclustered ones opened synchronously).
  function setModUrlParam(mod) {
    if (!mod) return;
    const isNum = /^\d+$/.test(String(mod.nexus_id));
    const lid = isNum ? String(mod.nexus_id) : mod.id;
    const url = new URL(window.location.href);
    url.searchParams.set(NCZ.URL_PARAM_MOD, lid);
    history.replaceState(null, "", url.toString());
  }
  function clearModUrlParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete(NCZ.URL_PARAM_MOD);
    history.replaceState(null, "", url.toString());
  }

  function repositionActivePopup() {
    if (!activePopup) return;
    positionDynamicPopup(map, activePopup);
  }

  // Coalesce bursty map/popup events into one popup reposition per animation frame.
  function scheduleActivePopupReposition() {
    if (popupRepositionFrame !== null) return;
    popupRepositionFrame = requestAnimationFrame(() => {
      popupRepositionFrame = null;
      repositionActivePopup();
    });
  }

  // Safety net only: re-open the focused popup if it closed while the marker
  // is an un-clustered singleton. Spiderfy was removed entirely (per product
  // decision) — focused/selected markers are now kept visible by pulling
  // them OUT of the cluster group (soloFocusMarker / applyPanelPinFocus), so
  // a focused marker is never hidden inside a bubble and never needs
  // spiderfying. For force-individual markers this whole function early-
  // returns at the hasLayer check (they're not in the group); it survives
  // only for any legacy clustered-focus edge.
  function restoreFocusedPopupIfVisible() {
    if (!focusedMarker) return;
    if (panelSelectedModId !== null) return;
    if (!markerClusterGroup.hasLayer(focusedMarker)) return;
    const visibleParent = markerClusterGroup.getVisibleParent(focusedMarker);
    if (!visibleParent) return;
    if (visibleParent === focusedMarker && !focusedMarker.isPopupOpen()) {
      focusedMarker.openPopup();
    }
  }

  function scheduleFocusedPopupRestore() {
    if (!focusedMarker || focusedRestoreFrame !== null) return;
    focusedRestoreFrame = requestAnimationFrame(() => {
      focusedRestoreFrame = null;
      restoreFocusedPopupIfVisible();
    });
  }

  map.on("popupopen", (e) => {
    pinTooltip.hide();
    activePopup = e.popup;
    const popupSource = e.popup?._source;
    if (popupSource?.modData) {
      focusedMarker = popupSource;
      setModUrlParam(popupSource.modData);
    }
    repositionActivePopup();
    scheduleActivePopupReposition();
    const popupImages = activePopup.getElement()?.querySelectorAll("img") || [];
    popupImages.forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", scheduleActivePopupReposition, { once: true });
      }
    });

    // Clipboard copy handler for Copy Link button
    const copyBtn = e.popup.getElement()?.querySelector(".ui-popup-action-link-copy-link");
    if (copyBtn) {
      let copyRevertTimer = null;
      copyBtn.addEventListener("click", () => {
        const url = copyBtn.dataset.copyUrl;
        clearTimeout(copyRevertTimer);
        navigator.clipboard.writeText(url).then(() => {
          copyBtn.textContent = "Copied!";
          copyRevertTimer = setTimeout(() => {
            copyBtn.innerHTML = '<span class="ui-popup-action-link-icon" aria-hidden="true"></span>';
          }, NCZ.COPY_FEEDBACK_MS);
        });
      });
    }
  });
  map.on("popupclose", (e) => {
    activePopup = null;
    const popupSource = e.popup?._source;
    const isZoomRelatedClose =
      isZoomTransitioning ||
      Boolean(map._animatingZoom) ||
      Boolean(markerClusterGroup._inZoomAnimation);
    // URL sync: clear the mod param when popup closes (unless zoom-related)
    if (popupSource?.modData && !isZoomRelatedClose) {
      clearModUrlParam();
    }
    if (
      focusedMarker &&
      popupSource === focusedMarker &&
      !isZoomRelatedClose &&
      map.hasLayer(focusedMarker)
    ) {
      // Manual close on a visible marker clears focused state.
      focusedMarker = null;
    }
    // Genuine dismissal of the soloed lone-pin's popup → let it re-cluster.
    // Skipped on zoom-driven closes (transient) and when the marker belongs
    // to an open panel set (clearPanelPinFocus owns that restore).
    if (
      soloFocusMarker &&
      popupSource === soloFocusMarker &&
      !isZoomRelatedClose &&
      !panelClusterModIds?.has(soloFocusMarker.modData.id)
    ) {
      setSoloFocusMarker(null);
    }
    if (popupRepositionFrame !== null) {
      cancelAnimationFrame(popupRepositionFrame);
      popupRepositionFrame = null;
    }
  });

  map.on("move zoom resize", () => {
    pinTooltip.reposition();
    scheduleActivePopupReposition();
  });

  const allMarkers = [];
  const modCountEl = document.getElementById("mod-count");
  const modListEl = document.getElementById("mod-list");
  const filterContainer = document.getElementById("category-filters");
  const authorFilterContainer = document.getElementById("author-filters");
  const tagFilterCountEl = document.getElementById("tag-filter-count");
  const authorFilterCountEl = document.getElementById("author-filter-count");
  const clearTagFiltersBtn = document.getElementById("clear-tag-filters");
  const clearAuthorFiltersBtn = document.getElementById("clear-author-filters");
  const sidebar = document.getElementById("sidebar");
  const sidebarClose = document.getElementById("sidebar-close");
  const sidebarOpen = document.getElementById("sidebar-open");
  const discoverLocationBtn = document.getElementById("discover-location-btn");
  // Cluster menu DOM references
  const clusterPanel = document.getElementById("cluster-panel");
  const clusterPanelResizeHandle = document.getElementById("cluster-panel-resize-handle");
  const clusterPanelClose = document.getElementById("cluster-panel-close");
  const clusterPanelCount = document.getElementById("cluster-panel-count");
  const clusterModList = document.getElementById("cluster-mod-list");

  function updateDiscoverButtonPosition() {
    if (!discoverLocationBtn || !sidebar) return;

    const isDesktop = window.innerWidth >= NCZ.MOBILE_BREAKPOINT;
    const isSidebarVisible = isDesktop && !sidebar.classList.contains("hidden");

    if (isSidebarVisible) {
      const sidebarWidth = Math.round(sidebar.getBoundingClientRect().width);
      discoverLocationBtn.style.left = `calc(${sidebarWidth}px + var(--space-md))`;
    } else {
      discoverLocationBtn.style.left = "var(--space-md)";
    }
  }

  // Compute the maximum allowed cluster menu width for current viewport
  function getClusterPanelMaxWidth() {
    const viewportBound = Math.floor(window.innerWidth * 0.7);
    return Math.max(
      NCZ.CLUSTER_PANEL_MIN_WIDTH,
      Math.min(NCZ.CLUSTER_PANEL_MAX_WIDTH, viewportBound),
    );
  }

  // Clamp width so dragging cannot make the panel too small or too wide
  function clampClusterPanelWidth(width) {
    return Math.min(
      getClusterPanelMaxWidth(),
      Math.max(NCZ.CLUSTER_PANEL_MIN_WIDTH, Math.round(width)),
    );
  }

  // Apply panel width (desktop only), and optionally save it in localStorage
  function setClusterPanelWidth(width, persist = true) {
    if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
      clusterPanel.style.removeProperty("width");
      return;
    }

    const clampedWidth = clampClusterPanelWidth(width);
    clusterPanel.style.width = `${clampedWidth}px`;

    if (persist) {
      try {
        localStorage.setItem(NCZ.CLUSTER_PANEL_WIDTH_KEY, String(clampedWidth));
      } catch {
        // Ignore storage failures (e.g. private mode/quota)
      }
    }
  }

  // Enable drag-to-resize from the panel's left edge
  function initClusterPanelResize() {
    if (!clusterPanelResizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    // While dragging, update width based on horizontal mouse movement
    const onMouseMove = (event) => {
      if (!isResizing) return;
      const deltaX = startX - event.clientX;
      setClusterPanelWidth(startWidth + deltaX, false);
    };

    // End drag operation, restore normal interactions, then persist final width
    const stopResizing = () => {
      if (!isResizing) return;
      isResizing = false;
      clusterPanel.classList.remove("resizing");
      document.body.classList.remove("cluster-panel-resizing");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopResizing);

      const finalWidth = clusterPanel.getBoundingClientRect().width;
      if (finalWidth) {
        setClusterPanelWidth(finalWidth, true);
      }

      if (map.dragging) map.dragging.enable();
    };

    // Start drag operation when user presses the resize handle
    clusterPanelResizeHandle.addEventListener("mousedown", (event) => {
      if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) return;
      event.preventDefault();
      event.stopPropagation();

      isResizing = true;
      startX = event.clientX;
      startWidth = clusterPanel.getBoundingClientRect().width;
      clusterPanel.classList.add("resizing");
      document.body.classList.add("cluster-panel-resizing");

      if (map.dragging) map.dragging.disable();

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", stopResizing);
    });

    // Keep width valid when viewport size changes
    window.addEventListener("resize", () => {
      if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
        clusterPanel.style.removeProperty("width");
        return;
      }

      const inlineWidth = Number.parseFloat(clusterPanel.style.width);
      const currentWidth =
        Number.isFinite(inlineWidth) && inlineWidth > 0
          ? inlineWidth
          : clusterPanel.getBoundingClientRect().width || NCZ.CLUSTER_PANEL_DEFAULT_WIDTH;
      setClusterPanelWidth(currentWidth, false);
    });

    // Restore saved width, or use default width on first visit
    const savedWidth = Number.parseInt(
      localStorage.getItem(NCZ.CLUSTER_PANEL_WIDTH_KEY),
      10,
    );
    if (Number.isFinite(savedWidth)) {
      setClusterPanelWidth(savedWidth, false);
    } else {
      setClusterPanelWidth(NCZ.CLUSTER_PANEL_DEFAULT_WIDTH, false);
    }
  }

  initClusterPanelResize();

  // Tracks which mod IDs the cluster panel is currently showing. Used by the
  // 3D map-aware staleness check so the panel auto-closes when a recompute
  // breaks up the cluster the panel was opened for.
  let panelClusterModIds = null;

  // The panel mod the user last clicked. null = panel just opened, no pin
  // chosen yet (cluster still on screen). Once set, the panel becomes a
  // static comparison list: successor tracking is suppressed (the cluster
  // it followed has been flown into and dissolved) and the cluster bubble's
  // toggle-close no longer applies (there's no bubble to re-click). Drives
  // the "selected pin prominent, rest dimmed" emphasis.
  let panelSelectedModId = null;

  // True only while pin emphasis is actually applied (a panel item was
  // clicked). Lets clearPanelPinFocus() short-circuit when there's nothing
  // to undo — important because populateClusterPanel() calls it on EVERY
  // (re)populate, including the high-frequency successor-tracking path
  // during camera moves. Without this, each successor recompute would do a
  // full marker sweep + a synchronous 3D recomputeClusters for no reason.
  let panelPinFocusApplied = false;

  // Adds .marker-cluster-active to the SAT cluster bubble whose modIds best
  // match panelClusterModIds. Called after each Leaflet cluster recompute
  // (zoomend / animationend / filter) because Leaflet recreates DOM elements.
  function refreshActiveSatClusterMark() {
    document.querySelectorAll('.leaflet-marker-icon.marker-cluster-active').forEach((el) => {
      el.classList.remove('marker-cluster-active');
    });
    if (!panelClusterModIds || panelClusterModIds.size === 0) return;
    if (mapEl.style.display === "none") return;  // SCHEMA active, ThreeMarkers handles its own
    // Find best parent by overlap count, same logic as recomputeSatClusterPanel
    const parentBuckets = new Map();
    for (const modId of panelClusterModIds) {
      const marker = allMarkers.find((m) => m.modData.id === modId);
      if (!marker || !markerClusterGroup.hasLayer(marker)) continue;
      const parent = markerClusterGroup.getVisibleParent(marker);
      if (!parent || typeof parent.getAllChildMarkers !== "function") continue;
      const key = parent._leaflet_id;
      if (!parentBuckets.has(key)) parentBuckets.set(key, { parent, count: 0 });
      parentBuckets.get(key).count++;
    }
    let bestEntry = null;
    for (const entry of parentBuckets.values()) {
      if (!bestEntry || entry.count > bestEntry.count) bestEntry = entry;
    }
    if (bestEntry && bestEntry.parent.getElement) {
      const el = bestEntry.parent.getElement();
      if (el) el.classList.add('marker-cluster-active');
    }
  }

  // True iff `set` contains exactly the IDs in `list`. Used by both cluster
  // bubble click handlers (2D + 3D) to detect "user clicked the cluster
  // whose contents are already in the panel" → toggle-close instead of
  // re-populate. Cheap O(n) — cluster sizes are bounded by markercluster's
  // disable-clustering-at-zoom threshold.
  function isSameModSet(set, list) {
    if (!set || set.size !== list.length) return false;
    for (const id of list) if (!set.has(id)) return false;
    return true;
  }

  // "Top pin, rest fade": after a panel item is clicked the cluster has
  // dissolved (focusMarker/focusMod flew in past the cluster radius), so the
  // member pins are individually visible. Dim every panel pin except the
  // selected one. 2D uses Leaflet's marker.setOpacity (survives the marker
  // DOM being recreated on zoom) + a zIndexOffset so the chosen pin sits
  // above its now-faded neighbours; 3D delegates to ThreeMarkers, which sets
  // the inner .marker-pin opacity (the only mechanism that survives
  // CSS2DRenderer's per-frame inline restyling). Two mechanisms, one
  // behaviour — the divergence is forced by the two views' DOM lifecycles,
  // not parallel styling.
  function applyPanelPinFocus() {
    if (!panelClusterModIds) return;
    for (const id of panelClusterModIds) {
      const marker = allMarkers.find((m) => m.modData.id === id);
      if (!marker) continue;
      // 2D force-individual: Leaflet.markercluster has no per-marker
      // "don't cluster" flag — the idiomatic way to keep specific markers
      // always visible is to pull them out of the cluster group and add
      // them straight to the map. Idempotent: only move if still grouped.
      if (markerClusterGroup.hasLayer(marker)) {
        markerClusterGroup.removeLayer(marker);
        marker.addTo(map);
      }
      const selected = id === panelSelectedModId;
      marker.setOpacity(selected ? 1 : 0.3);
      marker.setZIndexOffset(selected ? 1000 : 0);
    }
    const ids = [...panelClusterModIds];
    NCZ.ThreeMarkers?.setPanelPinFocus?.(ids, panelSelectedModId);
    // 3D equivalent: exclude the whole set from the distance-based clusterer
    // so dissolution doesn't depend on how tightly the mods are packed.
    NCZ.ThreeMarkers?.setForcedIndividualIds?.(new Set(ids));
    panelPinFocusApplied = true;
  }

  // Restore every panel pin to full opacity / default stacking. Must run
  // before panelClusterModIds is cleared (it drives the 2D iteration).
  // No-ops unless emphasis was actually applied — keeps the per-populate
  // call cheap and breaks the populateClusterPanel→clear→setForced→recompute
  // re-entry in the common (no pin picked) case.
  function clearPanelPinFocus() {
    if (!panelPinFocusApplied) return;
    if (panelClusterModIds) {
      for (const id of panelClusterModIds) {
        const marker = allMarkers.find((m) => m.modData.id === id);
        if (!marker) continue;
        marker.setOpacity(1);
        marker.setZIndexOffset(0);
        // Return the marker to the cluster group so it re-clusters normally.
        // Only if we actually pulled it out (standalone on the map and not
        // in the group) — guards the cluster-mode-then-close path where no
        // marker was ever moved.
        if (map.hasLayer(marker) && !markerClusterGroup.hasLayer(marker)) {
          map.removeLayer(marker);
          markerClusterGroup.addLayer(marker);
        }
      }
    }
    NCZ.ThreeMarkers?.setPanelPinFocus?.(null, null);
    NCZ.ThreeMarkers?.setForcedIndividualIds?.(null);
    panelPinFocusApplied = false;
  }

  // Hide and reset cluster menu state
  function hideClusterPanel() {
    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = "";
    clusterPanel.classList.add("cluster-panel-closed");
    clearPanelPinFocus();          // restore pin opacity/stacking first
    panelClusterModIds = null;
    panelSelectedModId = null;
    // Clear the active mark on whichever bubble was highlighted.
    refreshActiveSatClusterMark();
    NCZ.ThreeMarkers?.setActiveClusterMods?.(null);
  }

  // Shared 2D focus motion.
  //
  // 1. Close any popup that's already open FIRST. A lingering popup from the
  //    previously-selected pin would otherwise stay visible through the
  //    0.6s flyTo, repositioned every animation frame by the custom dynamic-
  //    popup placer → the "ghost / vibrating, faded double-popup". Nothing
  //    visible during the fly = no vibration.
  // 2. Sync ?mod= EAGERLY (not from popupopen). The popup is opened deferred
  //    on moveend, so a view switch during the fly would otherwise see no
  //    ?mod= and fail to restore — that's the "shared camera/popup broken
  //    on clustered pins" report (clustered pins route through this deferred
  //    path; unclustered ones open synchronously and were unaffected).
  // 3. Open the popup only once the flyTo settles. `opened` + the
  //    `focusedMarker === marker` guard handle rapid re-clicks (flyTo B
  //    interrupts flyTo A → A's moveend still fires, but focus moved on).
  // targetZoom never zooms OUT — keep the user's zoom if already close.
  // (6/8 is a building-detail zoom; tune here if it feels too near/far.)
  function flyToMarkerAndOpen(marker) {
    map.closePopup();
    focusedMarker = marker;
    setModUrlParam(marker.modData);
    const targetZoom = Math.max(map.getZoom(), 6);
    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      if (focusedMarker === marker) marker.openPopup();
    };
    map.once("moveend", openOnce);
    map.flyTo(marker.getLatLng(), targetZoom, { duration: 0.6 });
  }

  // Pull `marker` out of the cluster group so a clustered-but-focused pin is
  // visible without spiderfy. Returns the previously soloed marker to the
  // group first — unless it belongs to an active panel set, which
  // applyPanelPinFocus / clearPanelPinFocus own. This is the lone-pin path
  // (Discover / sidebar / deep-link); the panel path force-individuals the
  // whole set separately.
  // IMPORTANT ordering: reassign `soloFocusMarker` to the new marker FIRST,
  // operate on a local `prev`. `map.removeLayer(prev)` synchronously closes
  // prev's popup → the popupclose handler's solo-release branch fires
  // re-entrantly; if `soloFocusMarker` still pointed at `prev` there, that
  // branch would call setSoloFocusMarker(null) mid-call and the line below
  // would `markerClusterGroup.addLayer(null)` — prev removed from the map
  // and never re-added = the "Discover removes the pin when clicked again"
  // bug. Reassigning first makes `popupSource === soloFocusMarker` false in
  // the re-entrant check, so it no-ops; using the `prev` local makes the
  // re-add robust regardless.
  function setSoloFocusMarker(marker) {
    const prev = soloFocusMarker;
    soloFocusMarker = marker || null;
    if (prev && prev !== marker) {
      const ownedByPanel = panelClusterModIds?.has(prev.modData.id);
      if (
        !ownedByPanel &&
        map.hasLayer(prev) &&
        !markerClusterGroup.hasLayer(prev)
      ) {
        map.removeLayer(prev);
        markerClusterGroup.addLayer(prev);
      }
    }
    if (marker && markerClusterGroup.hasLayer(marker)) {
      markerClusterGroup.removeLayer(marker);
      marker.addTo(map);
    }
  }

  // Lone-pin focus (Discover / sidebar / deep-link). Force the marker
  // individual (no clustering, no spiderfy), then fly + open.
  function focusMarker(marker) {
    setSoloFocusMarker(marker);
    flyToMarkerAndOpen(marker);
  }

  // Panel-item focus. The marker is already individual (applyPanelPinFocus
  // pulled the whole panel set out of the cluster group before this runs),
  // so just fly + open — no solo bookkeeping needed.
  function flyToPanelMarker(marker) {
    flyToMarkerAndOpen(marker);
  }

  function focusRandomVisibleMarker() {
    // Route to whichever view is currently active. Each view holds its own
    // pin layer; visibility (after filters) is queried per-layer rather than
    // re-running the filter computation.
    const isSchema = mapEl.style.display === "none";

    if (isSchema) {
      const visibleIds = NCZ.ThreeMarkers?.getVisibleModIds?.() ?? [];
      if (visibleIds.length === 0) {
        alert("No visible locations match the current filters.");
        return;
      }
      const randomId = visibleIds[Math.floor(Math.random() * visibleIds.length)];
      NCZ.ThreeMarkers.focusMod(randomId);
    } else {
      const visibleMarkers = allMarkers.filter((marker) => markerClusterGroup.hasLayer(marker));
      if (visibleMarkers.length === 0) {
        alert("No visible locations match the current filters.");
        return;
      }
      const randomMarker = visibleMarkers[Math.floor(Math.random() * visibleMarkers.length)];
      focusMarker(randomMarker);
    }
    hideClusterPanel();

    if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
      sidebar.classList.add("hidden");
      sidebarOpen.classList.add("visible");
    }

    updateDiscoverButtonPosition();
  }

  if (discoverLocationBtn) {
    discoverLocationBtn.addEventListener("click", focusRandomVisibleMarker);
  }

  // Populates the cluster panel with a sorted list of mods. View-agnostic —
  // both the Leaflet clusterclick handler and ThreeMarkers cluster clicks
  // call this. onItemClick receives the mod object; the active view flies to
  // it (focusMarker for SAT, NCZ.ThreeMarkers.focusMod for SCHEMA) — the fly
  // dissolves the cluster but the panel stays open as a comparison list, so
  // the user can click each member in turn. The clicked pin is kept at full
  // opacity and the rest dim (applyPanelPinFocus).
  function populateClusterPanel(modsList, opts = {}) {
    const { onItemClick, nexusThumbs = {} } = opts;

    // New cluster context → drop any prior pin emphasis and selection.
    // Runs before panelClusterModIds is reassigned (below) so the old set
    // is the one un-dimmed.
    clearPanelPinFocus();
    panelSelectedModId = null;

    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = `(${modsList.length})`;

    if (modsList.length === 0) {
      const empty = document.createElement("li");
      empty.className = "cluster-empty";
      empty.textContent = "No mods found in this cluster.";
      clusterModList.appendChild(empty);
    } else {
      modsList.forEach((mod) => {
        const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES.other;
        const modTagsHtml = (mod.tags || [])
          .map((tag) => `<span class="tag-badge">${NCZ.escapeHtml(tag)}</span>`)
          .join("");

        // Look up thumb/full URLs from the opts-passed nexusThumbs map.
        // Kept as an explicit arg (not closure-captured) so this function
        // can live outside the try block where nexusThumbs is declared.
        const nexusThumb = nexusThumbs[String(mod.nexus_id)];
        const thumbSrc = nexusThumb?.thumbnailUrl || null;
        const fullSrc = nexusThumb?.pictureUrl || null;
        const isThumbClickable = Boolean(fullSrc);
        const thumbMarkup = thumbSrc
          ? `<img class="cluster-mod-thumb${isThumbClickable ? " cluster-mod-thumb-clickable" : ""}" src="${NCZ.escapeHtml(thumbSrc)}" alt="${NCZ.escapeHtml(mod.name)} thumbnail" referrerpolicy="no-referrer"${isThumbClickable ? ` data-full-src="${NCZ.escapeHtml(fullSrc)}"` : ""}>`
          : `<span class="cluster-mod-thumb cluster-mod-thumb-placeholder" aria-hidden="true"></span>`;

        const item = document.createElement("li");
        item.className = "cluster-mod-item";
        item.style.setProperty("--cluster-mod-color", catStyle.color);

        const button = document.createElement("button");
        button.type = "button";
        button.className = "cluster-mod-btn";
        button.innerHTML = `
          <span class="cluster-mod-layout">
            ${thumbMarkup}
            <span class="cluster-mod-content">
              <span class="cluster-mod-name">${NCZ.escapeHtml(mod.name)}${NCZ.isRecentlyUpdated(mod) ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>` : ""}</span>
              <span class="cluster-mod-separator"></span>
              <span class="cluster-mod-meta">by ${NCZ.escapeHtml(mod.authors.join(", "))}</span>
              <span class="cluster-mod-tags">
                ${modTagsHtml}
              </span>
              <span class="cluster-mod-desc">${NCZ.escapeHtml(mod.description || "No description provided.")}</span>
            </span>
          </span>
        `;

        // Open image modal when thumbnail is clicked
        const imageButton = button.querySelector(".cluster-mod-thumb[data-full-src]");
        if (imageButton) {
          imageButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            window.openImageGallery([imageButton.dataset.fullSrc], 0);
          });
        }

        button.addEventListener("click", () => {
          // Order matters: select → force-individual → fly.
          // applyPanelPinFocus must run BEFORE the fly so the whole panel
          // set is already pulled out of the cluster group (2D) / excluded
          // from the clusterer (3D); otherwise the bubble persists through
          // the fly (the original recording bug). The panel stays open on
          // desktop; mobile still closes it (full-screen panel + fly +
          // popup at once is too much there).
          panelSelectedModId = mod.id;
          applyPanelPinFocus();
          onItemClick?.(mod);
          if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) hideClusterPanel();
        });

        item.appendChild(button);
        clusterModList.appendChild(item);
      });
    }

    // Record which mods this panel is showing so 3D's stale-cluster check
    // can compare current cluster contents against this set on each recompute.
    panelClusterModIds = new Set(modsList.map((m) => m.id));
    clusterPanel.classList.remove("cluster-panel-closed");

    // Update the active-cluster mark in both views. The SAT side runs a
    // DOM scan; the 3D side hands the set to ThreeMarkers which finds and
    // marks the matching bubble itself. Both are no-ops in the inactive view.
    refreshActiveSatClusterMark();
    NCZ.ThreeMarkers?.setActiveClusterMods?.(panelClusterModIds);
  }

  clusterPanelClose.addEventListener("click", hideClusterPanel);

  // Close Sidebar
  sidebarClose.addEventListener("click", () => {
    sidebar.classList.add("hidden");
    sidebarOpen.classList.add("visible");
    updateDiscoverButtonPosition();
  });

  // Open Sidebar
  sidebarOpen.addEventListener("click", () => {
    sidebar.classList.remove("hidden");
    sidebarOpen.classList.remove("visible");
    updateDiscoverButtonPosition();
  });

  // Auto-hide sidebar on mobile screens
  if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) {
    sidebar.classList.add("hidden");
    sidebarOpen.classList.add("visible");
  }

  updateDiscoverButtonPosition();
  window.addEventListener("resize", updateDiscoverButtonPosition);

  map.on("click", hideClusterPanel);
  map.on("zoomstart", () => {
    isZoomTransitioning = true;
    // Note: cluster panel intentionally stays open on zoom (matches SCHEMA).
    // Closing only happens via outside-click (map.on("click") above), the
    // close button, view switch, or 3D successor-cluster going stale.
  });
  map.on("zoomend", () => {
    isZoomTransitioning = false;
    scheduleFocusedPopupRestore();
  });
  markerClusterGroup.on("animationend", scheduleFocusedPopupRestore);

  // 3. Fetch and Setup Data
  try {
    const { mods, tagsDict, excludedIds } = await NCZ.fetchModData();

    // Auto-discover mods tagged "NCZoning" on Nexus (manual entries win on conflict;
    // excluded ids are never rendered, even with a valid block)
    const existingNexusIds = new Set(
      mods
        .filter((m) => m.nexus_id && !["WIP", "Dummy"].includes(String(m.nexus_id)))
        .map((m) => String(m.nexus_id)),
    );
    const validTagNames = new Set(Object.keys(tagsDict));
    const { mods: autoMods, meta: autoMeta } = await NCZ.fetchNexusTaggedMods(existingNexusIds, validTagNames, excludedIds);
    mods.push(...autoMods);

    modCountEl.textContent = `(${mods.length})`;

    // Pre-seed thumbnail map from auto-discovery (already fetched), then
    // only call the API for manual mods that still need images
    const nexusThumbs = {};
    const manualNexusIds = [];
    for (const mod of mods) {
      const nid = String(mod.nexus_id);
      if (mod._thumbnailUrl || mod._pictureUrl) {
        nexusThumbs[nid] = { pictureUrl: mod._pictureUrl, thumbnailUrl: mod._thumbnailUrl };
      } else if (nid && !["wip", "dummy"].includes(nid.toLowerCase()) && !autoMeta[nid]) {
        manualNexusIds.push(nid);
      }
    }
    const fetchedThumbs = await NCZ.fetchNexusThumbnails(manualNexusIds);
    Object.assign(nexusThumbs, fetchedThumbs);
    // Fill in metadata from auto-discovery for manual mods that are NCZoning-tagged
    for (const [id, data] of Object.entries(autoMeta)) {
      if (!nexusThumbs[id]) nexusThumbs[id] = data;
    }

    // Backfill _updatedAt for manual Nexus mods before sorting
    for (const mod of mods) {
      if (!mod._updatedAt) {
        const thumb = nexusThumbs[String(mod.nexus_id)];
        if (thumb?.updatedAt) mod._updatedAt = thumb.updatedAt;
      }
    }

    const sortedMods = mods.sort(NCZ.sortModsByUpdated);
    // Hand the same data set to the 3D pin layer — pins won't appear until ThreeScene
    // is initialised (first switch to SCHEMA), but the call is safe before that and the
    // data is held internally so the layer can build pins on attach.
    NCZ.ThreeMarkers?.setMods?.(sortedMods, nexusThumbs, tagsDict);

    // Cluster panel wiring — both views call the same populateClusterPanel
    // helper. Registered here (inside the try block) so each handler's
    // closure can pass `nexusThumbs` and reference the loaded `mods` array.

    // 2D (Leaflet) cluster click → cluster panel
    markerClusterGroup.on("clusterclick", (a) => {
      if (a.originalEvent) L.DomEvent.stop(a.originalEvent);
      const childMarkers = a.layer
        .getAllChildMarkers()
        .slice()
        .sort((left, right) => NCZ.sortModsByUpdated(left.modData, right.modData));
      const childMods = childMarkers.map((m) => m.modData);
      // Toggle-close: re-clicking the cluster whose contents the panel shows
      // closes it — but only before a pin was picked. Once a pin is selected
      // the cluster has dissolved (flown into), so this path can't be hit
      // for that cluster anyway; the guard makes the intent explicit.
      if (
        panelSelectedModId === null &&
        isSameModSet(panelClusterModIds, childMods.map((m) => m.id))
      ) {
        hideClusterPanel();
        return;
      }
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => {
          const marker = childMarkers.find((m) => m.modData.id === mod.id);
          if (marker) flyToPanelMarker(marker);
        },
      });
    });

    // 3D (ThreeMarkers) cluster click → cluster panel
    NCZ.ThreeMarkers?.setClusterClickHandler?.((modIds) => {
      // Toggle-close on the active cluster, before a pin is picked (parity
      // with 2D — see that handler for the rationale).
      if (panelSelectedModId === null && isSameModSet(panelClusterModIds, modIds)) {
        hideClusterPanel();
        return;
      }
      const idSet = new Set(modIds);
      const childMods = mods
        .filter((m) => idSet.has(m.id))
        .sort(NCZ.sortModsByUpdated);
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => NCZ.ThreeMarkers.focusMod(mod.id),
      });
    });

    // 3D empty-canvas click → close the cluster panel. Parity with the 2D
    // `map.on("click", hideClusterPanel)` below: clicking empty space (not a
    // pin / cluster / popup) dismisses the panel in both views.
    NCZ.ThreeMarkers?.setEmptyClickHandler?.(hideClusterPanel);

    // 3D map-aware panel: when 3D clusters recompute (camera moved/zoomed/
    // tilted), follow the cluster the panel was opened for. Find the
    // "successor" — the current cluster with the most overlap with the
    // panel's mod set — and update the panel's contents to match. Close
    // only when no current cluster has any of the original mods, OR the
    // best successor has fewer than 2 mods (no longer a real cluster).
    NCZ.ThreeMarkers?.setClustersChangedHandler?.((clusterSets) => {
      if (!panelClusterModIds || panelClusterModIds.size === 0) return;
      // Once a pin is picked the panel is a static comparison list — the
      // flyTo already dissolved the cluster it tracked, so don't let the
      // recompute close or rewrite the panel out from under the user.
      if (panelSelectedModId !== null) return;
      // Skip while SAT is active — SAT panel state is independent.
      if (mapEl.style.display !== "none") return;

      let bestSet = null;
      let bestOverlap = 0;
      for (const ids of clusterSets) {
        let overlap = 0;
        for (const id of ids) if (panelClusterModIds.has(id)) overlap++;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestSet = ids;
        }
      }

      // No surviving cluster contains any of the original mods → close.
      // Or the successor has dissolved into a singleton → close.
      if (bestOverlap === 0 || !bestSet || bestSet.length < 2) {
        hideClusterPanel();
        return;
      }

      // If the successor's membership matches the current panel exactly,
      // skip the DOM rebuild (avoids flicker during continuous camera moves).
      if (bestSet.length === panelClusterModIds.size) {
        let identical = true;
        for (const id of bestSet) {
          if (!panelClusterModIds.has(id)) { identical = false; break; }
        }
        if (identical) return;
      }

      // Successor differs → re-populate the panel with its mods.
      const newMods = bestSet
        .map((id) => mods.find((m) => m.id === id))
        .filter(Boolean)
        .sort(NCZ.sortModsByUpdated);
      populateClusterPanel(newMods, {
        nexusThumbs,
        onItemClick: (mod) => NCZ.ThreeMarkers.focusMod(mod.id),
      });
    });

    // SAT map-aware panel: same successor-tracking logic as SCHEMA, but using
    // Leaflet's markerClusterGroup.getVisibleParent to find each panel mod's
    // current cluster. Used by zoomend and applyFilters to keep the panel in
    // sync with Leaflet's automatic cluster recomputation.
    function recomputeSatClusterPanel() {
      if (!panelClusterModIds || panelClusterModIds.size === 0) return;
      // Pin picked → static comparison list; the panel set is force-
      // individual now, so don't auto-close or rewrite the panel.
      if (panelSelectedModId !== null) return;
      // Skip while SCHEMA is active — SCHEMA panel state is independent.
      if (mapEl.style.display === "none") return;

      // Group panel mods by their current visible parent (cluster or singleton).
      const parentBuckets = new Map();
      for (const modId of panelClusterModIds) {
        const marker = allMarkers.find((m) => m.modData.id === modId);
        if (!marker || !markerClusterGroup.hasLayer(marker)) continue;
        const parent = markerClusterGroup.getVisibleParent(marker);
        if (!parent) continue;
        const key = parent._leaflet_id;
        if (!parentBuckets.has(key)) parentBuckets.set(key, { parent, count: 0 });
        parentBuckets.get(key).count++;
      }

      // Find the parent that absorbed the most panel mods.
      let bestEntry = null;
      for (const entry of parentBuckets.values()) {
        if (!bestEntry || entry.count > bestEntry.count) bestEntry = entry;
      }

      // No surviving parent contains any panel mod → close.
      if (!bestEntry || bestEntry.count === 0) {
        hideClusterPanel();
        return;
      }

      // Parent is a singleton marker (zoomed in past clustering) → close.
      if (typeof bestEntry.parent.getAllChildMarkers !== "function") {
        hideClusterPanel();
        return;
      }

      const childMarkers = bestEntry.parent.getAllChildMarkers().slice()
        .sort((l, r) => NCZ.sortModsByUpdated(l.modData, r.modData));
      if (childMarkers.length < 2) {
        hideClusterPanel();
        return;
      }

      // Skip rebuild if membership identical (avoid flicker during continuous interaction).
      // Still re-apply the active mark — Leaflet recreates cluster DOM elements
      // on zoom, so the previously-marked element may no longer exist.
      if (childMarkers.length === panelClusterModIds.size) {
        let identical = true;
        for (const m of childMarkers) {
          if (!panelClusterModIds.has(m.modData.id)) { identical = false; break; }
        }
        if (identical) {
          refreshActiveSatClusterMark();
          return;
        }
      }

      const childMods = childMarkers.map((m) => m.modData);
      populateClusterPanel(childMods, {
        nexusThumbs,
        onItemClick: (mod) => {
          const m = childMarkers.find((cm) => cm.modData.id === mod.id);
          if (m) flyToPanelMarker(m);
        },
      });
    }

    // Re-evaluate SAT panel after Leaflet finishes its zoom transition (clusters
    // recomputed at the new zoom level).
    map.on("zoomend", recomputeSatClusterPanel);
    // markercluster fires animationend after cluster animations settle —
    // covers zoom-driven cluster regrouping (spiderfy is no longer used).
    markerClusterGroup.on("animationend", recomputeSatClusterPanel);

    sortedMods.forEach((mod) => {
        const [lat, lng] = NCZ.cetToLeaflet(mod.coordinates[0], mod.coordinates[1]);
        const { catStyle, popupHtml, thumbSrc, fullSrc } = NCZ.prepareModRenderData(mod, nexusThumbs, tagsDict);

        // Custom Marker Icon (Diamond/Square for Night Corp)
        const icon = L.divIcon({
          className: "category-marker",
          html: `<div class="marker-pin ${catStyle.class}"></div>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        });

        const marker = L.marker([lat, lng], { icon });
        marker.modData = mod; // Store data for filtering later
        allMarkers.push(marker);
        markerClusterGroup.addLayer(marker);

        marker.on("mouseover", () => {
          pinTooltip.show(marker, mod.name);
        });
        marker.on("mouseout", () => {
          pinTooltip.hide(marker);
        });
        marker.on("click", () => {
          pinTooltip.hide(marker);
        });
        marker.on("remove", () => {
          pinTooltip.hide(marker);
        });

        marker.modThumb = thumbSrc;
        marker.modFull = fullSrc;

        marker.bindPopup(popupHtml, {
          autoPan: false,
          offset: [0, 0],
          minWidth: 360,
          maxWidth: 360,
          className: `ncz-dynamic-popup popup-${catStyle.class}`,
        });

        // Add to Sidebar
        const li = document.createElement("li");
        li.className = "mod-item";
        li.dataset.category = mod.category;
        li.dataset.tags = [...(mod.tags || []), ...(NCZ.isRecentlyUpdated(mod) ? ["updated"] : [])].join(",");
        li.dataset.authors = mod.authors.join(",");
        const sidebarBadge = mod._source === "nexus-auto"
          ? ` <span class="nexus-auto-badge" title="Sourced automatically from Nexus Mods" aria-hidden="true"></span>`
          : "";
        const sidebarUpdatedBadge = NCZ.isRecentlyUpdated(mod)
          ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>`
          : "";
        li.innerHTML = `
                <div class="mod-item-header">
                    <span class="mod-item-name">${NCZ.escapeHtml(mod.name)}</span>${sidebarBadge}${sidebarUpdatedBadge}
                </div>
                <span class="mod-item-author">by ${NCZ.escapeHtml(mod.authors.join(", "))}</span>
                <div class="mod-item-meta">
                    <span class="mod-item-category badge-${NCZ.escapeHtml(mod.category)}">${NCZ.escapeHtml(catStyle.label)}</span>
                </div>
            `;
        li.addEventListener("click", (e) => {
          if (e.target.tagName !== "A") {
            // Route to whichever view is currently active. mapEl hidden = 3D mode.
            if (mapEl.style.display === "none") {
              NCZ.ThreeMarkers?.focusMod?.(mod.id);
            } else {
              focusMarker(marker);
            }
            hideClusterPanel();
            if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) sidebar.classList.add("hidden");
          }
        });

        // Pulse marker (or parent cluster) on sidebar hover. Both views share
        // the `.pulsing` class + @keyframes markerPulse — calling both layers
        // is idempotent and keeps SAT/SCHEMA in sync without checking which
        // is active.
        li.addEventListener("mouseenter", () => {
          const element = marker.getElement();
          if (element) {
            const pin = element.querySelector(".marker-pin");
            if (pin) pin.classList.add("pulsing");
          } else {
            const visibleParent = markerClusterGroup.getVisibleParent(marker);
            if (visibleParent && visibleParent !== marker) {
              const clusterEl = visibleParent.getElement();
              if (clusterEl) clusterEl.classList.add("pulsing");
            }
          }
          NCZ.ThreeMarkers?.setPulse?.(mod.id, true);
        });
        li.addEventListener("mouseleave", () => {
          const element = marker.getElement();
          if (element) {
            const pin = element.querySelector(".marker-pin");
            if (pin) pin.classList.remove("pulsing");
          } else {
            const visibleParent = markerClusterGroup.getVisibleParent(marker);
            if (visibleParent && visibleParent !== marker) {
              const clusterEl = visibleParent.getElement();
              if (clusterEl) clusterEl.classList.remove("pulsing");
            }
          }
          NCZ.ThreeMarkers?.setPulse?.(mod.id, false);
        });

        modListEl.appendChild(li);
      });

    // Fit map to plotted pins
    const pinBounds = L.latLngBounds(
      mods.map((mod) => NCZ.cetToLeaflet(mod.coordinates[0], mod.coordinates[1])),
    );
    if (pinBounds.isValid()) {
      map.invalidateSize();
      map.fitBounds(pinBounds, { padding: [50, 50], maxZoom: 5 });
    }

    // Deep-link: open pin if ?mod= is in the URL
    const deepLinkParam = new URLSearchParams(window.location.search).get(NCZ.URL_PARAM_MOD);
    if (deepLinkParam) {
      const targetMarker = allMarkers.find(
        (m) => String(m.modData.nexus_id) === deepLinkParam || m.modData.id === deepLinkParam,
      );
      if (targetMarker) focusMarker(targetMarker);
    }

    // Re-open the popup in the freshly-activated view. Both ThreeMarkers and
    // the Leaflet popupopen handler keep ?mod= in sync, so this restore picks
    // up whatever was open before the switch — popups stay coherent across modes.
    onViewSwitched = (viewName) => {
      // Cluster panel state is view-specific: SAT and SCHEMA cluster differently
      // (Leaflet's stable IDs vs Three's screen-space recompute), so the panel's
      // mod set isn't meaningful in the other view. Close on switch.
      hideClusterPanel();

      const param = new URLSearchParams(window.location.search).get(NCZ.URL_PARAM_MOD);
      if (!param) return;
      if (viewName === "schema") {
        const mod = mods.find(
          (m) => String(m.nexus_id) === param || m.id === param,
        );
        if (mod) NCZ.ThreeMarkers?.focusMod?.(mod.id);
      } else {
        const targetMarker = allMarkers.find(
          (m) => String(m.modData.nexus_id) === param || m.modData.id === param,
        );
        if (targetMarker) focusMarker(targetMarker);
      }
    };

    // 5. Setup Category Filters
    const activeCategories = new Set(mods.map((m) => m.category));
    activeCategories.forEach((cat) => {
      const style = NCZ.CATEGORY_STYLES[cat] || NCZ.CATEGORY_STYLES["other"];
      const btn = document.createElement("button");
      btn.className = "filter-btn active";
      btn.textContent = style.label;
      btn.dataset.category = cat;
      btn.addEventListener("click", () => {
        btn.classList.toggle("active");
        applyFilters();
      });
      filterContainer.appendChild(btn);
    });

    // 5b. Setup Author Filters
    const usedAuthors = new Set();
    mods.forEach((mod) => mod.authors.forEach((a) => usedAuthors.add(a)));
    Array.from(usedAuthors)
      .sort()
      .forEach((author) => {
        const btn = document.createElement("button");
        btn.className = "tag-filter-btn"; // Reusing tag style for consistency
        btn.textContent = author;
        btn.dataset.author = author;
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          applyFilters();
        });
        authorFilterContainer.appendChild(btn);
      });

    // Add Tags filter UI (targets static #tag-filters div in HTML)
    const tagsFilterContainer = document.getElementById("tag-filters");
    function clearActiveTagLikeFilters(container) {
      container.querySelectorAll(".tag-filter-btn.active").forEach((btn) => {
        btn.classList.remove("active");
      });
    }

    if (clearTagFiltersBtn) {
      clearTagFiltersBtn.addEventListener("click", () => {
        clearActiveTagLikeFilters(tagsFilterContainer);
        applyFilters();
      });
    }

    if (clearAuthorFiltersBtn) {
      clearAuthorFiltersBtn.addEventListener("click", () => {
        clearActiveTagLikeFilters(authorFilterContainer);
        applyFilters();
      });
    }

    const usedTags = new Set();
    mods.forEach((mod) => (mod.tags || []).forEach((t) => usedTags.add(t)));

    // Prepend synthetic "updated" button if any mod is recently updated
    if (mods.some(NCZ.isRecentlyUpdated)) {
      const btn = document.createElement("button");
      btn.className = "tag-filter-btn";
      btn.textContent = NCZ.UPDATED_LABEL;
      btn.title = `Updated on Nexus within the last ${NCZ.RECENTLY_UPDATED_DAYS} days`;
      btn.dataset.tag = "updated";
      btn.addEventListener("click", () => { btn.classList.toggle("active"); applyFilters(); });
      tagsFilterContainer.appendChild(btn);
    }

    Array.from(usedTags)
      .sort((a, b) => {
        if (a === "nczoning") return -1;
        if (b === "nczoning") return 1;
        return a.localeCompare(b);
      })
      .forEach((tag) => {
        const def = tag === "nczoning"
          ? "Sourced automatically from Nexus Mods"
          : tagsDict[tag] || "";
        const btn = document.createElement("button");
        btn.className = "tag-filter-btn";
        btn.textContent = tag;
        btn.title = def;
        btn.dataset.tag = tag;
        btn.addEventListener("click", () => {
          btn.classList.toggle("active");
          applyFilters();
        });
        tagsFilterContainer.appendChild(btn);
      });

    // Setup collapsible section headers
    document.querySelectorAll(".sidebar-section-header.collapsible").forEach((header) => {
      const target = document.getElementById(header.dataset.collapseTarget);
      if (!target) return;
      header.addEventListener("click", () => {
        header.classList.toggle("collapsed");
        target.classList.toggle("filter-collapsed");
      });
    });

    // 6. Populate BBCode generator tag checkboxes (requires tagsDict from this scope)
    const bbcodeTagGrid = document.getElementById("bbcode-tag-checkboxes");
    if (bbcodeTagGrid) {
      Object.keys(tagsDict)
        .sort()
        .forEach((tag) => {
          const label = document.createElement("label");
          label.className = "bbcode-tag-checkbox";
          label.title = tagsDict[tag] || "";
          label.innerHTML = `<input type="checkbox" value="${tag}"> ${tag}`;
          bbcodeTagGrid.appendChild(label);
        });
    }

    // 7. Setup Text Search (debounced to avoid excessive re-filtering)
    const searchInput = document.getElementById("mod-search");
    const searchClearBtn = document.getElementById("mod-search-clear");
    let searchDebounce;
    function updateSearchClearButtonVisibility() {
      if (!searchClearBtn) return;
      searchClearBtn.hidden = searchInput.value.length === 0;
    }

    function clearSearchQuery() {
      if (searchInput.value.length === 0) return;
      searchInput.value = "";
      updateSearchClearButtonVisibility();
      clearTimeout(searchDebounce);
      applyFilters();
      searchInput.focus();
    }

    searchInput.addEventListener("input", () => {
      updateSearchClearButtonVisibility();
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(applyFilters, NCZ.SEARCH_DEBOUNCE_MS);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (searchInput.value.length === 0) return;
      event.preventDefault();
      clearSearchQuery();
    });

    if (searchClearBtn) {
      searchClearBtn.addEventListener("click", clearSearchQuery);
    }
    updateSearchClearButtonVisibility();

    // Centralized Filter Logic
    function applyFilters() {
      const query = searchInput.value.toLowerCase();
      const activeCats = Array.from(
        filterContainer.querySelectorAll(".filter-btn.active"),
      ).map((b) => b.dataset.category);
      const activeTags = Array.from(
        document.querySelectorAll("#tag-filters .tag-filter-btn.active"),
      ).map((b) => b.dataset.tag);
      const activeAuthors = Array.from(
        authorFilterContainer.querySelectorAll(".tag-filter-btn.active"),
      ).map((b) => b.dataset.author);
      if (tagFilterCountEl) tagFilterCountEl.textContent = activeTags.length > 0 ? ` (${activeTags.length})` : "";
      if (authorFilterCountEl) authorFilterCountEl.textContent = activeAuthors.length > 0 ? ` (${activeAuthors.length})` : "";
      if (clearTagFiltersBtn) clearTagFiltersBtn.hidden = activeTags.length === 0;
      if (clearAuthorFiltersBtn) clearAuthorFiltersBtn.hidden = activeAuthors.length === 0;

      // Close any open cluster panel FIRST. hideClusterPanel →
      // clearPanelPinFocus returns any force-individual (comparison-mode)
      // markers from the map back into the cluster group before we wipe it,
      // so they can't orphan on the map or survive a filter that excludes
      // them. Order matters: this must precede clearLayers().
      hideClusterPanel();
      // Clear current cluster group
      markerClusterGroup.clearLayers();
      const visibleMarkers = [];

      // Compute which mods pass all filters (view-agnostic)
      const visibleIds = NCZ.computeVisibleMods(mods, { query, activeCats, activeTags, activeAuthors });

      // Apply to Leaflet markers
      allMarkers.forEach((marker) => {
        if (visibleIds.has(marker.modData.id)) {
          markerClusterGroup.addLayer(marker);
          visibleMarkers.push(marker);
        }
      });

      // Apply same filter set to 3D pin layer
      NCZ.ThreeMarkers?.applyFilters?.(visibleIds);

      // SAT cluster panel may need to update or close after filter change —
      // some of its mods might no longer be in the visible cluster set.
      recomputeSatClusterPanel();

      // Filter the sidebar list items
      const listItems = modListEl.querySelectorAll(".mod-item");
      listItems.forEach((li) => {
        const modName = li
          .querySelector(".mod-item-name")
          .textContent.toLowerCase();
        const modAuthor = li
          .querySelector(".mod-item-author")
          .textContent.toLowerCase();
        const modCat = li.dataset.category;
        const modTags = (li.dataset.tags || "").split(",");
        const modAuthors = (li.dataset.authors || "").split(",").filter(Boolean);

        const matchesSearch =
          modName.includes(query) || modAuthor.includes(query);
        const matchesCategory = activeCats.includes(modCat);
        const matchesTags =
          activeTags.length === 0 ||
          activeTags.some((t) => modTags.includes(t));
        const matchesAuthor =
          activeAuthors.length === 0 ||
          activeAuthors.some((a) => modAuthors.includes(a));

        li.style.display =
          matchesSearch && matchesCategory && matchesTags && matchesAuthor
            ? "block"
            : "none";
      });

      // Update visible mod count
      modCountEl.textContent = `(${visibleMarkers.length}/${mods.length})`;

      if (focusedMarker && !markerClusterGroup.hasLayer(focusedMarker)) {
        focusedMarker = null;
      } else {
        scheduleFocusedPopupRestore();
      }
    }
  } catch (error) {
    console.error("Error loading mod data:", error);
  }
}

// --- Image Gallery Modal Logic ---
let currentGallery = [];
let currentIndex = 0;

window.openImageGallery = function (images, index) {
  currentGallery = images;
  currentIndex = index;
  updateModalImage();
  const imageModal = document.getElementById("image-modal");
  if (imageModal) imageModal.classList.remove("hidden");
};

function updateModalImage() {
  const modalImage = document.getElementById("modal-image");
  const imageCounter = document.getElementById("image-counter");
  const prevBtn = document.getElementById("prev-image");
  const nextBtn = document.getElementById("next-image");

  if (modalImage) {
    modalImage.src = currentGallery[currentIndex];
    modalImage.referrerPolicy = "no-referrer";
  }
  if (imageCounter)
    imageCounter.textContent = `IMAGE ${currentIndex + 1} / ${currentGallery.length}`;
  if (prevBtn)
    prevBtn.style.display = currentGallery.length > 1 ? "block" : "none";
  if (nextBtn)
    nextBtn.style.display = currentGallery.length > 1 ? "block" : "none";
}

function closeGallery() {
  const imageModal = document.getElementById("image-modal");
  const modalImage = document.getElementById("modal-image");
  if (imageModal) imageModal.classList.add("hidden");
  if (modalImage) modalImage.src = "";
}

// Delegated click handler for popup thumbnails (avoids inline onclick / XSS risk)
document.addEventListener("click", (e) => {
  const thumb = e.target.closest(".popup-thumb[data-full-src]");
  if (thumb) {
    window.openImageGallery([thumb.dataset.fullSrc], 0);
  }
});

// Global Event Listeners for Image Modal
document.addEventListener("DOMContentLoaded", () => {
  const closeImageModal = document.getElementById("close-image-modal");
  const imageModal = document.getElementById("image-modal");
  const prevBtn = document.getElementById("prev-image");
  const nextBtn = document.getElementById("next-image");

  if (closeImageModal) closeImageModal.addEventListener("click", closeGallery);
  if (imageModal) {
    const overlay = imageModal.querySelector(".modal-overlay");
    if (overlay) overlay.addEventListener("click", closeGallery);
  }

  if (prevBtn)
    prevBtn.addEventListener("click", () => {
      currentIndex =
        (currentIndex - 1 + currentGallery.length) % currentGallery.length;
      updateModalImage();
    });

  if (nextBtn)
    nextBtn.addEventListener("click", () => {
      currentIndex = (currentIndex + 1) % currentGallery.length;
      updateModalImage();
    });
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  const imageModal = document.getElementById("image-modal");
  const isImageModalOpen = imageModal && !imageModal.classList.contains("hidden");

  if (e.key === "Escape") {
    if (isImageModalOpen) {
      closeGallery();
      return;
    }

    const visibleModal = document.querySelector(".modal:not(.hidden)");
    if (visibleModal) {
      visibleModal.classList.add("hidden");
      if (visibleModal.id === "welcome-modal") {
        sessionStorage.setItem("nc_zoning_board_visited", "true");
      }
      return;
    }

    document.querySelector(".leaflet-popup-close-button")?.click();
    return;
  }

  if (!isImageModalOpen) return;
  if (e.key === "ArrowLeft" && currentGallery.length > 1) {
    currentIndex =
      (currentIndex - 1 + currentGallery.length) % currentGallery.length;
    updateModalImage();
  }
  if (e.key === "ArrowRight" && currentGallery.length > 1) {
    currentIndex = (currentIndex + 1) % currentGallery.length;
    updateModalImage();
  }
});
