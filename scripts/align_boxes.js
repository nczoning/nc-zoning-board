#!/usr/bin/env node
/**
 * scripts/align_boxes.js
 * ─────────────────────────────────────────────────────────────────────────
 * THE ALIGNMENT TEST. How well does the .dds building box cloud — the thing we
 * actually render — line up with the REAL architecture in the game's streaming
 * sectors?
 *
 * This one measurement decides three things at once, which is why it comes before
 * any more engine work:
 *
 *   1. Issue #824 — can we GENERATE our own box cloud from the streaming sectors?
 *      If we can, modded buildings appear on the map, because mods ship sectors and
 *      the .dds is a baked artefact they cannot touch. Viability hinges on whether
 *      the sectors even contain what the .dds contains.
 *
 *   2. ?archdebug / ?segdebug / ?partdebug — today these are views of a HEURISTIC
 *      (boxes clustered by proximity, classified by dimensions). If each box maps to
 *      real architecture, they can become views of KNOWN FACTS.
 *
 *   3. The night engine's missing structure. The window model currently stamps a
 *      uniform grid over 100% of every lit facade, because the panel dump cannot say
 *      how glass CLUSTERS on a building (75% of glass panels are instanced and carry
 *      no position). If our boxes correspond to real geometry, the sectors can tell
 *      us which box is a glazed slab and which is a blank service core — and the
 *      "uniform everywhere" default stops being a guess.
 *
 * WHAT IT COMPARES
 *   OURS  — the .dds instance cloud, decoded by tune_lib.decodeDistrict() (lifted
 *           VERBATIM from three-scene.js loadBuildings, so this tests what we RENDER,
 *           not a reimplementation of it).
 *   REAL  — architecture nodes from ncz_nodes.csv (dump_night_raw.wscript), which
 *           carry a CET position and a world-space AABB.
 *
 * THE HONEST CAVEATS, stated up front because they bound every number below:
 *   · An INSTANCED node has no position (the per-copy transforms are in a binary
 *     buffer WolvenKit will not expand). Those are excluded from REAL — so REAL is
 *     the non-instanced architecture only. It is a floor on coverage, not the truth.
 *   · ncz_nodes gives a node's POSITION and its AABB EXTENTS, but not the AABB's
 *     min/max — so we cannot know whether Position is the box's CENTRE or its BASE
 *     ORIGIN. Both readings are computed and reported. If they disagree wildly, that
 *     ambiguity is the finding and nothing downstream can be trusted until it is
 *     resolved.
 *
 * Usage:  node scripts/align_boxes.js [--raw <dir>] [--cell <m>]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { NCZ, DISTRICTS, decodeDistrict } = require('./tune_lib');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const CELL = process.argv.includes('--cell')
  ? parseFloat(process.argv[process.argv.indexOf('--cell') + 1])
  : 8;   // metres. Fine enough to see a building, coarse enough to hold the city in RAM.

// WHICH BOX CLOUD — and this is not a detail, it is the whole validity of the test.
//
// The sectors are VANILLA game data. The 'fixed' asset set is malgalad's 3D World Map
// Fixed, and it is a REBUILD, not an alignment nudge: median box displacement runs
// 122-2,786 CET by district and Watson has 5,185 boxes in vanilla that are absent in
// fixed (see wiki/learnings/fixed-asset-set-is-a-repack). Comparing vanilla sectors to
// the fixed cloud therefore measures malgalad's reconstruction, NOT the game's own
// correspondence.
//
//   --set vanilla  the CDPR cloud vs CDPR sectors. The TRUE correspondence, and the one
//                  issue #824 depends on: it is the relationship we would be reproducing.
//   --set fixed    what we actually RENDER (ASSET_SET_DEFAULT) vs the real city. Says
//                  whether malgalad's rebuild moved toward the game's truth or away.
//   --set both     run both and print them side by side. Default, because the DIFFERENCE
//                  is the finding.
const SET = process.argv.includes('--set')
  ? process.argv[process.argv.indexOf('--set') + 1]
  : 'both';

// Same definition of "architecture" the night analyser uses — props, vehicles and
// street furniture are not buildings and must not count as missed coverage.
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;

const X0 = NCZ.WORLD_MIN_X, X1 = NCZ.WORLD_MAX_X;
const Y0 = NCZ.WORLD_MIN_Y, Y1 = NCZ.WORLD_MAX_Y;
const GW = Math.ceil((X1 - X0) / CELL);
const GH = Math.ceil((Y1 - Y0) / CELL);
const gx = (x) => Math.floor((x - X0) / CELL);
const gy = (y) => Math.floor((y - Y0) / CELL);
const inGrid = (ix, iy) => ix >= 0 && ix < GW && iy >= 0 && iy < GH;

console.log(`grid ${GW} x ${GH} @ ${CELL} m  (${(GW * GH / 1e6).toFixed(1)}M cells)\n`);

// ── OURS: rasterise one .dds cloud ──────────────────────────────────────────
// decodeDistrict returns THREE-space (bcx = cetX, bcy = cetZ up, bcz = -cetY) with
// world-AABB half-extents. Convert back to CET so both sides speak one language.
function rasterCloud(setName) {
  const ours = new Uint8Array(GW * GH);
  const ourTop = new Float32Array(GW * GH);   // CET z of the box top — for the height check
  let boxes = 0, clouds = 0;
  for (const meta of DISTRICTS) {
    // decodeDistrict prefers dataDdsFixed. To force VANILLA, hand it a meta with the
    // fixed path removed — the decode is otherwise byte-identical, so this tests the
    // same code path against a different texture rather than a second implementation.
    const m = setName === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
    if (!(m.dataDdsFixed || m.dataDds)) continue;
    let d;
    try { d = decodeDistrict(m); } catch (e) { console.warn(`  skip ${meta.name} (${setName}): ${e.message}`); continue; }
    boxes += d.count; clouds++;
    for (let i = 0; i < d.count; i++) {
      const cx = d.bcx[i], cy = -d.bcz[i], cz = d.bcy[i];    // CET centre
      const hx = d.bhx[i], hy = d.bhz[i], hz = d.bhy[i];     // CET half-extents
      const top = cz + hz;
      const i0 = gx(cx - hx), i1 = gx(cx + hx), j0 = gy(cy - hy), j1 = gy(cy + hy);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!inGrid(i, j)) continue;
          const k = j * GW + i;
          ours[k] = 1;
          if (top > ourTop[k]) ourTop[k] = top;
        }
      }
    }
  }
  return { ours, ourTop, boxes, clouds };
}

// ── REAL: architecture nodes from the streaming sectors ─────────────────────
// SIZE COMES FROM THE MESH, NOT THE NODE. The node's `Bounds` field is populated on 1.9%
// of nodes (InstancedMesh: 0.0%), so the first version of this test compared our whole
// box cloud against a 3.5% sample of the architecture and reported a "precision" of 4.5%
// that meant nothing at all. ncz_assets.csv now carries each mesh's own LOCAL bounding
// box; local dims x the node's Scale is the real placed footprint, for every node.
const archBox = new Map();   // asset id → [dx, dy, dz] local dims
{
  const rows = fs.readFileSync(path.join(RAW, 'ncz_assets.csv'), 'utf8').split(/\r?\n/);
  const head = rows[0].split(',');
  const c = {}; head.forEach((h, i) => { c[h] = i; });
  if (c.bbx0 === undefined) {
    console.error('\n!! ncz_assets.csv has no bounding-box columns (bbx0..bbz1).');
    console.error('   Re-run scripts/wkit/dump_night_raw.wscript in WolvenKit. Without them this');
    console.error('   test can only see the ~2% of nodes whose Bounds field happens to be set,');
    console.error('   and every number it prints is a sample nobody checked was a sample.\n');
    process.exit(1);
  }
  for (let i = 1; i < rows.length; i++) {
    const L = rows[i]; if (!L || !ARCH.test(L)) continue;
    // Quoted paths contain no commas in practice, but split defensively on the leading
    // numeric columns only — id is first, and the bbox columns sit before mat_names.
    const f = L.split(',');
    const id = f[0];
    const b = [+f[c.bbx0], +f[c.bby0], +f[c.bbz0], +f[c.bbx1], +f[c.bby1], +f[c.bbz1]];
    if (!b.every(Number.isFinite) || !(b[3] > b[0] && b[4] > b[1] && b[5] > b[2])) continue;
    archBox.set(id, [b[3] - b[0], b[4] - b[1], b[5] - b[2]]);
  }
}
console.log(`REAL: ${archBox.size.toLocaleString()} architecture assets with a bounding box`);

// Position is either the AABB CENTRE or the BASE ORIGIN — the dump does not say which.
// Build BOTH interpretations and let the numbers pick.
const realC = new Uint8Array(GW * GH);        // footprint under "Position = centre"
const realTopC = new Float32Array(GW * GH);
const realTopB = new Float32Array(GW * GH);   // top under "Position = base origin"
let realNodes = 0, instSkipped = 0, degenerate = 0;
const nodePts = [];                           // (x, y, area) for the point-in-box test

const COL = {};
const rl = readline.createInterface({
  input: fs.createReadStream(path.join(RAW, 'ncz_nodes.csv')), crlfDelay: Infinity,
});
let first = true;
rl.on('line', (line) => {
  if (!line) return;
  if (first) { line.split(',').forEach((h, i) => { COL[h] = i; }); first = false; return; }
  const f = line.split(',');
  const dims = archBox.get(f[COL.asset]);
  if (!dims) return;
  // Instanced nodes carry no POSITION — the per-copy transforms live in a binary buffer
  // WolvenKit will not expand. The asset box fixes their SIZE but not their PLACEMENT, so
  // they still cannot be rasterised. Excluded, and COUNTED, so recall is always read as
  // "of the architecture we can actually locate".
  if ((+f[COL.inst] || 1) !== 1) { instSkipped++; return; }
  const x = +f[COL.x], y = +f[COL.y], z = +f[COL.z];
  if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
  // The placed box: the mesh's local dims x this node's Scale. An axis-aligned footprint
  // is a slight over-estimate for a rotated node, which is the safe direction here — it
  // can only make our boxes look WORSE at covering it, never better.
  const bw = dims[0] * (+f[COL.sx] || 1);
  const bh = dims[1] * (+f[COL.sy] || 1);
  const bd = dims[2] * (+f[COL.sz] || 1);
  if (!(bw > 0 && bh > 0 && bd > 0)) { degenerate++; return; }
  realNodes++;
  nodePts.push(x, y, bw * bh);

  const i0 = gx(x - bw / 2), i1 = gx(x + bw / 2), j0 = gy(y - bh / 2), j1 = gy(y + bh / 2);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!inGrid(i, j)) continue;
      const k = j * GW + i;
      realC[k] = 1;
      const tc = z + bd / 2, tb = z + bd;
      if (tc > realTopC[k]) realTopC[k] = tc;
      if (tb > realTopB[k]) realTopB[k] = tb;
    }
  }
});

rl.on('close', () => {
  console.log(`      ${realNodes.toLocaleString()} placed non-instanced arch nodes`);
  console.log(`      ${instSkipped.toLocaleString()} INSTANCED arch nodes skipped (no position — the known blind spot)`);
  if (degenerate) console.log(`      ${degenerate.toLocaleString()} degenerate bounds skipped\n`);

  // PRECISION IS BACK, and it is only meaningful now.
  //
  // "What fraction of our boxes sit on real architecture" was undefined while REAL was the
  // ~3.5% of the architecture whose node Bounds happened to be set: against a sparse
  // reference every uncovered box looks like a false positive whether it is one or not.
  // The first run of this script printed precision 4.5% and it meant nothing. With the
  // mesh's own box, REAL is now every non-instanced architecture node, so an uncovered box
  // really is a box standing on nothing.
  //
  // It is still a FLOOR, not the truth: instanced architecture has no position and cannot
  // be rasterised at all, so some "empty" boxes are standing on instanced geometry we
  // simply cannot see. Read precision as a lower bound.
  const sets = SET === 'both' ? ['vanilla', 'fixed'] : [SET];
  for (const setName of sets) {
    const { ours, ourTop, boxes, clouds } = rasterCloud(setName);
    console.log('='.repeat(72));
    console.log(`ASSET SET: ${setName.toUpperCase()}   ${boxes.toLocaleString()} boxes over ${clouds} clouds`);
    if (setName === 'fixed') console.log("  (malgalad's rebuild — what we RENDER)");
    else console.log('  (CDPR — the cloud that actually corresponds to these sectors)');
    console.log('='.repeat(72) + '\n');

    // ── 1. FOOTPRINT ────────────────────────────────────────────────────────
    let both = 0, onlyReal = 0, onlyOurs = 0;
    for (let k = 0; k < ours.length; k++) {
      if (ours[k] && realC[k]) both++;
      else if (ours[k]) onlyOurs++;
      else if (realC[k]) onlyReal++;
    }
    const recall = both / (both + onlyReal);
    const precision = both / (both + onlyOurs);
    const iou = both / (both + onlyOurs + onlyReal);
    console.log('1. FOOTPRINT — do our boxes stand where the architecture stands?');
    console.log(`   RECALL     ${(100 * recall).toFixed(1)}%   of real architecture is covered by a box`);
    console.log(`   PRECISION  ${(100 * precision).toFixed(1)}%   of our box area sits on locatable architecture (a FLOOR — instanced arch is invisible)`);
    console.log(`   IoU        ${(100 * iou).toFixed(1)}%`);
    console.log(`   (both ${both.toLocaleString()} · ours-only ${onlyOurs.toLocaleString()} · real-only ${onlyReal.toLocaleString()} cells)\n`);

    // ── 2. POINT TEST — robust to the centre-vs-origin ambiguity in XY ──────
    let hit = 0, hitArea = 0, totArea = 0;
    for (let p = 0; p < nodePts.length; p += 3) {
      const i = gx(nodePts[p]), j = gy(nodePts[p + 1]), a = nodePts[p + 2];
      totArea += a;
      if (inGrid(i, j) && ours[j * GW + i]) { hit++; hitArea += a; }
    }
    console.log('2. POINT TEST — does each real building STAND on a box?');
    console.log(`   by node  ${(100 * hit / (nodePts.length / 3)).toFixed(1)}%   by area  ${(100 * hitArea / totArea).toFixed(1)}%  <- a megabuilding is not one vote\n`);

    // ── 3. HEIGHT ──────────────────────────────────────────────────────────
    // Both readings of Position, because the dump does not say which it is. The one that
    // agrees is the one that is true — and if NEITHER agrees, that is the finding.
    for (const [label, realTop] of [['centre', realTopC], ['base', realTopB]]) {
      const diffs = [];
      for (let k = 0; k < ours.length; k++) {
        if (!ours[k] || !realC[k] || ourTop[k] === 0 || realTop[k] === 0) continue;
        diffs.push(ourTop[k] - realTop[k]);
      }
      if (!diffs.length) { console.log(`3. HEIGHT (Position=${label}) — no overlapping cells`); continue; }
      diffs.sort((a, b) => a - b);
      const within10 = diffs.filter((d) => Math.abs(d) <= 10).length / diffs.length;
      console.log(`3. HEIGHT (Position=${label})  median ours-real ${diffs[diffs.length >> 1].toFixed(1)} m`
        + `  p10 ${diffs[Math.floor(diffs.length * 0.1)].toFixed(1)}  p90 ${diffs[Math.floor(diffs.length * 0.9)].toFixed(1)}`
        + `  within +-10 m ${(100 * within10).toFixed(1)}%`);
    }
    console.log('');
  }

  console.log('READ THE VERDICT AS:');
  console.log('  VANILLA recall is the one that decides #824: it is the correspondence we');
  console.log('     would be reproducing when generating our own cloud from the sectors.');
  console.log('  FIXED recall says how well the cloud we actually RENDER matches the real');
  console.log('     city. Malgalad rebuilt these clouds (boxes moved 122-2,786 CET), so if');
  console.log('     FIXED beats VANILLA he moved TOWARD the truth; if it loses, away from it.');
  console.log('  All of it is computed over the ~3.5% of architecture with usable bounds.');
  console.log('     Re-run after the asset-bounds re-scan before trusting any of it.');
});
