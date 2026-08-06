import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTaggedModNodes, fetchModsByUidThumbs, fetchModArchiveNames,
  NEXUS_BATCH_SIZE, NEXUS_GAME_ID,
} from '../src/nexus.js';

function fakeFetch(pages) {
  let call = 0;
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.variables.offset);
    const page = pages[call++];
    if (page instanceof Error) throw page;
    return {
      ok: page.ok ?? true,
      status: page.status ?? 200,
      json: async () => page.json,
    };
  };
  impl.calls = calls;
  return impl;
}

const node = (i) => ({ modId: i, name: `Mod ${i}` });

test('paginates until the short page', async () => {
  const first = Array.from({ length: NEXUS_BATCH_SIZE }, (_, i) => node(i));
  const second = Array.from({ length: 10 }, (_, i) => node(100 + i));
  const impl = fakeFetch([
    { json: { data: { mods: { nodes: first, totalCount: 60 } } } },
    { json: { data: { mods: { nodes: second, totalCount: 60 } } } },
  ]);
  const nodes = await fetchTaggedModNodes(impl);
  assert.equal(nodes.length, 60);
  assert.deepEqual(impl.calls, [0, NEXUS_BATCH_SIZE]);
});

test('HTTP error throws (partial results must not look complete)', async () => {
  const impl = fakeFetch([{ ok: false, status: 503, json: {} }]);
  await assert.rejects(() => fetchTaggedModNodes(impl), /HTTP 503/);
});

test('missing mods page throws with error detail', async () => {
  const impl = fakeFetch([{ json: { errors: [{ message: 'boom' }] } }]);
  await assert.rejects(() => fetchTaggedModNodes(impl), /no mods page/);
});

test('second-page failure throws rather than returning half the tag population', async () => {
  const first = Array.from({ length: NEXUS_BATCH_SIZE }, (_, i) => node(i));
  const impl = fakeFetch([
    { json: { data: { mods: { nodes: first, totalCount: 60 } } } },
    { ok: false, status: 500, json: {} },
  ]);
  await assert.rejects(() => fetchTaggedModNodes(impl), /HTTP 500/);
});

// ── fetchModsByUidThumbs (manual-mod image backfill) ────────────────────────

// Queue of responses; Error entries throw (simulate a network failure).
function uidFetch(responses) {
  let call = 0;
  return async () => {
    const r = responses[call++];
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json };
  };
}
const uidNode = (i) => ({
  modId: i, name: `n${i}`, status: 'published',
  pictureUrl: `p${i}`, thumbnailUrl: `t${i}`, updatedAt: `u${i}`,
});

test('modsByUid: returns a thumb map keyed by modId', async () => {
  const impl = uidFetch([{ json: { data: { modsByUid: { nodes: [uidNode(1), uidNode(2)] } } } }]);
  const map = await fetchModsByUidThumbs(impl, ['1', '2']);
  assert.deepEqual(map['1'], { name: 'n1', status: 'published', pictureUrl: 'p1', thumbnailUrl: 't1', updatedAt: 'u1' });
  assert.deepEqual(map['2'], { name: 'n2', status: 'published', pictureUrl: 'p2', thumbnailUrl: 't2', updatedAt: 'u2' });
});

test('modsByUid: a deleted mod is RETURNED, carrying the status that says so', async () => {
  // The premise of #900's detection, and the opposite of what the issue
  // assumed. Measured against the live API: mod 17513 comes back with
  // `wastebinned`. Only the `mods` SEARCH query filters by status.
  const impl = uidFetch([{ json: { data: { modsByUid: { nodes: [
    { modId: 1, name: 'Gone - DELETED', status: 'wastebinned', updatedAt: 'u1' },
  ] } } } }]);
  const map = await fetchModsByUidThumbs(impl, ['1']);
  assert.equal(map['1'].status, 'wastebinned',
    'dropping this field is what made a deleted mod indistinguishable from a live one');
});

test('modsByUid: a node with no status yields null, which reads as published', async () => {
  const impl = uidFetch([{ json: { data: { modsByUid: { nodes: [{ modId: 1, pictureUrl: 'p1' }] } } } }]);
  const map = await fetchModsByUidThumbs(impl, ['1']);
  assert.equal(map['1'].status, null,
    'a pin must never come down because a field went missing from a response');
});

