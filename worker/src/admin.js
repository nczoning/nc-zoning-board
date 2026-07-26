/**
 * Admin CRUD over the location registry. Phase 4: direct writes, no submission
 * queue yet (that is Phase 5).
 *
 * Every route is gated on repository collaborator status, and every mutation
 * writes an audit row in the same request. The audit row is not optional
 * bookkeeping — once edits stop arriving as pull requests, it is the only
 * record of who changed what.
 */

import { resolveSession } from './auth.js';
import { adminCors } from './auth.js';
import { validateLocationInput } from './validate.js';
import { writeAudit, readAudit } from './audit.js';
import { KEYS } from './store.js';
import { runRefresh } from './refresh.js';

const json = (request, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...adminCors(request),
  },
});

/**
 * Gate. Returns the session, or a Response to return immediately.
 *
 * 503 for an indeterminate check, never 403: "we cannot tell" is not "you are
 * not allowed", and an admin locked out by a transient GitHub blip should be
 * told which of those happened. See github-app.js.
 */
async function requireCollaborator(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return { error: json(request, { error: 'unauthenticated' }, 401) };
  if (session.indeterminate) {
    return { error: json(request, { error: 'check_unavailable' }, 503) };
  }
  if (!session.collaborator) return { error: json(request, { error: 'forbidden' }, 403) };
  return { session };
}

/** Row -> the admin representation (everything, including admin-only fields). */
function rowToAdmin(row) {
  return {
    id: row.id,
    name: row.name,
    nexus_id: row.nexus_id,
    category: row.category,
    coordinates: row.z === null || row.z === undefined ? [row.x, row.y] : [row.x, row.y, row.z],
    yaw: row.yaw,
    description: row.description ?? '',
    credits: row.credits,
    authors: JSON.parse(row.authors ?? '[]'),
    tags: JSON.parse(row.tags ?? '[]'),
    source: row.source,
    status: row.status,
    admin_notes: row.admin_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Known tag ids, from the KV dataset the cron already maintains. */
async function tagNames(env) {
  const tags = await env.DATASET.get(KEYS.tags, 'json');
  return new Set(Object.keys(tags || {}));
}

/**
 * Rebuild the KV read path from D1 after a write, so an approved change appears
 * in seconds rather than at the next cron tick.
 *
 * 🔴 GATED ON DATA_SOURCE. If the cron is still sourcing from mods.json, a
 * write-through materialize would overwrite KV with D1-derived content and
 * silently perform the Phase 2 cutover as a side effect of an admin edit. So
 * when DATA_SOURCE is not 'd1' the write lands in D1 and the map keeps showing
 * mods.json — which is correct, and is what "nothing reads D1 yet" means.
 */
function materializeAfterWrite(env, ctx) {
  if (env.DATA_SOURCE !== 'd1') return;
  // Fire-and-forget: the admin gets their response immediately, and a failed
  // rebuild leaves last-known-good in place exactly as a failed cron does.
  ctx?.waitUntil?.(runRefresh(env).catch((err) => {
    console.error('write-through materialize failed:', String(err).slice(0, 200));
  }));
}

const COLUMN_FOR = {
  name: 'name', nexus_id: 'nexus_id', category: 'category', description: 'description',
  credits: 'credits', source: 'source', status: 'status', admin_notes: 'admin_notes',
  yaw: 'yaw',
};

/** Build the SET clause for a validated patch. */
function buildUpdate(payload) {
  const sets = [];
  const binds = [];
  for (const [field, column] of Object.entries(COLUMN_FOR)) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      sets.push(`${column} = ?`);
      binds.push(payload[field] === undefined ? null : payload[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'authors')) {
    sets.push('authors = ?'); binds.push(JSON.stringify(payload.authors));
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'tags')) {
    sets.push('tags = ?'); binds.push(JSON.stringify(payload.tags));
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'coordinates')) {
    const [x, y, z] = payload.coordinates;
    sets.push('x = ?', 'y = ?', 'z = ?');
    binds.push(x, y, z === undefined ? null : z);
  }
  return { sets, binds };
}

