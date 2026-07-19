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
//
// Coverage limitation (measured, not assumed): only files whose modFiles `uri`
// is the friendly filename (e.g. `Atari Canyon AIO-27618-1-0-….7z`) have a
// contents preview at the file-metadata path. Files stored under a UUID path
// (`uri` contains `/`, e.g. `b9/e3/70/b9e3…`) return 404 there regardless of
// slash-encoding — the preview simply isn't published for them. So we fetch
// ONLY friendly-uri files and skip UUID ones (no wasted subrequests, no false
// failures). ~94% of the mod population still yields ≥1 `.archive`; the rest
// resolve to `[]` (unknown), which the API already documents as "not
// determinable", never "ships no archives".

// Download-file categories that represent the mod's *current* files. We prefer
// these; ARCHIVED/OLD_VERSION are superseded and only used as a fallback when a
// mod has no current friendly-uri file (keeps the archive names current and the
// per-mod subrequest count low).
const CURRENT_FILE_CATEGORIES = new Set(['MAIN', 'OPTIONAL', 'UPDATE']);
// Hard cap on file-contents fetches per mod, so one mod with many optional
// variants can't blow the run's subrequest budget on its own.
const ARCHIVE_FILES_PER_MOD = 6;

const MOD_FILES_QUERY = `query ModFiles($modId: ID!, $gameId: ID!) {
  modFiles(modId: $modId, gameId: $gameId) {
    uri
    category
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
 * List a mod's downloadable files (uri + category) via the api-router modFiles
 * query. Returns { files, ok }: ok is false on any HTTP/GraphQL/parse failure,
 * so the caller can distinguish "genuinely no files" (ok:true, files:[]) from
 * "we couldn't tell" (ok:false) and avoid caching a transient failure as truth.
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @returns {Promise<{files: Array<{uri: string, category: string}>, ok: boolean}>}
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
    if (!res.ok) return { files: [], ok: false };
    const json = await res.json();
    const files = json?.data?.modFiles;
    if (!Array.isArray(files)) return { files: [], ok: false };
    return {
      files: files
        .filter((f) => typeof f?.uri === 'string' && f.uri.length > 0)
        .map((f) => ({ uri: f.uri, category: f.category || '' })),
      ok: true,
    };
  } catch {
    return { files: [], ok: false };
  }
}

/**
 * Fetch one downloadable file's contents preview and return its `.archive` file
 * names. Returns { names, ok }; ok is false on any failure (see fetchModFileUris
 * for why the caller needs the distinction). Only call this for friendly-uri
 * files — UUID-path uris have no preview and always 404 (see the section note).
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @param {string} uri the download file's friendly-name uri (from modFiles)
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
 * All `.archive` file names a mod ships, unioned across its previewable files,
 * deduped and sorted. Only friendly-uri files are fetched (UUID-path files have
 * no preview); current-category files (MAIN/OPTIONAL/UPDATE) are preferred, with
 * older friendly files used only as a fallback when a mod has no current one.
 * At most ARCHIVE_FILES_PER_MOD contents fetches, so one mod can't exhaust the
 * caller's per-run subrequest budget.
 *
 * `ok` is true only if the modFiles call AND every attempted contents call
 * succeeded, so the caller never caches a partial listing from a transient
 * failure as if it were complete. `subrequests` is the number of network calls
 * made, for budgeting.
 *
 * @param {typeof fetch} fetchImpl injectable for tests
 * @param {string|number} modId numeric Nexus mod id
 * @returns {Promise<{archives: string[], ok: boolean, subrequests: number}>}
 */
export async function fetchModArchiveNames(fetchImpl, modId) {
  const filesRes = await fetchModFileUris(fetchImpl, modId);
  let ok = filesRes.ok;
  let subrequests = 1; // the modFiles call itself

  // Friendly-uri files only (UUID paths have no derivable preview). Prefer the
  // mod's current files; fall back to any friendly file (older ARCHIVED/
  // OLD_VERSION) when none of the current ones are previewable.
  const friendly = filesRes.files.filter((f) => !f.uri.includes('/'));
  const current = friendly.filter((f) => CURRENT_FILE_CATEGORIES.has(f.category));
  const chosen = (current.length ? current : friendly).slice(0, ARCHIVE_FILES_PER_MOD);

  const all = new Set();
  for (const f of chosen) {
    const r = await fetchArchiveNamesForFile(fetchImpl, modId, f.uri);
    subrequests += 1;
    if (!r.ok) ok = false;
    for (const name of r.names) all.add(name);
  }
  return { archives: [...all].sort(), ok, subrequests };
}