test('modsByUid: a mod with no name yields null rather than dropping the key', async () => {
  // nexus_cache stores this, and `undefined` is not a legal D1 bind. The shape
  // has to stay stable whether or not Nexus supplied a name.
  const impl = uidFetch([{ json: { data: { modsByUid: { nodes: [{ modId: 1, pictureUrl: 'p1' }] } } } }]);
  const map = await fetchModsByUidThumbs(impl, ['1']);
  assert.equal(map['1'].name, null);
});

test('modsByUid: skips non-numeric ids and never fetches for an empty set', async () => {
  let called = false;
  const impl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.deepEqual(await fetchModsByUidThumbs(impl, ['WIP', 'Dummy']), {});
  assert.equal(called, false);
});

test('modsByUid: HTTP error degrades to empty, never throws (images are cosmetic)', async () => {
  const impl = uidFetch([{ ok: false, status: 503, json: {} }, { ok: false, status: 503, json: {} }]);
  assert.deepEqual(await fetchModsByUidThumbs(impl, ['1']), {});
});

test('modsByUid: a thrown fetch degrades to empty, never throws', async () => {
  const impl = uidFetch([new Error('network'), new Error('network')]);
  assert.deepEqual(await fetchModsByUidThumbs(impl, ['1']), {});
});

test('modsByUid: sends the composite (gameId<<32)+modId UID (not "gameId:modId")', async () => {
  // Wire-contract guard: Nexus silently drops UIDs in the wrong format and
  // returns no images, a bug the shape-only tests above can't catch.
  let sentUids = null;
  const impl = async (url, init) => {
    sentUids = JSON.parse(init.body).variables.uids;
    return { ok: true, json: async () => ({ data: { modsByUid: { nodes: [uidNode(28630)] } } }) };
  };
  await fetchModsByUidThumbs(impl, ['28630']);
  const expected = ((BigInt(NEXUS_GAME_ID) << 32n) + 28630n).toString();
  assert.deepEqual(sentUids, [expected]);
});

test('modsByUid: retries UIDs the first call silently dropped', async () => {
  const impl = uidFetch([
    { json: { data: { modsByUid: { nodes: [uidNode(1)] } } } }, // drops 2
    { json: { data: { modsByUid: { nodes: [uidNode(2)] } } } }, // retry fills 2
  ]);
  const map = await fetchModsByUidThumbs(impl, ['1', '2']);
  assert.ok(map['1'] && map['2'], 'both UIDs present after the retry');
});

// ── fetchModArchiveNames (installed-mod detection) ──────────────────────────

// A file-contents preview tree with the given .archive/other file names under
// archive/pc/mod/, the real nesting confirmed against a live file-metadata
// response (archive → pc → mod → files).
const tree = (...names) => ({
  children: [{ name: 'archive', type: 'directory', children: [
    { name: 'pc', type: 'directory', children: [
      { name: 'mod', type: 'directory', children: names.map((n) => ({
        name: n, type: 'file', path: `archive/pc/mod/${n}`, size: '1 kB',
      })) },
    ] },
  ] }],
});

// A new-scheme manifest: the flat file_path array the file-manifests host
// returns (confirmed live). One entry per file, name under archive/pc/mod/.
const manifest = (...names) => names.map((n) => ({
  file_path: `archive/pc/mod/${n}`, file_size: 1, file_hashes: {},
}));

// Routes the three hosts by URL. `trees` maps a friendly uri → its file-metadata
// tree; `manifests` maps a UUID uri → its file-manifests array. Either value can
// be { ok:false }/Error to simulate failure.
function archiveFetch({ modFiles = [], trees = {}, manifests = {}, routerOk = true } = {}) {
  return async (url, init) => {
    if (url.includes('api-router.nexusmods.com')) {
      if (!routerOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: { modFiles } }) };
    }
    if (url.includes('file-manifests.nexusmods.com')) {
      const uri = decodeURIComponent(
        url.replace('https://file-manifests.nexusmods.com/', '').replace(/\.json$/, ''),
      );
      const m = manifests[uri];
      if (m instanceof Error) throw m;
      if (m && m.ok === false) return { ok: false, status: m.status ?? 404, json: async () => ({}) };
      return { ok: true, json: async () => m ?? [] };
    }
    if (url.includes('file-metadata.nexusmods.com')) {
      const uri = decodeURIComponent(url.match(/\/[^/]+\/([^/]+)\.json$/)[1]);
      const t = trees[uri];
      if (t instanceof Error) throw t;
      if (t && t.ok === false) return { ok: false, status: t.status ?? 404, json: async () => ({}) };
      return { ok: true, json: async () => t ?? { children: [] } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('archives: unions .archive names across current files, deduped + sorted', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Main-1.7z', category: 'MAIN' }, { uri: 'Optional-2.7z', category: 'OPTIONAL' }],
    trees: {
      'Main-1.7z': tree('b.archive', 'a.archive', 'shared.archive'),
      'Optional-2.7z': tree('shared.archive', 'c.archive'),
    },
  });
  const res = await fetchModArchiveNames(impl, 27618);
  assert.deepEqual(res.archives, ['a.archive', 'b.archive', 'c.archive', 'shared.archive']);
  assert.equal(res.ok, true);
  assert.equal(res.subrequests, 3); // 1 modFiles + 2 files
});

