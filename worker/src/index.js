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
 */

const SCHEMA_VERSION = 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match',
};

/** Wrap payload data in the versioned response envelope. */
function envelope(data, datasetVersion = null) {
  return {
    schema: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    dataset_version: datasetVersion,
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
  return json(envelope({ error: 'not_found' }), { status: 404 });
}

const routes = {
  '/v1/health': (request, env) =>
    json(envelope({ status: 'ok', version: env.API_VERSION })),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(envelope({ error: 'method_not_allowed' }), { status: 405 });
    }

    const handler = routes[url.pathname];
    return handler ? handler(request, env) : notFound();
  },
};
