/**
 * NC Zoning Board — Pure Utility Functions
 * No DOM manipulation, no fetch. Operates on provided parameters + NCZ constants.
 */

// HTML escape — prevents XSS from user-supplied data (Nexus API, submitted JSON)
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
  catch { /* quota exceeded — silently skip */ }
};

// Convert gameId + modId → Nexus UID (composite BigInt key)
NCZ.toNexusUid = function (modId) {
  return ((BigInt(NCZ.NEXUS_GAME_ID) << BigInt(32)) + BigInt(modId)).toString();
};

// Forward: CET (x, y) → Leaflet [lat, lng]
// Derived from the Realistic Map 8k mod terrain quad UV mapping.
// See docs/coordinate-system.md for the full derivation.
NCZ.cetToLeaflet = function (cetX, cetY) {
  const lng = (cetX - NCZ.WORLD_MIN_X) / (NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X) * 256;
  const lat = (cetY - NCZ.WORLD_MAX_Y) / (NCZ.WORLD_MAX_Y - NCZ.WORLD_MIN_Y) * 256;
  return [lat, lng];
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


NCZ.clamp = function (value, min, max) {
  return Math.min(Math.max(value, min), max);
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

/**
 * Parse the NCZoning: metadata block from a Nexus mod description.
 * Returns a parsed object, or null if no valid block is present.
 *
 * Resilient to blocks that have lost their [code] wrapper or picked up
 * stray BBCode styling ([spoiler]/[size]/[font]/[color], often per-line)
 * — e.g. from a copy-paste round-trip (Discord → Nexus) or the author
 * manually reformatting. We strip every BBCode tag first, so a clean
 * [code] block and a styled/unwrapped one normalize to the same plain
 * text, then anchor on the `NCZoning:` sentinel line and read the
 * key=value lines that follow it.
 */
NCZ.parseNcZoningBlock = function (description, validTagNames) {
  if (!description) return null;

  // Normalize HTML line breaks, then strip every BBCode [tag]/[/tag].
  // This subsumes the old [spoiler] unwrap and the [code] requirement —
  // both become tag noise that disappears, leaving plain key=value text.
  const text = description
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[\/?[a-z][^\]]*\]/gi, "");

  const lines = text.split("\n").map((l) => l.trim());
  const start = lines.findIndex((l) => /^NCZoning\s*:$/i.test(l));
  if (start === -1) return null;

  // Read recognized key=value lines after the sentinel. Blank lines (left
  // behind by stripped per-line tags) are skipped; once we've collected at
  // least one field, the first unrecognized non-empty line ends the block
  // so trailing description prose isn't mis-parsed.
  const RECOGNIZED = new Set(["coords", "category", "tags", "yaw", "credits", "authors"]);
  const data = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const eqIdx = line.indexOf("=");
    const key = eqIdx === -1 ? "" : line.slice(0, eqIdx).trim().toLowerCase();
    if (!RECOGNIZED.has(key)) {
      if (Object.keys(data).length) break;
      continue;
    }
    const value = line.slice(eqIdx + 1).trim();
    if (value && !(key in data)) data[key] = value;
  }

  // coords is required — two or three comma-separated numbers [X, Y] or [X, Y, Z]
  if (!data.coords) return null;
  const coordParts = data.coords.split(",").map((s) => parseFloat(s.trim()));
  // Prevent invalid input: reject < 2 values (missing Y or both), > 3 values (extra fields), or NaN (failed parse)
  if (coordParts.length < 2 || coordParts.length > 3 || coordParts.some(isNaN)) return null;

  // category is required
  const validCategories = ["location-overhaul", "new-location", "other"];
  if (!data.category || !validCategories.includes(data.category)) return null;

  // tags: filter to known tags only — unknown tags silently dropped
  const tags = data.tags
    ? data.tags.split(",").map((t) => t.trim()).filter((t) => validTagNames.has(t))
    : [];

  // additional authors beyond Nexus uploader
  const additionalAuthors = data.authors
    ? data.authors.split(",").map((a) => a.trim()).filter(Boolean)
    : [];

  // yaw is optional
  const yaw = data.yaw && !isNaN(parseFloat(data.yaw)) ? parseFloat(data.yaw) : null;

  return {
    coordinates: coordParts,
    category: data.category,
    tags,
    credits: data.credits || null,
    additionalAuthors,
    yaw,
  };
};

// Returns true when a mod was updated on Nexus within the recent window.
NCZ.isRecentlyUpdated = function (mod) {
  if (!mod._updatedAt) return false;
  const cutoff = Date.now() - NCZ.RECENTLY_UPDATED_DAYS * 86400000;
  return new Date(mod._updatedAt).getTime() > cutoff;
};

// CET → Three.js world coords. Game Y axis becomes -Z (both right-handed, but Y/Z are swapped).
NCZ.cetToThree = function (cetX, cetY, cetZ) {
  return [cetX, cetZ || 0, -cetY];
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
  const editUrl = `https://github.com/spuddeh/nc-zoning-board/issues/new?template=modify_location.yml&location_id=${mod.id}&mod_name=${encodeURIComponent(mod.name)}&authors=${encodeURIComponent(mod.authors.join(", "))}&coord_x=${cX}&coord_y=${cY}&coord_z=${cZ ?? ""}&yaw=${mod.yaw ?? ""}${yawParam}`;

  const nexusThumb = nexusThumbs[String(mod.nexus_id)];
  const thumbSrc = nexusThumb?.thumbnailUrl || null;
  const fullSrc = nexusThumb?.pictureUrl || null;
  const hasPopupImage = Boolean(thumbSrc && fullSrc);

  const nexusAutoBadge = mod._source === "nexus-auto"
    ? ` <span class="nexus-auto-badge" title="Sourced automatically from Nexus Mods" aria-hidden="true"></span>`
    : "";
  const updatedPopupBadge = NCZ.isRecentlyUpdated(mod)
    ? ` <span class="badge-updated" title="Updated on Nexus within the last ${NCZ.RECENTLY_UPDATED_DAYS} days">${NCZ.UPDATED_LABEL}</span>`
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

// Comparator for Array.sort — orders mods by Nexus updatedAt descending.
// Mods with no Nexus date (WIP/Dummy) fall to end, sorted alphabetically.
NCZ.sortModsByUpdated = function (a, b) {
  const tsA = a._updatedAt ? new Date(a._updatedAt).getTime() : null;
  const tsB = b._updatedAt ? new Date(b._updatedAt).getTime() : null;
  if (tsA !== null && tsB !== null) return tsB - tsA;
  if (tsA !== null) return -1;
  if (tsB !== null) return 1;
  return a.name.localeCompare(b.name);
};