test('archives: fetches UUID-path files from the file-manifests host (flat manifest)', async () => {
  // New-scheme files (uri is a UUID storage path) have a flat manifest at the
  // file-manifests host: the .archive basename comes from file_path.
  const impl = archiveFetch({
    modFiles: [{ uri: 'ab/cd/ef/uuid-1', category: 'MAIN' }],
    manifests: { 'ab/cd/ef/uuid-1': manifest('New.archive', 'thing.xl') },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res.archives, ['New.archive', 'thing.xl']); // basenames; .xl included
  assert.equal(res.ok, true);
});

test('archives: unions across both hosts (friendly tree + UUID manifest)', async () => {
  const impl = archiveFetch({
    modFiles: [
      { uri: 'Main-1.7z', category: 'MAIN' },
      { uri: 'x/y/z/uuid-opt', category: 'OPTIONAL' },
    ],
    trees: { 'Main-1.7z': tree('a.archive') },
    manifests: { 'x/y/z/uuid-opt': manifest('b.archive') },
  });
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['a.archive', 'b.archive']);
});

test('archives: routes uri by shape (UUID→file-manifests, friendly→file-metadata)', async () => {
  const urls = [];
  const impl = async (url) => {
    if (url.includes('api-router')) {
      return { ok: true, json: async () => ({ data: { modFiles: [
        { uri: 'Friendly-1.7z', category: 'MAIN' },
        { uri: 'aa/bb/cc/uuid', category: 'OPTIONAL' },
      ] } }) };
    }
    urls.push(url);
    if (url.includes('file-manifests')) return { ok: true, json: async () => manifest('u.archive') };
    return { ok: true, json: async () => tree('f.archive') };
  };
  await fetchModArchiveNames(impl, 27618);
  assert.ok(
    urls.includes('https://file-manifests.nexusmods.com/aa/bb/cc/uuid.json'),
    'UUID uri → file-manifests host, path un-encoded',
  );
  assert.ok(
    urls.includes('https://file-metadata.nexusmods.com/file/nexus-files-s3-meta/3333/27618/Friendly-1.7z.json'),
    'friendly uri → file-metadata host',
  );
});

test('archives: prefers current-category files over older versions', async () => {
  const impl = archiveFetch({
    modFiles: [
      { uri: 'Current-1-0.7z', category: 'MAIN' },
      { uri: 'Old-0-9.zip', category: 'OLD_VERSION' },
    ],
    trees: { 'Current-1-0.7z': tree('current.archive'), 'Old-0-9.zip': tree('old.archive') },
  });
  // OLD_VERSION is not fetched when a current-category file is available.
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['current.archive']);
});

test('archives: falls back to older files when no current-category file exists', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'gg/hh/ii/uuid-old', category: 'OLD_VERSION' }],
    manifests: { 'gg/hh/ii/uuid-old': manifest('legacy.archive') },
  });
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['legacy.archive']);
});

test('archives: caps contents fetches per mod so one mod cannot exhaust the budget', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ uri: `Opt-${i}.7z`, category: 'OPTIONAL' }));
  const trees = Object.fromEntries(many.map((f, i) => [f.uri, tree(`a${i}.archive`)]));
  const res = await fetchModArchiveNames(archiveFetch({ modFiles: many, trees }), 1);
  assert.ok(res.subrequests <= 7, `subrequests ${res.subrequests} must be capped (1 + <=6)`);
  assert.ok(res.archives.length <= 6);
});

test('archives: collects .archive AND .xl (ArchiveXL), ignores .json/readme', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'M.7z', category: 'MAIN' }],
    trees: { 'M.7z': tree('thing.archive', 'thing.xl', 'appearance.json', 'readme.txt') },
  });
  // .xl lands in archive/pc/mod and is readable in-game; .json (CET/AMM) is not.
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['thing.archive', 'thing.xl']);
});

