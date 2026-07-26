/**
 * NC Zoning Board: Pure Utility Functions
 * No DOM manipulation, no fetch. Operates on provided parameters + NCZ constants.
 */

// HTML escape: prevents XSS from user-supplied data (Nexus API, submitted JSON)
NCZ.escapeHtml = function (text) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
};

// Read/write a JSON object from localStorage with a TTL check
NCZ.cacheGet = function (key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttl) return null;
    return data;
  } catch { return null; }
};

NCZ.cacheSet = function (key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); }
  catch { /* quota exceeded; silently skip */ }
};

// Forward: CET (x, y) → Leaflet [lat, lng]
// Derived from the Realistic Map 8k mod terrain quad UV mapping.
// See docs/coordinate-system.md for the full derivation.
NCZ.cetToLeaflet = function (cetX, cetY) {
  const lng = (cetX - NCZ.WORLD_MIN_X) / (NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X) * 256;
  const lat = (cetY - NCZ.WORLD_MAX_Y) / (NCZ.WORLD_MAX_Y - NCZ.WORLD_MIN_Y) * 256;
  return [lat, lng];
};

// Exact inverse of cetToLeaflet: Leaflet [lat, lng] → CET [x, y]. Used to
// resolve the district/subdistrict under the 2D cursor against the CET polygons.
NCZ.leafletToCet = function (lat, lng) {
  const cetX = lng / 256 * (NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X) + NCZ.WORLD_MIN_X;
  const cetY = lat / 256 * (NCZ.WORLD_MAX_Y - NCZ.WORLD_MIN_Y) + NCZ.WORLD_MAX_Y;
  return [cetX, cetY];
};

// Leaflet lat/lng distance converted to calibrated meters via the CET transform.
NCZ.leafletDistanceMeters = function (a, b) {
  const deltaLng = b.lng - a.lng;
  const deltaLat = b.lat - a.lat;
  const deltaCetX = deltaLng / NCZ.CET_TO_LEAFLET_X_SCALE;
  const deltaCetY = deltaLat / NCZ.CET_TO_LEAFLET_Y_SCALE;
  const distanceCetUnits = Math.hypot(deltaCetX, deltaCetY);
  return distanceCetUnits / NCZ.CET_UNITS_PER_METER;
};

// View-sync bridge between the 2D Leaflet map and the 3D perspective camera.
// Both directions match the *horizontal* visible CET width at screen centre:
// exact at any camera tilt, since the camera's right vector stays in world XZ
// (same reasoning as updateScaleBar()). The look-direction extent foreshortens
// when tilted, so the vertical match is approximate by design; we preserve the
// user's heading/tilt rather than snapping top-down.
//   Leaflet horizontal CET width @ zoom z = pxW · RX / (256 · 2^z)
//   Three  horizontal CET width @ dist d  = 2 · d · tan(fovY/2) · aspect
// `fov` is the camera's vertical FOV in degrees (THREE.PerspectiveCamera.fov).
NCZ.leafletViewToCameraExtent = function ({ centerLat, centerLng, zoom, leafletPxW, aspect3d, fov }) {
  const rangeX = NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X;
  const [cetX, cetY] = NCZ.leafletToCet(centerLat, centerLng);
  const widthCet = (leafletPxW * rangeX) / (256 * Math.pow(2, zoom));
  const halfFovY = (fov * Math.PI) / 360;
  const distance = widthCet / (2 * Math.tan(halfFovY) * aspect3d);
  return { cetX, cetY, distance };
};

// Inverse of leafletViewToCameraExtent: 3D camera ground target + distance → a
// Leaflet centre + (fractional) zoom. Caller clamps/rounds zoom to its range.
NCZ.cameraExtentToLeafletView = function ({ cetX, cetY, distance, aspect3d, fov, leafletPxW }) {
  const rangeX = NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X;
  const [lat, lng] = NCZ.cetToLeaflet(cetX, cetY);
  const halfFovY = (fov * Math.PI) / 360;
  const widthCet = 2 * distance * Math.tan(halfFovY) * aspect3d;
  const zoom = Math.log2((leafletPxW * rangeX) / (256 * widthCet));
  return { lat, lng, zoom };
};


NCZ.clamp = function (value, min, max) {
  return Math.min(Math.max(value, min), max);
};

/**
 * Tone-mapping exposure for a given sun elevation, from NCZ.SCENE_EXPOSURE_CURVE
 * (piecewise-linear, clamped to the endpoints). Shared by the time-of-day
 * slider (applySunTime) and the showcase flyover (updateFlyoverSun) so both
 * drive exposure identically; see the curve comment in constants.js.
 * @param {number} elevationRad sun elevation above the horizon, in radians
 */
