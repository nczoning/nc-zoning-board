/**
 * nexus_mod_status: pinned mods Nexus no longer calls published.
 *
 * A location whose mod is deleted or hidden on Nexus keeps its pin, because
 * with D1 as the registry it is a row and rows persist (#900). This module
 * decides how long a bad answer has to persist before it counts, and what each
 * kind of bad answer is allowed to do.
 *
 * ## Nexus says it outright
 *
 * The `Mod` type carries `status`, and `modsByUid` does NOT filter on it: a
 * deleted mod comes back looking like any other node. So the primary signal is
 * a string, not an absence, and it is available on the first sweep.
 *
 * That inverts what the issue assumed. Absence is the weak, rare case:
 * `fetchModsByUidThumbs` returns {} on failure, so an id that is simply not in
 * the response cannot be told apart from a Nexus outage, and only persistence
 * can settle it. A `status` of `wastebinned` needs no such argument.
 *
 * ## Three states, three rules
 *
 * | status        | confirmed after | what it does                    |
 * |---------------|-----------------|---------------------------------|
 * | `wastebinned` | 3 sweeps        | pin withheld from the dataset   |
 * | `hidden`      | 3 sweeps        | review list only, map untouched |
 * | `absent`      | 6 sweeps + 24h  | review list only, map untouched |
 *
 * **`hidden` never changes what is served.** It covers an author mid-upload and
 * a DMCA investigation equally, and the API will not say which: `Mod` has no
 * moderation field, `moderationWarnings` requires a login, and the mod page
 * refuses a machine. Only a person reading the author's stated reason can
 * decide, and the two decisions are opposite ones.
 *
 * **`wastebinned` does**, because deleted is deleted. It withholds the record
 * at build time rather than writing `locations.status`: the row stays exactly
 * as the admin left it, and if Nexus ever says published again the pin returns
 * with nobody involved. Writing the column would need a human to undo.
 *
 * ## Nothing here fails closed
 *
 * A null or unrecognised `status` reads as published. A pin must never come
 * down because a field went missing from a response, and Nexus changing the
 * vocabulary is a thing that can happen without warning on an API they
 * describe as unsupported.
 */

/** The one value that means "still on the site". Everything else is tracked. */
export const PUBLISHED = 'published';

/** Nexus's word for deleted. The only status allowed to change what is served. */
export const WASTEBINNED = 'wastebinned';

/** Local marker for "not in the response at all". Never a value Nexus sends. */
export const ABSENT = 'absent';

/**
 * Sweeps a status must repeat before it is acted on.
 *
 * Three, and it is confirmation rather than patience: one anomalous response
 * must not be able to pull a pin off the public map. It is deliberately NOT a
 * grace period for an author to finish an upload. A mod hidden for twenty
 * minutes and a mod hidden for a month both need a person to read the reason,
 * and waiting only delays the ones that matter.
 */
export const CONFIRM_SWEEPS = 3;

/**
 * Absence is held to the older, stricter rule, because it is the only one of
 * the three that a Nexus outage can manufacture.
 */
export const ABSENT_STREAK = 6;
export const ABSENT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The partial-outage guard for ABSENCE. A sweep is not believed when this many
 * ids came back empty AND they are this large a share of what was asked for:
 * `modsByUid` is chunked, and a chunk that fails after its retry returns {} for
 * its whole share, which looks exactly like a mass deletion.
 *
 * The floor matters as much as the ratio: with three pinned mods, one genuine
 * deletion is 33% and must still count.
 */
export const SWEEP_MIN_SUSPECT = 5;
export const SWEEP_MAX_RATIO = 0.25;

/**
 * The second guard, and the one that protects the MAP rather than the alert:
 * no sweep may withhold more than this many pins.
 *
 * A status-driven mass withdrawal has no innocent explanation the way an absent
 * batch does, which is exactly why it should stop and ask instead of acting.
 * Five is above any plausible real event and far below anything that would
 * empty the map.
 */
export const MAX_WITHHELD = 5;

/**
 * Does this sweep's absent set look like Nexus failing rather than mods going
 * away? Pure, and exported, because it decides whether a whole sweep is thrown
 * away and is worth testing directly.
 */
export function sweepLooksUnreliable({ missing, requested }) {
  if (missing < SWEEP_MIN_SUSPECT) return false;
  return missing >= requested * SWEEP_MAX_RATIO;
}

/**
 * Is this what Nexus says about a mod that is still on the site?
 *
 * Null included, and that is the point: an absent field is not evidence of
 * anything, and treating it as evidence would pull pins the first time the
 * schema moved.
 */
