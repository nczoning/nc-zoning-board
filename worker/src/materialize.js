/**
 * Materializer: D1 `locations` rows -> the served /v1 record map.
 *
 * The D1-sourced counterpart to buildDataset() in merge.js. Phase 1 only
 * *verifies* it (scripts/parity-check.mjs diffs its output against the live
 * API byte-for-byte); the cron does not call it until Phase 2.
 *
 * WHAT CHANGES vs merge.js, and why the shape does not:
 * - Locations no longer come from mods.json + parsed Nexus blocks. They all
 *   come from D1, including the 9 records that originally arrived via
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
 * the mirror is faithful. `archives` is appended by the caller (as refresh.js
 * does today), so it is absent here by design, not by omission.
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
export function rowToEntry(row) {
  return {
    id: row.id,
    name: row.name,
    nexus_id: row.nexus_id,
    coordinates: row.z === null || row.z === undefined
      ? [row.x, row.y]
      : [row.x, row.y, row.z],
    yaw: row.yaw,
    category: row.category,
    tags: JSON.parse(row.tags ?? '[]'),
    authors: JSON.parse(row.authors ?? '[]'),
    source: row.source,
    description: row.description ?? '',
    credits: row.credits,
  };
}

/**
 * @param {object} input
 * @param {Array}  input.rows          D1 `locations` rows (all statuses; filtered here)
 * @param {Set|Array} input.dismissed  nexus_ids from `dismissed_candidates`
 * @param {object} input.tagsDict      data/tags.json, for block validation
 * @param {Array}  input.nexusNodes    raw nodes from the NCZoning GraphQL query
 * @param {Array}  input.districts     data/subdistricts.json `districts[]`
 * @param {object} [input.manualThumbs] modsByUid image/updatedAt, keyed by nexus_id
 * @param {number} [input.nowMs]       clock the recently_updated bool is computed against
 * @returns {{full: Object<string, object>, meta: object}}
 */
export function materializeFromD1({
  rows, dismissed, tagsDict, nexusNodes, districts, manualThumbs = {}, nowMs = Date.now(),
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

  const nexusThumbs = {};
  const skipped = [];

  for (const node of nexusNodes || []) {
    const nexusId = String(node.modId);
    if (dismissedIds.has(nexusId)) continue;
    if (existingNexusIds.has(nexusId)) {
      nexusThumbs[nexusId] = {
        pictureUrl: node.pictureUrl || null,
        thumbnailUrl: node.thumbnailUrl || null,
        updatedAt: node.updatedAt || null,
      };
      continue;
    }
    // Not a location and not dismissed: a candidate. Surfaced on /v1/meta as
    // `skipped` exactly as before when it has no valid block. A mod WITH a
    // valid block is also not published here -- see the header note.
    const parsed = parseNcZoningBlock(node.description, validTagNames);
    if (!parsed) skipped.push({ nexus_id: nexusId, name: node.name || 'Unknown Mod' });
  }

  const all = published.map(rowToEntry).sort((a, b) => a.name.localeCompare(b.name));

  const cutoffMs = nowMs - RECENTLY_UPDATED_DAYS * 86400000;
  const full = {};

  for (const entry of all) {
    const { district, subdistrict } = assignDistrict(entry.coordinates, districts);
    const t = manualThumbs[String(entry.nexus_id)] || nexusThumbs[String(entry.nexus_id)] || null;
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

  return { full, meta: { skipped, nexus_thumbs: nexusThumbs } };
}
