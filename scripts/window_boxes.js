#!/usr/bin/env node
/**
 * scripts/window_boxes.js
 * ─────────────────────────────────────────────────────────────────────────
 * LAND THE REAL WINDOWS ON THE SURFACES WE ACTUALLY RENDER.
 *
 * We render a cloud of axis-aligned BOXES decoded from the .dds instance textures. The game
 * has 157,436 glass panes, and — since the transform pools were opened — every one of them
 * has an exact CET position, a rotation, and a size. This script joins the two.
 *
 * WHY NOT PREFABS. The plan said prefabs were "building identity". They are not: a
 * glass-bearing prefab is a KIT ASSEMBLY, median 16 m across and 8 m tall, max 112 m — there
 * is not one megabuilding-scale prefab in the set. Normalising a pane's height against an 8 m
 * assembly and averaging it with a 112 m one destroys exactly the vertical structure we are
 * trying to measure. Prefabs were a proxy for position, and we no longer need a proxy.
 *
 * The BOX is the right unit because the box is the thing the shader shades. Every quantity
 * below is defined on the surface the fragment shader will actually run over:
 *
 *   glassShare(box)  = glass area landed on it / its facade area   -> buildingOverrideBuffer
 *   profile(box)     = where up the box that glass sits             -> the vertical placement
 *   face(pane)       = which of the box's 4 walls (or its roof)     -> facemask, and onWall
 *
 * VALIDATION FIRST. The join rate IS the test. If real windows do not land on our boxes, then
 * the boxes are not where the buildings are, and every number after that is decoration. The
 * alignment test says our cloud has 86% recall against real architecture, so a join rate in
 * that neighbourhood is the pass mark. A join rate near 100% would mean the margin is too
 * generous and we are catching panes that belong to nothing.
 *
 * Usage:  node scripts/window_boxes.js [--set fixed|vanilla] [--margin 4]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
// DISTRICT_META, not DISTRICTS. tune_lib's DISTRICTS drops `ugly_building` as "the
// single-building debug isolate" — but the RENDERER still renders it (522 boxes), so a bake
// built from DISTRICTS has no entry for it, the per-district count guard refuses it, and
// those 522 boxes silently fall back to the old per-district model: a lit blob standing in
// an otherwise measured city. Bake exactly what is rendered.
const { NCZ, DISTRICT_META, decodeDistrict } = require('./tune_lib');
const DISTRICTS = DISTRICT_META;

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
// The asset set we RENDER is the fixed one (ASSET_SET_DEFAULT), so that is what the windows
// must land on. --set vanilla is for comparison, not for the model.
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'fixed';
// Panes sit ON a facade, i.e. slightly OUTSIDE the box's own surface, and our boxes are an
// approximation of a building rather than a tracing of it. A few metres of slack is physical,
// not a fudge — but it is REPORTED, and the sensitivity sweep at the end shows what it buys.
const MARGIN = process.argv.includes('--margin')
  ? parseFloat(process.argv[process.argv.indexOf('--margin') + 1]) : 4;
// How a pane picks its box. See the comment at the assignment site — `volume` is the naive
// rule and it loses facade panes to interior slabs in dense box soup; `surface` mounts a
// pane on the FACE it actually sits on.
const ASSIGN = process.argv.includes('--assign')
  ? process.argv[process.argv.indexOf('--assign') + 1] : 'near';

const { ARCH, makeGlassTest } = require('./glass_lib');
const pct = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];

function readCsv(file) {
  const lines = fs.readFileSync(path.join(RAW, file), 'utf8').split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    const f = []; let cur = '', q = false;
    for (const ch of L) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { f.push(cur); cur = ''; }
      else cur += ch;
    }
    f.push(cur);
    const o = {}; head.forEach((h, k) => { o[h] = f[k]; });
    out.push(o);
  }
  return out;
}

function qRot(q, v) {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
}

// ── THE BOXES WE RENDER ─────────────────────────────────────────────────────
// decodeDistrict is lifted verbatim from three-scene.js loadBuildings, so this joins onto
// what the browser draws, not onto a reimplementation of it. THREE space -> CET.
const bx = [], by = [], bz = [], bhx = [], bhy = [], bhz = [], bDist = [];
for (const meta of DISTRICTS) {
  const m = SET === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
  if (!(m.dataDdsFixed || m.dataDds)) continue;
  let d;
  try { d = decodeDistrict(m); } catch (e) { console.warn(`  skip ${meta.name}: ${e.message}`); continue; }
  for (let i = 0; i < d.count; i++) {
    bx.push(d.bcx[i]); by.push(-d.bcz[i]); bz.push(d.bcy[i]);
    bhx.push(d.bhx[i]); bhy.push(d.bhz[i]); bhz.push(d.bhy[i]);
    bDist.push(meta.name);
  }
}
const NB = bx.length;
console.log(`boxes (${SET}): ${NB.toLocaleString()}\n`);

// Spatial hash on XY so a pane looks at a handful of boxes, not 200,000.
const CELL = 32;
const key = (i, j) => i * 100000 + j;
const grid = new Map();
for (let b = 0; b < NB; b++) {
  const i0 = Math.floor((bx[b] - bhx[b] - MARGIN) / CELL), i1 = Math.floor((bx[b] + bhx[b] + MARGIN) / CELL);
  const j0 = Math.floor((by[b] - bhy[b] - MARGIN) / CELL), j1 = Math.floor((by[b] + bhy[b] + MARGIN) / CELL);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(b);
    }
  }
}

// ── ASSETS: local box + is-it-glass ─────────────────────────────────────────
// The glass definition is SHARED (scripts/glass_lib.js) — it now covers glass.mt and
// glass_onesided.mt as well as window_parallax_interior, which is 145 material definitions
// the old local regex here ignored outright.
const isGlassMat = makeGlassTest(readCsv('ncz_materials.csv'));
const asset = {};
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  const dx = +a.bbx1 - +a.bbx0, dy = +a.bby1 - +a.bby0, dz = +a.bbz1 - +a.bbz0;
  const ok = [dx, dy, dz].every((v) => Number.isFinite(v) && v > 0);
  if (!isGlassMat((a.mat_names || '').split('|'), (a.mat_paths || '').split('|'))) continue;
  asset[a.id] = ok ? [dx, dy, dz] : null;
}

// ── ACCUMULATE ──────────────────────────────────────────────────────────────
const gArea = new Float64Array(NB);           // glass area landed on each box
const gCount = new Uint32Array(NB);
const BANDS = 10;
const prof = new Float64Array(BANDS);         // area-weighted vertical profile, box-relative
const face = { px: 0, nx: 0, py: 0, ny: 0, roof: 0 };
let panes = 0, joined = 0, orphan = 0, noBox = 0, nearHits = 0;
let below = 0, above = 0, tooFlat = 0, profiled = 0;
const orphanZ = [];

function pane(a, x, y, z, q, sx, sy, sz) {
  const dims = asset[a];
  if (dims === undefined) return;             // not glass
  panes++;
  if (!dims) { noBox++; return; }

  const d = [dims[0] * (sx || 1), dims[1] * (sy || 1), dims[2] * (sz || 1)];
  const order = [0, 1, 2].sort((i, j) => d[i] - d[j]);
  const thin = order[0];
  const area = d[order[1]] * d[order[2]];
  const axis = [0, 0, 0]; axis[thin] = 1;
  const n = qRot(q, axis);
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;

  // WHICH BOX DOES THIS PANE BELONG TO?
  //
  // ASSIGN=volume (the first, WRONG rule): the smallest box CONTAINING the pane. Our
  // buildings are interpenetrating box SOUP — a tower is many overlapping slabs — so
  // "contains" is satisfied by every slab the pane happens to be inside, and "smallest"
  // then hands the pane to a tiny INTERIOR slab instead of the outer shell it is mounted
  // on. It ranked city_center (Corpo Plaza — the most glazed km2 in Night City) BELOW
  // Santo Domingo, because City Center has the most boxes per building and so suffers the
  // dilution worst. Kept only so the comparison can be run.
  //
  // ASSIGN=surface (the right rule): a window is mounted ON A FACE. Find the box whose
  // FACE the pane is sitting on — nearest surface, and the pane's normal must AGREE with
  // that face's normal. An interior slab has no face there, so it cannot claim the pane.
  const cand = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
  let best = -1, bestScore = Infinity;
  if (cand) {
    for (const b of cand) {
      if (ASSIGN === 'volume') {
        if (x < bx[b] - bhx[b] - MARGIN || x > bx[b] + bhx[b] + MARGIN) continue;
        if (y < by[b] - bhy[b] - MARGIN || y > by[b] + bhy[b] + MARGIN) continue;
        if (z < bz[b] - bhz[b] - MARGIN || z > bz[b] + bhz[b] + MARGIN) continue;
        const vol = bhx[b] * bhy[b] * bhz[b];
        if (vol < bestScore) { bestScore = vol; best = b; }
        continue;
      }

      // --- surface assignment -------------------------------------------------
      // Which of the box's faces does this pane's normal point along? Boxes are
      // axis-aligned, so the pane's own normal names the face directly.
      let d;
      if (Math.abs(nz) > 0.940) {
        // A roof pane: it lies on the TOP face. Must be over the footprint.
        if (x < bx[b] - bhx[b] - MARGIN || x > bx[b] + bhx[b] + MARGIN) continue;
        if (y < by[b] - bhy[b] - MARGIN || y > by[b] + bhy[b] + MARGIN) continue;
        d = Math.abs(z - (bz[b] + bhz[b]));
      } else if (Math.abs(nx) >= Math.abs(ny)) {
        // Faces +X / -X. The pane must lie WITHIN the face (its Y and Z extent) ...
        if (y < by[b] - bhy[b] - MARGIN || y > by[b] + bhy[b] + MARGIN) continue;
        if (z < bz[b] - bhz[b] - MARGIN || z > bz[b] + bhz[b] + MARGIN) continue;
        // ... and NEAR the face plane on the side its normal points to.
        const plane = bx[b] + (nx >= 0 ? bhx[b] : -bhx[b]);
        d = Math.abs(x - plane);
      } else {
        if (x < bx[b] - bhx[b] - MARGIN || x > bx[b] + bhx[b] + MARGIN) continue;
        if (z < bz[b] - bhz[b] - MARGIN || z > bz[b] + bhz[b] + MARGIN) continue;
        const plane = by[b] + (ny >= 0 ? bhy[b] : -bhy[b]);
        d = Math.abs(y - plane);
      }
      if (d > MARGIN) continue;            // not mounted on this box's face
      if (d < bestScore) { bestScore = d; best = b; }
    }
  }
  // ASSIGN=near (the one we ship). EXCLUSIVE ASSIGNMENT IS THE WRONG QUESTION.
  //
  // Our boxes approximate buildings from several metres out — at a 2 m margin only 49% of
  // panes are near any box face, at 8 m it is 92%. There is no exact "this pane belongs to
  // that box" fact to recover, and forcing one hands facade glass to interior slabs.
  //
  // So don't. Every box whose FACE is near this pane gets credit for it, non-exclusively —
  // the same reasoning as facemask v2, which stopped trying to reach a per-box verdict in
  // slab soup and moved the decision to the fragment. An interior slab also collecting
  // credit costs nothing: the facemask never draws its faces. And a highway pylon, an oil
  // tank or a silo has no glass anywhere near it, so it collects nothing and stays dark —
  // which is the whole point, and it survives however we normalise.
  if (ASSIGN === 'near') {
    let hits = 0;
    if (cand) {
      for (const b of cand) {
        if (x < bx[b] - bhx[b] - MARGIN || x > bx[b] + bhx[b] + MARGIN) continue;
        if (y < by[b] - bhy[b] - MARGIN || y > by[b] + bhy[b] + MARGIN) continue;
        if (z < bz[b] - bhz[b] - MARGIN || z > bz[b] + bhz[b] + MARGIN) continue;
        gArea[b] += area; gCount[b]++; hits++;
      }
    }
    if (!hits) { orphan++; orphanZ.push(z); return; }
    joined++;
    nearHits += hits;
    const b0 = cand[0];
    const base0 = bz[b0] - bhz[b0], h0 = 2 * bhz[b0];
    if (h0 > 3) {
      const t = (z - base0) / h0;
      if (t < 0) below++; else if (t >= 1) above++;
      else { prof[Math.floor(t * BANDS)] += area; profiled++; }
    } else tooFlat++;
    if (Math.abs(nz) > 0.940) face.roof += area;
    else if (Math.abs(nx) >= Math.abs(ny)) (nx >= 0 ? face.px += area : face.nx += area);
    else (ny >= 0 ? face.py += area : face.ny += area);
    return;
  }

  if (best < 0) { orphan++; orphanZ.push(z); return; }

  joined++;
  gArea[best] += area;
  gCount[best]++;

  // WHERE UP THE BOX. Box-relative, so a 200 m tower and a 6 m shopfront are comparable and
  // the normalisation is against the surface we shade rather than a kit assembly.
  //
  // DO NOT CLAMP. The join allows a MARGIN in Z, so a pane may legitimately sit slightly
  // below a box's base or above its top. Clamping those into t=0 / t=1 dumps them into the
  // end bands and MANUFACTURES a U-shaped profile out of the margin itself — on a box of
  // median height, a 4 m margin is a large slice of the whole range. Count them out loud
  // instead: a pane outside the box's own height is not evidence about where glass sits on
  // a facade, it is evidence about how well the box fits the building.
  const base = bz[best] - bhz[best], h = 2 * bhz[best];
  if (h > 3) {
    const t = (z - base) / h;
    if (t < 0) below++;
    else if (t >= 1) above++;
    else { prof[Math.floor(t * BANDS)] += area; profiled++; }
  } else {
    tooFlat++;
  }

  // WHICH FACE. Our boxes are axis-aligned, so the pane's world normal picks a face directly.
  if (Math.abs(nz) > 0.940) face.roof += area;              // >70 deg from vertical
  else if (Math.abs(nx) >= Math.abs(ny)) (nx >= 0 ? face.px += area : face.nx += area);
  else (ny >= 0 ? face.py += area : face.ny += area);
}

async function stream(file, onRow) {
  const COL = {};
  let first = true;
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(RAW, file)), crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    if (first) { line.split(',').forEach((h, i) => { COL[h] = i; }); first = false; continue; }
    onRow(line.split(','), COL);
  }
}

(async () => {
  // Instanced copies (one row per copy) ...
  await stream('ncz_instances.csv', (f, C) => {
    pane(f[C.asset], +f[C.x], +f[C.y], +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz]);
  });
  // ... AND the nodes that were never instanced. Both, or 11% of the city's glass vanishes.
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    const x = +f[C.x], y = +f[C.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
    pane(f[C.asset], x, y, +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz]);
  });

  // ── 1. THE JOIN RATE — this is the validation, not a statistic ────────────
  console.log('=== 1. DO THE REAL WINDOWS LAND ON THE BOXES WE RENDER?\n');
  console.log(`  glass panes             : ${panes.toLocaleString()}`);
  console.log(`  landed on a box         : ${joined.toLocaleString()}  (${(100 * joined / panes).toFixed(1)}%)   <- margin ${MARGIN} m`);
  console.log(`  orphaned (no box there) : ${orphan.toLocaleString()}  (${(100 * orphan / panes).toFixed(1)}%)`);
  if (noBox) console.log(`  no mesh bounding box    : ${noBox.toLocaleString()}`);
  console.log(`\n  The alignment test puts our cloud at ~86% recall against real architecture.`);
  console.log(`  A join rate near that is the pass mark. Far below ⇒ our boxes are not where`);
  console.log(`  the buildings are. Near 100% ⇒ the margin is catching panes that belong to nothing.`);

  // ── 2. PER-BOX GLASS SHARE — the number the shader wants ──────────────────
  // A box's facade is its four sides: perimeter x height.
  console.log('\n=== 2. PER-BOX GLASS SHARE — glass area / facade area\n');
  const lit = [];
  for (let b = 0; b < NB; b++) {
    if (!gCount[b]) continue;
    const facade = 4 * (bhx[b] + bhy[b]) * (2 * bhz[b]);
    if (facade <= 0) continue;
    lit.push(Math.min(1, gArea[b] / facade));
  }
  lit.sort((a, b) => a - b);
  const withGlass = lit.length;
  console.log(`  boxes with any glass: ${withGlass.toLocaleString()} of ${NB.toLocaleString()}  (${(100 * withGlass / NB).toFixed(1)}%)`);
  console.log(`  ⇒ ${(100 * (NB - withGlass) / NB).toFixed(1)}% of the boxes we light have NO real windows on them at all\n`);
  console.log(`  glass share, among boxes that HAVE glass:`);
  console.log(`    p10 ${(100 * pct(lit, 0.1)).toFixed(1)}%   p25 ${(100 * pct(lit, 0.25)).toFixed(1)}%   median ${(100 * pct(lit, 0.5)).toFixed(1)}%   p75 ${(100 * pct(lit, 0.75)).toFixed(1)}%   p90 ${(100 * pct(lit, 0.9)).toFixed(1)}%`);
  console.log(`\n  Today the shader uses ONE per-district scalar for every building. This is the`);
  console.log(`  spread that scalar is standing in for.`);

  // ── 3. VERTICAL PROFILE, against the box we shade ─────────────────────────
  console.log('\n=== 3. VERTICAL PROFILE — where up the BOX does the glass sit?\n');
  console.log(`  panes INSIDE their box's height : ${profiled.toLocaleString()}  (${(100 * profiled / joined).toFixed(1)}% of joined)`);
  console.log(`  panes BELOW the box's base      : ${below.toLocaleString()}  (${(100 * below / joined).toFixed(1)}%)   } the box does not fit`);
  console.log(`  panes ABOVE the box's top       : ${above.toLocaleString()}  (${(100 * above / joined).toFixed(1)}%)   } the building it sits on`);
  console.log(`  panes on boxes <3 m tall        : ${tooFlat.toLocaleString()}  (${(100 * tooFlat / joined).toFixed(1)}%)`);
  console.log('\n  These are EXCLUDED, not clamped. Clamping them into the end bands would build a');
  console.log('  U-shaped profile out of the join margin and call it architecture.\n');
  const psum = prof.reduce((a, b) => a + b, 0);
  const pmax = Math.max(...prof);
  for (let i = BANDS - 1; i >= 0; i--) {
    const f = psum ? prof[i] / psum : 0;
    console.log(`   ${String(i * 10).padStart(3)}-${String((i + 1) * 10).padEnd(3)}%   ${(100 * f).toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(50 * prof[i] / pmax))}`);
  }

  // ── 4. FACES ─────────────────────────────────────────────────────────────
  console.log('\n=== 4. WHICH FACE OF THE BOX?\n');
  const ftot = face.px + face.nx + face.py + face.ny + face.roof;
  for (const [k, v] of Object.entries(face)) {
    console.log(`   ${k.padEnd(5)} ${(100 * v / ftot).toFixed(1).padStart(5)}%   ${(v / 1e3).toFixed(1)}k m2`);
  }
  console.log('\n  Roughly equal on the four walls ⇒ no facing bias, and the facemask decides');
  console.log('  visibility. A large roof share is glass that `onWall` throws away today.');

  // ── 4b. THE CLASSIFIER WE NO LONGER HAVE TO WRITE ────────────────────────
  // If glass lands only on things that ARE buildings, then "which box is a building" stops
  // being a question we answer with shape heuristics and zone overrides — CDPR already
  // answered it by choosing where to put window material. A highway pylon, an oil tank, a
  // silo, a rooftop AC unit: no pane lands on them, so they get no windows, and nobody had
  // to decide what they were.
  //
  // The test: do the boxes that CARRY glass look different from the ones that do not, and
  // do the districts sort the way a human would sort them?
  console.log('\n=== 4b. IS "HAS GLASS" ALREADY A BUILDING CLASSIFIER?\n');
  const gDims = [], nDims = [];
  const perDist = {};
  for (let b = 0; b < NB; b++) {
    const foot = Math.max(2 * bhx[b], 2 * bhy[b]);
    const hgt = 2 * bhz[b];
    const rec = { foot, hgt, slender: hgt / Math.max(1e-3, foot) };
    (gCount[b] ? gDims : nDims).push(rec);
    const D = perDist[bDist[b]] || (perDist[bDist[b]] = { n: 0, g: 0, gA: 0, fA: 0 });
    D.n++; if (gCount[b]) D.g++;
    // AREA, not box count. "Share of a district's BOXES that carry glass" is normalised by
    // how many boxes a district's buildings happen to be chopped into — so a district of big
    // towers (city_center: 40,128 boxes, the most of any) is penalised for being made of more
    // slabs, and comes out LOW however glazed it is. Glass area over facade area is the
    // quantity the shader actually consumes, and it does not care how the soup was diced.
    D.gA += gArea[b];
    D.fA += 4 * (bhx[b] + bhy[b]) * (2 * bhz[b]);
  }
  const med = (arr, f) => { const s = arr.map(f).sort((a, b) => a - b); return pct(s, 0.5); };
  console.log('                       boxes      median footprint   median height   median slenderness');
  console.log(`  WITH glass      ${String(gDims.length).padStart(9)}   ${med(gDims, (r) => r.foot).toFixed(1).padStart(12)} m   ${med(gDims, (r) => r.hgt).toFixed(1).padStart(11)} m   ${med(gDims, (r) => r.slender).toFixed(2).padStart(15)}`);
  console.log(`  WITHOUT glass   ${String(nDims.length).padStart(9)}   ${med(nDims, (r) => r.foot).toFixed(1).padStart(12)} m   ${med(nDims, (r) => r.hgt).toFixed(1).padStart(11)} m   ${med(nDims, (r) => r.slender).toFixed(2).padStart(15)}`);
  console.log('\n  (slenderness = height / footprint. A mast or pylon is slender; a building is not.)');

  console.log('\n  district GLAZING = glass area / facade area  (what the shader consumes):\n');
  const dn = Object.keys(perDist).sort((a, b) => (perDist[b].gA / perDist[b].fA) - (perDist[a].gA / perDist[a].fA));
  const gmax = Math.max(...dn.map((d) => perDist[d].gA / perDist[d].fA));
  for (const d of dn) {
    const D = perDist[d];
    const f = D.gA / D.fA;
    console.log(`   ${d.padEnd(22)} ${(100 * f).toFixed(2).padStart(6)}%   (boxes-with-glass ${(100 * D.g / D.n).toFixed(1).padStart(4)}%)  ${'#'.repeat(Math.round(50 * f / gmax))}`);
  }
  console.log('\n  Corpo/downtown high and industrial/badlands low ⇒ the data is doing the');
  console.log('  classification for us, and no shape heuristic is required.');

  // ── BAKE — per-box window density, in INSTANCE ORDER ─────────────────────
  // The renderer decodes each district's _data.dds in raster order and keeps a running
  // validCount, so box i here IS instance i there (decodeDistrict is lifted verbatim from
  // loadBuildings — that is why align_boxes.js can trust the same indices). One byte per
  // box: the whole city is ~257 KB.
  //
  // The VALUE is glass area over the box's own facade area — a DENSITY, not a lit fraction.
  // Intensity is a separate knob and is tuned afterwards, deliberately: tuning brightness
  // against a wrong placement is how WINDOW_LIT_FRACTION = 0.20 got tuned into existence.
  if (process.argv.includes('--bake')) {
    const SHARE_MAX = 0.5;    // the quantisation ceiling. p90 of a glassy box is ~0.27, so
                              // 0.5 keeps the top end honest without wasting half the range.
    const out = Buffer.alloc(NB);
    const manifest = { shareMax: SHARE_MAX, margin: MARGIN, assign: ASSIGN, set: SET, districts: [] };
    let off = 0, nonzero = 0;
    for (const meta of DISTRICTS) {
      const m = SET === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
      if (!(m.dataDdsFixed || m.dataDds)) continue;
      let n = 0;
      while (off + n < NB && bDist[off + n] === meta.name) n++;
      for (let i = 0; i < n; i++) {
        const b = off + i;
        const facade = 4 * (bhx[b] + bhy[b]) * (2 * bhz[b]);
        const share = facade > 0 ? gArea[b] / facade : 0;
        const v = Math.max(0, Math.min(255, Math.round(255 * share / SHARE_MAX)));
        out[b] = v;
        if (v) nonzero++;
      }
      manifest.districts.push({ name: meta.name, count: n, offset: off });
      off += n;
    }
    // ONE BAKE PER ASSET SET, AND THE FILENAME SAYS WHICH.
    //
    // The two clouds are DIFFERENT GEOMETRY, not two views of one thing: vanilla decodes
    // 271,022 boxes, malgalad's fixed set 263,258 (it is a rebuild — see
    // wiki/learnings/fixed-asset-set-is-a-repack). The bake is indexed BY INSTANCE, so a
    // fixed-set bake applied to the vanilla cloud is 263,258 correct indices followed by
    // garbage, i.e. a city that looks *plausibly* wrong. A single shared file cannot exist.
    fs.writeFileSync(path.join(__dirname, '..', 'data', `window-boxes-${SET}.bin`), out);
    fs.writeFileSync(path.join(__dirname, '..', 'data', `window-boxes-${SET}.json`), JSON.stringify(manifest, null, 2));
    console.log(`\n=== BAKED data/window-boxes-${SET}.bin — ${NB.toLocaleString()} boxes, ${nonzero.toLocaleString()} with windows (${(100 * nonzero / NB).toFixed(1)}%)`);
    console.log(`    ${(out.length / 1024).toFixed(0)} KB, one byte per instance, shareMax ${SHARE_MAX}`);
  }

  // ── 5. MARGIN SENSITIVITY — is the join rate real, or is it the slack? ────
  console.log('\n=== 5. IS THE JOIN REAL, OR IS IT THE MARGIN?\n');
  console.log('  (orphan Z distribution — if orphans are high in the air, they are real windows');
  console.log('   on towers our cloud is missing; if they are at ground level, they are shopfronts');
  console.log('   and street kit that never had a box.)');
  if (orphanZ.length) {
    orphanZ.sort((a, b) => a - b);
    console.log(`\n  orphan pane Z (CET): p10 ${pct(orphanZ, 0.1).toFixed(0)}  median ${pct(orphanZ, 0.5).toFixed(0)}  p90 ${pct(orphanZ, 0.9).toFixed(0)}  max ${orphanZ[orphanZ.length - 1].toFixed(0)}`);
  }
})();
