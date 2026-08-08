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
 * `summary` and `uploader` are the opposite: they exist to be handed out. The
 * candidates list serves them so the submit form can prefill a description and
 * an author, which is exactly what merge.js builds those two fields of an
 * auto-discovered record from. They are starting points for a submitter to
 * edit, never published values.
 *
 * ## Archives live here too, and cost the most to fetch
 *
 * The `.archive` file names a mod ships (installed-mod detection) are a
 * per-mod, multi-subrequest fetch, so they are budgeted per tick and refetched
 * only when a mod re-uploads. `archives_at` records the `updated_at` they were
 * read against, because `updated_at` itself moves the instant Nexus reports the
 * re-upload.
 *
 * refreshArchives() is a SEPARATE pass from the sweep, driven by the records
 * the dataset actually serves rather than by the `locations` table. The two sets
 * are the same now that production reads D1, but keeping the pass driven by what
 * is served means it stays correct if they ever diverge again. They used to:
 * while production built from mods.json, a mod merged to main reached mods.json
 * and not D1, and driving archives off the table would have shipped no file list
 * for exactly those mods.
 *
 * ## D1 bound parameters
 *
 * The ceiling is 100 per query, measured
 * (learnings/d1-refuses-more-than-100-bound-parameters). Writes go through
 * DB.batch() as one statement per row, binding eight each. A single multi-row
 * statement with a placeholder per mod throws on every call at this size, and
 * surfaces in a browser as a CORS error rather than a SQL one.
 */

import { fetchTaggedModNodes, fetchModsByUidThumbs, fetchModArchiveNames } from './nexus.js';
import { readArchives } from './store.js';
import {
  recordSweep, sweepLooksUnreliable, isPublished, ABSENT, PUBLISHED,
} from './nexus-status.js';

/** Columns compared to decide whether a row needs writing. */
const TRACKED = [
  'name', 'summary', 'uploader', 'updated_at', 'thumbnail_url', 'picture_url',
  'archives', 'archives_by_file', 'archives_at', 'nczoning_tagged', 'status',
];

// Per-tick archive budgets, carried over from refresh.js unchanged. Archives are
// near-static, so steady state fetches nothing; these cap the cold fill and any
// re-upload burst so archive work can never breach the Worker's 50-subrequest
// limit alongside the tagged query and the thumbnail batches. A cold cache fills
// over roughly ceil(records / ARCHIVE_MOD_BUDGET) ticks, which the one-time
// carry-over below is there to avoid paying at all.
const ARCHIVE_MOD_BUDGET = 15;
const ARCHIVE_SUBREQUEST_BUDGET = 25;

/**
 * How long after a mod's own `updated_at` an unreadable file listing counts as
 * "too early" rather than as "this mod ships no archives".
 *
 * Nexus publishes a file's contents manifest minutes to hours AFTER the upload
 * that `updated_at` reports, and a re-upload re-queues the mod the moment that
 * timestamp moves. The two race: mod 31332 was refetched 2m42s after its own
 * upload (measured 2026-08-03), read 404 on every file, and a listing stored
 * from that answer says "ships nothing" until the mod's next release, because
 * `archives_at` already matches.
 *
 * The bound is time rather than an attempt counter because time is already
 * stored. `updated_at` says how old the upload is, so no column, no migration,
 * and no per-mod state to keep consistent.
 *
 * A preview that is broken for good therefore costs a day of retries and then
 * records `[]`. It cannot sit at the head of the newest-first queue forever,
 * which is the starvation the 404-survives-ok rule in nexus.js exists to
 * prevent.
 */
const ARCHIVE_LISTING_GRACE_MS = 24 * 60 * 60 * 1000;

/** Whether `updatedAt` is recent enough that an unread listing is worth retrying. */
function withinListingGrace(updatedAt, nowIso) {
  const uploaded = Date.parse(updatedAt ?? '');
  const now = Date.parse(nowIso);
  if (!Number.isFinite(uploaded) || !Number.isFinite(now)) return false;
  return now - uploaded < ARCHIVE_LISTING_GRACE_MS;
}

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
    // The tagged query returns published mods only (measured against the live
    // API), so a node arriving from it is published by construction. Stated
    // rather than read off the node, which does not carry the field.
    status: tagged ? PUBLISHED : (node.status ?? null),
    // The two fields merge.js builds an auto-discovered record's description
    // and first author from, kept so the submit form can prefill the same way.
    summary: node.summary ?? null,
    uploader: node.uploader?.name ?? null,
    updated_at: node.updatedAt ?? null,
    thumbnail_url: node.thumbnailUrl ?? null,
    picture_url: node.pictureUrl ?? null,
    nczoning_tagged: tagged ? 1 : 0,
  };
}

