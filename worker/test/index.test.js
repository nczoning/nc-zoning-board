import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { KEYS } from '../src/store.js';

// In-memory KV seeded with a full dataset (matches what the cron writes).
function fakeKV(entries = {}) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

const META = {
  schema: 1, generated_at: '2026-07-04T00:00:00.000Z', dataset_version: 'abc123',
  counts: { manual: 1, auto: 1, total: 2, per_district: { Watson: 2 } },
  skipped: [], discovery_stale: false,
};
const SLIM = [
  { id: 'm1', name: 'Manual', nexus_id: '1', coordinates: [1, 2, 3], category: 'other', tags: [], authors: ['A'], source: 'manual', district: 'Watson', subdistrict: 'Kabuki' },
  { id: 'nexus-2', name: 'Auto', nexus_id: '2', coordinates: [4, 5, 6], category: 'new-location', tags: ['nczoning'], authors: ['B'], source: 'auto', district: 'Watson', subdistrict: null },
];
const FULL = {
  m1: { ...SLIM[0], description: 'a manual mod' },
  'nexus-2': { ...SLIM[1], description: 'an auto mod' },
};
const DISTRICTS = [{ id: 'watson', name: 'Watson', boundary: [0, 0, 10, 0, 10, 10], centroid: { x: 5, y: 5 }, subdistricts: [] }];
const TAGS = { apartment: 'a place', corpo: 'suits' };

function seededEnv() {
  return {
    API_VERSION: '0.1.0',
    DATASET: fakeKV({
      [KEYS.meta]: META, [KEYS.slim]: SLIM, [KEYS.full]: FULL,
      [KEYS.districts]: DISTRICTS, [KEYS.tags]: TAGS,
    }),
  };
}

const GET = (path, headers) => new Request(`https://api.nczoning.net${path}`, { headers });

test('GET /v1/health returns ok + version, no ETag', async () => {
  const res = await worker.fetch(GET('/v1/health'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), null);
  const body = await res.json();
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.version, '0.1.0');
});

test('GET /v1/locations returns the slim array in an envelope with ETag', async () => {
  const res = await worker.fetch(GET('/v1/locations'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), '"abc123"');
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.equal(body.schema, 1);
  assert.equal(body.dataset_version, 'abc123');
  assert.equal(body.data.length, 2);
  assert.ok(!('description' in body.data[0])); // slim
});

test('GET /v1/locations?full=1 returns full entries as an array, with a -full ETag', async () => {
  const res = await worker.fetch(GET('/v1/locations?full=1'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), '"abc123-full"'); // variant ETag, not the slim one
  const body = await res.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].description, 'a manual mod'); // full carries description
});

test('a slim ETag does not satisfy a ?full=1 request (distinct representations)', async () => {
  const res = await worker.fetch(
    GET('/v1/locations?full=1', { 'If-None-Match': '"abc123"' }), seededEnv());
  assert.equal(res.status, 200); // slim etag ≠ full etag → fresh 200, never a wrong 304
});

test('matching -full ETag yields 304 for ?full=1', async () => {
  const res = await worker.fetch(
    GET('/v1/locations?full=1', { 'If-None-Match': '"abc123-full"' }), seededEnv());
  assert.equal(res.status, 304);
});

test('matching If-None-Match yields 304 with no body', async () => {
  const res = await worker.fetch(GET('/v1/locations', { 'If-None-Match': '"abc123"' }), seededEnv());
  assert.equal(res.status, 304);
  assert.equal(res.headers.get('ETag'), '"abc123"');
  assert.equal(await res.text(), '');
});

test('stale If-None-Match yields a fresh 200', async () => {
  const res = await worker.fetch(GET('/v1/locations', { 'If-None-Match': '"old"' }), seededEnv());
  assert.equal(res.status, 200);
});

test('GET /v1/locations/{id} returns the full entry', async () => {
  const res = await worker.fetch(GET('/v1/locations/nexus-2'), seededEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.description, 'an auto mod');
});

test('GET /v1/locations/{unknown} → 404', async () => {
  const res = await worker.fetch(GET('/v1/locations/nope'), seededEnv());
  assert.equal(res.status, 404);
  assert.equal((await res.json()).data.error, 'not_found');
});

test('GET /v1/districts returns the hierarchy with flat boundaries', async () => {
  const res = await worker.fetch(GET('/v1/districts'), seededEnv());
  const body = await res.json();
  assert.equal(body.data[0].name, 'Watson');
  assert.ok(body.data[0].boundary.every((n) => typeof n === 'number'));
});

test('GET /v1/tags returns the dictionary', async () => {
  const res = await worker.fetch(GET('/v1/tags'), seededEnv());
  assert.deepEqual((await res.json()).data, TAGS);
});

test('GET /v1/meta returns counts + discovery_stale (not the raw record)', async () => {
  const res = await worker.fetch(GET('/v1/meta'), seededEnv());
  const body = await res.json();
  assert.equal(body.data.counts.total, 2);
  assert.equal(body.data.discovery_stale, false);
  assert.ok(!('dataset_version' in body.data)); // version lives on the envelope
});

test('empty KV (pre-first-cron) → 503 not_ready', async () => {
  const env = { API_VERSION: '0.1.0', DATASET: fakeKV() };
  const res = await worker.fetch(GET('/v1/locations'), env);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('Retry-After'), '60');
});

test('OPTIONS preflight → 204 with CORS', async () => {
  const res = await worker.fetch(
    new Request('https://api.nczoning.net/v1/locations', { method: 'OPTIONS' }), seededEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
});

test('POST → 405', async () => {
  const res = await worker.fetch(
    new Request('https://api.nczoning.net/v1/locations', { method: 'POST' }), seededEnv());
  assert.equal(res.status, 405);
});

test('unknown route → 404', async () => {
  const res = await worker.fetch(GET('/v1/nope'), seededEnv());
  assert.equal(res.status, 404);
});
