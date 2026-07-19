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
const uidNode = (i) => ({ modId: i, pictureUrl: `p${i}`, thumbnailUrl: `t${i}`, updatedAt: `u${i}` });

test('modsByUid: returns a thumb map keyed by modId', async () => {
  const impl = uidFetch([{ json: { data: { modsByUid: { nodes: [uidNode(1), uidNode(2)] } } } }]);
  const map = await fetchModsByUidThumbs(impl, ['1', '2']);
  assert.deepEqual(map['1'], { pictureUrl: 'p1', thumbnailUrl: 't1', updatedAt: 'u1' });
  assert.deepEqual(map['2'], { pictureUrl: 'p2', thumbnailUrl: 't2', updatedAt: 'u2' });
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
// archive/pc/mod/ — the real nesting confirmed against a live file-metadata
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

// Routes api-router (modFiles) and file-metadata (contents) by host. `trees`
// maps a file uri → its contents tree, or { ok:false }/Error to simulate failure.
function archiveFetch({ modFiles = [], trees = {}, routerOk = true } = {}) {
  return async (url, init) => {
    if (url.includes('api-router.nexusmods.com')) {
      if (!routerOk) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => ({ data: { modFiles } }) };
    }
    if (url.includes('file-metadata.nexusmods.com')) {
      const uri = decodeURIComponent(url.match(/\/[^/]+\/([^/]+)\.json$/)[1]);
      const t = trees[uri];
      if (t instanceof Error) throw t;
      if (t && t.ok === false) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => t ?? { children: [] } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('archives: unions .archive names across files, deduped + sorted', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Main-1.7z' }, { uri: 'Optional-2.7z' }],
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

test('archives: ignores non-.archive files (e.g. .xl, readme)', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'M.7z' }],
    trees: { 'M.7z': tree('thing.archive', 'thing.xl', 'readme.txt') },
  });
  assert.deepEqual((await fetchModArchiveNames(impl, 1)).archives, ['thing.archive']);
});

test('archives: modFiles failure → ok:false, no archives, only the one subrequest', async () => {
  const res = await fetchModArchiveNames(archiveFetch({ routerOk: false }), 1);
  assert.deepEqual(res, { archives: [], ok: false, subrequests: 1 });
});

test('archives: a file-contents failure marks ok:false but keeps what it found', async () => {
  const impl = archiveFetch({
    modFiles: [{ uri: 'Good.7z' }, { uri: 'Bad.7z' }],
    trees: { 'Good.7z': tree('good.archive'), 'Bad.7z': { ok: false } },
  });
  const res = await fetchModArchiveNames(impl, 1);
  assert.deepEqual(res.archives, ['good.archive']);
  assert.equal(res.ok, false); // partial: caller must not cache this as final
});

test('archives: a thrown fetch degrades to ok:false, never throws', async () => {
  const impl = async () => { throw new Error('network'); };
  assert.deepEqual(await fetchModArchiveNames(impl, 1), { archives: [], ok: false, subrequests: 1 });
});

test('archives: sends modId/gameId as ID strings and builds the file-metadata URL', async () => {
  // Wire-contract guard (cf. the modsByUid UID lesson): modFiles args are ID!,
  // and the file-metadata path is game/mod/<uri-encoded>.json.
  let sentVars = null;
  let metaUrl = null;
  const impl = async (url, init) => {
    if (url.includes('api-router')) {
      sentVars = JSON.parse(init.body).variables;
      return { ok: true, json: async () => ({ data: { modFiles: [{ uri: 'A B-1.7z' }] } }) };
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
