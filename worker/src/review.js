/**
 * The review surface: the queue of public submissions, and the candidate mods
 * that have no pin yet.
 *
 * Reached only through handleAdmin, which has already resolved the session and
 * refused anyone who is not a collaborator. There is deliberately no second
 * gate here: two checks in two files is how one of them ends up subtly weaker
 * than the other.
 *
 * ## The resolved statuses, decided here
 *
 * `submissions.status` has no CHECK constraint. It defaults to 'pending' and
 * the rest are a convention this module owns:
 *
 *   pending | approved | rejected | held
 *
 * They are exported so the tests assert against the same strings the routes
 * write, rather than against a second copy that can drift.
 *
 * `held` means parked, pending a decision between reviewers. It does not mean
 * changes were requested of anyone: nothing here delivers a review note. See
 * the note on review notes below.
 *
 * ## Resolving is one-way, and that is a correctness rule
 *
 * Only a PENDING submission can be approved, rejected or held. Without
 * that guard a double-clicked Approve on a `create` inserts the location twice,
 * with two ids, two pins and nothing to say they are the same submission. So
 * the status check is a WHERE clause on the resolving UPDATE and its row count
 * is what the route branches on, not a read-then-write that another request can
 * interleave with.
 *
 * ## Approving a removal hides, it does not delete
 *
 * A `remove` submission is a member of the public saying a pin should not be
 * there. `status = 'hidden'` pulls it off the map and keeps the record, which
 * is exactly what admin.js already says that status is for; DELETE is for
 * records that should never have existed, which is not a call a submitter can
 * make. An admin who does want it gone can delete it afterwards from the
 * editor, deliberately.
 *
 * ## What is never sent to the client
 *
 * `submitter_ip_hash`. It exists for the rate limit and for abuse triage
 * (docs/privacy.md), it is purged at 90 days, and a dashboard that rendered it
 * would put a pseudonymous identifier on screen for every reviewer with no
 * purpose that the queue itself needs.
 */

import { adminCors } from './auth.js';
import { validateLocationInput } from './validate.js';
import { readTagSlugs } from './tag-registry.js';
import { readCandidates } from './nexus-cache.js';
import { writeAudit } from './audit.js';
import {
  getRow, loadAdminRecord, loadAdminRecordById, materializeAfterWrite,
  insertLocation, patchLocation,
} from './registry.js';

/** The one pending state, and the three resolved ones. */
export const PENDING = 'pending';
export const RESOLVED = {
  approve: 'approved',
  reject: 'rejected',
  hold: 'held',
};

/** Matches submissions.review_note, and REASON_MAX in submissions.js. */
const NOTE_MAX = 1000;

/** The queue is a work list, not an archive. Same shape as the audit limit. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const json = (request, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...adminCors(request),
  },
});

/**
 * A stored payload as an object.
 *
 * Never throws. A submission with a malformed payload is still a row a reviewer
 * has to be able to see and reject, and taking the whole queue down over one
 * bad cell would make that impossible.
 */
function parsePayload(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Row -> the review representation. See the header on submitter_ip_hash. */
function rowToReview(row) {
  return {
    id: row.id,
    kind: row.kind,
    location_id: row.location_id,
    payload: parsePayload(row.payload),
    status: row.status,
    submitter_note: row.submitter_note,
    submitter_contact: row.submitter_contact,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    created_at: row.created_at,
  };
}

async function readSubmission(env, id) {
  return env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
}

/**
 * Move a submission out of `pending`, or report that someone else already did.
 *
 * The status is in the WHERE clause rather than checked beforehand: two
 * reviewers clicking Approve at the same moment both pass a read-then-write
 * check, and only one of them can win this one.
 */
async function resolve(env, id, status, { actor, note, nowIso }) {
  const result = await env.DB.prepare(
    `UPDATE submissions
        SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
      WHERE id = ? AND status = ?`,
  ).bind(status, actor, nowIso, note ?? null, id, PENDING).run();
  return (result?.meta?.changes ?? 0) > 0;
}

/** The reviewer's reason. Stored on the row; nothing sends it anywhere. */
function checkNote(value, { required }) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return required ? ['reason is required'] : [];
  }
  if (typeof value !== 'string') return ['reason must be a string'];
  if (value.length > NOTE_MAX) return [`reason must be at most ${NOTE_MAX} characters`];
  return [];
}

