/**
 * NC Zoning Board: API & Data Services
 * All fetch/network functions. Depends on NCZ constants + utils.
 */

// ── Data API (v1) ────────────────────────────────────────────────────────────

// The site's ONLY data path: fetch the whole registry from the server-built
// Data API (/v1/locations?full=1). The server owns the manual + Nexus
// auto-discovery merge, district enrichment and thumbnail resolution, so the
// browser makes ZERO Nexus calls. Uses If-None-Match/304 against a
// localStorage-cached body.
//
// Returns { mods, nexusThumbs, recentlyUpdatedDays } in the shapes the rest of
// app.js expects. THROWS on any failure (network, non-2xx, malformed, slim
// payload). There is deliberately no client-side fallback: the API's primary
// consumer (in-game mods) has none, so the site stays a real canary — a throw
// here surfaces a loud "map data unavailable" state, never a silent empty map.
NCZ.fetchLocationsFromApi = async function () {
  const url = `${NCZ.API_BASE}/v1/locations?full=1`;

  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(NCZ.API_LOCATIONS_CACHE_KEY) || "null");
  } catch {
    cached = null;
  }

  const headers = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  const res = await fetch(url, { headers });

  let rawLocations;
  let freshEtag = null; // set only on a fresh 200 we should cache
  // The recency window, read straight off the response envelope. Cached with the
  // data so the 304 path keeps it; null when an older API omits it (the caller
  // falls back to NCZ.RECENTLY_UPDATED_DAYS).
  let recentlyUpdatedDays = null;
  if (res.status === 304 && Array.isArray(cached?.data)) {
    console.log(`Data API: 304 Not Modified — reusing ${cached.data.length} cached locations`);
    rawLocations = cached.data;
    recentlyUpdatedDays = cached.recentlyUpdatedDays ?? null;
  } else if (res.ok) {
    const envelope = await res.json();
    rawLocations = envelope?.data;
    if (!Array.isArray(rawLocations)) {
      throw new Error("Data API: malformed payload (envelope.data is not an array)");
    }
    recentlyUpdatedDays = envelope?.recently_updated_days ?? null;
    freshEtag = res.headers.get("ETag");
    console.log(`Data API: loaded ${rawLocations.length} locations (dataset ${String(envelope.dataset_version).slice(0, 8)})`);
  } else {
    throw new Error(`Data API: HTTP ${res.status}`);
  }

  // Guard against a slim payload (an API that doesn't honour ?full=1, e.g. an
  // older deploy still on the endpoint). Full entries always carry a
  // `description` key; if it's missing the popups/cluster list would render
  // empty, so treat it as unusable and surface the error state rather than ship
  // a degraded map. (Zero locations is a valid dataset; don't trip on it.)
  // Runs before caching so a rejected slim body is never stored.
  if (rawLocations.length > 0 && !("description" in rawLocations[0])) {
    throw new Error("Data API: slim payload (full=1 not honoured)");
  }

  if (freshEtag !== null) {
    try {
      localStorage.setItem(NCZ.API_LOCATIONS_CACHE_KEY, JSON.stringify({ etag: freshEtag, data: rawLocations, recentlyUpdatedDays }));
    } catch {
      /* localStorage quota: fine, we just won't get a 304 next load */
    }
  }

  // Map API entries → the internal shape the rest of the app consumes. The API
  // uses source "manual"/"auto" + snake_case image fields; the app keys off the
  // legacy `_source` sentinel, `_updatedAt`, and a `nexusThumbs` lookup.
  const nexusThumbs = {};
  const mods = rawLocations.map((e) => {
    const nid = String(e.nexus_id);
    if (e.thumbnail_url || e.picture_url) {
      nexusThumbs[nid] = {
        thumbnailUrl: e.thumbnail_url || null,
        pictureUrl: e.picture_url || null,
        updatedAt: e.updated_at || null,
      };
    }
    return {
      ...e,
      // Manual mods have no _source (drives the "Suggest Edit" link + no auto
      // badge); auto mods use the "nexus-auto" sentinel the badges key off.
      ...(e.source === "auto" ? { _source: "nexus-auto" } : {}),
      _updatedAt: e.updated_at || null,
    };
  });

  return { mods, nexusThumbs, recentlyUpdatedDays };
};
