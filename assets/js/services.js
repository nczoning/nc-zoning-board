/**
 * NC Zoning Board: API & Data Services
 * All fetch/network functions. Depends on NCZ constants + utils.
 */

// ── Data API (v1) ────────────────────────────────────────────────────────────

// The site's ONLY data path: fetch the whole registry from the server-built
// Data API (/v1/locations). The server owns the manual + Nexus auto-discovery
// merge, district enrichment and thumbnail resolution, so the browser makes
// ZERO Nexus calls. Uses If-None-Match/304 against a localStorage-cached body.
//
// That localStorage layer sits BEHIND the browser's own HTTP cache, and is not
// the thing saving most requests: inside `max-age=300` the browser answers
// without asking the origin, and after it expires the browser revalidates with its own
// ETag. This layer earns its place when the HTTP cache is evicted or cleared:
// localStorage survives that, so a returning tab revalidates instead of
// re-downloading ~250KB. It stored nothing at all until the API began exposing
// `ETag` through CORS.
//
// `?full=1` is gone from this call. It dates from the slim/full split, which
// was removed. The Worker still accepts it as a no-op alias for older
// consumers (in-game mods), but the site passing it only suggested the split
// still exists.
//
// Returns { mods, nexusThumbs, recentlyUpdatedDays } in the shapes the rest of
// app.js expects. THROWS on any failure (network, non-2xx, malformed, slim
// payload). There is deliberately no client-side fallback: the API's primary
// consumer (in-game mods) has none, so the site stays a real canary: a throw
// here surfaces a loud "map data unavailable" state, never a silent empty map.
NCZ.fetchLocationsFromApi = async function () {
  const url = `${NCZ.API_BASE}/v1/locations`;

  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(NCZ.API_LOCATIONS_CACHE_KEY) || "null");
  } catch {
    cached = null;
  }

  const headers = {};
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  // `no-cache` means "always revalidate", NOT "don't cache" (that is
  // `no-store`). The browser still sends its conditional headers and still
  // reuses the cached body on a 304. It just refuses to serve a fresh-by-TTL
  // copy without asking first.
  //
  // Without this, a page load replays whatever the browser cached, for up to
  // max-age. `/v1/locations` is CROSS-ORIGIN (api.nczoning.net vs
  // nczoning.net), and a normal F5 does not force-revalidate cross-origin
  // fetches, so pressing refresh after adding a location can show the
  // pre-change map for five minutes, with no way for the user to tell.
  // Observed exactly that: a reload 50s after a create still rendered a record
  // that had already been deleted.
  //
  // The cost is one conditional request per PAGE LOAD, which is user-initiated
  // and rare. It deliberately does NOT apply to the update poll
  // (NCZ.checkForDatasetUpdate), which stays a plain fetch so the browser can
  // answer it locally, which is what keeps polling nearly free.
  const res = await fetch(url, { headers, cache: "no-cache" });

  let rawLocations;
  let freshEtag = null; // set only on a fresh 200 we should cache
  // The recency window, read straight off the response envelope. Cached with the
  // data so the 304 path keeps it; null when an older API omits it (the caller
  // falls back to NCZ.RECENTLY_UPDATED_DAYS).
  let recentlyUpdatedDays = null;
  // Content hash of the dataset. Cached alongside the body because the 304 path
  // never reads an envelope, and the update poll needs something to compare
  // against on every load, not only on a fresh 200.
  let datasetVersion = null;
  if (res.status === 304 && Array.isArray(cached?.data)) {
    console.log(`Data API: 304 Not Modified, reusing ${cached.data.length} cached locations`);
    rawLocations = cached.data;
    recentlyUpdatedDays = cached.recentlyUpdatedDays ?? null;
    datasetVersion = cached.datasetVersion ?? null;
  } else if (res.ok) {
    const envelope = await res.json();
    rawLocations = envelope?.data;
    if (!Array.isArray(rawLocations)) {
      throw new Error("Data API: malformed payload (envelope.data is not an array)");
    }
    recentlyUpdatedDays = envelope?.recently_updated_days ?? null;
    datasetVersion = envelope?.dataset_version ?? null;
    freshEtag = res.headers.get("ETag");
    console.log(`Data API: loaded ${rawLocations.length} locations (dataset ${String(envelope.dataset_version).slice(0, 8)})`);
  } else {
    throw new Error(`Data API: HTTP ${res.status}`);
  }

  // Sanity-check the payload shape. Records always carry a `description` key;
  // if it's missing the popups and cluster list would render empty, so treat it
  // as unusable and surface the loud error state rather than ship a degraded
  // map. (Zero locations is a valid dataset; don't trip on it.)
  //
  // This outlived the slim/full split it was written for. It now guards
  // against any API that answers this route with something other than full
  // records. Runs before caching so a rejected body is never stored.
  if (rawLocations.length > 0 && !("description" in rawLocations[0])) {
    throw new Error("Data API: payload is missing full record fields");
  }

  if (freshEtag !== null) {
    try {
      localStorage.setItem(NCZ.API_LOCATIONS_CACHE_KEY, JSON.stringify({ etag: freshEtag, data: rawLocations, recentlyUpdatedDays, datasetVersion }));
    } catch {
      /* localStorage quota: fine, we just won't get a 304 next load */
    }
  }

  // Map API entries → the internal shape the rest of the app consumes. The API
  // uses source "manual"/"auto" + snake_case image fields; the app keys off the
  // `_updatedAt` and a `nexusThumbs` lookup.
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
      _updatedAt: e.updated_at || null,
    };
  });

  return { mods, nexusThumbs, recentlyUpdatedDays, datasetVersion };
};