/**
 * Grant a `create` by putting a hidden record back on the map, instead of
 * inserting a second one.
 *
 * The case this exists for: a removal was approved, the record went `hidden`,
 * and later someone submits the same mod again. Approving that create normally
 * would leave two rows for one pin, one hidden and one published.
 *
 * It restores the record AS IT STANDS. The submitted coordinates and
 * description are NOT applied: the stored record is curated (34 of 295 names
 * differ from their Nexus title deliberately), and quietly overwriting that
 * from an anonymous payload is not a restore. A reviewer who does want the new
 * values makes that edit deliberately afterwards.
 *
 * Three checks, three distinct refusals, because each one means the reviewer
 * pointed at the wrong record and they are wrong in different ways.
 */
async function restoreInstead(env, submission, locationId, { actor, nowIso }) {
  const row = await getRow(env, locationId);
  if (!row) {
    return { error: 'location_missing', detail: 'that location does not exist', status: 409 };
  }
  if (row.status !== 'hidden') {
    return {
      error: 'not_hidden',
      detail: `"${row.name}" is ${row.status}, not hidden, so there is nothing to restore`,
      status: 409,
    };
  }

  // A mod supplies more than one location (23896 supplies two tattoo shops), so
  // matching on nexus_id does NOT prove this is the right record. It does prove
  // it is the right MOD, which is the part a reviewer can pick wrong by
  // clicking the row above the one they meant.
  const payload = parsePayload(submission.payload);
  if (String(row.nexus_id ?? '') !== String(payload.nexus_id ?? '')) {
    return {
      error: 'nexus_id_mismatch',
      detail: `"${row.name}" is mod ${row.nexus_id}, and this submission is for mod ${payload.nexus_id}`,
      status: 409,
    };
  }

  const before = await loadAdminRecord(env, row);
  await patchLocation(env, locationId, { status: 'published' }, nowIso);
  const after = await loadAdminRecordById(env, locationId);
  await writeAudit(env, { actor, action: 'location.update', target: locationId, before, after });
  return { location: after, restored: true };
}

/**
 * Apply an approved submission to the registry.
 *
 * The payload is REVALIDATED here, against the tag registry as it stands now
 * rather than as it stood when the submission arrived. A tag can be renamed or
 * deleted between the two, and applying a payload that references a tag which
 * no longer exists would write a location whose join rows silently go missing.
 *
 * Returns `{error}` for a refusal the caller turns into a status, leaving the
 * submission pending: a submission that could not be applied has not been
 * reviewed, and marking it approved anyway would lose it.
 */
async function applyApproval(env, submission, { actor, nowIso, restoreLocationId }) {
  const payload = parsePayload(submission.payload);

  if (submission.kind === 'create') {
    // The reviewer chose to grant this by restoring an existing record rather
    // than by inserting a new one. Still an approval: the request was granted.
    if (restoreLocationId) {
      return restoreInstead(env, submission, restoreLocationId, { actor, nowIso });
    }

    const v = validateLocationInput(payload, { tagNames: await readTagSlugs(env) });
    if (!v.ok) return { error: 'validation_failed', errors: v.errors, status: 422 };

    const id = await insertLocation(env, payload, nowIso);
    const after = await loadAdminRecordById(env, id);
    // Two audit rows for one approval, and both are real: the queue moved, and
    // so did the registry. Reading a location's history must not depend on
    // knowing which route created it.
    await writeAudit(env, { actor, action: 'location.create', target: id, after });
    return { location: after };
  }

  // edit and remove both name an existing record, and it can have been deleted
  // since the submission arrived.
  const beforeRow = await getRow(env, submission.location_id);
  if (!beforeRow) {
    return {
      error: 'location_missing',
      detail: 'the location this submission refers to no longer exists',
      status: 409,
    };
  }
  const before = await loadAdminRecord(env, beforeRow);

  if (submission.kind === 'edit') {
    const v = validateLocationInput(payload, { tagNames: await readTagSlugs(env), partial: true });
    if (!v.ok) return { error: 'validation_failed', errors: v.errors, status: 422 };

    const patched = await patchLocation(env, submission.location_id, payload, nowIso);
    if (patched.empty) {
      return { error: 'empty_patch', detail: 'this submission changes no field', status: 422 };
    }
    const after = await loadAdminRecordById(env, submission.location_id);
    await writeAudit(env, {
      actor, action: 'location.update', target: submission.location_id, before, after,
    });
    return { location: after };
  }

  // remove: hide, never delete. See the header.
  if (before.status === 'hidden') {
    return { error: 'already_hidden', detail: 'this location is already off the map', status: 409 };
  }
  await patchLocation(env, submission.location_id, { status: 'hidden' }, nowIso);
  const after = await loadAdminRecordById(env, submission.location_id);
  await writeAudit(env, {
    actor, action: 'location.update', target: submission.location_id, before, after,
  });
  return { location: after };
}

