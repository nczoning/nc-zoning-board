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
NCZ.fetchNexusTaggedMods = async function (existingNexusIds, validTagNames) {
  // Return cached auto-discovery results if still fresh
  const cached = NCZ.cacheGet(NCZ.AUTODISCOVERY_CACHE_KEY, NCZ.AUTODISCOVERY_CACHE_TTL);
  if (cached) {
    // Re-filter against current manual entries (may have changed since cache was written)
    const cachedMods = Array.isArray(cached) ? cached : cached.mods;
    const cachedMeta = Array.isArray(cached) ? {} : (cached.meta || {});
    const filtered = cachedMods.filter((m) => !existingNexusIds.has(m.nexus_id));
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

// Fetch mod registry (mods.json) and tag definitions (tags.json) in parallel.
// Returns { mods: Array, tagsDict: Object }.
NCZ.fetchModData = async function () {
  const [modsRes, tagsRes] = await Promise.all([
    fetch(NCZ.DATA_MODS_PATH),
    fetch(NCZ.DATA_TAGS_PATH),
  ]);
  const mods = await modsRes.json();
  const tagsDict = await tagsRes.json();
  return { mods, tagsDict };
};