NCZ.exposureForSunElevation = function (elevationRad) {
  const curve = NCZ.SCENE_EXPOSURE_CURVE;
  if (!curve || !curve.length) return NCZ.SCENE_EXPOSURE;
  const deg = elevationRad * 180 / Math.PI;
  if (deg <= curve[0][0]) return curve[0][1];
  if (deg >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 1; i < curve.length; i++) {
    const [d1, e1] = curve[i];
    if (deg <= d1) {
      const [d0, e0] = curve[i - 1];
      return e0 + (e1 - e0) * ((deg - d0) / (d1 - d0));
    }
  }
  return NCZ.SCENE_EXPOSURE;
};

/**
 * Chooses an anchor side and calculates a clamped box position + arrow anchor.
 * Consumers apply the returned values to their own DOM elements/styles.
 */
NCZ.pickDirectionAndPosition = function (anchorPoint, size, mapSize, config) {
  const mapWidth = mapSize.x ?? mapSize.width;
  const mapHeight = mapSize.y ?? mapSize.height;
  const directionOrder = config.directionOrder ?? ["top", "bottom", "right", "left"];

  const requiredVertical = size.height + config.gapPx + config.arrowSizePx;
  const requiredHorizontal = size.width + config.gapPx + config.arrowSizePx;

  const space = {
    top: anchorPoint.y - config.marginPx,
    bottom: mapHeight - anchorPoint.y - config.marginPx,
    left: anchorPoint.x - config.marginPx,
    right: mapWidth - anchorPoint.x - config.marginPx,
  };

  let direction = directionOrder.find((dir) => {
    if (dir === "top" || dir === "bottom") return space[dir] >= requiredVertical;
    return space[dir] >= requiredHorizontal;
  });

  if (!direction) {
    direction = directionOrder.reduce(
      (best, dir) => (space[dir] > space[best] ? dir : best),
      directionOrder[0],
    );
  }

  let left = anchorPoint.x - (size.width / 2);
  let top = anchorPoint.y - size.height - config.gapPx - config.arrowSizePx;

  if (direction === "bottom") {
    top = anchorPoint.y + config.gapPx + config.arrowSizePx;
  } else if (direction === "left") {
    left = anchorPoint.x - size.width - config.gapPx - config.arrowSizePx;
    top = anchorPoint.y - (size.height / 2);
  } else if (direction === "right") {
    left = anchorPoint.x + config.gapPx + config.arrowSizePx;
    top = anchorPoint.y - (size.height / 2);
  }

  let minLeft = config.marginPx;
  let maxLeft = mapWidth - config.marginPx - size.width;
  let minTop = config.marginPx;
  let maxTop = mapHeight - config.marginPx - size.height;

  if (direction === "right") minLeft += config.arrowSizePx;
  if (direction === "left") maxLeft -= config.arrowSizePx;
  if (direction === "bottom") minTop += config.arrowSizePx;
  if (direction === "top") maxTop -= config.arrowSizePx;

  if (maxLeft < minLeft) {
    minLeft = maxLeft = Math.max(0, (mapWidth - size.width) / 2);
  }
  if (maxTop < minTop) {
    minTop = maxTop = Math.max(0, (mapHeight - size.height) / 2);
  }

  left = NCZ.clamp(left, minLeft, maxLeft);
  top = NCZ.clamp(top, minTop, maxTop);

  const arrowX = NCZ.clamp(
    anchorPoint.x - left,
    config.arrowEdgePaddingPx,
    size.width - config.arrowEdgePaddingPx,
  );
  const arrowY = NCZ.clamp(
    anchorPoint.y - top,
    config.arrowEdgePaddingPx,
    size.height - config.arrowEdgePaddingPx,
  );

  return { direction, left, top, arrowX, arrowY };
};

// Returns true when a mod was updated on Nexus within the recent window.
// The API computes this server-side (so the clockless in-game consumer can read
// it too) and ships it as `recently_updated` on every record; trust that when
// present. The timestamp fallback below only runs for an older API deploy that
// omits the bool, computing it from the raw `_updatedAt` and effective window.
NCZ.isRecentlyUpdated = function (mod) {
  if (typeof mod.recently_updated === "boolean") return mod.recently_updated;
  if (!mod._updatedAt) return false;
  const days = NCZ.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS;
  return new Date(mod._updatedAt).getTime() > Date.now() - days * 86400000;
};

// CET → Three.js world coords. Game Y axis becomes -Z (both right-handed, but Y/Z are swapped).
NCZ.cetToThree = function (cetX, cetY, cetZ) {
  return [cetX, cetZ || 0, -cetY];
};

