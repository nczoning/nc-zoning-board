/**
 * nexus_cache: the Nexus mod index, swept from the cron.
 *
 * One row per mod, being the union of every NCZoning-tagged mod (the candidate
 * pool) and every location's numeric nexus_id (served images and update times).
 * Serves the four Nexus-derived `/v1` fields via a join on nexus_id, and backs
 * the candidates list as a query rather than a live Nexus call on a public
 * route.
 *
 * ## Fetch every tick, write only what changed
 *
 * D1's free tier allows 100k row-writes/day and the cron fires 288 times.
 * Writing ~300 rows per tick is 86,400 writes/day, 86% of the cap before
 * locations and audit rows. So a sweep writes only rows whose content differs
 * from what is stored, and an unchanged tick costs nothing. Fetching is cheap
 * either way: one GraphQL call for the whole tagged set plus batched modsByUid.
 *
 * Same gate refresh.js applies to KV, and worth holding: the #849 heartbeat
 * bypassed that gate and reinstated the per-tick cost it existed to remove
 * (HEARTBEAT_MIN_INTERVAL_MS in config.js).
 *
 * Follows from the gate: **`fetched_at` is when the row last CHANGED**, not
 * when it was last checked. A per-row checked-timestamp is the 86k writes being
 * avoided. Sweep freshness is a dataset-level value.
 *
 * ## nexus_id is not unique across locations
 *
 * 296 locations carry a numeric nexus_id and use 295 distinct values: mod 23896
 * supplies two separate tattoo shops. The join to `locations` is therefore
 * ONE-TO-MANY, and both rows correctly read the same images. Do not add a
 * UNIQUE constraint on locations.nexus_id, and do not key a location lookup by
 * it (see #889).
 *
 * ## `name` is stored for comparison, never for display
 *
 * 34 of 295 location names differ from their Nexus title by curation rather
 * than staleness, for example "CP2.31 Cliffside Abode Player Home" served as
 * "Cliffside Abode Player Home". Serving this column would undo that. It exists
 * so a rename can be detected by diffing it against locations.name.
 *
 * ## D1 bound parameters
 *
 * The ceiling is 100 per query, measured
 * (learnings/d1-refuses-more-than-100-bound-parameters). Writes go through
 * DB.batch() as one statement per row, binding eight each. A single multi-row
 * statement with a placeholder per mod throws on every call at this size, and
 * surfaces in a browser as a CORS error rather than a SQL one.
 */

import { fetchTaggedModNodes, fetchModsByUidThumbs } from './nexus.js';

/** Columns compared to decide whether a row needs writing. */
const TRACKED = ['name', 'updated_at', 'thumbnail_url', 'picture_url', 'archives', 'nczoning_tagged'];

/** Nexus ids that are placeholders rather than real mods. */
const isRealNexusId = (id) => Boolean(id) && /^\d+$/.test(String(id));

/**
 * Normalise a tagged-query node into the row shape.
 *
 * `archives` stays whatever the caller already resolved (it is fetched
 * separately and expensively); null means "not known this sweep", which is
 * distinct from "known to be empty" and must not overwrite a stored value.
 */
function nodeToRow(node, tagged) {
  return {
    nexus_id: String(node.modId),
    name: node.name ?? null,
    updated_at: node.updatedAt ?? null,
    thumbnail_url: node.thumbnailUrl ?? null,
    picture_url: node.pictureUrl ?? null,
    nczoning_tagged: tagged ? 1 : 0,
  };
}

/** Existing rows, keyed by nexus_id. One query, no bound parameters. */
export async function readNexusCache(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, name, updated_at, thumbnail_url, picture_url, archives,
            nczoning_tagged, fetched_at
       FROM nexus_cache`,
  ).all();
  const map = new Map();
  for (const r of results ?? []) map.set(String(r.nexus_id), r);
  return map;
}

/**
 * Candidates: NCZoning-tagged mods that are neither a location nor dismissed.
 *
 * Pure SQL and no bound parameters, which is the point of the table. The
 * anti-joins are NOT IN subqueries rather than an id list from the caller,
 * precisely so this does not grow a placeholder per location and hit the 100
 * bound parameter ceiling at 297 records.
 */
export async function readCandidates(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, name, thumbnail_url, picture_url, updated_at
       FROM nexus_cache
      WHERE nczoning_tagged = 1
        AND nexus_id NOT IN (SELECT nexus_id FROM locations WHERE nexus_id IS NOT NULL)
        AND nexus_id NOT IN (SELECT nexus_id FROM dismissed_candidates)
      ORDER BY name`,
  ).all();
  return (results ?? []).map((r) => ({
    nexus_id: String(r.nexus_id),
    name: r.name ?? 'Unknown Mod',
    thumbnail_url: r.thumbnail_url ?? null,
    picture_url: r.picture_url ?? null,
    updated_at: r.updated_at ?? null,
  }));
}

/**
 * Decide which rows differ from what is stored.
 *
 * Exported for the tests: the write gate is the load-bearing part of this
 * module, so it is tested directly rather than only through a live sweep.
 *
 * A field that is `undefined` in the incoming row means "not resolved this
 * sweep" and never counts as a change. A field that is explicitly `null` does:
 * a mod whose image was removed should lose it.
 */