/** Existing rows, keyed by nexus_id. One query, no bound parameters. */
export async function readNexusCache(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, name, summary, uploader, updated_at, thumbnail_url,
            picture_url, archives, archives_at, nczoning_tagged, status, fetched_at
       FROM nexus_cache`,
  ).all();
  const map = new Map();
  for (const r of results ?? []) map.set(String(r.nexus_id), r);
  return map;
}

/**
 * A stored `archives` value as an array. Never throws: a malformed cell is a
 * cosmetic loss for one mod, and letting it propagate would take the whole
 * refresh into last-known-good over a file listing.
 */
function parseArchives(value) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * A stored `archives_by_file` value as `{ [downloadName]: string[] }`. Same
 * posture as parseArchives: a malformed cell degrades to "no breakdown", which
 * falls back to the flat union rather than taking the refresh down.
 */
function parseArchivesByFile(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * The four Nexus-derived /v1 fields, keyed by nexus_id, for the materializer to
 * join on. One-to-many: two locations sharing a mod read the same entry.
 *
 * Callers must treat an empty index as a failure rather than as "no images" --
 * see the guard in refresh.js. Serving 297 records with every image stripped is
 * a valid-looking dataset that would sail through the content hash and replace
 * a good one.
 */
export async function readNexusIndex(env) {
  const { results } = await env.DB.prepare(
    `SELECT nexus_id, updated_at, thumbnail_url, picture_url, archives, archives_by_file,
            archives_at, nczoning_tagged
       FROM nexus_cache`,
  ).all();
  const index = new Map();
  for (const r of results ?? []) {
    index.set(String(r.nexus_id), {
      thumbnailUrl: r.thumbnail_url ?? null,
      pictureUrl: r.picture_url ?? null,
      updatedAt: r.updated_at ?? null,
      archives: parseArchives(r.archives),
      // The same names grouped by the download they came from. Empty for every
      // row written before migration 0011 and refilled on that mod's next
      // listing fetch; consulted only for a page that maps to >1 location.
      archivesByFile: parseArchivesByFile(r.archives_by_file),
      // Carried so an archives-only write can preserve it: writeRows sets the
      // flag unconditionally, and a candidate that lost it here would quietly
      // drop out of the candidates list.
      nczoning_tagged: r.nczoning_tagged ?? 0,
      // `archives: []` is a real answer -- plenty of mods ship no .archive at
      // all -- so the array cannot say whether the listing has ever been read.
      // These two carry that, and only refreshArchives looks at them.
      archivesKnown: r.archives != null,
      // Distinct from `archivesByFile` being empty: `{}` is a real answer (the
      // page's downloads had no readable contents), NULL means the breakdown
      // has never been computed. Only the second is a reason to refetch, and
      // conflating them would refetch a genuinely empty page every tick.
      archivesByFileKnown: r.archives_by_file != null,
      archivesAt: r.archives_at ?? null,
    });
  }
  return index;
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
    `SELECT nexus_id, name, summary, uploader, thumbnail_url, picture_url, updated_at
       FROM nexus_cache
      WHERE nczoning_tagged = 1
        AND nexus_id NOT IN (SELECT nexus_id FROM locations WHERE nexus_id IS NOT NULL)
        AND nexus_id NOT IN (SELECT nexus_id FROM dismissed_candidates)
      ORDER BY name`,
  ).all();
  return (results ?? []).map((r) => ({
    nexus_id: String(r.nexus_id),
    name: r.name ?? 'Unknown Mod',
    summary: r.summary ?? null,
    uploader: r.uploader ?? null,
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
       (nexus_id, name, summary, uploader, updated_at, thumbnail_url, picture_url,
        archives, archives_by_file, archives_at, nczoning_tagged, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(nexus_id) DO UPDATE SET
       name            = COALESCE(excluded.name, nexus_cache.name),
       summary         = COALESCE(excluded.summary, nexus_cache.summary),
       uploader        = COALESCE(excluded.uploader, nexus_cache.uploader),
       updated_at      = COALESCE(excluded.updated_at, nexus_cache.updated_at),
       thumbnail_url   = COALESCE(excluded.thumbnail_url, nexus_cache.thumbnail_url),
       picture_url     = COALESCE(excluded.picture_url, nexus_cache.picture_url),
       archives        = COALESCE(excluded.archives, nexus_cache.archives),
       archives_by_file = COALESCE(excluded.archives_by_file, nexus_cache.archives_by_file),
       archives_at     = COALESCE(excluded.archives_at, nexus_cache.archives_at),
       nczoning_tagged = excluded.nczoning_tagged,
       status          = COALESCE(excluded.status, nexus_cache.status),
       fetched_at      = excluded.fetched_at`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(
    String(r.nexus_id),
    r.name ?? null,
    r.summary ?? null,
    r.uploader ?? null,
    r.updated_at ?? null,
    r.thumbnail_url ?? null,
    r.picture_url ?? null,
    r.archives ?? null,
    r.archives_by_file ?? null,
    r.archives_at ?? null,
    r.nczoning_tagged ?? 0,
    r.status ?? null,
    nowIso,
  )));
  return rows.length;
}