// ── Submissions ──────────────────────────────────────────────────────────────

// NCZoning-tagged Nexus mods that are neither on the map nor dismissed, for the
// submit form's mod picker.
//
// An empty list is a normal answer, not a failure: almost every tagged mod is
// already a location, so the list is short by design and often empty. The
// caller shows the manual path either way. THROWS on a transport or HTTP
// failure, which is a different state again: the picker cannot say whether a
// mod is listed, so it must not imply that it is not.
NCZ.fetchSubmissionCandidates = async function () {
  const res = await fetch(`${NCZ.API_BASE}/submissions/candidates`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Candidates: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.candidates) ? body.candidates : [];
};

// Queue a submission. Resolves for every answer the API gives, including the
// refusals, because they are not all the same thing to a form: an expired
// Turnstile token needs the widget re-rendered, a rate limit is not a
// validation error, and a 503 is the server's problem rather than the
// submitter's.
//
// Returns { ok, status, code, errors, data }. `code` is the API's refusal code
// (turnstile_expired, rate_limited, invalid_submission and friends), or
// "network" when the request never arrived.
NCZ.postSubmission = async function (body) {
  let res;
  try {
    res = await fetch(`${NCZ.API_BASE}/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, code: "network", errors: [], data: null };
  }

  const payload = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, code: null, errors: [], data: payload };

  return {
    ok: false,
    status: res.status,
    code: payload?.error ?? "unknown_error",
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
    data: payload,
  };
};

// ── Passive update check ─────────────────────────────────────────────────────

// Has the served dataset changed since `knownVersion`? Returns the new envelope
// when it has, otherwise null.
//
// A PLAIN fetch, with no conditional header and no cache-buster, on purpose.
// `/v1/locations` is served `public, max-age=300`, so inside that window the
// browser answers this from its own HTTP cache and NO request reaches the
// Worker. Measured: 4 identical plain fetches produced 0 Worker invocations,
// while 4 with `cache: 'no-store'` produced 4.
//
// That is what makes polling affordable: cost is set by the cache TTL, not by
// how often this runs. Polling every 60s and every 300s cost the same ~1 Worker
// request per tab per 5 minutes (~288/day against a 100,000/day cap). Adding a
// cache-buster here would multiply that by the poll rate for no benefit the
// user can perceive.
//
// The flip side, and it is deliberate: detection lags by up to the TTL, so a
// change surfaces within roughly 5-6 minutes rather than instantly.
NCZ.checkForDatasetUpdate = async function (knownVersion) {
  if (!knownVersion) return null; // nothing to compare against; stay quiet
  let res;
  try {
    res = await fetch(`${NCZ.API_BASE}/v1/locations`);
  } catch {
    return null; // offline or blocked: a failed poll is a no-op, never an alarm
  }
  if (!res.ok) return null;

  const envelope = await res.json().catch(() => null);
  const version = envelope?.dataset_version;
  if (!version || version === knownVersion) return null;
  if (!Array.isArray(envelope.data)) return null;
  return envelope;
};
