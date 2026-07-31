/**
 * Writes against the location registry, shared by the two routes that perform
 * them: the admin editor (admin.js) and the review queue (review.js).
 *
 * One definition, two callers, because approving a submission has to produce a
 * record indistinguishable from one an admin typed in by hand. The parity gate
 * rebuilds all 18 served fields from D1, so a second INSERT with its own idea
 * of the defaults surfaces there as a difference that depends on which route
 * wrote the row.
 *
 * The tag join is part of a write, not a follow-up to it. resolveTags treats
 * location_tags as authoritative, so an INSERT without syncLocationTags
 * materializes a record with no tags at all. Both helpers here own the join
 * rather than leaving it to the caller to remember.
 */

import { runRefresh } from './refresh.js';
import { syncLocationTags, readTagsForLocations } from './tag-registry.js';

/** Payload field -> column, for the fields that map one to one. */
const COLUMN_FOR = {
  name: 'name', nexus_id: 'nexus_id', category: 'category', description: 'description',
  credits: 'credits', status: 'status', admin_notes: 'admin_notes',
  yaw: 'yaw',
};

export async function getRow(env, id) {
  return env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first();
}

/**
 * Row -> the admin representation (everything, including admin-only fields).
 *
 * `tags` comes from the `location_tags` join, passed in by the caller, NOT from
 * the legacy `locations.tags` column. The join is what the materializer reads,
 * so it is what the dashboard must show. Rendering the column would let an
 * edit that never reached the join look like it had landed.
 *
 * The synthetic `nczoning` marker is absent here by construction (it is not a
 * registry row, so it has no join rows). That is correct for an editor: it is
 * not a tag an admin owns, and the materializer re-adds it for auto records.
 */
export function rowToAdmin(row, tags = [], nexusUpdatedAt = null) {
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
    tags,
    status: row.status,
    admin_notes: row.admin_notes,
    added_at: row.added_at,
    modified_at: row.modified_at,
    // The MOD's update time on Nexus, which is a different thing from both of
    // the above and is the `updated_at` a /v1 record carries. Named in full here
    // so the dashboard cannot show three dates that look interchangeable.
    nexus_updated_at: nexusUpdatedAt,
  };
}

/**
 * `nexus_id` -> the mod's Nexus update time, for every cached mod.
 *
 * One query for the whole list rather than a lookup per record: the admin list
 * route already reads tags in bulk for the same reason.
 */
export async function readNexusUpdatedMap(env) {
  const { results } = await env.DB.prepare(
    'SELECT nexus_id, updated_at FROM nexus_cache',
  ).all();
  const map = new Map();
  for (const r of results ?? []) map.set(String(r.nexus_id), r.updated_at ?? null);
  return map;
}

/** One location, joined to its tags and the mod's Nexus update time. */
export async function loadAdminRecord(env, row) {
  const map = await readTagsForLocations(env, [row.id]);
  const nexus = await env.DB.prepare(
    'SELECT updated_at FROM nexus_cache WHERE nexus_id = ?',
  ).bind(String(row.nexus_id)).first();
  return rowToAdmin(row, map.get(row.id) ?? [], nexus?.updated_at ?? null);
}

/** The same, by id. Returns null when the record is gone. */
export async function loadAdminRecordById(env, id) {
  const row = await getRow(env, id);
  return row ? loadAdminRecord(env, row) : null;
}

/**
 * Rebuild the KV read path from D1 after a write, so an approved change appears
 * in seconds rather than at the next cron tick.
 *
 * GATED ON DATA_SOURCE. If the cron is still sourcing from mods.json, a
 * write-through materialize would overwrite KV with D1-derived content and
 * silently perform the Phase 2 cutover as a side effect of an admin edit. So
 * when DATA_SOURCE is not 'd1' the write lands in D1 and the map keeps showing
 * mods.json, which is correct, and is what "nothing reads D1 yet" means.
 */
