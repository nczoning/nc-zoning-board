/**
 * Nexus V2 GraphQL auto-discovery fetch: server-side port of the
 * pagination loop in assets/js/services.js fetchNexusTaggedMods, minus
 * the merge (that lives in merge.js) and the localStorage cache (KV plays
 * that role, in the B3 cron).
 *
 * The V2 API is technically unsupported (see docs/nexus-api-reference.md);
 * callers must treat failures as "keep last-known-good", never as "empty
 * dataset".
 */

export const NEXUS_GQL_ENDPOINT = 'https://api.nexusmods.com/v2/graphql';
// Newer public router endpoint that exposes modFiles (the V2 endpoint above
// does not). Both are unauthenticated; see docs/nexus-api-reference.md.
export const NEXUS_ROUTER_ENDPOINT = 'https://api-router.nexusmods.com/graphql';
// S3-backed file-contents preview: the tree Nexus shows under "Preview file
// contents" on a mod's Files tab. Keyed by game/mod/<uri>.json.
export const FILE_METADATA_BASE = 'https://file-metadata.nexusmods.com/file/nexus-files-s3-meta';
export const NEXUS_GAME_ID = 3333; // Cyberpunk 2077
export const NEXUS_BATCH_SIZE = 50;
const ARCHIVE_UA = 'nczoning-data-api (+https://nczoning.net)';

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
 * Fetch every mod tagged NCZoning for CP2077. Throws on any page failure:
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
 * single decimal string, NOT "gameId:modId". Must match the site's
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
      return {}; // cosmetic: swallow and let the caller serve what it has
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

// ── Archive names (installed-mod detection) ─────────────────────────────────
// Publishes each mod's shipped `.archive` file names so an in-game consumer can
// match them against the player's archive/pc/mod/ folder ("you have these
// location mods installed"). Two hops per mod: modFiles → each file's contents
// preview. Everything here is NON-THROWING: archive names are supplementary, so
// a Nexus hiccup returns { ok:false } and the caller keeps last-known-good, it
// never marks the whole dataset stale.

const MOD_FILES_QUERY = `query ModFiles($modId: ID!, $gameId: ID!) {
  modFiles(modId: $modId, gameId: $gameId) {
    uri
  }
}`;

/**
 * Recursively collect `.archive` file names from a file-contents preview tree.
 * Nodes look like { name, type: 'directory'|'file', children: [...] }; the root
 * is { children: [...] }. Tolerant of shape drift: it only cares about `name`,
 * `type`, and `children`, walking whatever nesting Nexus returns.
 */
function collectArchiveNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectArchiveNames(child, out);
    return;
  }
  if (node.type === 'file' && typeof node.name === 'string' && node.name.toLowerCase().endsWith('.archive')) {
    out.add(node.name);
  }
  if (Array.isArray(node.children)) collectArchiveNames(node.children, out);
}

/**
 * List every downloadable file's `uri` for a mod via the api-router modFiles
 * query. Returns { uris, ok }: ok is false on any HTTP/GraphQL/parse failure, so
 * the caller can distinguish "genuinely no files" (ok:true, uris:[]) from "we
 * couldn't tell" (ok:false) and avoid caching a transient failure as truth.
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @returns {Promise<{uris: string[], ok: boolean}>}
 */
export async function fetchModFileUris(fetchImpl, modId) {
  try {
    const res = await fetchImpl(NEXUS_ROUTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: MOD_FILES_QUERY,
        variables: { modId: String(modId), gameId: String(NEXUS_GAME_ID) },
      }),
    });
    if (!res.ok) return { uris: [], ok: false };
    const json = await res.json();
    const files = json?.data?.modFiles;
    if (!Array.isArray(files)) return { uris: [], ok: false };
    return {
      uris: files.map((f) => f?.uri).filter((u) => typeof u === 'string' && u.length > 0),
      ok: true,
    };
  } catch {
    return { uris: [], ok: false };
  }
}

/**
 * Fetch one downloadable file's contents preview and return its `.archive` file
 * names. Returns { names, ok }; ok is false on any failure (see fetchModFileUris
 * for why the caller needs the distinction).
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @param {string} uri the download file's uri (from modFiles)
 * @returns {Promise<{names: string[], ok: boolean}>}
 */
export async function fetchArchiveNamesForFile(fetchImpl, modId, uri) {
  try {
    const url = `${FILE_METADATA_BASE}/${NEXUS_GAME_ID}/${modId}/${encodeURIComponent(uri)}.json`;
    const res = await fetchImpl(url, { headers: { 'User-Agent': ARCHIVE_UA } });
    if (!res.ok) return { names: [], ok: false };
    const json = await res.json();
    const names = new Set();
    collectArchiveNames(json, names);
    return { names: [...names], ok: true };
  } catch {
    return { names: [], ok: false };
  }
}

/**
 * All `.archive` file names a mod ships, unioned across every downloadable file
 * (main + optional variants), deduped and sorted. Cost is 1 modFiles call + 1
 * file-contents call per file — the caller budgets how many mods it refreshes
 * per cron run to stay under the Worker subrequest cap.
 *
 * `ok` is true only if the modFiles call AND every file-contents call succeeded,
 * so the caller never caches a partial listing produced by a transient failure
 * as if it were complete. `subrequests` is the number of network calls made, for
 * budgeting.
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @returns {Promise<{archives: string[], ok: boolean, subrequests: number}>}
 */
export async function fetchModArchiveNames(fetchImpl, modId) {
  const filesRes = await fetchModFileUris(fetchImpl, modId);
  let ok = filesRes.ok;
  let subrequests = 1; // the modFiles call itself
  const all = new Set();
  for (const uri of filesRes.uris) {
    const r = await fetchArchiveNamesForFile(fetchImpl, modId, uri);
    subrequests += 1;
    if (!r.ok) ok = false;
    for (const name of r.names) all.add(name);
  }
  return { archives: [...all].sort(), ok, subrequests };
}