/**
 * POST /admin/submissions/:id/(approve|reject|hold)
 *
 * The registry write happens BEFORE the submission is resolved, so a failure to
 * apply leaves the submission pending and retryable. The other order would mark
 * a submission approved and then discover it could not be applied, which reads
 * as done and is not.
 */
async function act(request, env, ctx, { id, action, actor }) {
  let body = {};
  if (request.headers.get('Content-Type')?.includes('application/json')) {
    try { body = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(request, { error: 'invalid_body', detail: 'body must be a JSON object' }, 400);
  }

  // Required on the two outcomes that turn something down, optional on the one
  // that does not.
  //
  // NOT because the submitter reads it. NOTHING DELIVERS IT: submissions are
  // anonymous, `submitter_contact` is optional free text that only a person
  // acts on, and there is no route by which a submitter can read their own
  // row. The reason is required because it is the only record of why a
  // submission was turned down, and it is what a reviewer needs when the same
  // mod comes back. If a submitter-facing status page is built later, this
  // field is what it would show, which is a reason to write it well now and
  // not a reason to describe it as delivered today.
  const errors = checkNote(body.reason, { required: action !== 'approve' });
  if (body.restore_location_id !== undefined && typeof body.restore_location_id !== 'string') {
    errors.push('restore_location_id must be a string');
  }
  if (errors.length) return json(request, { error: 'invalid_review', errors }, 400);

  const row = await readSubmission(env, id);
  if (!row) return json(request, { error: 'not_found' }, 404);

  // Restoring instead of inserting is a `create` idea. An edit and a removal
  // already name the record they act on, and honouring a second id here would
  // let a reviewer resolve one submission by changing an unrelated location.
  if (body.restore_location_id && !(action === 'approve' && row.kind === 'create')) {
    return json(request, {
      error: 'invalid_review',
      errors: ['restore_location_id applies only to approving a create'],
    }, 400);
  }
  if (row.status !== PENDING) {
    return json(request, {
      error: 'already_resolved',
      detail: `this submission was already ${row.status}`,
      status: row.status,
      reviewed_by: row.reviewed_by,
    }, 409);
  }

  const nowIso = new Date().toISOString();
  let applied = null;
  if (action === 'approve') {
    applied = await applyApproval(env, row, {
      actor, nowIso, restoreLocationId: body.restore_location_id ?? null,
    });
    if (applied.error) {
      return json(request, {
        error: applied.error,
        detail: applied.detail,
        errors: applied.errors,
      }, applied.status);
    }
  }

  const status = RESOLVED[action];
  const won = await resolve(env, id, status, { actor, note: body.reason ?? null, nowIso });
  if (!won) {
    // Another reviewer resolved it between the read above and this update. The
    // registry write, if there was one, has already landed and is in the audit
    // log under this actor, so say so plainly rather than reporting a clean
    // conflict that hides a write.
    return json(request, {
      error: 'already_resolved',
      detail: applied
        ? 'another reviewer resolved this first, and the registry write from this request has already been applied. Check the audit log.'
        : 'another reviewer resolved this first',
    }, 409);
  }

  await writeAudit(env, {
    actor,
    action: `submission.${action}`,
    target: String(id),
    before: { status: PENDING },
    after: {
      status,
      review_note: body.reason ?? null,
      location_id: applied?.location?.id ?? row.location_id,
      // How the request was granted, not just that it was. An approval that
      // inserted nothing and an approval that inserted a record are different
      // events, and the log is the only place that distinction survives.
      granted_by: applied ? (applied.restored ? 'restore' : 'apply') : null,
    },
  });

  if (applied) materializeAfterWrite(env, ctx);

  const submission = rowToReview(await readSubmission(env, id));
  return json(request, {
    submission,
    location: applied?.location ?? null,
    restored: applied?.restored === true,
  });
}

/** Every mod a reviewer has put aside, newest first. */
async function readDismissed(env) {
  const { results } = await env.DB.prepare(
    `SELECT d.nexus_id, d.reason, d.dismissed_by, d.dismissed_at, n.name, n.thumbnail_url
       FROM dismissed_candidates d
       LEFT JOIN nexus_cache n ON n.nexus_id = d.nexus_id
      ORDER BY d.dismissed_at DESC`,
  ).all();
  return (results ?? []).map((r) => ({
    nexus_id: String(r.nexus_id),
    name: r.name ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    reason: r.reason,
    dismissed_by: r.dismissed_by,
    dismissed_at: r.dismissed_at,
  }));
}

/**
 * The candidates surface.
 *
 * Both lists in one response, because they are one decision: a candidate is
 * either waiting, or it was put aside and can be brought back. Two routes would
 * make the dashboard fetch twice to render one panel.
 */
async function handleCandidates(request, env, { method, actor, nexusId }) {
  if (!nexusId) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    return json(request, {
      candidates: await readCandidates(env),
      dismissed: await readDismissed(env),
    });
  }

  const existing = await env.DB.prepare(
    'SELECT * FROM dismissed_candidates WHERE nexus_id = ?',
  ).bind(nexusId).first();

  if (method === 'POST') {
    if (existing) {
      return json(request, { error: 'already_dismissed', nexus_id: nexusId }, 409);
    }
    let body = {};
    if (request.headers.get('Content-Type')?.includes('application/json')) {
      try { body = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }
    }
    const errors = checkNote(body.reason, { required: false });
    if (errors.length) return json(request, { error: 'invalid_review', errors }, 400);

    const nowIso = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?)',
    ).bind(nexusId, body.reason?.trim() || null, actor, nowIso).run();

    await writeAudit(env, {
      actor,
      action: 'candidate.dismiss',
      target: nexusId,
      after: { reason: body.reason?.trim() || null },
    });
    return json(request, {
      dismissed: {
        nexus_id: nexusId, reason: body.reason?.trim() || null,
        dismissed_by: actor, dismissed_at: nowIso,
      },
    }, 201);
  }

  if (method === 'DELETE') {
    // Reversible, which is the whole reason this replaced a Discord alert: a
    // mod dismissed by mistake comes back into the list at the next sweep.
    if (!existing) return json(request, { error: 'not_found' }, 404);
    await env.DB.prepare('DELETE FROM dismissed_candidates WHERE nexus_id = ?').bind(nexusId).run();
    await writeAudit(env, {
      actor,
      action: 'candidate.restore',
      target: nexusId,
      before: { reason: existing.reason, dismissed_by: existing.dismissed_by },
    });
    return json(request, { restored: nexusId });
  }

  return json(request, { error: 'method_not_allowed' }, 405);
}

