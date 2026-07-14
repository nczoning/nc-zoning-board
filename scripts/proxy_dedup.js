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

/**
 * Build the "detailed glass lives here" grid.
 * Feed it every DETAILED (non-proxy) glass placement; it remembers the ground it covers.
 */
function makeDetailGrid() {
  const cells = new Set();
  return {
    add(x, y) { cells.add(key(x, y)); },
    /** Is this ground already covered by real, detailed, glazed architecture? */
    covered(x, y) { return cells.has(key(x, y)); },
    size() { return cells.size; },
  };
}

/**
 * Decide whether a placement should be counted.
 *
 * A DETAILED placement is always counted. A PROXY placement is counted only if its ground is not
 * already covered by detail — i.e. only where it is the ONLY thing standing there.
 *
 * The proxy is checked at its CENTRE and at the four corners of its footprint, because an
 * aggregate proxy is large and its centre may fall on a courtyard while its bulk sits on top of
 * real buildings. If ANY of those samples is covered, the detail is present and the proxy is a
 * duplicate.
 */
function makeProxyFilter(grid, assetPath, assetFoot) {
  const stat = { detail: 0, proxyKept: 0, proxyDropped: 0 };
  return {
    stat,
    /** @returns {boolean} count this placement? */
    keep(assetId, x, y) {
      const p = assetPath[assetId] || '';
      if (!PROXY.test(p)) { stat.detail++; return true; }
      const r = (assetFoot[assetId] || 0) * 0.5;
      const pts = r > 0
        ? [[x, y], [x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]]
        : [[x, y]];
      for (const [px, py] of pts) {
        if (grid.covered(px, py)) { stat.proxyDropped++; return false; }
      }
      stat.proxyKept++;
      return true;
    },
    report() {
      const n = stat.proxyKept + stat.proxyDropped;
      console.log('\n=== PROXY DEDUP — a proxy is a building, but only where there is no real one\n');
      console.log(`  detailed placements      ${stat.detail.toLocaleString()}`);
      console.log(`  proxy placements         ${n.toLocaleString()}`);
      console.log(`    DROPPED (detail exists) ${stat.proxyDropped.toLocaleString()}  (${n ? ((stat.proxyDropped / n) * 100).toFixed(1) : 0}%)  <- these would have DOUBLED a real building`);
      console.log(`    KEPT (proxy is all there is) ${stat.proxyKept.toLocaleString()}  <- buildings that would otherwise render DARK`);
    },
  };
}

module.exports = { makeDetailGrid, makeProxyFilter, CELL };
