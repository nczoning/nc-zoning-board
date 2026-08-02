/**
 * nexus_missing: pinned mods Nexus has stopped returning.
 *
 * A location whose mod is deleted or hidden on Nexus keeps its pin, because
 * with D1 as the registry it is a row and rows persist (#900). This module is
 * the memory that turns "Nexus did not answer about this mod" -- a fact that on
 * its own means nothing -- into "Nexus has not answered about this mod for a
 * day", which is worth telling a person about.
 *
 * ## One sweep proves nothing
 *
 * `fetchModsByUidThumbs` never throws; it returns `{}` on failure, and an empty
 * result is indistinguishable from a successful call that found nothing. So a
 * single sweep cannot tell "these mods are gone" from "Nexus is down", and
 * persistence across sweeps is the only signal there is. That is why this
 * module exists at all rather than the sweep just raising an alert.
 *
 * Three guards, in the order they apply:
 *
 *   1. The sweep skips counting entirely when it already knows it failed
 *      (`summary.stale`, the all-or-nothing case nexus-cache.js already
 *      detects). Without this one Nexus outage flags the whole registry.
 *   2. `sweepLooksUnreliable` catches the PARTIAL outage the stale flag cannot:
 *      modsByUid is chunked, and a chunk that fails after its retry returns {}
 *      for its share while the other chunks succeed. That looks exactly like
 *      "50 mods were deleted at once", which is not a thing that happens.
 *   3. Even a clean sweep only increments. Flagging needs both a streak and a
 *      duration -- see FLAG_STREAK / FLAG_MIN_AGE_MS.
 *
 * ## No row means healthy
 *
 * A sweep that gets a mod back deletes its row rather than zeroing it, so the
 * table holds only the mods currently in trouble. Same for a mod that stops
 * being asked about: unpinned, or newly NCZoning-tagged (which moves it into
 * the tagged set, which is proof it exists). `recordSweep` therefore prunes
 * every row it was not told is still missing -- which is only safe because the
 * caller does not call it on a sweep it does not trust.
 *
 * ## It never writes locations.status
 *
 * No auto-hide, by the issue's explicit terms. This feeds a review list and one
 * alert; an admin decides whether the pin comes down.
 */

/**
 * Consecutive sweeps a mod must go unanswered before it is flagged.
 *
 * The cron is 5-minutely, so on a healthy Worker the duration below is the
 * binding constraint and this is nearly free. It earns its place when the cron
 * is not healthy: a Worker that ran twice in 24 hours and missed both times has
 * satisfied the duration without ever demonstrating persistence.
 */
export const FLAG_STREAK = 6;

/**
 * How long a mod must be CONTINUOUSLY missing before it is flagged.
 *
 * A day, because the failure this is guarding against is a long Nexus outage
 * being read as a mass deletion, and Nexus outages are measured in minutes to
 * hours. Nothing here is time-critical: a deleted mod's pin has already been up
 * for however long nobody noticed, and a day's delay costs nothing against
 * that. Expressed as a duration rather than a sweep count so it does not move
 * if the cron interval does.
 */
export const FLAG_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The partial-outage guard. A sweep is not trusted when this many ids came back
 * empty AND they are this large a share of what was asked for.
 *
 * The floor matters as much as the ratio: with three pinned-but-untagged mods,
 * one genuine deletion is 33% of the request and must still count.
 */
export const SWEEP_MIN_SUSPECT = 5;
export const SWEEP_MAX_RATIO = 0.25;

/**
 * Does this sweep's miss set look like Nexus failing rather than mods going
 * away? Pure, and exported, because it is the rule that decides whether a
 * whole sweep is thrown away and it is worth testing directly.
 */
export function sweepLooksUnreliable({ missing, requested }) {
  if (missing < SWEEP_MIN_SUSPECT) return false;
  return missing >= requested * SWEEP_MAX_RATIO;
}

