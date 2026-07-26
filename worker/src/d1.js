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
