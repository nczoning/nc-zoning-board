/**
 * Materializer: D1 `locations` rows -> the served /v1 record map.
 *
 * The only builder of the served dataset. Every location is a D1 row,
 * including the 9 that arrived via auto-discovery before the cutover.
 *
 * Nothing auto-publishes. A tagged Nexus mod is a *candidate*, not a location,
 * so the Nexus loop here only backfills images and collects `skipped`; it
 * never creates a record. That is why `dismissed_candidates` alone replaces
 * the dual role excluded_mods.json played.
 *
 * The record key ORDER below is load-bearing: JSON.stringify emits insertion
 * order, and the /v1 payload is a public contract that was fixed by a
 * byte-for-byte parity gate at the cutover. `archives` is appended afterwards
 * by attachArchives below, so it is absent from the literal by design, not by
 * omission.
 */

import { assignDistrict } from './districts.js';

/**
 * `locations.nexus_files` as an array of Nexus download names, or null.
 *
 * null means "not mapped" and is the correct, normal state: only a record
 * sharing its Nexus page with another record needs a mapping. An empty or
 * malformed array is also null, so a half-written value cannot be read as
 * "mapped to nothing".
 */
export function parseNexusFiles(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const names = parsed.filter((n) => typeof n === 'string' && n.length > 0);
    return names.length ? names : null;
  } catch {
    return null;
  }
}

/**
 * Decode one D1 row into the intermediate entry shape.
 *
 * Two round-trip details that a byte-for-byte diff will catch and a "looks
 * right" review will not:
 * - A NULL `z` must produce a 2-element `[x, y]`, not `[x, y, null]`. Every
 *   current record has a Z, but the schema and mods.schema.json both still
 *   permit the legacy pair, so the decoder has to.
 * - NULL `yaw` / `credits` must OMIT the key rather than emit null, matching
 *   merge.js's conditional spreads.
 */
export function rowToEntry(row, locationTags) {
  return {
    id: row.id,
    name: row.name,
    nexus_id: row.nexus_id,
    coordinates: row.z === null || row.z === undefined
      ? [row.x, row.y]
      : [row.x, row.y, row.z],
    yaw: row.yaw,
    category: row.category,
    tags: resolveTags(row, locationTags),
    authors: JSON.parse(row.authors ?? '[]'),
    description: row.description ?? '',
    credits: row.credits,
  };
}

/**
 * Tags for one record.
 *
 * `locationTags` is REQUIRED, and a missing map throws rather than defaulting.
 * Tags come only from the join; the legacy `locations.tags` JSON column no
 * longer exists. A silent default would serve every record untagged while
 * looking like it worked.
 *
 * The synthetic `nczoning` marker is NOT added. Nothing auto-publishes, so the
 * marker would be a visible filter for a tag `/v1/tags` does not list and that
 * describes nothing a consumer can act on.
 */
function resolveTags(row, locationTags) {
  if (!locationTags) {
    throw new Error('materializeFromD1: locationTags is required; tags come from the join');
  }
  return [...(locationTags.get(row.id) ?? [])];
}

/**
 * @param {object} input
 * @param {Array}  input.rows          D1 `locations` rows (all statuses; filtered here)
 * @param {Set|Array} input.dismissed  nexus_ids from `dismissed_candidates`
 * @param {Array}  input.nexusNodes    raw nodes from the NCZoning GraphQL query
 * @param {Array}  input.districts     data/subdistricts.json `districts[]`
 * @param {Map}    [input.nexusIndex]  readNexusIndex(): the Nexus-derived fields
 *   keyed by nexus_id. One lookup, not two: under D1 the tagged nodes and the
 *   modsByUid backfill have both already been folded into `nexus_cache` by the
 *   sweep, so a second in-memory channel would only be a way for them to disagree.
 * @returns {{full: Object<string, object>, meta: object}}
 *
 * NO CLOCK. Every field here is a pure function of the stored data, which is
 * what lets the cron's content-hash gate suppress an unchanged tick's KV write.
 * Recency is not answered here: both consumers own a clock and derive it
 * themselves from `updated_at` and the envelope's `recently_updated_days`.
 * A time-derived field added here re-breaks the write gate; see
 * wiki/learnings/time-relative-field-cannot-ride-a-content-hash-gated-write.
 */