async function getRow(env, id) {
  return env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first();
}

/**
 * Route the /admin/* surface.
 * @returns {Promise<Response|null>} null when the path is not an admin route.
 */
export async function handleAdmin(request, env, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/admin/')) return null;

  const gate = await requireCollaborator(request, env);
  if (gate.error) return gate.error;
  const actor = gate.session.login;

  const method = request.method;
  const listMatch = url.pathname === '/admin/locations';
  const oneMatch = url.pathname.match(/^\/admin\/locations\/([^/]+)$/);

  // ---- audit -------------------------------------------------------------
  if (url.pathname === '/admin/audit' && method === 'GET') {
    return json(request, { entries: await readAudit(env, url.searchParams.get('limit')) });
  }

  // ---- list --------------------------------------------------------------
  if (listMatch && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM locations ORDER BY name').all();
    return json(request, { locations: (results ?? []).map(rowToAdmin) });
  }

  // ---- create ------------------------------------------------------------
  if (listMatch && method === 'POST') {
    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateLocationInput(payload, { tagNames: await tagNames(env) });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    // Server-generated, never client-supplied: a caller-chosen id is how a deep
    // link gets silently repointed at a different mod.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const [x, y, z] = payload.coordinates;

    await env.DB.prepare(`
      INSERT INTO locations (id, name, nexus_id, category, x, y, z, yaw, description,
        credits, authors, tags, source, status, admin_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, payload.name, payload.nexus_id, payload.category,
      x, y, z === undefined ? null : z,
      payload.yaw ?? null,
      payload.description ?? '',
      payload.credits || null,
      JSON.stringify(payload.authors), JSON.stringify(payload.tags),
      payload.source ?? 'manual', payload.status ?? 'published',
      payload.admin_notes ?? null, now, now,
    ).run();

    const after = rowToAdmin(await getRow(env, id));
    await writeAudit(env, { actor, action: 'location.create', target: id, after });
    materializeAfterWrite(env, ctx);
    return json(request, { location: after }, 201);
  }

  // ---- read one ----------------------------------------------------------
  if (oneMatch && method === 'GET') {
    const row = await getRow(env, decodeURIComponent(oneMatch[1]));
    if (!row) return json(request, { error: 'not_found' }, 404);
    return json(request, { location: rowToAdmin(row) });
  }

  // ---- update ------------------------------------------------------------
  if (oneMatch && method === 'PATCH') {
    const id = decodeURIComponent(oneMatch[1]);
    const before = await getRow(env, id);
    if (!before) return json(request, { error: 'not_found' }, 404);

    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateLocationInput(payload, { tagNames: await tagNames(env), partial: true });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    const { sets, binds } = buildUpdate(payload);
    if (!sets.length) return json(request, { error: 'empty_patch' }, 400);

    sets.push('updated_at = ?');
    binds.push(new Date().toISOString(), id);
    await env.DB.prepare(`UPDATE locations SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

    const after = rowToAdmin(await getRow(env, id));
    await writeAudit(env, {
      actor, action: 'location.update', target: id, before: rowToAdmin(before), after,
    });
    materializeAfterWrite(env, ctx);
    return json(request, { location: after });
  }

  // ---- delete ------------------------------------------------------------
  if (oneMatch && method === 'DELETE') {
    const id = decodeURIComponent(oneMatch[1]);
    const before = await getRow(env, id);
    if (!before) return json(request, { error: 'not_found' }, 404);

    await env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(id).run();
    // The full record goes into `before`, so a delete is recoverable from the
    // audit log. `status: 'hidden'` remains the right move for a mod pulled
    // from the map; this is for records that should never have existed.
    await writeAudit(env, {
      actor, action: 'location.delete', target: id, before: rowToAdmin(before),
    });
    materializeAfterWrite(env, ctx);
    return json(request, { deleted: id });
  }

  return json(request, { error: 'not_found' }, 404);
}
