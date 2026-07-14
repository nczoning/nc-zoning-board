#!/usr/bin/env node
/**
 * scripts/proxy_dedup.js
 * ─────────────────────────────────────────────────────────────────────────
 * A PROXY IS A BUILDING — BUT ONLY WHERE THERE IS NO REAL ONE.
 *
 * A proxy is the low-detail, whole-building stand-in the game streams when you are too far away
 * for the panel-by-panel version to matter. Some buildings ship ONLY as a proxy: Arasaka
 * Waterfront's twelve identical towers are nine kit-built ones and THREE proxies, because you
 * cannot get close enough to those three for the difference to show. They are real buildings and
 * our map renders them dark, because a regex looking for `architecture` in the path threw them
 * away. City-wide: 7,016 tall glazed proxy-only copies.
 *
 * ─── AND THE TRAP, WHICH IS WORSE THAN THE BUG ──────────────────────────────
 * MOST BUILDINGS SHIP WITH BOTH. `wat_nid_building_a_v38_005` is placed as 2,136 instanced meshes
 * AND 72 proxy meshes. The game streams one or the other by distance; THE SECTOR DATA CONTAINS
 * BOTH. So simply including proxies double-counts every glazed building in Night City — a 2x
 * overcount wearing the costume of a fix, which is the exact shape of the bug this pipeline spent
 * a day removing.
 *
 * ─── THE RULE ───────────────────────────────────────────────────────────────
 * Use a proxy ONLY where no detailed geometry covers it. That is a SPATIAL question, not a
 * prefab one:
 *
 *   - a PER-BUILDING proxy (wat_nid_building_a_v38) shares its prefab with the detail, so a
 *     prefab test would work…
 *   - …but an AGGREGATE proxy (`*_mproxy`, one mesh for a whole block) does NOT. Its prefab has no
 *     detailed siblings, so a prefab test keeps it — and it lands on top of a dozen real
 *     buildings. That is the case that makes prefab-matching wrong and geometry right.
 *
 * So: rasterise where DETAILED glass exists, then drop any proxy whose footprint is already
 * covered. Coarse cells, because we are asking "is there a real building here", not "which one".
 *
 * PRINTS WHAT IT DROPS. A silent dedup is indistinguishable from a silent filter.
 */
'use strict';
const { PROXY } = require('./glass_lib');

const CELL = 24;                                  // m. A building is many cells; a pane is one.
const key = (i, j) => `${Math.floor(i / CELL)},${Math.floor(j / CELL)}`;

// ─── AND THE GROUND IS NOT THE BUILDING ─────────────────────────────────────
// The rule above ("is there detailed glass on this spot?") is a FOOTPRINT test, and a building is
// a VOLUME. Night City's towers are built as a kit-built PODIUM at street level — shops, lobby,
// 20 m — with a single proxy mesh for the 150 m of tower above it. The footprint test sees the
// podium's glass, calls the proxy a duplicate, and throws the tower away.
//
//         ░░░░░░░░      <- the PROXY. 150 m of tower, windows and all. DELETED.
//         ░░░░░░░░
//       ▓▓▓▓▓▓▓▓▓▓▓▓    <- the PODIUM. Detailed, glazed, ~20 m. This is all the old rule saw.
//     ─────────────── ground
//
// Measured over all 21,894 glazed proxy placements (2026-07-15):
//
//   proxyTop - detailTop:  p50 -21 m      <- the MEDIAN dropped proxy is SHORTER than the detail
//     <= 0 m   16,262  75.7%   a true duplicate. The old rule was RIGHT about these.
//     0-20 m    3,814  17.8%   bbox noise / parapets. Ambiguous.
//     > 20 m    1,396   6.5%   REAL TOWERS OVER PODIUMS — and 772 of them clear the detail by
//                              more than EIGHTY METRES. wat_lch_building_c_v38_top_a is a 197 m
//                              tower vetoed by a 51 m podium.
//
// So the old rule is right three times in four, and the quarter it gets wrong is the tallest,
// glassiest buildings in the game — because those are the ones built podium-plus-proxy. Keep the
// footprint test; add the axis it was missing.
//
// A proxy is a DUPLICATE only if the detail beneath it reaches its height. If the proxy stands
// clear of that detail, it is carrying geometry nothing else has, and it is a building.
const PROXY_Z_MARGIN = 20;   // m the proxy must clear the detail by to count as its own building

