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
  function switchView(viewName) {
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
      NCZ.ThreeScene.init("map-3d");
      NCZ.ThreeScene.startRenderLoop();
    } else {
      map3dEl.style.display = "none";
      mapEl.style.display   = "block";
      NCZ.ThreeScene.stopRenderLoop();
      map.invalidateSize();
    }
    onViewSwitched?.(viewName);
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

  function applySunTime(morroMinutes) {
    // morroMinutes = Morro Bay PDT (e.g. 600 = 10:00 AM PDT)
    if (typeof SunCalc === 'undefined' || !NCZ.ThreeScene?.setSunPosition) return;
    const date = new Date(SOLSTICE);
    // Convert PDT → UTC: PDT = UTC-7, so UTC = PDT + 7
    date.setUTCHours((Math.floor(morroMinutes / 60) - PDT_OFFSET) % 24, morroMinutes % 60, 0, 0);
    const pos = SunCalc.getPosition(date, SUN_LAT, SUN_LNG);
    NCZ.ThreeScene.setSunPosition(pos.azimuth, pos.altitude);
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

    // Default: 10:00 AM PDT — sun ~45° elevation from ENE, good hillshading contrast
    const DEFAULT_SUN_MINUTES = 600;
    sunSlider.value = DEFAULT_SUN_MINUTES;
    applySunTime(DEFAULT_SUN_MINUTES);
  }

  // ── Shadows toggle
  document.getElementById("overlay-shadows")?.addEventListener("change", e => {
    NCZ.ThreeScene?.setShadowsEnabled?.(e.target.checked);
  });

  const flyoverBtn = document.getElementById("scene-flyover-btn");
  // Elements to hide during showcase. We save each one's inline display value
  // so we can restore it exactly — this handles elements that JS may have
  // already toggled (e.g. sidebar-open uses a .visible class, not display).
  const _showcaseEls = [];

  function enterShowcase() {
    ['header', '#sidebar-open', '#discover-location-btn',
     '#overlay-controls', '#map-view-toggle', '#scene-controls']
      .forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        _showcaseEls.push({ el, display: el.style.display });
        el.style.display = 'none';
      });

    document.getElementById('map-3d').classList.add('showcase-fullscreen');
    NCZ.Flyover.startFlyover(); // creates and manages the fade overlay internally
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
    flyoverBtn.classList.contains("active") ? exitShowcase() : enterShowcase();
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

  function restoreFocusedPopupIfVisible() {
    if (!focusedMarker) return;
    if (!markerClusterGroup.hasLayer(focusedMarker)) return;
    const visibleParent = markerClusterGroup.getVisibleParent(focusedMarker);
    if (!visibleParent) return;

    if (visibleParent === focusedMarker) {
      if (!focusedMarker.isPopupOpen()) {
        focusedMarker.openPopup();
      }
      return;
    }

    // Keep focused markers visible even when they are clustered by re-spiderfying
    // their current cluster once zoom animations have settled.
    if (typeof visibleParent.spiderfy !== "function" || markerClusterGroup._inZoomAnimation) return;
    if (markerClusterGroup._spiderfied === visibleParent) return;

    const targetCluster = visibleParent;
    const targetMarker = focusedMarker;
    markerClusterGroup.once("spiderfied", (event) => {
      if (event.cluster !== targetCluster) return;
      if (focusedMarker !== targetMarker) return;
      scheduleFocusedPopupRestore();
    });
    targetCluster.spiderfy();
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
      // URL sync: reflect the open pin in the address bar
      const mod = popupSource.modData;
      const isNum = /^\d+$/.test(String(mod.nexus_id));
      const lid = isNum ? String(mod.nexus_id) : mod.id;
      const url = new URL(window.location.href);
      url.searchParams.set(NCZ.URL_PARAM_MOD, lid);
      history.replaceState(null, "", url.toString());
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
      const url = new URL(window.location.href);
      url.searchParams.delete(NCZ.URL_PARAM_MOD);
      history.replaceState(null, "", url.toString());
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

  // Hide and reset cluster menu state
  function hideClusterPanel() {
    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = "";
    clusterPanel.classList.add("cluster-panel-closed");
  }

  function focusMarker(marker) {
    focusedMarker = marker;
    markerClusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
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

  markerClusterGroup.on("clusterclick", (a) => {
    if (a.originalEvent) L.DomEvent.stop(a.originalEvent);

    // Collect mods from clicked cluster and sort by last updated
    const childMarkers = a.layer
      .getAllChildMarkers()
      .slice()
      .sort((left, right) => NCZ.sortModsByUpdated(left.modData, right.modData));

    // Rebuild cluster menu list for this cluster
    clusterModList.innerHTML = "";
    clusterPanelCount.textContent = `(${childMarkers.length})`;

    if (childMarkers.length === 0) {
      const empty = document.createElement("li");
      empty.className = "cluster-empty";
      empty.textContent = "No mods found in this cluster.";
      clusterModList.appendChild(empty);
    } else {
      childMarkers.forEach((childMarker) => {
        const mod = childMarker.modData;
        const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES.other;
        // Build tag chips shown under author name
        const modTagsHtml = (mod.tags || [])
          .map((tag) => `<span class="tag-badge">${NCZ.escapeHtml(tag)}</span>`)
          .join("");
        // Thumbnail becomes clickable only when full-size image exists
        const isThumbClickable = Boolean(childMarker.modFull);
        const thumbMarkup = childMarker.modThumb
          ? `<img class="cluster-mod-thumb${isThumbClickable ? " cluster-mod-thumb-clickable" : ""}" src="${NCZ.escapeHtml(childMarker.modThumb)}" alt="${NCZ.escapeHtml(mod.name)} thumbnail" referrerpolicy="no-referrer"${isThumbClickable ? ` data-full-src="${NCZ.escapeHtml(childMarker.modFull)}"` : ""}>`
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

        // Clicking row focuses corresponding marker/popup on the map
        button.addEventListener("click", () => {
          focusMarker(childMarker);
          if (window.innerWidth < NCZ.MOBILE_BREAKPOINT) hideClusterPanel();
        });

        item.appendChild(button);
        clusterModList.appendChild(item);
      });
    }

    // Slide menu in from the right
    clusterPanel.classList.remove("cluster-panel-closed");
  });

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
    hideClusterPanel();
  });
  map.on("zoomend", () => {
    isZoomTransitioning = false;
    scheduleFocusedPopupRestore();
  });
  markerClusterGroup.on("animationend", scheduleFocusedPopupRestore);

  // 3. Fetch and Setup Data
  try {
    const { mods, tagsDict } = await NCZ.fetchModData();

    // Auto-discover mods tagged "NCZoning" on Nexus (manual entries win on conflict)
    const existingNexusIds = new Set(
      mods
        .filter((m) => m.nexus_id && !["WIP", "Dummy"].includes(String(m.nexus_id)))
        .map((m) => String(m.nexus_id)),
    );
    const validTagNames = new Set(Object.keys(tagsDict));
    const { mods: autoMods, meta: autoMeta } = await NCZ.fetchNexusTaggedMods(existingNexusIds, validTagNames);
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

      // Clear current cluster group
      markerClusterGroup.clearLayers();
      hideClusterPanel();
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