export function diffRows(incoming, existing) {
  const writes = [];
  for (const row of incoming) {
    const prev = existing.get(String(row.nexus_id));
    if (!prev) { writes.push(row); continue; }
    const changed = TRACKED.some((k) => {
      if (row[k] === undefined) return false;
      return (row[k] ?? null) !== (prev[k] ?? null);
    });
    if (changed) writes.push({ ...row });
  }
  return writes;
}

/**
 * Upsert the changed rows. One statement per row, batched.
 *
 * COALESCE on the expensive/optional columns so a sweep that did not resolve
 * them leaves the stored value alone rather than nulling it. Passing undefined
 * as a bind is an error in D1, so undefined is normalised to null first and the
 * COALESCE is what makes null mean "keep".
 */
async function writeRows(env, rows, nowIso) {
  if (!rows.length) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO nexus_cache
       (nexus_id, name, updated_at, thumbnail_url, picture_url, archives,
        nczoning_tagged, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(nexus_id) DO UPDATE SET
       name            = COALESCE(excluded.name, nexus_cache.name),
       updated_at      = COALESCE(excluded.updated_at, nexus_cache.updated_at),
       thumbnail_url   = COALESCE(excluded.thumbnail_url, nexus_cache.thumbnail_url),
       picture_url     = COALESCE(excluded.picture_url, nexus_cache.picture_url),
       archives        = COALESCE(excluded.archives, nexus_cache.archives),
       nczoning_tagged = excluded.nczoning_tagged,
       fetched_at      = excluded.fetched_at`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(
    String(r.nexus_id),
    r.name ?? null,
    r.updated_at ?? null,
    r.thumbnail_url ?? null,
    r.picture_url ?? null,
    r.archives ?? null,
    r.nczoning_tagged ?? 0,
    nowIso,
  )));
  return rows.length;
}

/**
 * One sweep. Returns a summary rather than throwing, matching runRefresh's
 * posture: a Nexus outage must leave the last known good cache in place and be
 * visible, not take the cron down with it.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl]  injected for tests
 * @param {string}   [opts.nowIso]     injected for tests
 */
export async function refreshNexusCache(env, { fetchImpl = fetch, nowIso } = {}) {
  const stamp = nowIso ?? new Date().toISOString();
  const summary = { tagged: 0, backfilled: 0, written: 0, untagged: 0, stale: false };

  let taggedNodes;
  try {
    taggedNodes = await fetchTaggedModNodes(fetchImpl);
  } catch (err) {
    // Last known good stays. Reported, not thrown: see the header note.
    summary.stale = true;
    summary.error = String(err).slice(0, 200);
    return summary;
  }

  const existing = await readNexusCache(env);
  const incoming = new Map();

  for (const node of taggedNodes ?? []) {
    if (!isRealNexusId(node.modId)) continue;
    const row = nodeToRow(node, true);
    incoming.set(row.nexus_id, row);
  }
  summary.tagged = incoming.size;

  // Locations whose images we serve but which are not tagged, so the tagged
  // query said nothing about them.
  const { results: locRows } = await env.DB.prepare(
    'SELECT DISTINCT nexus_id FROM locations WHERE nexus_id IS NOT NULL',
  ).all();
  const needBackfill = (locRows ?? [])
    .map((r) => String(r.nexus_id))
    .filter((id) => isRealNexusId(id) && !incoming.has(id));

  if (needBackfill.length) {
    // Do not wrap this in a try/catch: fetchModsByUidThumbs never throws, it
    // returns {} on failure because images are cosmetic. That empty object is
    // indistinguishable from a successful call that found nothing, so the only
    // usable signal is the count against what was requested.
    const thumbs = await fetchModsByUidThumbs(fetchImpl, needBackfill);
    for (const [id, t] of Object.entries(thumbs ?? {})) {
      incoming.set(String(id), {
        nexus_id: String(id),
        name: t.name ?? null,
        updated_at: t.updatedAt ?? null,
        thumbnail_url: t.thumbnailUrl ?? null,
        picture_url: t.pictureUrl ?? null,
        nczoning_tagged: 0,
      });
    }
    summary.backfilled = Object.keys(thumbs ?? {}).length;
    summary.backfill_requested = needBackfill.length;
    if (summary.backfilled === 0) {
      // Asked for some, got none. Either Nexus is down or every id is unknown
      // to it; both are worth surfacing rather than reporting a clean sweep.
      summary.stale = true;
      summary.error = `backfill returned nothing for ${needBackfill.length} ids`;
    }
  }

  // A mod that was tagged and no longer is must lose the flag, or it stays in
  // the candidates list forever. Set difference against what is stored, so this
  // costs a write only for mods that actually changed state.
  for (const [id, prev] of existing) {
    if (prev.nczoning_tagged === 1 && !incoming.has(id)) {
      incoming.set(id, { nexus_id: id, nczoning_tagged: 0 });
      summary.untagged += 1;
    }
  }

  const writes = diffRows([...incoming.values()], existing);
  summary.written = await writeRows(env, writes, stamp);
  return summary;
}
