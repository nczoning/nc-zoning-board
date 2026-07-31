/**
 * The machine surface. Routes for callers that are not a browser and not a
 * person: right now that is `monitor_api_health.js`, running in GitHub Actions.
 *
 * ## Why this is not under /admin/
 *
 * `handleAdmin` gates every `/admin/*` route on GitHub collaborator status, and
 * `index.js` states that as an invariant: there is no path through it that
 * reaches a mutation ungated. A GitHub Action has no session and cannot get
 * one, so putting a shared-secret write inside `/admin/*` would mean a reader
 * of that invariant has to know about an exception to it.
 *
 * Keeping the machine surface on its own prefix leaves the invariant literally
 * true and makes the two authentication models visible in the URL. The human
 * half of the alerts feature (reading, acknowledging) stays on `/admin/alerts`
 * behind the session, where it belongs.
 *
 * ## No CORS, deliberately
 *
 * Nothing here is called from a browser, so no `Access-Control-*` headers are
 * emitted and a cross-origin fetch cannot read a response. The secret is not
 * safe in a browser anyway; withholding CORS makes accidentally putting it
 * there fail loudly rather than work.
 */

import { raiseAlert, validateAlertInput } from './alerts.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/**
 * Compare two secrets without leaking their relationship through timing.
 *
 * Both sides are hashed first so the comparison always runs over 32 equal
 * bytes: a raw byte-by-byte compare of the strings would return early on the
 * first mismatch AND leak the expected length. `crypto.subtle.timingSafeEqual`
 * is not used directly because it throws on a length mismatch, which is itself
 * the signal being hidden.
 */
async function secretsMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (!presented || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i += 1) diff |= av[i] ^ bv[i];
  return diff === 0;
}

/**
 * Gate. Returns null when the caller is authorised, or the Response to send.
 *
 * A missing `ALERTS_INGEST_SECRET` is 503, not 403: the endpoint is
 * misconfigured rather than the caller being wrong, and an unset secret must
 * never be satisfiable by an unset header.
 */
async function requireSharedSecret(request, env) {
  if (!env.ALERTS_INGEST_SECRET) {
    return json({ error: 'ingest_unconfigured' }, 503);
  }
  const header = request.headers.get('Authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!(await secretsMatch(presented, env.ALERTS_INGEST_SECRET))) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

/**
 * Route `/internal/*`.
 * @returns {Promise<Response|null>} null when the path is not an internal route.
 */
export async function handleInternal(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/internal/')) return null;

  if (url.pathname === '/internal/alerts') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

    const denied = await requireSharedSecret(request, env);
    if (denied) return denied;

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const check = validateAlertInput(payload);
    if (!check.ok) return json({ error: 'invalid_alert', errors: check.errors }, 400);

    // The result is reported rather than collapsed into 200/500. A caller that
    // gets recorded:true, forwarded:false knows the history is intact and only
    // the Discord hop failed, which is a different operational problem from
    // the alert never landing anywhere.
    const result = await raiseAlert(env, check.alert);
    return json(result, 202);
  }

  return json({ error: 'not_found' }, 404);
}