/**
 * Resolve `archives` for the records this cycle is about to serve, budgeted.
 *
 * Driven by `records` (the built dataset), not by the `locations` table -- see
 * the header note. Updates `index` in place so the caller can attach the result
 * without re-reading, and writes only the rows whose listing actually changed.
 *
 * A mod is due when its listing has never been read, or when the `updated_at`
 * it was read against no longer matches the record's -- the exact re-upload
 * signal for its file contents. Newest first, so a re-upload beats the cold
 * fill for the budget. A transient failure (`ok:false`) is skipped rather than
 * stored, so the next tick retries instead of recording a partial listing as
 * final.
 *
 * A third outcome is skipped too: `ok:true` with `listed:false`, meaning every
 * file preview 404'd and the empty array is a silence rather than an answer.
 * That is worth retrying only while the upload is recent enough for Nexus to
 * still be publishing its manifests, so ARCHIVE_LISTING_GRACE_MS bounds it and
 * an older mod stores `[]`.
 *
 * @param {object} env
 * @param {typeof fetch} fetchImpl
 * @param {object} opts
 * @param {Array}  opts.records  served records, each `{nexus_id, updated_at}`
 * @param {Map}    opts.index    readNexusIndex(), mutated in place
 * @param {string} opts.nowIso
 */