export const isPublished = (status) => status == null || String(status) === PUBLISHED;

/** Every tracked row, keyed by nexus_id. One query, no bound parameters. */
async function readRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, status, streak, first_seen_at, last_seen_at, flagged_at,
            dismissed_by, dismissed_at
       FROM nexus_mod_status`,
  ).all();
  const map = new Map();
  for (const r of results ?? []) map.set(String(r.nexus_id), r);
  return map;
}

/**
 * Has this row repeated its status long enough to act on, and not been acted on
 * already? `flagged_at` set means the alert went out and the review list has
 * it, whether or not anyone has looked.
 */
function crossesThreshold(row, nowMs) {
  if (row.flagged_at) return false;
  if (row.status !== ABSENT) return row.streak >= CONFIRM_SWEEPS;

  if (row.streak < ABSENT_STREAK) return false;
  const since = Date.parse(row.first_seen_at);
  if (!Number.isFinite(since)) return false;
  return nowMs - since >= ABSENT_MIN_AGE_MS;
}

/**
 * Fold one sweep's verdicts into the table.
 *
 * @param {object} env
 * @param {object} opts
 * @param {Map<string,string>} opts.unavailable  nexus_id -> status, for every
 *   pinned mod this sweep did NOT get a published answer for. `absent` is this
 *   module's own value; everything else is Nexus's own string, stored verbatim
 *   so an unrecognised vocabulary is recorded rather than discarded.
 * @param {string} opts.nowIso
 * @returns {Promise<{tracked:number, cleared:number, flagged:string[]}>}
 *   `flagged` is the ids that crossed on THIS sweep, which is what the caller
 *   alerts on. Already-flagged ids are not repeated.
 *
 * NOT called on a sweep the caller does not trust: this prunes every row it was
 * not told about, so a failed sweep passed through here would clear the table.
 */
export async function recordSweep(env, { unavailable = new Map(), nowIso }) {
  const stamp = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(stamp);
  const existing = await readRows(env);

  const upsert = env.DB.prepare(
    `INSERT INTO nexus_mod_status
       (nexus_id, status, streak, first_seen_at, last_seen_at, flagged_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(nexus_id) DO UPDATE SET
       status        = excluded.status,
       streak        = excluded.streak,
       first_seen_at = excluded.first_seen_at,
       last_seen_at  = excluded.last_seen_at,
       flagged_at    = excluded.flagged_at`,
  );
  const remove = env.DB.prepare('DELETE FROM nexus_mod_status WHERE nexus_id = ?');

  const statements = [];
  const flagged = [];

  for (const [rawId, status] of unavailable) {
    const id = String(rawId);
    const prev = existing.get(id);
    // A different status is a different fact, so the run restarts. Carrying the
    // clock from a `hidden` run into a `wastebinned` one would let a deletion
    // act on a confirmation it never got, and withholding a pin is the one
    // thing here a visitor can see.
    const continues = prev?.status === status;
    const row = {
      status,
      streak: continues ? prev.streak + 1 : 1,
      first_seen_at: continues ? prev.first_seen_at : stamp,
      flagged_at: continues ? (prev.flagged_at ?? null) : null,
    };
    if (crossesThreshold(row, nowMs)) {
      row.flagged_at = stamp;
      flagged.push(id);
    }
    statements.push(upsert.bind(
      id, row.status, row.streak, row.first_seen_at, stamp, row.flagged_at,
    ));
  }

  // Every row this sweep did not name: Nexus called it published, or it is no
  // longer pinned. Both are a delete rather than a reset, so an untracked mod
  // costs no write at all in the steady state. A dismissal goes with the row,
  // which is right: the admin dismissed a mod that was in trouble, and this one
  // is not.
  let cleared = 0;
  for (const id of existing.keys()) {
    if (unavailable.has(id)) continue;
    statements.push(remove.bind(id));
    cleared += 1;
  }

  if (statements.length) await env.DB.batch(statements);
  return { tracked: unavailable.size, cleared, flagged };
}

/**
 * The nexus_ids whose pins the dataset must NOT be built from: confirmed
 * deleted, and not dismissed by an admin who decided otherwise.
 *
 * Capped. A status-driven mass withdrawal has no innocent explanation, so past
 * the cap this withholds NOTHING and reports the count instead: a gutted map is
 * a worse outcome than a stale pin, and both are worse than being told.
 *
 * @returns {Promise<{withhold:Set<string>, refused:number}>}
 */
export async function readWithheld(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id FROM nexus_mod_status
      WHERE status = ? AND flagged_at IS NOT NULL AND dismissed_at IS NULL`,
  ).bind(WASTEBINNED).all();
  const ids = (results ?? []).map((r) => String(r.nexus_id));
  if (ids.length > MAX_WITHHELD) return { withhold: new Set(), refused: ids.length };
  return { withhold: new Set(ids), refused: 0 };
}

