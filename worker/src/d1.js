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
