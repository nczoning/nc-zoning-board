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
// Computed here, from the raw `_updatedAt` and the window the API publishes on
// its envelope (`NCZ.recentlyUpdatedDays`). The API serves no recency bool: it
// would be the only time-dependent field in the payload, which forces the cron
// to rewrite KV on every tick.
NCZ.isRecentlyUpdated = function (mod) {
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
/**
 * Normalise whatever /v1/tags returned into the { slug: description } map the
 * renderers use.
 *
 * TRANSITIONAL: accepts BOTH the array-of-records shape (D1-backed, current)
 * and the legacy { slug: description } dictionary. Not defensive coding for its
 * own sake: the site and the Worker deploy independently, and the dev site
 * reads the PRODUCTION API by default, so during the migration a new site can
 * legitimately be talking to an API still serving the pre-0.4.0 shape. Tolerating
 * both means the two can ship in either order with no flag day.
 *
 * Delete the dictionary branch once every environment serves the array.
 */
NCZ.normaliseTags = function (payload) {
  if (Array.isArray(payload)) {
    return Object.fromEntries(
      payload.map((t) => [t.slug, t.description ?? ""])
    );
  }
  return payload && typeof payload === "object" ? payload : {};
};

/**
 * The id a shared ?mod= link addresses. Always the location id: a Nexus id
 * identifies a mod, and one mod can supply several locations (#889).
 *
 * The resolver must keep accepting a Nexus id too. Every link shared before
 * this uses one.
 */
NCZ.modLinkId = function (mod) {
  return mod.id;
};

/**
 * The pin popup, for both views: Leaflet binds this string and the Three.js
 * layer puts it in a CSS2DObject card.
 *
 * The fix action is a BUTTON carrying the location id, not a link, and nothing
 * here binds a handler. One delegated listener in app.js serves every pin in
 * both views; a per-popup listener would have to be attached twice, once in
 * each view's popup-open path, and the two would drift.
 *
 * ONE action, not two. Asking for a pin to be taken down is a kind of
 * correction, chosen inside the form, rather than a second button beside it:
 * everything a separate report could say, the form already asks for.
 *
 * It renders on every record. The edit link it replaces was hidden on
 * auto-discovered pins, which made sense when the only way to correct one was to
 * edit a Nexus description. A submission goes to the same queue whatever the
 * record's provenance.
 */
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

  const copyLinkUrl = `${NCZ.SITE_URL}?${NCZ.URL_PARAM_MOD}=${encodeURIComponent(NCZ.modLinkId(mod))}`;

  const nexusThumb = nexusThumbs[String(mod.nexus_id)];
  const thumbSrc = nexusThumb?.thumbnailUrl || null;
  const fullSrc = nexusThumb?.pictureUrl || null;
  const hasPopupImage = Boolean(thumbSrc && fullSrc);

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
      <div class="custom-popup-title">${NCZ.escapeHtml(mod.name)}</div>
      <div class="custom-popup-body">
        <div class="custom-popup-authors">${authorsHtml}</div>
        ${mod.credits ? `<div class="custom-popup-credits">Credits: ${creditsHtml || NCZ.escapeHtml(mod.credits)}</div>` : ""}
        <div class="custom-popup-desc">${NCZ.escapeHtml(mod.description || "No description provided.")}</div>
        ${tagsHtml ? `<div class="custom-popup-tags">${tagsHtml}</div>` : ""}
        <div class="popup-actions">
          <a href="${NCZ.escapeHtml(nexusUrl)}" target="_blank" class="ui-popup-action-link ui-popup-action-link-nexus">${NCZ.escapeHtml(nexusLabel)}</a>
          <button type="button" class="ui-popup-action-link ui-popup-action-link-copy-link tertiary" data-copy-url="${NCZ.escapeHtml(copyLinkUrl)}" aria-label="Copy link to this pin" title="Copy link"><span class="ui-popup-action-link-icon" aria-hidden="true"></span></button>
          <button type="button" class="ui-popup-action-link ui-popup-action-link-edit tertiary" data-edit-location="${NCZ.escapeHtml(String(mod.id))}" aria-label="Suggest a fix" title="Suggest a correction to this pin, or ask for it to be taken down. A reviewer decides."><span class="ui-popup-action-link-icon" aria-hidden="true"></span></button>
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

// ── Submission form ──────────────────────────────────────────────────────────

// The mod id in a Nexus reference. Accepts a bare numeric id, the current
// /games/cyberpunk2077/mods/<id> URL and the older /cyberpunk2077/mods/<id>
// form, with or without a scheme, query or trailing path.
//
// Returns { id } or { error }. A URL naming a different game is an error rather
// than a silently accepted id: the number is real, it just points at another
// game's mod, and nothing downstream could tell.
NCZ.parseNexusRef = function (input) {
  const text = String(input ?? "").trim();
  if (!text) return { error: "Enter the mod's Nexus page URL, or its numeric id." };

  if (/^\d+$/.test(text)) return { id: text };

  if (/nexusmods\.com/i.test(text)) {
    if (!/nexusmods\.com\/(games\/)?cyberpunk2077\//i.test(text)) {
      return { error: "That link is for a different game. Use the mod's Cyberpunk 2077 page." };
    }
    const match = text.match(/\/mods\/(\d+)/);
    if (match) return { id: match[1] };
    return { error: "That link has no mod id in it. Open the mod's own page and copy the URL." };
  }

  return { error: "Enter the mod's Nexus page URL, or its numeric id." };
};

// Which of the three coordinate values are unusable, and the one message that
// covers them.
//
// Split out because the row is a single control in the form and three boxes on
// the screen: the message belongs to the row, the red border belongs to the box
// that is wrong. It takes the three values rather than a whole form, so the
// live check can call it on every keystroke.
//
// @returns {{axes: string[], message: string|null}}
NCZ.coordinateProblems = function (x, y, z) {
  const parse = (v) => parseFloat(String(v ?? "").trim());
  const values = { x: parse(x), y: parse(y), z: parse(z) };
  const failed = new Set();
  const messages = [];

  // Every problem in the row, not the first one. Returning early on the X/Y
  // check hides a bad Z until X is fixed, so a submitter corrects one number,
  // sends, and meets the next complaint.
  const missing = ["x", "y", "z"].filter((axis) => !Number.isFinite(values[axis]));
  if (missing.length) {
    missing.forEach((axis) => failed.add(axis));
    messages.push("Enter X, Y and Z as numbers.");
  }

  const outside = ["x", "y"].filter((axis) => Number.isFinite(values[axis]) && (
    axis === "x"
      ? values.x < NCZ.TERRAIN_MIN_X || values.x > NCZ.TERRAIN_MAX_X
      : values.y < NCZ.TERRAIN_MIN_Y || values.y > NCZ.TERRAIN_MAX_Y
  ));
  if (outside.length) {
    outside.forEach((axis) => failed.add(axis));
    messages.push(`X and Y must be between ${NCZ.TERRAIN_MIN_X} and ${NCZ.TERRAIN_MAX_X}.`);
  }

  if (Number.isFinite(values.z) && (values.z < NCZ.COORD_Z_MIN || values.z > NCZ.COORD_Z_MAX)) {
    failed.add("z");
    messages.push(`Z must be between ${NCZ.COORD_Z_MIN} and ${NCZ.COORD_Z_MAX}.`);
  }

  return {
    axes: ["x", "y", "z"].filter((axis) => failed.has(axis)),
    message: messages.length ? `${messages.join(" ")} Check the values against the CET output.` : null,
  };
};

// A Nexus summary as a starting description.
//
// The same truncation merge.js applies when it builds an auto-discovered
// record's description from the summary, so a submitter sees what that path
// would have published, and can edit it.
NCZ.summaryToDescription = function (summary) {
  const text = String(summary ?? "").trim();
  if (text.length <= NCZ.DESCRIPTION_MAX_LENGTH) return text;
  return `${text.slice(0, NCZ.DESCRIPTION_MAX_LENGTH - 3)}...`;
};

// Read and validate the location fields both submission modals collect.
//
// Pure: the caller passes raw strings and gets back the payload POST
// /submissions accepts, plus one message per field that failed. Every rule here
// also exists in worker/src/validate.js, which is the enforcement point:
// /submissions is an anonymous public write, so a rule that lives only in the
// browser sits in the layer the submitter controls. This copy exists to say so
// inline, before a send that would come back 400.
//
// Two rules are deliberately stricter than the server, because the server
// serves the admin editor too: `description` must be non-empty, and `nexus_id`
// must be numeric. A reviewer can set "WIP" on approval; a submitter cannot
// evidence it.
//
// @param {object} raw            trimmed or untrimmed strings, straight off the inputs
// @param {object} [opts]
// @param {string[]} [opts.knownTags]  tag slugs the registry knows; unknown tags
//   are an error, matching the server rather than dropping them
// @param {string} [opts.fixedNexusId]  the mod id an EDIT is against. An edit
//   does not ask which mod this is, so there is no field to parse, and the
//   stored value may be "WIP" or "Dummy", which the public form refuses for a
//   new pin but must not refuse for an edit to an existing one.
// @returns {{values: object, errors: object}}  errors is keyed by field name
NCZ.collectLocationForm = function (raw, { knownTags, fixedNexusId } = {}) {
  const errors = {};
  const text = (v) => String(v ?? "").trim();

  const name = text(raw.name);
  if (name.length < NCZ.NAME_MIN_LENGTH) {
    errors.name = `Give the location a name of at least ${NCZ.NAME_MIN_LENGTH} characters.`;
  }

  const authors = text(raw.authors).split(",").map((a) => a.trim()).filter(Boolean);
  if (!authors.length) errors.authors = "Name at least one author.";

  const description = text(raw.description);
  if (!description) {
    errors.description = "Describe the location, so a reviewer knows what is being added.";
  } else if (description.length > NCZ.DESCRIPTION_MAX_LENGTH) {
    errors.description = `Keep the description to ${NCZ.DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }

  const nums = ["x", "y", "z"].map((k) => parseFloat(text(raw[k])));
  const coordinates = NCZ.coordinateProblems(raw.x, raw.y, raw.z);
  if (coordinates.message) errors.coordinates = coordinates.message;

  const yawText = text(raw.yaw);
  let yaw = null;
  if (yawText) {
    yaw = parseFloat(yawText);
    if (!Number.isFinite(yaw)) errors.yaw = "Yaw must be a number, or left blank.";
  }

  const category = text(raw.category);
  if (!NCZ.CATEGORY_STYLES[category]) errors.category = "Choose a category.";

  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => text(t)).filter(Boolean) : [];
  if (knownTags) {
    const unknown = tags.filter((t) => !knownTags.includes(t));
    if (unknown.length) errors.tags = `Unknown tag(s): ${unknown.join(", ")}.`;
  }

  const ref = fixedNexusId
    ? { id: String(fixedNexusId) }
    : NCZ.parseNexusRef(raw.nexusId);
  if (ref.error) errors.nexus_id = ref.error;

  const credits = text(raw.credits);

  const values = {
    name,
    authors,
    description,
    coordinates: nums.every(Number.isFinite) ? nums : [],
    yaw,
    category,
    tags,
    nexus_id: ref.id ?? "",
    credits: credits || null,
  };

  return { values, errors };
};

// The fields of an edit that actually changed, against the record the map is
// already holding.
//
// An edit submission sends only these. Sending the whole record would make
// every proposal look like a rewrite in the review queue's diff, and the
// reviewer's job is to see that the yaw moved, not to re-read the description.
// The server agrees: `kind: 'edit'` validates with `partial: true` and refuses a
// payload with no fields in it.
//
// Arrays compare by content, not by identity: `tags` and `authors` are rebuilt
// from the form on every read, so a reference test would call every submission
// a change to both.
//
// @param {object} original  the stored record, as /v1 serves it
// @param {object} values    collectLocationForm().values
// @returns {object} the changed subset, empty when nothing moved
NCZ.diffLocation = function (original, values) {
  const changed = {};
  const same = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      const left = Array.isArray(a) ? a : [];
      const right = Array.isArray(b) ? b : [];
      return left.length === right.length && left.every((v, i) => v === right[i]);
    }
    // null and "" both mean "no credits" on a record, and a form cannot tell
    // them apart, so clearing a field that was already empty is not a change.
    if ((a ?? "") === "" && (b ?? "") === "") return true;
    return a === b;
  };

  for (const [key, value] of Object.entries(values)) {
    if (!same(original?.[key], value)) changed[key] = value;
  }
  return changed;
};

// The submission envelope fields, which sit beside the payload rather than in
// it: validateLocationInput rejects unknown keys, so a note posted inside the
// payload would refuse the whole submission.
//
// Both are optional. `contact` is personal data and is collected only so a
// reviewer can ask a question; see docs/privacy.md.
NCZ.collectSubmissionMeta = function (raw) {
  const errors = {};
  const note = String(raw.note ?? "").trim();
  const contact = String(raw.contact ?? "").trim();

  if (note.length > NCZ.SUBMISSION_NOTE_MAX) {
    errors.note = `Keep the note to ${NCZ.SUBMISSION_NOTE_MAX} characters or fewer.`;
  }
  if (contact.length > NCZ.SUBMISSION_CONTACT_MAX) {
    errors.contact = `Keep the contact to ${NCZ.SUBMISSION_CONTACT_MAX} characters or fewer.`;
  }

  return {
    values: { submitter_note: note || null, submitter_contact: contact || null },
    errors,
  };
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