// Area-weighted polygon centroid (shoelace) for a ring of [x, y] vertices.
// Centre of mass, so it handles non-convex rings far better than a plain vertex
// average (which drifts toward dense corners). Returns [cx, cy] in the ring's
// own space. Falls back to the vertex average for a degenerate (zero-area) ring.
// Matches scripts/preview_district_borders.py's Shapely centroid.
NCZ.polygonCentroid = function (ring) {
  if (!ring || ring.length === 0) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += cross;
    cx += (ring[j][0] + ring[i][0]) * cross;
    cy += (ring[j][1] + ring[i][1]) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (6 * a), cy / (6 * a)];
};

// Ray-casting point-in-polygon test. Generic over coordinate space: `point`
// and `ring` vertices are both [a, b] pairs in the SAME space (3D passes world
// [x, -z]; 2D passes [lat, lng]). `ring` is the polygon's vertex list; the
// closing edge back to ring[0] is handled implicitly. Returns true if the point
// is inside (odd crossing count).
NCZ.pointInPolygon = function (point, ring) {
  if (!ring || ring.length < 3) return false;
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

// Builds the full popup HTML string for a mod.
// View-agnostic: both Leaflet (marker.bindPopup) and Three.js (CSS2DObject) call this.
NCZ.buildPopupHtml = function (mod, catStyle, nexusThumbs, tagsDict) {
  const nexus_id_lower = String(mod.nexus_id).toLowerCase();
  let nexusUrl = `https://www.nexusmods.com/cyberpunk2077/mods/${mod.nexus_id}`;
  let nexusLabel = "View on Nexus";
  if (nexus_id_lower === "wip") {
    nexusUrl = "https://www.nexusmods.com/games/cyberpunk2077";
    nexusLabel = "Status: WIP";
  } else if (nexus_id_lower === "dummy") {
    nexusUrl = "https://www.nexusmods.com/games/cyberpunk2077";
    nexusLabel = "Status: Dummy/Test";
  }

  const isNumericNexusId = /^\d+$/.test(String(mod.nexus_id));
  const modLinkId = isNumericNexusId ? String(mod.nexus_id) : mod.id;
  const copyLinkUrl = `${NCZ.SITE_URL}?${NCZ.URL_PARAM_MOD}=${encodeURIComponent(modLinkId)}`;

  const [cX, cY, cZ] = mod.coordinates;
  const yawParam = mod.yaw != null ? `&yaw=${mod.yaw}` : "";
  const editUrl = `https://github.com/nczoning/nc-zoning-board/issues/new?template=modify_location.yml&location_id=${mod.id}&mod_name=${encodeURIComponent(mod.name)}&authors=${encodeURIComponent(mod.authors.join(", "))}&coord_x=${cX}&coord_y=${cY}&coord_z=${cZ ?? ""}&yaw=${mod.yaw ?? ""}${yawParam}`;

  const nexusThumb = nexusThumbs[String(mod.nexus_id)];
  const thumbSrc = nexusThumb?.thumbnailUrl || null;
  const fullSrc = nexusThumb?.pictureUrl || null;
  const hasPopupImage = Boolean(thumbSrc && fullSrc);

  const nexusAutoBadge = mod._source === "nexus-auto"
    ? ` <span class="nexus-auto-badge" title="Sourced automatically from Nexus Mods" aria-hidden="true"></span>`
    : "";
  const updatedPopupBadge = NCZ.isRecentlyUpdated(mod)
    ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.recentlyUpdatedDays ?? NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>`
    : "";

  const authorsHtml = mod.authors
    .map((author) => `<a href="https://www.nexusmods.com/profile/${encodeURIComponent(author)}/mods?gameId=3333" target="_blank" class="ui-popup-action-link small"><img src="assets/img/nexus-mods_favicon.ico" class="ui-popup-action-link-icon" alt="" aria-hidden="true"> ${NCZ.escapeHtml(author)}</a>`)
    .join(" ");

  const tagsHtml = (mod.tags || [])
    .map((tag) => {
      const def = tag === "nczoning" ? "Sourced automatically from Nexus Mods" : tagsDict[tag] || "";
      return `<span class="tag-badge" title="${NCZ.escapeHtml(def)}">${NCZ.escapeHtml(tag)}</span>`;
    })
    .join("");

  const creditNames = (mod.credits || "").split(",").map((n) => n.trim()).filter(Boolean);
  const creditsHtml = creditNames
    .map((n) => `<span class="custom-popup-credit-name">${NCZ.escapeHtml(n)}</span>`)
    .join(", ");

  return `
    <div class="custom-popup-content" style="--popup-title-accent: ${catStyle.color};">
      <span class="popup-category-badge">${NCZ.escapeHtml(catStyle.label)}</span>
      ${updatedPopupBadge}
      ${hasPopupImage ? `
        <div class="custom-popup-header has-image">
          <div class="custom-popup-images">
            <img src="${NCZ.escapeHtml(thumbSrc)}" class="popup-thumb" referrerpolicy="no-referrer" data-full-src="${NCZ.escapeHtml(fullSrc)}">
          </div>
        </div>` : ""}
      <div class="custom-popup-title">${NCZ.escapeHtml(mod.name)}${nexusAutoBadge}</div>
      <div class="custom-popup-body">
        <div class="custom-popup-authors">${authorsHtml}</div>
        ${mod.credits ? `<div class="custom-popup-credits">Credits: ${creditsHtml || NCZ.escapeHtml(mod.credits)}</div>` : ""}
        <div class="custom-popup-desc">${NCZ.escapeHtml(mod.description || "No description provided.")}</div>
        ${tagsHtml ? `<div class="custom-popup-tags">${tagsHtml}</div>` : ""}
        <div class="popup-actions">
          <a href="${NCZ.escapeHtml(nexusUrl)}" target="_blank" class="ui-popup-action-link ui-popup-action-link-nexus">${NCZ.escapeHtml(nexusLabel)}</a>
          <button type="button" class="ui-popup-action-link ui-popup-action-link-copy-link tertiary" data-copy-url="${NCZ.escapeHtml(copyLinkUrl)}" aria-label="Copy link to this pin" title="Copy link"><span class="ui-popup-action-link-icon" aria-hidden="true"></span></button>
          ${!mod._source ? `<a href="${NCZ.escapeHtml(editUrl)}" target="_blank" class="ui-popup-action-link ui-popup-action-link-edit tertiary" aria-label="Suggest Edit" title="Suggest Edit"><span class="ui-popup-action-link-icon" aria-hidden="true"></span></a>` : ""}
        </div>
      </div>
    </div>
  `;
};

// Prepares all view-agnostic data for rendering a mod pin and popup.
// Both Leaflet and Three.js pin creation consume this instead of computing in-place.
NCZ.prepareModRenderData = function (mod, nexusThumbs, tagsDict) {
  const catStyle = NCZ.CATEGORY_STYLES[mod.category] || NCZ.CATEGORY_STYLES["other"];
  const nexusThumb = nexusThumbs[String(mod.nexus_id)];
  const thumbSrc = nexusThumb?.thumbnailUrl || null;
  const fullSrc = nexusThumb?.pictureUrl || null;

  const nexus_id_lower = String(mod.nexus_id).toLowerCase();
  let nexusUrl = `https://www.nexusmods.com/cyberpunk2077/mods/${mod.nexus_id}`;
  let nexusLabel = "View on Nexus";
  if (nexus_id_lower === "wip") {
    nexusUrl = "https://www.nexusmods.com/games/cyberpunk2077";
    nexusLabel = "Status: WIP";
  } else if (nexus_id_lower === "dummy") {
    nexusUrl = "https://www.nexusmods.com/games/cyberpunk2077";
    nexusLabel = "Status: Dummy/Test";
  }

  return {
    mod,
    catStyle,
    thumbSrc,
    fullSrc,
    nexusUrl,
    nexusLabel,
    popupHtml: NCZ.buildPopupHtml(mod, catStyle, nexusThumbs, tagsDict),
  };
};

// Returns a Set of mod IDs that pass all active filters.
// filters: { query: string, activeCats: string[], activeTags: string[], activeAuthors: string[] }
// "updated" in activeTags is special: matches NCZ.isRecentlyUpdated(mod), not mod.tags.
NCZ.computeVisibleMods = function (allMods, filters) {
  const { query, activeCats, activeTags, activeAuthors } = filters;
  const q = query.toLowerCase();
  const visible = new Set();

  for (const mod of allMods) {
    const matchesSearch = mod.name.toLowerCase().includes(q) ||
      mod.authors.some((a) => a.toLowerCase().includes(q));
    const matchesCategory = activeCats.includes(mod.category);
    const matchesTags = activeTags.length === 0 ||
      activeTags.some((t) => t === "updated" ? NCZ.isRecentlyUpdated(mod) : (mod.tags || []).includes(t));
    const matchesAuthor = activeAuthors.length === 0 ||
      activeAuthors.some((a) => mod.authors.includes(a));

    if (matchesSearch && matchesCategory && matchesTags && matchesAuthor) {
      visible.add(mod.id);
    }
  }

  return visible;
};

// Comparator for Array.sort: orders mods by Nexus updatedAt descending.
// Mods with no Nexus date (WIP/Dummy) fall to end, sorted alphabetically.
NCZ.sortModsByUpdated = function (a, b) {
  const tsA = a._updatedAt ? new Date(a._updatedAt).getTime() : null;
  const tsB = b._updatedAt ? new Date(b._updatedAt).getTime() : null;
  if (tsA !== null && tsB !== null) return tsB - tsA;
  if (tsA !== null) return -1;
  if (tsB !== null) return 1;
  return a.name.localeCompare(b.name);
};
