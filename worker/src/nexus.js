/**
 * Nexus V2 GraphQL auto-discovery fetch — server-side port of the
 * pagination loop in assets/js/services.js fetchNexusTaggedMods, minus
 * the merge (that lives in merge.js) and the localStorage cache (KV plays
 * that role, in the B3 cron).
 *
 * The V2 API is technically unsupported (see docs/nexus-api-reference.md);
 * callers must treat failures as "keep last-known-good", never as "empty
 * dataset".
 */

export const NEXUS_GQL_ENDPOINT = 'https://api.nexusmods.com/v2/graphql';
export const NEXUS_GAME_ID = 3333; // Cyberpunk 2077
export const NEXUS_BATCH_SIZE = 50;

const QUERY = `
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

/**
 * Fetch every mod tagged NCZoning for CP2077. Throws on any page failure —
 * a partial node list must never be mistaken for the full tag population
 * (missing mods would be dropped from the map).
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @returns {Promise<Array>} raw GraphQL nodes
 */
export async function fetchTaggedModNodes(fetchImpl = fetch) {
  const nodes = [];
  let offset = 0;
  let totalCount = Infinity;

  while (offset < totalCount) {
    const res = await fetchImpl(NEXUS_GQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          filter: {
            gameId: [{ value: String(NEXUS_GAME_ID) }],
            tag: [{ value: 'NCZoning' }],
          },
          count: NEXUS_BATCH_SIZE,
          offset,
        },
      }),
    });
    if (!res.ok) throw new Error(`Nexus GraphQL HTTP ${res.status}`);

    const json = await res.json();
    const page = json?.data?.mods;
    if (!page) {
      throw new Error(
        `Nexus GraphQL: no mods page in response${json?.errors ? ` (${JSON.stringify(json.errors).slice(0, 200)})` : ''}`,
      );
    }

    totalCount = page.totalCount ?? 0;
    const pageNodes = page.nodes || [];
    if (pageNodes.length === 0) break;
    nodes.push(...pageNodes);
    offset += pageNodes.length;
    if (pageNodes.length < NEXUS_BATCH_SIZE) break; // last page
  }

  return nodes;
}

/**
 * Composite UID Nexus expects for modsByUid: (gameId << 32) + modId, as a
 * single decimal string — NOT "gameId:modId". Must match the site's
 * NCZ.toNexusUid (assets/js/utils.js) exactly, or Nexus silently drops the
 * UIDs and returns no images.
 */
function toNexusUid(modId) {
  return ((BigInt(NEXUS_GAME_ID) << 32n) + BigInt(modId)).toString();
}

const THUMBS_QUERY = `query modsByUid($uids: [ID!]!, $count: Int!) {
  modsByUid(uids: $uids, count: $count) {
    nodes {
      modId
      pictureUrl
      thumbnailUrl
      updatedAt
    }
  }
}`;

/**
 * Fetch picture/thumbnail/updatedAt for a set of numeric mod ids via
 * modsByUid. Unlike fetchTaggedModNodes, this NEVER throws: thumbnails are
 * cosmetic, so a Nexus hiccup here degrades to "some images missing this
 * cycle", not "whole dataset stale". Auto-discovered mods already carry their
 * images from the tagged query; this covers the manual entries.
 *
 * Mirrors the site's chunk + single-retry pattern (large modsByUid calls
 * silently drop a subset of nodes), see assets/js/services.js.
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string[]} numericIds manual mods' numeric nexus_ids
 * @returns {Promise<Object<string, {pictureUrl, thumbnailUrl, updatedAt}>>}
 */
export async function fetchModsByUidThumbs(fetchImpl = fetch, numericIds = []) {
  const ids = [...new Set(numericIds.map(String))].filter((id) => /^\d+$/.test(id));
  if (ids.length === 0) return {};

  const postChunk = async (chunkIds) => {
    try {
      const res = await fetchImpl(NEXUS_GQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: THUMBS_QUERY,
          variables: { uids: chunkIds.map(toNexusUid), count: chunkIds.length },
        }),
      });
      if (!res.ok) return {};
      const json = await res.json();
      const nodes = json?.data?.modsByUid?.nodes || [];
      const map = {};
      for (const node of nodes) {
        map[String(node.modId)] = {
          pictureUrl: node.pictureUrl || null,
          thumbnailUrl: node.thumbnailUrl || null,
          updatedAt: node.updatedAt || null,
        };
      }
      return map;
    } catch {
      return {}; // cosmetic — swallow and let the caller serve what it has
    }
  };

  const fetchChunk = async (chunkIds) => {
    const first = await postChunk(chunkIds);
    const missing = chunkIds.filter((id) => !first[id]);
    if (missing.length === 0) return first;
    const retry = await postChunk(missing); // one in-flight retry for dropped UIDs
    return { ...first, ...retry };
  };

  const chunks = [];
  for (let i = 0; i < ids.length; i += NEXUS_BATCH_SIZE) {
    chunks.push(ids.slice(i, i + NEXUS_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(fetchChunk));
  return Object.assign({}, ...results);
}
