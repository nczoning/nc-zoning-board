/**
 * NC Zoning Board — API & Data Services
 * All fetch/network functions. Depends on NCZ constants + utils.
 */

// Batch-fetch mod thumbnails from Nexus V2 GraphQL API (no auth needed for public data)
// NOTE from Nexus Mods (Pickysaurus): The V2 API is technically unsupported, and long-term
// they intend to move back to REST. This implementation might need an update in the future if V2 is retired.
NCZ.fetchNexusThumbnails = async function (nexusIds) {
  const validIds = nexusIds.filter((id) => {
    if (!id) return false;
    const lower = id.toLowerCase();
    if (lower === "wip" || lower === "dummy") return false;
    return /^\d+$/.test(id); // Must be numeric
  });
  if (validIds.length === 0) return {};

  // Return cached thumbnails if still fresh
  const cached = NCZ.cacheGet(NCZ.THUMB_CACHE_KEY, NCZ.THUMB_CACHE_TTL);
  if (cached) {
    // Check if all requested IDs are in the cache — if so, skip the API call
    const missing = validIds.filter((id) => !cached[id]);
    if (missing.length === 0) {
      console.log(`Thumbnails: serving ${validIds.length} from cache`);
      return cached;
    }
    // Only fetch the missing IDs
    console.log(`Thumbnails: ${validIds.length - missing.length} cached, fetching ${missing.length} new`);
    const fetched = await NCZ.fetchNexusThumbnailsFromApi(missing);
    const merged = { ...cached, ...fetched };
    NCZ.cacheSet(NCZ.THUMB_CACHE_KEY, merged);
    return merged;
  }

  const result = await NCZ.fetchNexusThumbnailsFromApi(validIds);
  NCZ.cacheSet(NCZ.THUMB_CACHE_KEY, result);
  return result;
};

NCZ.fetchNexusThumbnailsFromApi = async function (validIds) {
  if (validIds.length === 0) return {};

  // Chunk the request — large modsByUid calls silently return a partial subset
  // of nodes, leaving some pins without thumbnails on first load. Mirrors the
  // pagination already used in fetchNexusTaggedMods.
  const CHUNK = NCZ.NEXUS_BATCH_SIZE;
  const chunks = [];
  for (let i = 0; i < validIds.length; i += CHUNK) {
    chunks.push(validIds.slice(i, i + CHUNK));
  }

  const query = `query modsByUid($uids: [ID!]!, $count: Int!) {
        modsByUid(uids: $uids, count: $count) {
            nodes {
                modId
                pictureUrl
                thumbnailUrl
                updatedAt
            }
        }
    }`;

  const postChunk = async (chunkIds) => {
    const uids = chunkIds.map((id) => NCZ.toNexusUid(id));
    try {
      const res = await fetch(NCZ.NEXUS_GQL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { uids, count: chunkIds.length } }),
      });
      const json = await res.json();
      const nodes = json?.data?.modsByUid?.nodes || [];
      const thumbMap = {};
      nodes.forEach((node) => {
        thumbMap[String(node.modId)] = {
          pictureUrl: node.pictureUrl,
          thumbnailUrl: node.thumbnailUrl,
          updatedAt: node.updatedAt || null,
        };
      });
      return thumbMap;
    } catch (err) {
      console.warn("Failed to fetch Nexus thumbnails chunk:", err);
      return {};
    }
  };

  // Single in-flight retry for UIDs the API silently dropped — covers the
  // residual per-UID flakiness that batching alone doesn't fix. UIDs still
  // missing after the retry are likely deleted/hidden mods on Nexus.
  const fetchChunk = async (chunkIds) => {
    const firstResult = await postChunk(chunkIds);
    const missingIds = chunkIds.filter((id) => !firstResult[id]);
    if (missingIds.length === 0) return firstResult;

    console.warn(
      `Thumbnails: chunk dropped ${missingIds.length}/${chunkIds.length} UIDs (${missingIds.join(", ")}); retrying`
    );
    const retryResult = await postChunk(missingIds);
    const stillMissing = missingIds.filter((id) => !retryResult[id]);
    if (stillMissing.length > 0) {
      console.warn(
        `Thumbnails: ${stillMissing.length} UIDs still missing after retry (${stillMissing.join(", ")}); likely deleted or hidden on Nexus`
      );
    }
    return { ...firstResult, ...retryResult };
  };

  const results = await Promise.all(chunks.map(fetchChunk));
  return Object.assign({}, ...results);
};

