/**
 * Dataset builder: the server-side version of the merge the browser does
 * in assets/js/services.js (fetchNexusTaggedMods) + app.js concat.
 *
 * Pure function: all inputs are plain data, no fetching, no KV. The cron
 * handler (B3) feeds it CDN files + Nexus nodes; tests feed it fixtures.
 *
 * Precedence rules (must match the site):
 * - excluded_mods.json entries never appear, even with a valid block
 * - manual entries win by nexus_id; the Nexus node only contributes
 *   image/updatedAt metadata for thumbnail backfill
 * - auto entries need a valid [NCZoning] block (coords + category)
 *
 * Contract rules (frozen): auto entries get stable id `nexus-<nexus_id>`;
 * every location carries source ("manual"|"auto") and district/subdistrict.
 */

import { parseNcZoningBlock } from './parse.js';
import { assignDistrict } from './districts.js';
import { RECENTLY_UPDATED_DAYS } from './config.js';

export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * @param {object} input
 * @param {Array}  input.manualMods   compiled mods.json array
 * @param {object} input.tagsDict     data/tags.json ({tag: definition})
 * @param {object} input.excluded     data/excluded_mods.json ({nexusId: reason})
 * @param {Array}  input.nexusNodes   raw nodes from the NCZoning GraphQL query
 * @param {Array}  input.districts    data/subdistricts.json `districts[]`
 * @param {object} [input.manualThumbs] modsByUid image/updatedAt for manual
 *   mods, keyed by numeric nexus_id ({pictureUrl, thumbnailUrl, updatedAt}).
 *   Covers manual entries not tagged NCZoning (the tagged query only backfills
 *   the tagged ones). Optional so existing callers/tests don't break.
 * @param {number} [input.nowMs] wall-clock (ms) the recently_updated bool is
 *   computed against. refresh.js passes the cron tick's clock; defaults to
 *   Date.now() so other callers still work. Tests pass a fixed value.
 * @returns {{full: Object<string, object>, meta: object}}
 */
export function buildDataset({ manualMods, tagsDict, excluded, nexusNodes, districts, manualThumbs = {}, nowMs = Date.now() }) {
  const validTagNames = new Set(Object.keys(tagsDict));
  const excludedIds = new Set(Object.keys(excluded || {}));

  // Numeric nexus_ids of manual entries (WIP/Dummy have no Nexus page).
  const existingNexusIds = new Set(
    manualMods
      .map((m) => String(m.nexus_id))
      .filter((id) => !['wip', 'dummy'].includes(id.toLowerCase())),
  );

  const nexusThumbs = {}; // manual-entry image/updatedAt backfill, keyed by nexus_id
  const autoEntries = [];
  const skipped = []; // tagged mods with no valid block, surfaced for monitoring

  for (const node of nexusNodes || []) {
    const nexusId = String(node.modId);
    if (excludedIds.has(nexusId)) continue;
    if (existingNexusIds.has(nexusId)) {
      nexusThumbs[nexusId] = {
        pictureUrl: node.pictureUrl || null,
        thumbnailUrl: node.thumbnailUrl || null,
        updatedAt: node.updatedAt || null,
      };
      continue;
    }

    const parsed = parseNcZoningBlock(node.description, validTagNames);
    if (!parsed) {
      skipped.push({ nexus_id: nexusId, name: node.name || 'Unknown Mod' });
      continue;
    }

    const uploaderName = node.uploader?.name || 'Unknown';
    const summary = node.summary || '';
    autoEntries.push({
      id: `nexus-${nexusId}`,
      name: node.name || 'Unknown Mod',
      authors: [uploaderName, ...parsed.additionalAuthors],
      ...(parsed.credits ? { credits: parsed.credits } : {}),
      coordinates: parsed.coordinates,
      ...(parsed.yaw !== null ? { yaw: parsed.yaw } : {}),
      nexus_id: nexusId,
      description:
        summary.length > DESCRIPTION_MAX_LENGTH
          ? summary.slice(0, DESCRIPTION_MAX_LENGTH - 3) + '...'
          : summary,
      category: parsed.category,
      tags: [...parsed.tags],
      source: 'auto',
      thumbnail_url: node.thumbnailUrl || null,
      picture_url: node.pictureUrl || null,
      updated_at: node.updatedAt || null,
    });
  }

  const all = [
    ...manualMods.map((m) => ({ ...m, source: 'manual' })),
    ...autoEntries,
  ].sort((a, b) => a.name.localeCompare(b.name));

  // Resolve image/updatedAt for a full entry. Auto mods carry theirs from the
  // tagged node; manual mods come from the modsByUid backfill (manualThumbs),
  // falling back to the tagged-query thumbs for manual mods that happen to be
  // NCZoning-tagged. WIP/Dummy (non-numeric) manual entries resolve to nulls.
  // The field is ALWAYS present (null when unknown) so the shape stays stable
  // for DTO consumers.
  function resolveThumbs(entry) {
    if (entry.source === 'auto') {
      return {
        thumbnail_url: entry.thumbnail_url ?? null,
        picture_url: entry.picture_url ?? null,
        updated_at: entry.updated_at ?? null,
      };
    }
    const t = manualThumbs[String(entry.nexus_id)] || nexusThumbs[String(entry.nexus_id)] || null;
    return {
      thumbnail_url: t?.thumbnailUrl ?? null,
      picture_url: t?.pictureUrl ?? null,
      updated_at: t?.updatedAt ?? null,
    };
  }

  // One representation: the full record, keyed by id (the by-id endpoint reads
  // full[id]; the list endpoint serves Object.values(full), which keeps the
  // alphabetical order of `all`). No separate slim array; consumers derive any
  // aggregate (counts, category breakdown) by grouping these records locally.
  const cutoffMs = nowMs - RECENTLY_UPDATED_DAYS * 86400000;
  const full = {};

  for (const entry of all) {
    const { district, subdistrict } = assignDistrict(entry.coordinates, districts);
    const thumbs = resolveThumbs(entry);
    // Server-computed polyfill for the clockless in-game consumer. Content ×
    // wall-clock, so it must ride the periodically-rehashed content (refresh.js
    // recomputes it every cron tick), never materialise-once. NaN (bad/absent
    // date) → false.
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
      district,
      subdistrict,
      recently_updated,
      description: entry.description ?? '',
      ...(entry.credits ? { credits: entry.credits } : {}),
      ...thumbs,
    };
  }

  return {
    full,
    // skipped = tagged mods with no valid block, surfaced on /v1/meta for the
    // auto-discovery monitor. No aggregate counts: consumers derive their own.
    meta: { skipped, nexus_thumbs: nexusThumbs },
  };
}