/**
 * Route /admin/submissions* and /admin/candidates*. Returns null for anything
 * else, so handleAdmin falls through to the location routes.
 *
 * @returns {Promise<Response|null>}
 */
export async function handleReview({ request, env, ctx, actor, method, url }) {
  const path = url.pathname;

  // ---- the queue ----------------------------------------------------------
  if (path === '/admin/submissions') {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);

    // Every status, not just pending. A reviewer needs to see what they decided
    // ten minutes ago, and the counts on the dashboard are derived client-side
    // from these rows rather than from an aggregate this route computes:
    // `decisions/api-per-location-records` removed server-side aggregates
    // because several consumers counting independently produced bug #823.
    const raw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), MAX_LIMIT) : DEFAULT_LIMIT;
    const { results } = await env.DB.prepare(
      'SELECT * FROM submissions ORDER BY created_at DESC, id DESC LIMIT ?',
    ).bind(limit).all();
    return json(request, { submissions: (results ?? []).map(rowToReview) });
  }

  const actionMatch = path.match(/^\/admin\/submissions\/(\d+)\/(approve|reject|hold)$/);
  if (actionMatch) {
    if (method !== 'POST') return json(request, { error: 'method_not_allowed' }, 405);
    return act(request, env, ctx, {
      id: Number(actionMatch[1]), action: actionMatch[2], actor,
    });
  }

  const oneMatch = path.match(/^\/admin\/submissions\/(\d+)$/);
  if (oneMatch) {
    if (method !== 'GET') return json(request, { error: 'method_not_allowed' }, 405);
    const row = await readSubmission(env, Number(oneMatch[1]));
    if (!row) return json(request, { error: 'not_found' }, 404);
    return json(request, { submission: rowToReview(row) });
  }

  if (path.startsWith('/admin/submissions/')) return json(request, { error: 'not_found' }, 404);

  // ---- candidates ---------------------------------------------------------
  if (path === '/admin/candidates') {
    return handleCandidates(request, env, { method, actor, nexusId: null });
  }

  const candidateMatch = path.match(/^\/admin\/candidates\/([^/]+)$/);
  if (candidateMatch) {
    return handleCandidates(request, env, {
      method, actor, nexusId: decodeURIComponent(candidateMatch[1]),
    });
  }

  if (path.startsWith('/admin/candidates/')) return json(request, { error: 'not_found' }, 404);

  return null;
}
