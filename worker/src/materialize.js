/**
 * Materializer: D1 `locations` rows -> the served /v1 record map.
 *
 * The D1-sourced counterpart to buildDataset() in merge.js. Phase 1 only
 * *verifies* it (scripts/parity-check.mjs diffs its output against the live
 * API byte-for-byte); the cron does not call it until Phase 2.
 *
 * WHAT CHANGES vs merge.js, and why the shape does not:
 * - Locations no longer come from mods.json + parsed Nexus blocks. They all
 *   come from D1, including the 9 records that arrived via
 *   auto-discovery (imported at Phase 1, `source='auto'` preserved).
 * - Nothing auto-publishes any more. A tagged Nexus mod with a valid block is
 *   a *candidate*, not a location. So the Nexus loop here only ever backfills
 *   images and collects `skipped`; it never creates a record. That is the
 *   plan's model, and it is why `dismissed_candidates` alone replaces the dual
 *   role excluded_mods.json used to play.
 *
 * The record key ORDER below is load-bearing: /v1 responses are compared
 * byte-for-byte at the Phase 1 gate, and JSON.stringify emits insertion order.
 * It mirrors merge.js:141-157 deliberately, and the parity diff is what proves
 * the mirror is faithful. `archives` is appended afterwards by attachArchives
 * below, so it is absent from the literal by design, not by omission.
 */

import { parseNcZoningBlock } from './parse.js';
import { assignDistrict } from './districts.js';
import { RECENTLY_UPDATED_DAYS } from './config.js';

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
    source: row.source,
    description: row.description ?? '',
    credits: row.credits,
  };
}

/**
 * Tags for one record.
 *
 * When `locationTags` is supplied it is authoritative — that is the join, and
 * the production path. Without it the legacy `locations.tags` JSON column is
 * used; migration 0002 keeps both in sync precisely so the switch can be
 * proven byte-for-byte before the column is dropped.
 *
 * `nczoning` is re-added for auto-sourced records because it is not a registry
 * row: it is a marker auto-discovery adds, and merge.js prepends it the same
 * way. It goes first, matching every existing auto record.
 */
function resolveTags(row, locationTags) {
  if (!locationTags) return JSON.parse(row.tags ?? '[]');
  const slugs = locationTags.get(row.id) ?? [];
  return row.source === 'auto' ? ['nczoning', ...slugs] : [...slugs];
}

/**
 * @param {object} input
 * @param {Array}  input.rows          D1 `locations` rows (all statuses; filtered here)
 * @param {Set|Array} input.dismissed  nexus_ids from `dismissed_candidates`
 * @param {object} input.tagsDict      data/tags.json, for block validation
 * @param {Array}  input.nexusNodes    raw nodes from the NCZoning GraphQL query
 * @param {Array}  input.districts     data/subdistricts.json `districts[]`
 * @param {Map}    [input.nexusIndex]  readNexusIndex(): the Nexus-derived fields
 *   keyed by nexus_id. One lookup, not two: under D1 the tagged nodes and the
 *   modsByUid backfill have both already been folded into `nexus_cache` by the
 *   sweep, so a second in-memory channel would only be a way for them to disagree.
 * @param {number} [input.nowMs]       clock the recently_updated bool is computed against
 * @returns {{full: Object<string, object>, meta: object}}
 */
export function materializeFromD1({
  rows, dismissed, tagsDict, nexusNodes, districts, nexusIndex = new Map(),
  locationTags = null, nowMs = Date.now(),
}) {
  const validTagNames = new Set(Object.keys(tagsDict));
  const dismissedIds = dismissed instanceof Set ? dismissed : new Set(dismissed || []);

  // Only published records reach the map. `hidden` keeps the row but pulls the
  // pin (the Nexus-deletion case); `draft` has never been published.
  const published = rows.filter((r) => r.status === 'published');

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
    // Not a location and not dismissed: a candidate. Surfaced on /v1/meta as
    // `skipped` exactly as before when it has no valid block. A mod WITH a
    // valid block is also not published here -- see the header note.
    const parsed = parseNcZoningBlock(node.description, validTagNames);
    if (!parsed) skipped.push({ nexus_id: nexusId, name: node.name || 'Unknown Mod' });
  }

  const all = published
    .map((row) => rowToEntry(row, locationTags))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cutoffMs = nowMs - RECENTLY_UPDATED_DAYS * 86400000;
  const full = {};

  for (const entry of all) {
    const { district, subdistrict } = assignDistrict(entry.coordinates, districts);
    const t = nexusIndex.get(String(entry.nexus_id)) || null;
    const thumbs = {
      thumbnail_url: t?.thumbnailUrl ?? null,
      picture_url: t?.pictureUrl ?? null,
      updated_at: t?.updatedAt ?? null,
    };
    const recently_updated = thumbs.updated_at
      ? Date.parse(thumbs.updated_at) > cutoffMs
      : false;

    full[entry.id] = {
      id: entry.id,
      name: entry.name,
      nexus_id: String(entry.nexus_id),
      coordinates: entry.coordinates,
      ...(entry.yaw !== undefined && entry.yaw !== null ? { yaw: entry.yaw } : {}),
      category: entry.category,
      tags: entry.tags,
      authors: entry.authors,
      source: entry.source,
      district,
      subdistrict,
      recently_updated,
      description: entry.description ?? '',
      ...(entry.credits ? { credits: entry.credits } : {}),
      ...thumbs,
    };
  }

  return { full, meta: { skipped } };
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
export function attachArchives(full, nexusIndex = new Map()) {
  for (const rec of Object.values(full)) {
    rec.archives = nexusIndex.get(String(rec.nexus_id))?.archives ?? [];
  }
  return full;
}
