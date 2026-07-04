/**
 * Dataset builder — the server-side version of the merge the browser does
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

export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * @param {object} input
 * @param {Array}  input.manualMods   compiled mods.json array
 * @param {object} input.tagsDict     data/tags.json ({tag: definition})
 * @param {object} input.excluded     data/excluded_mods.json ({nexusId: reason})
 * @param {Array}  input.nexusNodes   raw nodes from the NCZoning GraphQL query
 * @param {Array}  input.districts    data/subdistricts.json `districts[]`
 * @returns {{locations: Array, full: Object<string, object>, meta: object}}
 */
export function buildDataset({ manualMods, tagsDict, excluded, nexusNodes, districts }) {
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
  const skipped = []; // tagged mods with no valid block — surfaced for monitoring

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
      tags: ['nczoning', ...parsed.tags],
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

  const perDistrict = {};
  const locations = [];
  const full = {};

  for (const entry of all) {
    const { district, subdistrict } = assignDistrict(entry.coordinates, districts);
    const key = district || 'Outside mapped districts';
    perDistrict[key] = (perDistrict[key] || 0) + 1;

    locations.push({
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
    });

    full[entry.id] = {
      ...locations[locations.length - 1],
      description: entry.description ?? '',
      ...(entry.credits ? { credits: entry.credits } : {}),
      ...(entry.source === 'auto'
        ? {
            thumbnail_url: entry.thumbnail_url,
            picture_url: entry.picture_url,
            updated_at: entry.updated_at,
          }
        : {}),
    };
  }

  return {
    locations,
    full,
    meta: {
      counts: {
        manual: manualMods.length,
        auto: autoEntries.length,
        total: all.length,
        per_district: perDistrict,
      },
      skipped,
      nexus_thumbs: nexusThumbs,
    },
  };
}