/** Every tracked row, keyed by nexus_id. One query, no bound parameters. */
async function readRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, miss_streak, missing_since, last_missed_at, flagged_at,
            dismissed_by, dismissed_at
       FROM nexus_missing`,
  ).all();
  const map = new Map();
  for (const r of results ?? []) map.set(String(r.nexus_id), r);
  return map;
}

/**
 * Should this row be flagged now? Both conditions, and only once: `flagged_at`
 * already set means the alert has been raised and the review list already has
 * it, whether or not anyone has looked.
 */
function crossesThreshold(row, nowMs) {
  if (row.flagged_at) return false;
  if (row.miss_streak < FLAG_STREAK) return false;
  const since = Date.parse(row.missing_since);
  if (!Number.isFinite(since)) return false;
  return nowMs - since >= FLAG_MIN_AGE_MS;
}

/**
 * Fold one sweep's result into the table.
 *
 * @param {object} env
 * @param {object} opts
 * @param {string[]} opts.missing  ids that were asked for and not returned
 * @param {string}   opts.nowIso   this sweep's stamp
 * @returns {Promise<{tracked:number, cleared:number, flagged:string[]}>}
 *   `flagged` is the ids that crossed the threshold ON THIS SWEEP, which is
 *   what the caller alerts on. Already-flagged ids are not repeated.
 *
 * NOT called on a sweep the caller does not trust: this prunes every row it was
 * not told about, so a failed sweep passed through here would clear the table.
 */
export async function recordSweep(env, { missing = [], nowIso }) {
  const stamp = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(stamp);
  const missingIds = [...new Set(missing.map(String))];
  const missingSet = new Set(missingIds);
  const existing = await readRows(env);

  const upsert = env.DB.prepare(
    `INSERT INTO nexus_missing
       (nexus_id, miss_streak, missing_since, last_missed_at, flagged_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(nexus_id) DO UPDATE SET
       miss_streak    = excluded.miss_streak,
       last_missed_at = excluded.last_missed_at,
       flagged_at     = excluded.flagged_at`,
  );
  const remove = env.DB.prepare('DELETE FROM nexus_missing WHERE nexus_id = ?');

  const statements = [];
  const flagged = [];

  for (const id of missingIds) {
    const prev = existing.get(id);
    const row = {
      nexus_id: id,
      miss_streak: (prev?.miss_streak ?? 0) + 1,
      // Kept from the existing row: this is the start of the streak, and the
      // streak has not been broken or there would be no row to read.
      missing_since: prev?.missing_since ?? stamp,
      flagged_at: prev?.flagged_at ?? null,
    };
    if (crossesThreshold(row, nowMs)) {
      row.flagged_at = stamp;
      flagged.push(id);
    }
    statements.push(upsert.bind(
      id, row.miss_streak, row.missing_since, stamp, row.flagged_at,
    ));
  }

  // Every row not in this sweep's miss set: Nexus answered about it, or it is
  // no longer pinned, or it picked up the NCZoning tag. All three are proof the
  // mod is fine, and all three are a delete rather than a reset -- see the
  // module note. A dismissal is discarded with the row, which is correct: the
  // admin dismissed a mod that was missing, and this one is not.
  let cleared = 0;
  for (const id of existing.keys()) {
    if (missingSet.has(id)) continue;
    statements.push(remove.bind(id));
    cleared += 1;
  }

  // One statement per row, batched, matching nexus-cache.js. Nothing to do is
  // the steady state and costs no write at all.
  if (statements.length) await env.DB.batch(statements);
  return { tracked: missingIds.length, cleared, flagged };
}

/**
 * The review list: every tracked mod, with the pins that point at it.
 *
 * Serves the un-flagged rows too. The dashboard shows the flagged ones and
 * counts the rest, which is the house rule that a display derives rather than
 * asking the API to have already decided.
 *
 * The locations query is an `IN (SELECT ...)` rather than an id list from the
 * caller, for the same reason readCandidates is: no bound parameter per mod, no
 * 100-parameter ceiling to grow into.
 */
export async function readMissing(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.nexus_id, m.miss_streak, m.missing_since, m.last_missed_at,
            m.flagged_at, m.dismissed_by, m.dismissed_at, c.name AS mod_name
       FROM nexus_missing m
       LEFT JOIN nexus_cache c ON c.nexus_id = m.nexus_id
      ORDER BY m.missing_since`,
  ).all();
  const rows = results ?? [];
  if (!rows.length) return [];

  const { results: locs } = await env.DB.prepare(
    `SELECT id, name, status, nexus_id FROM locations
      WHERE nexus_id IN (SELECT nexus_id FROM nexus_missing)
      ORDER BY name`,
  ).all();
  const byMod = new Map();
  for (const l of locs ?? []) {
    const key = String(l.nexus_id);
    if (!byMod.has(key)) byMod.set(key, []);
    byMod.get(key).push({ id: l.id, name: l.name, status: l.status });
  }

  return rows.map((r) => ({
    nexus_id: String(r.nexus_id),
    mod_name: r.mod_name ?? null,
    miss_streak: Number(r.miss_streak ?? 0),
    missing_since: r.missing_since,
    last_missed_at: r.last_missed_at,
    flagged_at: r.flagged_at ?? null,
    dismissed_by: r.dismissed_by ?? null,
    dismissed_at: r.dismissed_at ?? null,
    // A flagged mod with no locations is possible and is not an error: the pin
    // it was flagged for can be deleted between the flag and the next sweep,
    // and the row survives until that sweep prunes it.
    locations: byMod.get(String(r.nexus_id)) ?? [],
  }));
}

/**
 * One tracked mod, or null. Used by the dismiss route so it can 404 rather than
 * report success for an id that is not being tracked.
 */
export async function readMissingOne(env, nexusId) {
  const all = await readMissing(env);
  return all.find((r) => r.nexus_id === String(nexusId)) ?? null;
}

/**
 * Dismiss a flagged mod, or undo that.
 *
 * Dismissing does NOT delete the row and does not reset the streak. The mod is
 * still missing; the admin has said they know. Deleting would hand the next
 * sweep a clean slate and re-flag it a day later, which is the behaviour that
 * would teach people to ignore the panel.
 *
 * Returns the updated record, or null when the id is not tracked.
 */
export async function setMissingDismissed(env, nexusId, { actor, dismissed = true, nowIso } = {}) {
  const id = String(nexusId);
  const existing = await readRows(env);
  if (!existing.has(id)) return null;

  const stamp = nowIso ?? new Date().toISOString();
  await env.DB.prepare(
    'UPDATE nexus_missing SET dismissed_by = ?, dismissed_at = ? WHERE nexus_id = ?',
  ).bind(
    dismissed ? (actor ?? null) : null,
    dismissed ? stamp : null,
    id,
  ).run();
  return readMissingOne(env, id);
}