export function materializeAfterWrite(env, ctx) {
  if (env.DATA_SOURCE !== 'd1') return;
  // Fire-and-forget: the admin gets their response immediately, and a failed
  // rebuild leaves last-known-good in place exactly as a failed cron does.
  ctx?.waitUntil?.(runRefresh(env).catch((err) => {
    console.error('write-through materialize failed:', String(err).slice(0, 200));
  }));
}

/**
 * Build the SET clause for a validated patch.
 *
 * `tags` is deliberately NOT here: it lives in the join now, and
 * syncLocationTags owns both representations. Setting the column here as well
 * would write it twice with two different normalisations.
 */
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
  if (Object.prototype.hasOwnProperty.call(payload, 'coordinates')) {
    const [x, y, z] = payload.coordinates;
    sets.push('x = ?', 'y = ?', 'z = ?');
    binds.push(x, y, z === undefined ? null : z);
  }
  return { sets, binds };
}

/**
 * Insert a validated location. Returns the server-generated id.
 *
 * The id is server-generated, never client-supplied: a caller-chosen id is how
 * a deep link gets silently repointed at a different mod. That holds for an
 * approved submission too, where the "caller" is an anonymous submitter.
 */
export async function insertLocation(env, payload, nowIso = new Date().toISOString()) {
  const id = crypto.randomUUID();
  const [x, y, z] = payload.coordinates;

  await env.DB.prepare(`
    INSERT INTO locations (id, name, nexus_id, category, x, y, z, yaw, description,
      credits, authors, tags, status, admin_notes, added_at, modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, payload.name, payload.nexus_id, payload.category,
    x, y, z === undefined ? null : z,
    payload.yaw ?? null,
    payload.description ?? '',
    payload.credits || null,
    JSON.stringify(payload.authors), JSON.stringify(payload.tags),
    payload.status ?? 'published',
    payload.admin_notes ?? null, nowIso, nowIso,
  ).run();

  // The join, not just the column. Without this the record materializes with
  // no tags at all, because resolveTags treats the join as authoritative.
  await syncLocationTags(env, id, payload.tags);
  return id;
}

/**
 * Apply a validated partial patch. `{empty: true}` when the payload names no
 * column and no tags, which is a caller error rather than a no-op write.
 *
 * OPTIMISTIC CONCURRENCY. Pass `ifMatch` as the `modified_at` the caller read,
 * and the write applies only while the record still carries it. Three admins
 * share one registry and one queue, so without this the second save silently
 * replaces the first: the audit log records both, but nobody is told, and the
 * admin who saved first sees their change vanish on next load.
 *
 * Returns `{conflict: true}` when the row moved underneath. SQLite counts a
 * matched row as changed even when the values are identical, so `changes === 0`
 * means the WHERE did not match rather than "nothing needed writing". The
 * caller has already established the row exists, so the only way to miss is a
 * stale `ifMatch`.
 *
 * Omitting `ifMatch` is an unguarded write, which is correct for a caller that
 * genuinely means "apply this regardless" (see review.js).
 */
export async function patchLocation(
  env, id, payload, nowIso = new Date().toISOString(), { ifMatch = null } = {},
) {
  const patchesTags = Object.prototype.hasOwnProperty.call(payload, 'tags');
  const { sets, binds } = buildUpdate(payload);
  if (!sets.length && !patchesTags) return { empty: true };

  // A tags-only patch still has to move modified_at, so the column write is
  // unconditional rather than gated on `sets`.
  sets.push('modified_at = ?');
  binds.push(nowIso, id);

  let sql = `UPDATE locations SET ${sets.join(', ')} WHERE id = ?`;
  if (ifMatch) {
    sql += ' AND modified_at = ?';
    binds.push(ifMatch);
  }
  const res = await env.DB.prepare(sql).bind(...binds).run();
  if (ifMatch && res?.meta?.changes === 0) return { conflict: true };

  if (patchesTags) await syncLocationTags(env, id, payload.tags);
  return { empty: false };
}
