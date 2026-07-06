/**
 * NC Zoning Data API — read-only Worker serving the mod registry to
 * Cyberpunk 2077 mods (and, later, the website itself).
 *
 * Contract rules (frozen, see docs/data-api-plan.md):
 * - Every response uses the envelope
 *   { schema, generated_at, dataset_version, data }.
 * - JSON stays DTO-mappable for the in-game RedData consumer:
 *   no arrays-of-arrays, property names are case-sensitive.
 * - Path-based versioning: additive changes only within /v1/.
 *
 * Data is served from KV (written by the 5-minute cron, see refresh.js).
 * ETag = dataset_version (the content hash): a client sending a matching
 * If-None-Match gets a 304 without the big data read.
 */

import { runRefresh } from './refresh.js';
import { KEYS } from './store.js';
import { docsPage, spec } from './docs.js';

const SCHEMA_VERSION = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match',
};

// Dataset routes are cached for 5 min at the edge/browser, with a 1-hour
// stale-while-revalidate window so a client never blocks on a refresh.
const DATA_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

/** Wrap payload data in the versioned envelope (version/time from meta). */
function envelope(data, meta) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: meta?.generated_at ?? null,
    dataset_version: meta?.dataset_version ?? null,
    data,
  };
}

/** JSON response with CORS + content-type set. */
function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

function notFound() {
  return json(envelope({ error: 'not_found' }, null), { status: 404 });
}

/** Before the first successful cron, KV is empty — say so, don't 404. */
function notReady() {
  return json(envelope({ error: 'not_ready' }, null), {
    status: 503,
    headers: { 'Retry-After': '60' },
  });
}

/**
 * Serve a dataset payload from KV with ETag/304 + cache headers. `build`
 * receives the parsed meta and returns the response `data`, or `undefined`
 * to signal a 404 (e.g. an unknown location id).
 */
async function serveDataset(request, env, build, etagSuffix = '') {
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  if (!meta) return notReady();

  // The ETag is the dataset content hash. Representations that share a hash
  // but differ in body (slim vs ?full=1) must NOT share an ETag, or a client
  // caching one and requesting the other would get a wrong 304. Vary it.
  const etag = `"${meta.dataset_version}${etagSuffix}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ...CORS_HEADERS, ETag: etag, 'Cache-Control': DATA_CACHE },
    });
  }

  const data = await build(env, meta);
  if (data === undefined) return notFound();

  return json(envelope(data, meta), {
    headers: { ETag: etag, 'Cache-Control': DATA_CACHE },
  });
}

const routes = {
  // Human docs (Scalar) + the machine-readable spec.
  'GET /': () => docsPage(),
  'GET /openapi.json': () =>
    json(spec, { headers: { 'Cache-Control': 'public, max-age=300' } }),

  'GET /v1/health': (request, env) =>
    json(envelope({ status: 'ok', version: env.API_VERSION }, null)),

  // Slim by default: the lean list, kept RedData-mappable for the in-game
  // parser. `?full=1` returns the full entries as an array — description/credits
  // + image URLs — in one request. Both current consumers (the website and the
  // in-game NCZoningCore mod) fetch ?full=1; slim stays for any consumer that
  // only needs the minimal shape.
  'GET /v1/locations': (request, env) => {
    const url = new URL(request.url);
    if (url.searchParams.get('full') === '1') {
      return serveDataset(
        request,
        env,
        async (e) => {
          const full = await e.DATASET.get(KEYS.full, 'json');
          return full ? Object.values(full) : undefined;
        },
        '-full',
      );
    }
    return serveDataset(request, env, (e) => e.DATASET.get(KEYS.slim, 'json'));
  },

  'GET /v1/districts': (request, env) =>
    serveDataset(request, env, (e) => e.DATASET.get(KEYS.districts, 'json')),

  'GET /v1/tags': (request, env) =>
    serveDataset(request, env, (e) => e.DATASET.get(KEYS.tags, 'json')),

  'GET /v1/meta': (request, env) =>
    serveDataset(request, env, (e, meta) => ({
      counts: meta.counts,
      discovery_stale: meta.discovery_stale ?? false,
      skipped: meta.skipped ?? [],
    })),
};

/** GET /v1/locations/{id} — full entry, or 404. */
function locationById(request, env, id) {
  return serveDataset(request, env, async (e) => {
    const full = await e.DATASET.get(KEYS.full, 'json');
    return full?.[id]; // undefined → 404
  });
}

export default {
  // 5-minute cron: rebuild the dataset into KV (see refresh.js).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRefresh(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(envelope({ error: 'method_not_allowed' }, null), { status: 405 });
    }

    // Static routes first.
    const handler = routes[`GET ${url.pathname}`];
    if (handler) return handler(request, env);

    // Parametric: /v1/locations/{id}
    const locMatch = url.pathname.match(/^\/v1\/locations\/([^/]+)$/);
    if (locMatch) return locationById(request, env, decodeURIComponent(locMatch[1]));

    return notFound();
  },
};