// Fetch all mods tagged "NCZoning" from Nexus V2 GraphQL, parse their BBCode blocks,
// and return an array of mod objects ready to merge with the manual mods.json entries.
// ModsFilter schema: https://graphql.nexusmods.com/#definition-ModsFilter
// Fields use [BaseFilterValue] = array of { value: ... } objects.
// "uploader" on the Mod type is a plain string (username), not a nested object.
NCZ.fetchNexusTaggedMods = async function (existingNexusIds, validTagNames, excludedNexusIds) {
  // Mods tagged NCZoning by mistake (or too minor to map) — never rendered,
  // even if their block parses. Optional arg so existing callers/tests don't break.
  const excluded = excludedNexusIds || new Set();
  // Return cached auto-discovery results if still fresh
  const cached = NCZ.cacheGet(NCZ.AUTODISCOVERY_CACHE_KEY, NCZ.AUTODISCOVERY_CACHE_TTL);
  if (cached) {
    // Re-filter against current manual + excluded entries (either may have
    // changed since the cache was written).
    const cachedMods = Array.isArray(cached) ? cached : cached.mods;
    const cachedMeta = Array.isArray(cached) ? {} : (cached.meta || {});
    const filtered = cachedMods.filter(
      (m) => !existingNexusIds.has(m.nexus_id) && !excluded.has(m.nexus_id),
    );
    console.log(`NCZoning: serving ${filtered.length} auto-discovered mods from cache`);
    return { mods: filtered, meta: cachedMeta };
  }

  const query = `
    query NCZoningMods($filter: ModsFilter!, $count: Int!, $offset: Int!) {
      mods(filter: $filter, count: $count, offset: $offset) {
        nodes {
          modId
          name
          summary
          description
          pictureUrl
          thumbnailUrl
          updatedAt
          uploader {
            name
          }
        }
        totalCount
      }
    }
  `;

  const COUNT = NCZ.NEXUS_BATCH_SIZE;
  let offset = 0;
  let totalCount = Infinity;
  const results = [];
  const meta = {}; // Metadata for manually-registered mods also tagged NCZoning

  try {
    while (offset < totalCount) {
      const res = await fetch(NCZ.NEXUS_GQL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            filter: {
              gameId: [{ value: String(NCZ.NEXUS_GAME_ID) }],
              tag: [{ value: "NCZoning" }],
            },
            count: COUNT,
            offset,
          },
        }),
      });
      const json = await res.json();

      if (json.errors) {
        console.warn("NCZoning API errors:", json.errors);
      }

      const page = json?.data?.mods;
      if (!page) {
        console.warn("NCZoning auto-discovery: no mods page in response", json);
        break;
      }

      totalCount = page.totalCount ?? 0;
      const nodes = page.nodes || [];
      console.log(`NCZoning: fetched ${nodes.length} mods (offset ${offset}, total ${totalCount})`);
      if (nodes.length === 0) break;

      for (const node of nodes) {
        const nexusId = String(node.modId);
        if (excluded.has(nexusId)) {
          // Intentionally off the map — skip without creating a meta entry.
          console.log(`NCZoning: excluding mod ${nexusId} (${node.name}) — on the exclusion list`);
          continue;
        }
        if (existingNexusIds.has(nexusId)) {
          // Manual entry wins for mod data, but preserve API metadata for backfilling _updatedAt
          meta[nexusId] = {
            pictureUrl: node.pictureUrl || null,
            thumbnailUrl: node.thumbnailUrl || null,
            updatedAt: node.updatedAt || null,
          };
          continue;
        }

        const parsed = NCZ.parseNcZoningBlock(node.description, validTagNames);
        if (!parsed) {
          console.log(`NCZoning: skipping mod ${nexusId} (${node.name}) — no valid [NCZoning] block found. Description preview:`, (node.description || "").slice(0, 300));
          continue;
        }

        const uploaderName = node.uploader?.name || "Unknown";
        const allAuthors = [uploaderName, ...parsed.additionalAuthors];

        const summary = node.summary || "";
        const description =
          summary.length > NCZ.DESCRIPTION_MAX_LENGTH ? summary.slice(0, NCZ.DESCRIPTION_MAX_LENGTH - 3) + "..." : summary;

        results.push({
          id: `nexus-auto-${nexusId}`,
          name: node.name || "Unknown Mod",
          authors: allAuthors,
          ...(parsed.credits ? { credits: parsed.credits } : {}),
          coordinates: parsed.coordinates,
          ...(parsed.yaw !== null ? { yaw: parsed.yaw } : {}),
          nexus_id: nexusId,
          description,
          category: parsed.category,
          tags: ["nczoning", ...parsed.tags],
          _source: "nexus-auto",
          _thumbnailUrl: node.thumbnailUrl || null,
          _pictureUrl: node.pictureUrl || null,
          _updatedAt: node.updatedAt || null,
        });
      }

      offset += nodes.length;
      if (nodes.length < COUNT) break; // last page
    }
  } catch (err) {
    console.warn("NCZoning auto-discovery failed:", err);
  }

  console.log(`NCZoning: auto-discovery complete — ${results.length} mods added`);
  NCZ.cacheSet(NCZ.AUTODISCOVERY_CACHE_KEY, { mods: results, meta });
  return { mods: results, meta };
};