export async function refreshArchives(env, fetchImpl, { records, index, nowIso }) {
  const summary = {
    seeded: 0, fetched: 0, unlisted: 0, pending: 0, written: 0,
  };
  const stamp = nowIso ?? new Date().toISOString();

  const due = new Map();
  // Rows whose listing is current but predate migration 0011, so they have no
  // per-download breakdown. Kept separate from `due`: their `archives` is fine
  // and must not be re-seeded, they only need the grouping recomputed. Without
  // this the backfill never happens at all, because a listing that already
  // matches its `updated_at` is never refetched, and the download picker would
  // sit on "no breakdown cached" forever.
  //
  // Self-limiting: one fetch writes the column (JSON.stringify always yields at
  // least `{}`), so a row leaves this set permanently. The whole registry
  // drains in roughly ceil(records / ARCHIVE_MOD_BUDGET) ticks, behind the same
  // budget as any other archive work.
  const breakdownDue = new Map();
  for (const rec of records) {
    const id = String(rec.nexus_id);
    if (!isRealNexusId(id) || due.has(id) || breakdownDue.has(id)) continue;
    const updatedAt = rec.updated_at ?? null;
    const entry = index.get(id);
    if (entry?.archivesKnown && entry.archivesAt === updatedAt) {
      if (!entry.archivesByFileKnown) breakdownDue.set(id, updatedAt);
      continue;
    }
    due.set(id, updatedAt);
  }
  if (!due.size && !breakdownDue.size) return summary;

  // One-time carry-over from the KV blob this table replaces. Worth the read
  // twice over: it skips a ~20 tick cold fill, and archive-seeds.json holds
  // hand-built listings for mods whose Nexus "Preview file contents" is broken,
  // which a refetch would silently replace with nothing. The read stops
  // happening once every served mod has a listing, because `due` is then empty.
  let seeds = {};
  try {
    seeds = await readArchives(env);
  } catch {
    // The blob is an optimisation, not a source. Fetching covers its absence.
  }

  const resolved = new Map();
  // `archivesByFile` is undefined for a seeded listing (archive-seeds.json is a
  // flat array and has no download breakdown). Left undefined it COALESCEs to
  // "keep whatever is stored", which is right: a seed must not erase a
  // breakdown a real fetch already produced.
  const take = (id, updatedAt, archives, archivesByFile) => {
    resolved.set(id, { archives, archivesByFile, updatedAt });
    index.set(id, {
      ...(index.get(id) ?? { thumbnailUrl: null, pictureUrl: null, updatedAt }),
      archives,
      archivesByFile: archivesByFile ?? index.get(id)?.archivesByFile ?? {},
      archivesKnown: true,
      archivesAt: updatedAt,
    });
    due.delete(id);
    breakdownDue.delete(id);
  };

  for (const [id, updatedAt] of [...due]) {
    const seed = seeds[id];
    if (!seed || (seed.updatedAt ?? null) !== updatedAt || !Array.isArray(seed.archives)) continue;
    take(id, updatedAt, seed.archives);
    summary.seeded += 1;
  }

  // Listing work first, breakdown backfill with whatever budget is left: a mod
  // with no file list at all is a worse state than one with a list and no
  // grouping, and the backfill is a one-off that can take as many ticks as it
  // needs.
  const ordered = [
    ...[...due].sort((a, b) => String(b[1] ?? '').localeCompare(String(a[1] ?? ''))),
    ...breakdownDue,
  ];
  let mods = 0;
  let subrequests = 0;
  for (const [id, updatedAt] of ordered) {
    if (mods >= ARCHIVE_MOD_BUDGET || subrequests >= ARCHIVE_SUBREQUEST_BUDGET) break;
    const res = await fetchModArchiveNames(fetchImpl, id);
    mods += 1;
    subrequests += res.subrequests;
    if (!res.ok) continue;
    if (!res.listed && withinListingGrace(updatedAt, stamp)) {
      // Nothing was read and the upload is new enough that Nexus is probably
      // still publishing its manifests. Leave it due for the next tick.
      summary.unlisted += 1;
      continue;
    }
    // A backfill refetch must never downgrade a listing it was not asked to
    // change. If Nexus has stopped serving this mod's manifests since the
    // listing was stored, the fetch comes back empty; taking that would turn a
    // good file list into "ships nothing" for a mod that only needed grouping.
    const backfillOnly = breakdownDue.has(id) && !due.has(id);
    const keep = backfillOnly && !res.archives.length
      ? (index.get(id)?.archives ?? [])
      : res.archives;
    take(id, updatedAt, keep, res.archivesByFile);
    summary.fetched += 1;
  }
  summary.pending = due.size + breakdownDue.size;

  // A row per mod, same batching and the same 100-bound-parameter ceiling as
  // the sweep. Nothing resolved means nothing written, which is the steady
  // state: archives only move when a mod re-uploads.
  const rows = [...resolved].map(([nexusId, r]) => ({
    nexus_id: nexusId,
    nczoning_tagged: index.get(nexusId)?.nczoning_tagged ?? 0,
    archives: JSON.stringify(r.archives),
    archives_by_file: r.archivesByFile ? JSON.stringify(r.archivesByFile) : null,
    archives_at: r.updatedAt,
  }));
  summary.written = await writeRows(env, rows, stamp);
  return summary;
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
 * @param {Array}    [opts.taggedNodes] the tagged set, when the caller has
 *   already fetched it. The cron does: one GraphQL call serves both this sweep
 *   and the dataset build, and a second would double the cost of the tick.
 */
export async function refreshNexusCache(env, { fetchImpl = fetch, nowIso, taggedNodes: given } = {}) {
  const stamp = nowIso ?? new Date().toISOString();
  const summary = { tagged: 0, backfilled: 0, written: 0, untagged: 0, stale: false };

  let taggedNodes = given;
  if (!taggedNodes) {
    try {
      taggedNodes = await fetchTaggedModNodes(fetchImpl);
    } catch (err) {
      // Last known good stays. Reported, not thrown: see the header note.
      summary.stale = true;
      summary.error = String(err).slice(0, 200);
      return summary;
    }
  }

  const existing = await readNexusCache(env);
  const incoming = new Map();

  for (const node of taggedNodes ?? []) {
    if (!isRealNexusId(node.modId)) continue;
    const row = nodeToRow(node, true);
    incoming.set(row.nexus_id, row);
  }
  summary.tagged = incoming.size;

  // Mods with a pin but no NCZoning tag, which the tagged query says nothing
  // about. DISTINCT, because one mod can supply two locations.
  const { results: locRows } = await env.DB.prepare(
    'SELECT DISTINCT nexus_id FROM locations WHERE nexus_id IS NOT NULL',
  ).all();
  const pinnedIds = (locRows ?? []).map((r) => String(r.nexus_id)).filter(isRealNexusId);
  const needBackfill = pinnedIds.filter((id) => !incoming.has(id));

  // Every pinned mod this sweep has an answer about: the ones asked via
  // modsByUid, and the ones the tagged query already returned (which is proof
  // of `published`, since that query serves published mods only).
  //
  // Load-bearing for the recovery report, NOT for the counting. A tracked mod
  // that has dropped out of this set is one nothing points at any more, which
  // is a different fact from the mod being fixed. See recordSweep.
  const considered = new Set(pinnedIds);

  // What this sweep learned about each pinned mod that is not published:
  // nexus_id -> status, where `absent` means the response did not mention it.
  // Folded into nexus_mod_status at the end, once it is known whether the sweep
  // can be trusted at all.
  const unavailable = new Map();
  let missingIds = [];

  if (needBackfill.length) {
    // Do not wrap this in a try/catch: fetchModsByUidThumbs never throws, it
    // returns {} on failure because images are cosmetic. That empty object is
    // indistinguishable from a successful call that found nothing, so the only
    // usable signal is the count against what was requested.
    const thumbs = await fetchModsByUidThumbs(fetchImpl, needBackfill);
    const returned = new Set(Object.keys(thumbs ?? {}).map(String));
    missingIds = needBackfill.filter((id) => !returned.has(id));
    for (const [id, t] of Object.entries(thumbs ?? {})) {
      // A deleted or hidden mod is RETURNED by modsByUid, unlike the tagged
      // query, which filters. Its images and name are cached like any other
      // (they are what the review list shows); `status` is what says the pin
      // needs looking at.
      if (!isPublished(t.status)) unavailable.set(String(id), String(t.status));
      incoming.set(String(id), {
        nexus_id: String(id),
        name: t.name ?? null,
        status: t.status ?? null,
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
  summary.modStatus = await trackModStatus(
    env, { unavailable, considered, missingIds, needBackfill, summary, stamp },
  );
  return summary;
}

/**
 * Fold this sweep's verdicts into `nexus_mod_status` (#900).
 *
 * Runs after the cache write, and never fails the sweep: a mod that vanished
 * from Nexus is worth telling someone about, and it is not worth costing the
 * dataset its freshness when the bookkeeping for it hits a D1 error. Same
 * posture as archives.
 *
 * Two reasons to skip a sweep entirely, and both are the difference between a
 * useful flag and one Nexus outage condemning the whole registry:
 *
 *   * `summary.stale` -- the all-or-nothing case detected above. Asked for
 *     some, got none: that is Nexus, not the mods.
 *   * `sweepLooksUnreliable` -- the partial case the stale flag cannot see.
 *     modsByUid is chunked and a chunk that fails after its retry returns {}
 *     for its whole share, which looks like a simultaneous mass deletion.
 *
 * Both guards are about ABSENCE, which is the only one of the three states a
 * Nexus failure can manufacture: a failed chunk returns no node, never a node
 * saying `wastebinned`. They still gate the whole step, because a sweep that
 * cannot be trusted about half its ids should not be recording verdicts on the
 * other half either.
 *
 * Skipping leaves the stored runs untouched rather than resetting them: a mod
 * that really is gone keeps the count it has earned and picks up again on the
 * next sweep worth believing.
 */
async function trackModStatus(
  env, { unavailable, considered, missingIds, needBackfill, summary, stamp },
) {
  if (summary.stale) return { skipped: 'stale', flagged: [] };
  if (sweepLooksUnreliable({ missing: missingIds.length, requested: needBackfill.length })) {
    console.warn(
      `nexus_mod_status: ignoring sweep, ${missingIds.length} of ${needBackfill.length} `
      + 'ids came back empty (reads as a Nexus failure, not a deletion)',
    );
    return { skipped: 'unreliable', flagged: [] };
  }
  // Absence is folded in only now, so the guards above judge it first.
  for (const id of missingIds) unavailable.set(id, ABSENT);
  try {
    return await recordSweep(env, { unavailable, considered, nowIso: stamp });
  } catch (err) {
    console.warn('nexus_mod_status tracking failed (non-fatal):', String(err).slice(0, 200));
    return { skipped: 'error', flagged: [], error: String(err).slice(0, 200) };
  }
}
