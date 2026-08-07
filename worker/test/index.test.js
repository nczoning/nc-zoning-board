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
  skipped: [], discovery_stale: false, last_refresh_at: '2026-07-04T00:05:00.000Z',
};
// The single representation: full records keyed by id (what /v1/locations serves
// the values of, and /v1/locations/{id} reads directly). Recency is not among
// the fields: consumers derive it from updated_at and the envelope's window.
const FULL = {
  m1: { id: 'm1', name: 'Manual', nexus_id: '1', coordinates: [1, 2, 3], category: 'other', tags: [], authors: ['A'], district: 'Watson', subdistrict: 'Kabuki', description: 'a manual mod', updated_at: '2026-07-01T00:00:00Z' },
  'nexus-2': { id: 'nexus-2', name: 'Auto', nexus_id: '2', coordinates: [4, 5, 6], category: 'new-location', tags: [], authors: ['B'], district: 'Watson', subdistrict: null, description: 'an auto mod', updated_at: '2026-07-03T00:00:00Z' },
};
const DISTRICTS = [{ id: 'watson', name: 'Watson', boundary: [0, 0, 10, 0, 10, 10], centroid: { x: 5, y: 5 }, subdistricts: [] }];
const TAGS = { apartment: 'a place', corpo: 'suits' };

function seededEnv() {
  return {
    API_VERSION: '9.9.9-test',
    DATASET: fakeKV({
      [KEYS.meta]: META, [KEYS.full]: FULL,
      [KEYS.districts]: DISTRICTS, [KEYS.tags]: TAGS,
    }),
  };
}

const GET = (path, headers) => new Request(`https://api.nczoning.net${path}`, { headers });

test('GET /v1/health returns ok + version + cron heartbeat, uncached, no ETag', async () => {
  const res = await worker.fetch(GET('/v1/health'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), null);
  assert.equal(res.headers.get('Cache-Control'), 'no-store'); // probe always reads origin
  const body = await res.json();
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.version, '9.9.9-test');
  assert.equal(body.data.last_refresh_at, META.last_refresh_at); // liveness heartbeat (#849)
  assert.equal(typeof body.data.refresh_age_seconds, 'number');
  assert.ok(body.data.refresh_age_seconds >= 0);
});

test('GET /v1/health before the first cron: alive, heartbeat null (not 503)', async () => {
  const env = { API_VERSION: '9.9.9-test', DATASET: fakeKV() };
  const res = await worker.fetch(GET('/v1/health'), env);
  assert.equal(res.status, 200); // the Worker itself is up, even with empty KV
  const body = await res.json();
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.last_refresh_at, null);    // cron hasn't run yet
  assert.equal(body.data.refresh_age_seconds, null);
});

test('GET /v1/locations returns the full records, with the recency window on the envelope', async () => {
  const res = await worker.fetch(GET('/v1/locations'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), '"abc123"');
  assert.match(res.headers.get('Cache-Control'), /max-age=300/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const body = await res.json();
  assert.equal(body.schema, 1);
  assert.equal(body.dataset_version, 'abc123');
  assert.equal(body.recently_updated_days, 7); // window published on the envelope
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].description, 'a manual mod');     // single full representation
  // The window is published; the per-record answer is not. Consumers compute it.
  assert.equal('recently_updated' in body.data[0], false);
  assert.equal(body.data[0].updated_at, '2026-07-01T00:00:00Z');
});

test('GET /v1/locations?full=1 is a no-op alias: same body, same ETag', async () => {
  const res = await worker.fetch(GET('/v1/locations?full=1'), seededEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), '"abc123"'); // one representation → one ETag, no -full variant
  const body = await res.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].description, 'a manual mod');
});

test('the base ETag satisfies a ?full=1 request (one representation, shared ETag)', async () => {
  const res = await worker.fetch(
    GET('/v1/locations?full=1', { 'If-None-Match': '"abc123"' }), seededEnv());
  assert.equal(res.status, 304); // same hash, same body → a correct 304
});

test('ETag is exposed to cross-origin JS, or the whole 304 path is dead', async () => {
  // Cross-origin JS can read only a short safelist of response headers unless
  // the server names the rest in Access-Control-Expose-Headers. ETag is not on
  // that list, so without this header `res.headers.get('ETag')` returns null in
  // the browser, so services.js stores no ETag, never sends If-None-Match,
  // and the 304 branch it implements can never execute. The fallback is a
  // perfectly correct 200, so the failure is silent.
  const res = await worker.fetch(GET('/v1/locations'), seededEnv());
  const exposed = (res.headers.get('Access-Control-Expose-Headers') ?? '')
    .split(',').map((s) => s.trim().toLowerCase());
  assert.ok(exposed.includes('etag'),
    `ETag must be exposed for conditional requests to work; saw: ${res.headers.get('Access-Control-Expose-Headers')}`);
  assert.ok(res.headers.get('ETag'), 'and an ETag must actually be sent');
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
  assert.equal(body.data.updated_at, '2026-07-03T00:00:00Z');
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

test('GET /v1/meta returns health flags only, no aggregate counts', async () => {
  const res = await worker.fetch(GET('/v1/meta'), seededEnv());
  const body = await res.json();
  assert.equal(body.data.discovery_stale, false);
  assert.deepEqual(body.data.skipped, []);
  assert.ok(!('counts' in body.data));          // aggregates removed
  assert.ok(!('dataset_version' in body.data));  // version lives on the envelope
});

test('empty KV (pre-first-cron) → 503 not_ready', async () => {
  const env = { API_VERSION: '9.9.9-test', DATASET: fakeKV() };
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
