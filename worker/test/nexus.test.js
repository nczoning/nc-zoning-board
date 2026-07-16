import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTaggedModNodes, fetchModsByUidThumbs, NEXUS_BATCH_SIZE, NEXUS_GAME_ID } from '../src/nexus.js';

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
