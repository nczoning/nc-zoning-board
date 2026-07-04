import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTaggedModNodes, NEXUS_BATCH_SIZE } from '../src/nexus.js';

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