/**
 * Build the "detailed glass lives here" grid.
 * Feed it every DETAILED (non-proxy) glass placement; it remembers the ground it covers — AND HOW
 * HIGH the glass on that ground reaches, which is the whole point.
 */
function makeDetailGrid() {
  const cells = new Map();                        // cell -> highest detailed glass top (m)
  return {
    add(x, y, top = 0) {
      const k = key(x, y);
      const cur = cells.get(k);
      if (cur === undefined || top > cur) cells.set(k, top);
    },
    covered(x, y) { return cells.has(key(x, y)); },
    /** How high does detailed glass reach here? -Infinity if nothing is here. */
    topAt(x, y) { const t = cells.get(key(x, y)); return t === undefined ? -Infinity : t; },
    size() { return cells.size; },
  };
}

/**
 * Decide whether a placement should be counted.
 *
 * A DETAILED placement is always counted. A PROXY placement is counted only where it is not a
 * duplicate of detailed geometry — and "duplicate" is a question about a VOLUME, not a footprint.
 *
 * Sampled at the CENTRE and the four corners of its footprint: an aggregate proxy is large and its
 * centre may fall on a courtyard while its bulk sits on top of real buildings.
 */
function makeProxyFilter(grid, assetPath, assetFoot, assetTop = {}) {
  const stat = { detail: 0, proxyKept: 0, proxyDropped: 0, keptByHeight: 0, keptEmpty: 0 };
  return {
    stat,
    /**
     * @param z   placement Z (CET, up)
     * @param sz  placement Z scale
     * @returns {boolean} count this placement?
     */
    keep(assetId, x, y, z = 0, sz = 1) {
      const p = assetPath[assetId] || '';
      if (!PROXY.test(p)) { stat.detail++; return true; }

      const r = (assetFoot[assetId] || 0) * 0.5;
      const pts = r > 0
        ? [[x, y], [x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]]
        : [[x, y]];

      // How high does the detail under this proxy reach?
      let detailTop = -Infinity;
      for (const [px, py] of pts) {
        const t = grid.topAt(px, py);
        if (t > detailTop) detailTop = t;
      }

      // Nothing there at all — the proxy IS the building.
      if (detailTop === -Infinity) { stat.proxyKept++; stat.keptEmpty++; return true; }

      // Something is there. Does this proxy stand clear of it?
      const proxyTop = z + (assetTop[assetId] || 0) * (sz || 1);
      if (proxyTop > detailTop + PROXY_Z_MARGIN) {
        stat.proxyKept++; stat.keptByHeight++; return true;      // a tower over a podium
      }
      stat.proxyDropped++; return false;                          // a genuine duplicate
    },
    report() {
      const n = stat.proxyKept + stat.proxyDropped;
      console.log('\n=== PROXY DEDUP — a proxy is a building, but only where there is no real one\n');
      console.log(`  detailed placements      ${stat.detail.toLocaleString()}`);
      console.log(`  proxy placements         ${n.toLocaleString()}`);
      console.log(`    DROPPED (detail reaches its height) ${stat.proxyDropped.toLocaleString()}  (${n ? ((stat.proxyDropped / n) * 100).toFixed(1) : 0}%)  <- these would have DOUBLED a real building`);
      console.log(`    KEPT, nothing else there            ${stat.keptEmpty.toLocaleString()}  <- proxy-only buildings`);
      console.log(`    KEPT, stands >${PROXY_Z_MARGIN} m clear of it     ${stat.keptByHeight.toLocaleString()}  <- TOWERS OVER PODIUMS. A footprint test deleted these.`);
    },
  };
}

module.exports = { makeDetailGrid, makeProxyFilter, CELL, PROXY_Z_MARGIN };