test('archives: a removal-only mod (ships only .xl) is still detected', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Removal.7z', category: 'MAIN' }],
    trees: { 'Removal.7z': tree('h10_apartment_removal.xl') },
  });
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['h10_apartment_removal.xl']);
});

test('archives: modFiles failure → ok:false, no archives, only the one subrequest', async () => {
  const res = await fetchModArchiveNames(archiveFetch({ routerOk: false }), 1);
  assert.deepEqual(res, {
    archives: [], ok: false, listed: false, subrequests: 1,
  });
});

test('archives: a 404 file has no preview but does NOT poison the mod (ok stays true)', async () => {
  // The starvation bug: a good MAIN + a preview-less (404) sibling must still
  // cache the MAIN's archives, or the mod retries forever and blocks the queue.
  const impl = archiveFetch({
    modFiles: [{ uri: 'Good.7z', category: 'MAIN' }, { uri: 'NoPreview.7z', category: 'OPTIONAL' }],
    trees: { 'Good.7z': tree('good.archive'), 'NoPreview.7z': { ok: false, status: 404 } },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res.archives, ['good.archive']);
  assert.equal(res.ok, true); // 404 is definitive, not a retry-worthy failure
});

test('archives: a transient (5xx) file failure marks ok:false so it retries', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Good.7z', category: 'MAIN' }, { uri: 'Flaky.7z', category: 'MAIN' }],
    trees: { 'Good.7z': tree('good.archive'), 'Flaky.7z': { ok: false, status: 503 } },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res.archives, ['good.archive']);
  assert.equal(res.ok, false); // transient: caller must not cache this as final
});

test('archives: a mod whose only file 404s is ok:true but listed:false', async () => {
  // ok stays true so the mod leaves the queue rather than starving it, and
  // listed:false is what stops the empty array being stored as "ships nothing".
  const impl = archiveFetch({
    modFiles: [{ uri: 'Gone.7z', category: 'MAIN' }],
    trees: { 'Gone.7z': { ok: false, status: 404 } },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res, {
    archives: [], ok: true, listed: false, subrequests: 2,
  });
});

test('archives: a read listing with no .archive in it is listed:true', async () => {
  // An AMM-only mod: the preview loads and genuinely holds no install file.
  // Same empty array as the 404 case above, opposite meaning.
  const impl = archiveFetch({
    modFiles: [{ uri: 'AMM.7z', category: 'MAIN' }],
    trees: { 'AMM.7z': tree('decor.json', 'readme.txt') },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res.archives, []);
  assert.equal(res.listed, true, 'a 200 that holds no .archive is still an answer');
});

test('archives: one readable file makes the mod listed, even beside a 404 sibling', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Good.7z', category: 'MAIN' }, { uri: 'NoPreview.7z', category: 'OPTIONAL' }],
    trees: { 'Good.7z': tree('good.archive'), 'NoPreview.7z': { ok: false, status: 404 } },
  });
  assert.equal((await fetchModArchiveNames(impl, 1)).listed, true);
});

test('archives: a mod with no downloadable files at all is listed:false', async () => {
  // Nothing was read, so nothing is known: the same silence as a 404.
  const res = await fetchModArchiveNames(archiveFetch({ modFiles: [] }), 1);
  assert.deepEqual(res, {
    archives: [], ok: true, listed: false, subrequests: 1,
  });
});

test('archives: a thrown fetch degrades to ok:false, never throws', async () => {
  const impl = async () => { throw new Error('network'); };
  assert.deepEqual(await fetchModArchiveNames(impl, 1), {
    archives: [], ok: false, listed: false, subrequests: 1,
  });
});

test('archives: sends modId/gameId as ID strings and builds the file-metadata URL', async () => {
  // Wire-contract guard (cf. the modsByUid UID lesson): modFiles args are ID!,
  // and the file-metadata path is game/mod/<uri-encoded>.json.
  let sentVars = null;
  let metaUrl = null;
  const impl = async (url, init) => {
    if (url.includes('api-router')) {
      sentVars = JSON.parse(init.body).variables;
      return { ok: true, json: async () => ({ data: { modFiles: [{ uri: 'A B-1.7z', category: 'MAIN' }] } }) };
    }
    metaUrl = url;
    return { ok: true, json: async () => tree('x.archive') };
  };
  await fetchModArchiveNames(impl, 27618);
  assert.deepEqual(sentVars, { modId: '27618', gameId: String(NEXUS_GAME_ID) });
  assert.equal(
    metaUrl,
    'https://file-metadata.nexusmods.com/file/nexus-files-s3-meta/3333/27618/A%20B-1.7z.json',
  );
});
