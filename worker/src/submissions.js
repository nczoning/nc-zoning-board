/**
 * The submission queue: the first PUBLIC WRITE route on this API.
 *
 * Every other write path is a pull request or an authenticated collaborator
 * using the dashboard. `POST /submissions` is neither, so three checks that sit
 * elsewhere for them belong here:
 *
 * - **Validation is server-side or it does not exist.** The submit form's rules
 *   sit in the layer the submitter controls. validateLocationInput is shared
 *   with the admin editor, so a submission cannot express something the editor
 *   would refuse.
 * - **Admin-only fields are refused, not ignored.** `status`, `admin_notes` and
 *   `source` are writable by an admin and are part of the same validator, so a
 *   payload carrying `status: 'published'` has to be rejected here. Dropping
 *   them silently would leave an approve path applying a field the submitter
 *   chose.
 * - **Nothing published by this route reaches the map.** A row lands in
 *   `submissions` with status `pending`. Approval is a separate, gated action.
 *
 * ## What is stored about the submitter, and why
 *
 * A salted SHA-256 of the IP, never the IP. The salt is a secret, and **an
 * unset salt fails the request closed**: SHA-256 of an IPv4 address without one
 * has four billion possible inputs and is reversed by enumeration in seconds,
 * so an unsalted hash is a stored IP with extra steps.
 *
 * It exists for the rate limit and for abuse triage, and is purged at
 * RETENTION_DAYS by purgeSubmitterIps(), which the cron calls. See docs/privacy.md.
 *
 * `submitter_contact` is optional, and is for a reviewer to ask a question
 * about the submission. Nothing else reads it.
 */

import { validateLocationInput } from './validate.js';
import { readTagSlugs } from './tag-registry.js';
import { readCandidates } from './nexus-cache.js';
import { writeAudit } from './audit.js';

const KINDS = ['create', 'edit', 'remove'];

/** Fields only an admin may set. Present in validateLocationInput's writable set. */
const ADMIN_ONLY = ['status', 'admin_notes', 'source'];

const NOTE_MAX = 1000;
const CONTACT_MAX = 200;
const REASON_MAX = 1000;

/** Submissions accepted from one address per window. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** How long a submitter's hashed address is kept. */
export const RETENTION_DAYS = 90;