/**
 * The review list: every tracked mod, with the pins that point at it.
 *
 * Serves the unflagged rows too. The dashboard shows the confirmed ones and
 * counts the rest, which is the house rule that a display derives rather than
 * asking the API to have already decided.
 *
 * The locations query is an `IN (SELECT ...)` rather than an id list from the
 * caller, for the same reason readCandidates is: no bound parameter per mod, no
 * 100-parameter ceiling to grow into.
 */
export async function readModStatuses(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.nexus_id, m.status, m.streak, m.first_seen_at, m.last_seen_at,
            m.flagged_at, m.dismissed_by, m.dismissed_at, c.name AS mod_name
       FROM nexus_mod_status m
       LEFT JOIN nexus_cache c ON c.nexus_id = m.nexus_id
      ORDER BY m.first_seen_at`,
  ).all();
  const rows = results ?? [];
  if (!rows.length) return [];

  const { results: locs } = await env.DB.prepare(
    `SELECT id, name, status, nexus_id FROM locations
      WHERE nexus_id IN (SELECT nexus_id FROM nexus_mod_status)
      ORDER BY name`,
  ).all();
  const byMod = new Map();
  for (const l of locs ?? []) {
    const key = String(l.nexus_id);
    if (!byMod.has(key)) byMod.set(key, []);
    byMod.get(key).push({ id: l.id, name: l.name, status: l.status });
  }

  const { refused } = await readWithheld(env);

  return rows.map((r) => ({
    nexus_id: String(r.nexus_id),
    mod_name: r.mod_name ?? null,
    status: r.status,
    streak: Number(r.streak ?? 0),
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    flagged_at: r.flagged_at ?? null,
    dismissed_by: r.dismissed_by ?? null,
    dismissed_at: r.dismissed_at ?? null,
    // Says outright whether this pin is off the map, rather than leaving three
    // consumers to re-derive it from status + flagged_at + dismissed_at and one
    // of them to get it wrong. False while the cap is refusing to act, which is
    // the honest answer: the pin IS still being served.
    withheld: !refused && r.status === WASTEBINNED
      && Boolean(r.flagged_at) && !r.dismissed_at,
    // A tracked mod with no locations is possible and is not an error: the pin
    // can be deleted between one sweep and the next, and the row survives until
    // that next sweep prunes it.
    locations: byMod.get(String(r.nexus_id)) ?? [],
  }));
}

/**
 * One tracked mod, or null. Used by the dismiss route so it can 404 rather than
 * report success for an id nothing is tracking.
 */
export async function readModStatusOne(env, nexusId) {
  const all = await readModStatuses(env);
  return all.find((r) => r.nexus_id === String(nexusId)) ?? null;
}

/**
 * Dismiss a flagged mod, or undo that.
 *
 * Dismissing does NOT delete the row and does not reset the streak. The mod is
 * still in trouble; the admin has said they know. Deleting would hand the next
 * sweep a clean slate and re-flag it, which is the behaviour that teaches
 * people to ignore the panel.
 *
 * For a `wastebinned` mod it also PUTS THE PIN BACK, because withholding is
 * gated on the dismissal. That is the intended escape hatch: an admin who
 * thinks Nexus is wrong, or who wants the pin up while they point it at a
 * successor mod, needs a way to say so that is not editing the record into a
 * state they then have to remember to undo.
 *
 * Returns the updated record, or null when the id is not tracked.
 */
export async function setDismissed(env, nexusId, { actor, dismissed = true, nowIso } = {}) {
  const id = String(nexusId);
  const existing = await readRows(env);
  if (!existing.has(id)) return null;

  const stamp = nowIso ?? new Date().toISOString();
  await env.DB.prepare(
    'UPDATE nexus_mod_status SET dismissed_by = ?, dismissed_at = ? WHERE nexus_id = ?',
  ).bind(
    dismissed ? (actor ?? null) : null,
    dismissed ? stamp : null,
    id,
  ).run();
  return readModStatusOne(env, id);
}
