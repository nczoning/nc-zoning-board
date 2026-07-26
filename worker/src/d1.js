/**
 * D1 read layer for the refresh path.
 *
 * Deliberately thin: the cron needs exactly two reads, and both are whole-table
 * scans of small tables (296 rows and 1 row today). No pagination, because D1
 * returns the full result set for a statement — but see the count guard below
 * for why that is asserted rather than assumed.
 */

/**
 * Every `locations` row. Status filtering happens in materializeFromD1 rather
 * than here, so the materializer sees the same rows the admin dashboard will
 * and there is one place that decides what "published" means.
 *
 * The count guard exists because a silently truncated result set is the failure
 * that looks like success: 200 of 296 locations still renders as a working map,
 * just a smaller one. Cheap to check, and it turns a silent data loss into a
 * refresh failure that keeps last-known-good and alerts.
 */
export async function readLocationRows(env) {
  const [rows, counted] = await Promise.all([
    env.DB.prepare('SELECT * FROM locations').all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM locations').first(),
  ]);
  const results = rows.results ?? [];
  if (results.length !== counted.n) {
    throw new Error(`D1 returned ${results.length} locations but COUNT(*) is ${counted.n}`);
  }
  if (results.length === 0) {
    // An empty registry is never legitimate here. Throwing routes it into the
    // last-known-good path instead of materializing an empty map.
    throw new Error('D1 `locations` is empty -- refusing to materialize an empty dataset');
  }
  return results;
}

/** nexus_ids we have looked at and decided to keep off the map. */
export async function readDismissedIds(env) {
  const { results } = await env.DB.prepare('SELECT nexus_id FROM dismissed_candidates').all();
  return new Set((results ?? []).map((r) => String(r.nexus_id)));
}

/**
 * The tag registry, in display order. This is the /v1/tags payload shape:
 * an array of records, matching /v1/locations and the per-record philosophy,
 * rather than the arbitrarily-keyed map it used to be (which is also awkward
 * for the in-game RedData `FromJson`).
 *
 * `name` falls back to the slug when NULL, which is exactly today's rendering —
 * the site shows the raw tag string as the badge. That fallback is what lets
 * this ship without any visual change until labels are actually set.
 */
export async function readTags(env) {
  const { results } = await env.DB.prepare(
    'SELECT slug, name, description, sort_order FROM tags ORDER BY sort_order, slug',
  ).all();
  return (results ?? []).map((r) => ({
    slug: r.slug,
    name: r.name ?? r.slug,
    description: r.description,
    sort_order: r.sort_order,
  }));
}

/**
 * Per-location tag slugs, as a Map(location_id -> string[]).
 *
 * Ordered by slug, because tag order carries no meaning — it is a set rendered
 * as badges. 286 of the 287 manual records were already alphabetical and the
 * single outlier was normalised, so this reproduces the existing output rather
 * than imposing a new order.
 *
 * `nczoning` is absent by construction (it is not a `tags` row), and is
 * re-added by the materializer for auto-sourced records, exactly as merge.js
 * prepends it.
 */
export async function readLocationTags(env) {
  const { results } = await env.DB.prepare(
    'SELECT location_id, tag_slug FROM location_tags ORDER BY location_id, tag_slug',
  ).all();
  const map = new Map();
  for (const r of results ?? []) {
    if (!map.has(r.location_id)) map.set(r.location_id, []);
    map.get(r.location_id).push(r.tag_slug);
  }
  return map;
}

/** How long a collaborator verdict is trusted before it is re-checked. */
export const COLLABORATOR_TTL_MS = 10 * 60 * 1000;

/**
 * A cached collaborator verdict, or null if absent or stale.
 *
 * Returns null rather than a stale verdict so the caller re-checks: an admin
 * who was removed from the repo should lose access within the TTL, and a
 * "prefer the cached answer" fallback would quietly extend it forever.
 */
export async function readCachedVerdict(env, userId, nowMs = Date.now()) {
  const row = await env.DB.prepare(
    'SELECT id, login, is_collaborator, checked_at FROM users WHERE id = ?',
  ).bind(userId).first();
  if (!row) return null;
  const checkedMs = Date.parse(row.checked_at);
  if (!Number.isFinite(checkedMs) || nowMs - checkedMs > COLLABORATOR_TTL_MS) return null;
  return { login: row.login, isCollaborator: row.is_collaborator === 1 };
}

/**
 * Record a verdict, preserving first_seen_at across re-checks.
 *
 * Only ever called with a real yes/no. An indeterminate check ('error' from
 * checkCollaborator) must NOT reach here — caching "no" because GitHub was
 * unreachable would lock an admin out for the full TTL over a transient blip.
 */
export async function recordUser(env, { id, login, isCollaborator }, nowMs = Date.now()) {
  const now = new Date(nowMs).toISOString();
  await env.DB.prepare(`
    INSERT INTO users (id, login, is_collaborator, checked_at, first_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      login = excluded.login,
      is_collaborator = excluded.is_collaborator,
      checked_at = excluded.checked_at
  `).bind(id, login, isCollaborator ? 1 : 0, now, now).run();
}