/**
 * CORS for the public write route.
 *
 * Wildcard, and deliberately NOT the credentialed adminCors: submissions are
 * anonymous, no cookie is read, and `Allow-Credentials` with a wildcard origin
 * is rejected by the browser outright. The preflight in index.js has to name
 * this prefix or every POST dies before the handler runs.
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

/** Hex SHA-256 of `salt:value`, via Web Crypto. */
async function saltedHash(salt, value) {
  const bytes = new TextEncoder().encode(`${salt}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a Turnstile token server-side.
 *
 * Returns a reason rather than a boolean, because the modal has to tell a
 * duplicate or expired token (re-render the widget, the submitter did nothing
 * wrong) apart from a refusal. Tokens are single-use and expire after five
 * minutes, so `timeout-or-duplicate` is the common answer for a form left open.
 *
 * A network failure is NOT treated as a pass. A bot check that opens on error
 * is a bot check an attacker can trigger.
 */
export async function verifyTurnstile(env, token, remoteip, fetchImpl = fetch) {
  if (!env.TURNSTILE_SECRET_KEY) return { ok: false, code: 'verification_unavailable' };
  if (typeof token !== 'string' || !token) return { ok: false, code: 'turnstile_missing' };
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip }),
    });
    if (!res.ok) return { ok: false, code: 'verification_unavailable' };
    const body = await res.json();
    if (body?.success) return { ok: true };
    const codes = body?.['error-codes'] ?? [];
    return {
      ok: false,
      code: codes.includes('timeout-or-duplicate') ? 'turnstile_expired' : 'turnstile_failed',
      errors: codes,
    };
  } catch {
    return { ok: false, code: 'verification_unavailable' };
  }
}

/**
 * Submissions from this address inside the window.
 *
 * Counted from the `submissions` table rather than a counter store, so it needs
 * no new table and no KV write per attempt. It counts only what was ACCEPTED:
 * a refused submission writes no row, so a submitter fixing a validation error
 * six times is not locked out for an hour.
 */
async function recentCount(env, ipHash, nowMs) {
  const since = new Date(nowMs - RATE_WINDOW_MS).toISOString();
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submissions WHERE submitter_ip_hash = ? AND created_at >= ?',
  ).bind(ipHash, since).first();
  return row?.n ?? 0;
}

/** The location fields of a payload, with the admin-only ones called out. */
function checkPayload(payload, { tagNames, partial }) {
  const errors = [];
  if (payload === undefined || payload === null) return { errors: ['payload is required'] };
  for (const key of ADMIN_ONLY) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      errors.push(`${key} cannot be set on a submission: it is decided at review`);
    }
  }
  const stripped = { ...payload };
  for (const key of ADMIN_ONLY) delete stripped[key];
  const result = validateLocationInput(stripped, { tagNames, partial });
  return { errors: [...errors, ...result.errors], values: stripped };
}

function checkText(value, { field, max, required = false }) {
  if (value === undefined || value === null) {
    return required ? [`${field} is required`] : [];
  }
  if (typeof value !== 'string') return [`${field} must be a string`];
  if (required && !value.trim()) return [`${field} is required`];
  if (value.length > max) return [`${field} must be at most ${max} characters`];
  return [];
}

/** Does this location exist? An edit or removal of nothing is a mistake, not a queue item. */
async function locationExists(env, id) {
  if (typeof id !== 'string' || !id) return false;
  const row = await env.DB.prepare('SELECT id FROM locations WHERE id = ?').bind(id).first();
  return Boolean(row);
}

/**
 * POST /submissions. 201 with the queued id, or a refusal with a distinct code
 * so the modal can act on it rather than showing one generic error.
 */
async function create(request, env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid_body', detail: 'body must be a JSON object' }, 400);
  }

  const kind = body.kind;
  if (!KINDS.includes(kind)) {
    return json({ error: 'invalid_kind', detail: `kind must be one of: ${KINDS.join(', ')}` }, 400);
  }

  // The salt first: without it nothing about the submitter may be stored, and
  // that is a server misconfiguration rather than a bad request.
  if (!env.SUBMISSION_IP_SALT) {
    return json({ error: 'submissions_unavailable', detail: 'server is missing its hash salt' }, 503);
  }

  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const ipHash = await saltedHash(env.SUBMISSION_IP_SALT, ip);

  // Before validation, so a refusal cannot be used to probe the validator, and
  // before Turnstile, so a flood costs no siteverify calls.
  if (await recentCount(env, ipHash, nowMs) >= RATE_LIMIT) {
    return json({
      error: 'rate_limited',
      detail: `at most ${RATE_LIMIT} submissions per hour`,
    }, 429);
  }

  const turnstile = await verifyTurnstile(env, body.turnstile_token, ip, fetchImpl);
  if (!turnstile.ok) {
    const status = turnstile.code === 'verification_unavailable' ? 503 : 403;
    return json({ error: turnstile.code }, status);
  }

  const errors = [
    ...checkText(body.submitter_note, { field: 'submitter_note', max: NOTE_MAX }),
    ...checkText(body.submitter_contact, { field: 'submitter_contact', max: CONTACT_MAX }),
  ];
  let stored = null;

  if (kind === 'create') {
    const tagNames = await readTagSlugs(env);
    const checked = checkPayload(body.payload, { tagNames, partial: false });
    errors.push(...checked.errors);
    stored = checked.values ?? null;
  } else {
    if (!await locationExists(env, body.location_id)) {
      errors.push('location_id must be an existing location');
    }
    if (kind === 'edit') {
      const tagNames = await readTagSlugs(env);
      const checked = checkPayload(body.payload, { tagNames, partial: true });
      errors.push(...checked.errors);
      if (checked.values && Object.keys(checked.values).length === 0) {
        errors.push('payload must contain at least one changed field');
      }
      stored = checked.values ?? null;
    } else {
      // A removal carries no location fields: there is nothing to apply, and a
      // payload here would be a request the reviewer cannot act on.
      if (body.payload !== undefined && body.payload !== null) {
        errors.push('a removal carries no payload, only a reason');
      }
      errors.push(...checkText(body.reason, { field: 'reason', max: REASON_MAX, required: true }));
      stored = { reason: body.reason };
    }
  }

  if (errors.length) return json({ error: 'invalid_submission', errors }, 400);

  const createdAt = new Date(nowMs).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO submissions
       (kind, location_id, payload, status, submitter_note, submitter_contact,
        submitter_ip_hash, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
  ).bind(
    kind,
    kind === 'create' ? null : body.location_id,
    JSON.stringify(stored ?? {}),
    body.submitter_note ?? null,
    body.submitter_contact ?? null,
    ipHash,
    createdAt,
  ).run();

  const id = result?.meta?.last_row_id ?? null;

  // Audited like any other write. The actor is not a person here, and saying
  // 'anonymous' rather than inventing one keeps the log honest about what is
  // known. The IP hash is deliberately NOT in the audit row: it is retained
  // for 90 days on the submission and the audit log is append-only forever.
  await writeAudit(env, {
    actor: 'anonymous',
    action: `submission.${kind}`,
    target: id === null ? null : String(id),
    after: { kind, location_id: body.location_id ?? null, payload: stored },
  }, nowMs);

  return json({ id, kind, status: 'pending' }, 201);
}

/**
 * GET /submissions/candidates: NCZoning-tagged mods that are neither a location
 * nor dismissed, for the submit form's first step.
 *
 * A `nexus_cache` query, not a live Nexus call: this is a public route, and
 * putting a third-party API on its critical path would make an anonymous
 * request able to trigger one.
 */
async function candidates(env) {
  return json({ candidates: await readCandidates(env) });
}

/**
 * Clear hashed addresses older than the retention window.
 *
 * Applied regardless of the submission's status, which is stricter than
 * "resolved submissions after 90 days": a submission still pending after three
 * months is abandoned, and there is no version of abuse triage that needs its
 * address. The row itself, and the queue, are untouched.
 *
 * An UPDATE matching nothing writes no rows, so this is free on the ordinary
 * tick and needs no gate of its own.
 */
export async function purgeSubmitterIps(env, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - RETENTION_DAYS * 86400000).toISOString();
  const result = await env.DB.prepare(
    'UPDATE submissions SET submitter_ip_hash = NULL WHERE submitter_ip_hash IS NOT NULL AND created_at < ?',
  ).bind(cutoff).run();
  return result?.meta?.changes ?? 0;
}

/**
 * Route `/submissions*`. Returns null for any other path, so index.js can fall
 * through to the read routes.
 */
export async function handleSubmissions(request, env, opts = {}) {
  const url = new URL(request.url);
  if (url.pathname !== '/submissions' && !url.pathname.startsWith('/submissions/')) return null;

  if (url.pathname === '/submissions/candidates') {
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    return candidates(env);
  }

  if (url.pathname === '/submissions') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return create(request, env, opts);
  }

  return json({ error: 'not_found' }, 404);
}
