/**
 * nexus_cache: the Nexus mod index, refreshed from the cron.
 *
 * Holds one row per mod we care about, which is the union of
 *   - every mod currently carrying the NCZoning tag (candidates), and
 *   - every location's numeric nexus_id (served images and update times).
 *
 * WHY THIS TABLE EARNS ITS KEEP
 *
 * Before it, the four Nexus-derived served fields were fetched live on every
 * cron tick and resolved two different ways depending on `source`: auto records
 * carried their own images from the tagged query, manual ones came from a
 * separate modsByUid backfill (materialize.js:136, merge.js resolveThumbs).
 * One table collapses that to a single lookup, and it is what lets the
 * candidates list be a query instead of a live Nexus call on a public
 * unauthenticated route.
 *
 * THE WRITE BUDGET IS THE WHOLE DESIGN
 *
 * D1's free tier allows 100k row-writes/day. The cron fires every 5 minutes,
 * so 288 times a day. Writing ~300 rows on every tick is 86,400 writes/day,
 * 86% of the cap, before locations writes and audit rows. That does not fit.
 *
 * So: FETCH every tick (cheap: one GraphQL call for the whole tagged set, plus
 * batched modsByUid for the rest), but WRITE only rows whose content actually
 * changed. A tick where nothing changed on Nexus costs zero writes, and a mod's
 * name, images or file list change rarely.
 *
 * This is the same content-hash gate refresh.js already applies to KV, and the
 * reason to be strict about it is on the record: issue #849 added a liveness
 * heartbeat that deliberately bypassed that gate and reinstated the exact
 * per-tick write cost the gate existed to remove. HEARTBEAT_MIN_INTERVAL_MS in
 * config.js is the scar. This is the same mistake available at 86x the scale.
 *
 * Consequence, deliberately accepted: `fetched_at` means "when this row last
 * CHANGED", not "when we last checked". Storing a per-row checked-timestamp is
 * precisely the 86k writes being avoided. Sweep freshness is a dataset-level
 * value, not a per-row one.
 *
 * nexus_id IS NOT UNIQUE ACROSS LOCATIONS
 *
 * Measured 2026-07-27: 296 locations carry a numeric nexus_id and they use 295
 * distinct values. Mod 23896 ("Watson Tattoo Shops") supplies two locations,
 * Little China Pink Ink and Northside Tattoo & Body Mods, which is legitimate:
 * one mod can add two separate places, each deserving its own pin.
 *
 * So the join from here to `locations` is ONE-TO-MANY. Both locations read the
 * same images and the same upstream title, which is correct. Do not add a
 * UNIQUE constraint on locations.nexus_id, and do not key a location lookup by
 * it.
 *
 * NAME IS NOT DERIVED FROM THIS TABLE, deliberately. 34 of 295 location names
 * differ from the Nexus title, and the differences are curation rather than
 * staleness: stripped version prefixes ("CP2.31 Cliffside Abode Player Home"),
 * stripped tool suffixes ("(World Builder)", "Worldbuilder"), stripped
 * marketing tails ("- REVOLUTION"), tidied whitespace. Serving `name` from
 * here would undo all of it. The stored title is for DETECTING a rename, by
 * comparing it against locations.name, not for replacing one.
 *
 * D1 BOUND PARAMETER LIMIT
 *
 * D1 allows exactly 100 bound parameters PER QUERY, measured, not documented
 * (learnings/d1-refuses-more-than-100-bound-parameters). Every write here goes
 * through DB.batch() as one statement per row, so each statement binds about
 * eight. Never assemble a single multi-row statement with one placeholder per
 * mod: at ~300 mods that throws on every call, and the browser reports it as a
 * CORS error rather than as the SQL error it is.
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
    // fetchModsByUidThumbs NEVER throws: thumbnails are cosmetic, so it swallows
    // and returns {} on any failure. A try/catch here would be dead code, and
    // the empty object it returns on total failure is indistinguishable from a
    // successful call that found nothing. So the check is on the COUNT against
    // what was asked for, not on an exception that cannot arrive.
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