// Fetch mod registry (mods.json), tag definitions (tags.json), and the
// auto-discovery exclusion list (excluded_mods.json) in parallel.
// Returns { mods: Array, tagsDict: Object, excludedIds: Set<string> }.
NCZ.fetchModData = async function () {
  const [modsRes, tagsRes, excludedRes] = await Promise.all([
    fetch(NCZ.DATA_MODS_PATH),
    fetch(NCZ.DATA_TAGS_PATH),
    fetch(NCZ.DATA_EXCLUDED_PATH),
  ]);
  const mods = await modsRes.json();
  const tagsDict = await tagsRes.json();
  // Flat { "nexusId": "reason" } object; a missing/broken file must not break
  // the page, so fall back to an empty exclusion set.
  let excludedIds = new Set();
  try {
    excludedIds = new Set(Object.keys(await excludedRes.json()).map(String));
  } catch (err) {
    console.warn("NCZoning: could not load exclusion list, proceeding with none", err);
  }
  return { mods, tagsDict, excludedIds };
};

// ── Data API (B7) ────────────────────────────────────────────────────────────

// Primary data path: fetch the whole registry from the server-built Data API
// (/v1/locations?full=1). This replaces the client-side manual + Nexus
// auto-discovery merge — the server already does that merge (plus district
// enrichment and, since B7, manual-mod thumbnails), so the browser makes ZERO
// Nexus calls here. Uses If-None-Match/304 against a localStorage-cached body.
//
// Returns { mods, nexusThumbs } in the same shapes the rest of app.js expects.
// THROWS on any failure (network, non-2xx, malformed) so the caller can fall
// back to the legacy client-side path — never a silent empty map.
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

  // Guard against a slim payload (an API that doesn't honour ?full=1 — e.g. an
  // older deploy still on the endpoint). Full entries always carry a
  // `description` key; if it's missing the popups/cluster list would render
  // empty, so treat it as unusable and let the caller fall back rather than
  // ship a degraded map. (Zero locations is a valid dataset — don't trip on it.)
  // Runs before caching so a rejected slim body is never stored.
  if (rawLocations.length > 0 && !("description" in rawLocations[0])) {
    throw new Error("Data API: slim payload (full=1 not honoured) — falling back");
  }

  if (freshEtag !== null) {
    try {
      localStorage.setItem(NCZ.API_LOCATIONS_CACHE_KEY, JSON.stringify({ etag: freshEtag, data: rawLocations, recentlyUpdatedDays }));
    } catch {
      /* localStorage quota — fine, we just won't get a 304 next load */
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

// Legacy client-side data path (pre-B7): load mods.json + tags.json +
// excluded_mods.json, merge Nexus auto-discovery, fetch thumbnails via
// modsByUid, backfill _updatedAt. Retained as the graceful FALLBACK for when
// the Data API is unavailable; a follow-up deletes it once B7 parity has baked.
// Returns { mods, nexusThumbs, tagsDict } — the same trio the API path yields
// (plus tagsDict, which the API path fetches locally alongside).
NCZ.fetchModDataClientSide = async function () {
  const { mods, tagsDict, excludedIds } = await NCZ.fetchModData();

  const existingNexusIds = new Set(
    mods
      .filter((m) => m.nexus_id && !["WIP", "Dummy"].includes(String(m.nexus_id)))
      .map((m) => String(m.nexus_id)),
  );
  const validTagNames = new Set(Object.keys(tagsDict));
  const { mods: autoMods, meta: autoMeta } = await NCZ.fetchNexusTaggedMods(
    existingNexusIds,
    validTagNames,
    excludedIds,
  );
  mods.push(...autoMods);

  // Pre-seed thumbnails from auto-discovery (already fetched), then only call
  // the API for manual mods that still need images.
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
  // Fill in metadata from auto-discovery for manual mods that are NCZoning-tagged.
  for (const [id, data] of Object.entries(autoMeta)) {
    if (!nexusThumbs[id]) nexusThumbs[id] = data;
  }

  // Backfill _updatedAt for manual Nexus mods before the caller sorts.
  for (const mod of mods) {
    if (!mod._updatedAt) {
      const thumb = nexusThumbs[String(mod.nexus_id)];
      if (thumb?.updatedAt) mod._updatedAt = thumb.updatedAt;
    }
  }

  return { mods, nexusThumbs, tagsDict };
};
