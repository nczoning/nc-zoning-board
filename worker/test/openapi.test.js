import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../src/index.js';

const specPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

// The concrete routes the Worker actually serves (from index.js), normalised
// to the OpenAPI path style ({id} placeholder).
const ROUTER_PATHS = [
  '/v1/health', '/v1/locations', '/v1/locations/{id}',
  '/v1/districts', '/v1/tags', '/v1/meta',
];

test('openapi.json is valid JSON with the expected top-level shape', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.info.title);
  assert.ok(spec.paths && Object.keys(spec.paths).length > 0);
});

test('every served route is documented in the spec (no undocumented routes)', () => {
  for (const p of ROUTER_PATHS) {
    assert.ok(spec.paths[p], `route ${p} is served but missing from openapi.json`);
    assert.ok(spec.paths[p].get, `route ${p} has no GET in openapi.json`);
  }
});

test('every documented v1 path is actually served (no stale spec paths)', () => {
  for (const p of Object.keys(spec.paths)) {
    if (!p.startsWith('/v1/')) continue;
    assert.ok(ROUTER_PATHS.includes(p), `openapi.json documents ${p} but the Worker does not serve it`);
  }
});

test('GET / serves the HTML docs page', async () => {
  const res = await worker.fetch(new Request('https://api.nczoning.net/'), { API_VERSION: '9.9.9-test' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  const body = await res.text();
  assert.match(body, /api-reference/); // Scalar mount point
  assert.match(body, /\/openapi\.json/);
});

test('GET /openapi.json serves the spec', async () => {
  const res = await worker.fetch(new Request('https://api.nczoning.net/openapi.json'), { API_VERSION: '9.9.9-test' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.openapi, '3.1.0');
  assert.deepEqual(Object.keys(body.paths).sort(), Object.keys(spec.paths).sort());
});