export function materializeFromD1({
  rows, dismissed, nexusNodes, districts, nexusIndex = new Map(),
  locationTags = null, withheld = new Set(),
}) {
  const dismissedIds = dismissed instanceof Set ? dismissed : new Set(dismissed || []);
  const withheldIds = withheld instanceof Set ? withheld : new Set(withheld || []);

  // Only published records reach the map. `hidden` keeps the row but pulls the
  // pin; `draft` has never been published.
  const publishedRows = rows.filter((r) => r.status === 'published');

  // Records whose Nexus mod has been confirmed deleted (`wastebinned` on
  // consecutive sweeps; see nexus-status.js). Withheld HERE rather than by
  // writing `locations.status`, so the row keeps whatever the admin last set
  // and a reversal on Nexus restores the pin with nobody involved. Reported on
  // /v1/meta, because a record that is published and not served is otherwise a
  // silent disagreement between the dashboard and the map.
  const withdrawn = publishedRows.filter((r) => withheldIds.has(String(r.nexus_id)));
  const published = withdrawn.length
    ? publishedRows.filter((r) => !withheldIds.has(String(r.nexus_id)))
    : publishedRows;

  // Every record's nexus_id, not just the manual ones -- the auto-discovered
  // records are rows now, so they suppress their own re-creation for free.
  const existingNexusIds = new Set(
    published
      .map((r) => String(r.nexus_id))
      .filter((id) => id && !['wip', 'dummy'].includes(id.toLowerCase())),
  );

  const skipped = [];

  for (const node of nexusNodes || []) {
    const nexusId = String(node.modId);
    if (dismissedIds.has(nexusId)) continue;
    // Already on the map. Its images come from the index like every other
    // record's, so the node has nothing left to contribute here.
    if (existingNexusIds.has(nexusId)) continue;
    // Not a location and not dismissed: a candidate, surfaced on /v1/meta as
    // `skipped`. Every such mod is listed. The block parser used to filter this
    // list down to the ones that failed to parse; nothing publishes from a
    // block any more, so a mod carrying one is a candidate like any other and
    // hiding it would only hide it from the reviewer.
    skipped.push({ nexus_id: nexusId, name: node.name || 'Unknown Mod' });
  }

  const all = published
    .map((row) => rowToEntry(row, locationTags))
    .sort((a, b) => a.name.localeCompare(b.name));

  const full = {};

  for (const entry of all) {
    const { district, subdistrict } = assignDistrict(entry.coordinates, districts);
    const t = nexusIndex.get(String(entry.nexus_id)) || null;
    const thumbs = {
      thumbnail_url: t?.thumbnailUrl ?? null,
      picture_url: t?.pictureUrl ?? null,
      updated_at: t?.updatedAt ?? null,
    };
    full[entry.id] = {
      id: entry.id,
      name: entry.name,
      nexus_id: String(entry.nexus_id),
      coordinates: entry.coordinates,
      ...(entry.yaw !== undefined && entry.yaw !== null ? { yaw: entry.yaw } : {}),
      category: entry.category,
      tags: entry.tags,
      authors: entry.authors,
      district,
      subdistrict,
      description: entry.description ?? '',
      ...(entry.credits ? { credits: entry.credits } : {}),
      ...thumbs,
    };
  }

  // How each record's archive list should be resolved. Kept out of `full`
  // deliberately: `full` is the public payload with a byte-for-byte contract,
  // and this is internal routing.
  //
  // "Contested" is a page that more than one PUBLISHED record points at. That
  // is the trigger, not "the page has several downloads": 229 of 294 pages today
  // have several downloads (main plus updates and optional patches, all one
  // location) and exactly one page has several locations. See migration 0011.
  const perPage = new Map();
  for (const row of published) {
    const id = String(row.nexus_id);
    perPage.set(id, (perPage.get(id) ?? 0) + 1);
  }
  const archivePlan = new Map();
  for (const row of published) {
    archivePlan.set(row.id, {
      contested: (perPage.get(String(row.nexus_id)) ?? 0) > 1,
      files: parseNexusFiles(row.nexus_files),
    });
  }

  return {
    full,
    archivePlan,
    meta: {
      skipped,
      // Records on a page shared with another record that have not been mapped
      // to a download. Each is served `[]` rather than the whole page, so it
      // cannot report installed off another location's files, and it is named
      // here so the state is visible instead of looking like "ships nothing".
      unmapped: published
        .filter((r) => (perPage.get(String(r.nexus_id)) ?? 0) > 1
          && !parseNexusFiles(r.nexus_files))
        .map((r) => ({ id: r.id, nexus_id: String(r.nexus_id) })),
      // Published in the registry, deliberately not on the map. Named, not
      // counted: "3 records withheld" is a number nobody can check, and the
      // dashboard's drift row has to subtract exactly these.
      withheld: withdrawn.map((r) => ({ id: r.id, nexus_id: String(r.nexus_id) })),
    },
  };
}

/**
 * Attach each record's `.archive` file names, in place and last, matching the
 * position refresh.js has always appended them in. Always an array: `[]` means
 * unknown or not yet swept, never "ships no archives", and the in-game consumer
 * reads it that way.
 *
 * Pure, and shared by the cron and the parity gate so the gate cannot pass
 * against a channel the cron does not use.
 */
/**
 * What one record's `archives` should be. The single definition of that answer.
 *
 * Exported and shared with the admin dashboard deliberately. The dashboard is
 * where a reviewer goes to CHECK this mapping, so a second copy of the rule
 * there is the one place a disagreement would be invisible: it showed the whole
 * page's listing while /v1 served the split, which reads as "the mapping did
 * not work".
 *
 * @param {object} opts
 * @param {string[]} [opts.pageArchives]    the page's flat union
 * @param {object}   [opts.archivesByFile]  that union grouped by download name
 * @param {string[]|null} [opts.files]      this record's mapped download names
 * @param {boolean}  [opts.contested]       another record points at this page
 */
export function resolveArchives({
  pageArchives = [], archivesByFile = {}, files = null, contested = false,
} = {}) {
  // The ordinary case, and all but two records today: the only record on its
  // page, so the page's whole listing is its listing.
  if (!contested) return pageArchives;

  // Two or more records share this page, so the union would hand each of them
  // the others' files and Core would report every one of them installed as soon
  // as the player had any one of them.
  //
  // Unmapped resolves empty, not to the union: a false "not installed" is a
  // missing badge, a false "installed" is a lie about the player's game. A
  // mapping that matched no download resolves empty for the same reason, since
  // the fallback IS the bug.
  if (!files) return [];
  const picked = new Set();
  for (const fileName of files) {
    for (const name of archivesByFile[fileName] ?? []) picked.add(name);
  }
  return [...picked].sort();
}

export function attachArchives(full, nexusIndex = new Map(), archivePlan = new Map()) {
  for (const rec of Object.values(full)) {
    const entry = nexusIndex.get(String(rec.nexus_id));
    const plan = archivePlan.get(rec.id);
    rec.archives = resolveArchives({
      pageArchives: entry?.archives ?? [],
      archivesByFile: entry?.archivesByFile ?? {},
      files: plan?.files ?? null,
      contested: Boolean(plan?.contested),
    });
  }
  return full;
}
