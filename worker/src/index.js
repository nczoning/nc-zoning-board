/**
 * NC Zoning Data API: read-only Worker serving the mod registry to
 * Cyberpunk 2077 mods (and, later, the website itself).
 *
 * Contract rules (frozen, see docs/api-reference.md):
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
import { RECENTLY_UPDATED_DAYS } from './config.js';

const SCHEMA_VERSION = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match',
};

// Dataset routes are cached for 5 min at the edge/browser, with a 1-hour
// stale-while-revalidate window so a client never blocks on a refresh.
const DATA_CACHE = 'public, max-age=300, stale-while-revalidate=3600';

/**
 * Wrap payload data in the versioned envelope (version/time from meta).
 * recently_updated_days publishes the recency window so clock-having consumers
 * (and the website's tooltip text) read the rule rather than hardcoding it; the
 * clockless in-game consumer instead reads each record's recently_updated bool.
 */
function envelope(data, meta) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: meta?.generated_at ?? null,
    dataset_version: meta?.dataset_version ?? null,
    recently_updated_days: RECENTLY_UPDATED_DAYS,
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

/** Before the first successful cron, KV is empty; say so, don't 404. */
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
async function serveDataset(request, env, build) {
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  if (!meta) return notReady();

  // The ETag is the dataset content hash. There is a single location
  // representation now, so every route derives its ETag from the same hash.
  const etag = `"${meta.dataset_version}"`;
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

  // Liveness + the cron heartbeat. `status` is "ok" whenever the Worker itself
  // answers; `last_refresh_at` (the "when did the cron last RUN" stamp, written
  // every cron cycle — see refresh.js) plus a server-computed `refresh_age_seconds`
  // let the monitor detect a wedged-but-still-serving cron (issue #849) and give
  // the clockless in-game consumer a freshness read too. Both are null before the
  // first cron tick. no-store so the probe always reads origin, never an edge
  // copy; the read is one small KV get.
  'GET /v1/health': async (request, env) => {
    const meta = await env.DATASET.get(KEYS.meta, 'json');
    const lastRefreshAt = meta?.last_refresh_at ?? null;
    const refreshAgeSeconds = lastRefreshAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(lastRefreshAt)) / 1000))
      : null;
    return json(
      envelope(
        {
          status: 'ok',
          version: env.API_VERSION,
          last_refresh_at: lastRefreshAt,
          refresh_age_seconds: refreshAgeSeconds,
        },
        null,
      ),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  },

  // One representation: the full records as an array, every field the DTO
  // consumer needs, RedData-mappable. `?full=1` is accepted as a no-op alias so
  // existing consumers (the website and the in-game NCZoningCore mod, which both
  // request it) keep working; there is no leaner shape to opt out to.
  'GET /v1/locations': (request, env) =>
    serveDataset(request, env, async (e) => {
      const full = await e.DATASET.get(KEYS.full, 'json');
      return full ? Object.values(full) : undefined;
    }),

  'GET /v1/districts': (request, env) =>
    serveDataset(request, env, (e) => e.DATASET.get(KEYS.districts, 'json')),

  'GET /v1/tags': (request, env) =>
    serveDataset(request, env, (e) => e.DATASET.get(KEYS.tags, 'json')),

  // Operational metadata only: health flags the monitors read. No aggregate
  // counts: consumers derive those from the per-location records.
  'GET /v1/meta': (request, env) =>
    serveDataset(request, env, (e, meta) => ({
      discovery_stale: meta.discovery_stale ?? false,
      skipped: meta.skipped ?? [],
    })),
};

/** GET /v1/locations/{id}: full entry, or 404. */
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
