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

// ── THE BOXES WE RENDER — ORIENTED ──────────────────────────────────────────
// THE BOXES ARE ROTATED. This script used to join windows against each box's world AABB, which
// for a yawed box is a DIFFERENT, BIGGER box: median 1.96x the volume, and its walls point at
// the world axes instead of at the building. Only 26.6% of the city's boxes are within 5 deg of
// an axis; the median is yawed 26.3 deg.
//
// The cost was not subtle. Landing the game's 1,706,847 real windows:
//
//                        on the AABB      on the box we DRAW
//   "no wall faces that way"   48.7%   ->        0.9%
//   landed (margin 2 m)        22.9%   ->       43.4%
//
// Half the city's windows matched no wall AT ALL — not because Night City's walls are strange,
// but because we were asking a bounding box which way its walls faced. The renderer never had
// this bug (three-scene.js keeps the quaternion); every SCRIPT did.
//
// So: keep the orientation, and do every test in the BOX'S OWN FRAME, where it is an honest AABB.
const bx = [], by = [], bz = [];                  // centre, CET
const thx = [], thy = [], thz = [];               // TRUE half-extents, CET
const bqx = [], bqy = [], bqz = [], bqw = [];     // orientation, CET
const bhx = [], bhy = [], bhz = [];               // world AABB — BROAD-PHASE ONLY (the spatial hash)
const bDist = [];
for (const meta of DISTRICTS) {
  const m = SET === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
  if (!(m.dataDdsFixed || m.dataDds)) continue;
  let d;
  try { d = decodeDistrict(m); } catch (e) { console.warn(`  skip ${meta.name}: ${e.message}`); continue; }
  for (let i = 0; i < d.count; i++) {
    bx.push(d.bcx[i]); by.push(-d.bcz[i]); bz.push(d.bcy[i]);
    bhx.push(d.bhx[i]); bhy.push(d.bhz[i]); bhz.push(d.bhy[i]);
    // THREE -> CET. Extents: THREE (x,y,z) = CET (x,z,y). Quaternion: THREE (X,Y,Z,W) was built
    // from CET (qx,qy,qz,qw) as (qx, qz, -qy, qw), so the inverse is CET = (X, -Z, Y, W).
    thx.push(d.btx[i]); thy.push(d.btz[i]); thz.push(d.bty[i]);
    bqx.push(d.bqx[i]); bqy.push(-d.bqz[i]); bqz.push(d.bqy[i]); bqw.push(d.bqw[i]);
    bDist.push(meta.name);
  }
}
const NB = bx.length;
console.log(`boxes (${SET}): ${NB.toLocaleString()}  [ORIENTED]\n`);

// Rotate v by the CONJUGATE of box b's quaternion: world -> the box's own frame. In that frame
// the box is axis-aligned again and every test below is the simple one it always looked like.
function toLocal(b, v) {
  const x = -bqx[b], y = -bqy[b], z = -bqz[b], w = bqw[b];
  const [a, c, d] = v;
  const tx = 2 * (y * d - z * c), ty = 2 * (z * a - x * d), tz = 2 * (x * c - y * a);
  return [a + w * tx + (y * tz - z * ty), c + w * ty + (z * tx - x * tz), d + w * tz + (x * ty - y * tx)];
}

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

// ── ASSETS: the REAL window geometry ────────────────────────────────────────
// THE WINDOW IS A SUBMESH, NOT A PANEL. This used to take the mesh's whole bounding box and
// call its two largest dimensions "glass":
//
//     const area = d[order[1]] * d[order[2]];       // <- 48.00 m2 of CONCRETE
//
// `cct_cpz_building_a_b_6m_window` is a 6 x 8 m facade slab with four window strips set into
// it. Its true glass area is 17.10 m2. Every window model this project has built lit the slab,
// and no amount of re-normalising a denominator was ever going to fix a numerator that was
// measuring the wall. scripts/window_geom.js pulls the glass submesh out of the mesh's GLB and
// sums its TRIANGLES (one-sided — 45% of panes are modelled front AND back).
//
// NO FALLBACK. An asset with no entry in window-geom.json contributes NO glass and is COUNTED.
// It does not get a guessed area, because a guessed area is indistinguishable from a measured
// one three months later. If a district goes dark, the console says exactly how many assets and
// how many placed copies were missing geometry, and that is a bug to fix upstream — in the
// export — not to paper over here.
const GEOM_FILE = path.join(__dirname, '..', 'data', 'window-geom.json');
if (!fs.existsSync(GEOM_FILE)) {
  console.error(`\nMISSING ${GEOM_FILE}\nRun:  node scripts/window_geom.js\n`);
  process.exit(1);
}
const GEOM = JSON.parse(fs.readFileSync(GEOM_FILE, 'utf8'));

// Appearance id -> name. 30.2% of placed instances use a NON-DEFAULT appearance, and on 190
// meshes the appearance changes WHICH CHUNKS ARE GLASS. Resolving every instance against the
// default appearance would misglaze a third of the city.
const APP_NAME = {};
for (const r of readCsv('ncz_appearances.csv')) APP_NAME[r.id] = r.appearance;

// The CSV-based glass test is kept for ONE purpose: to count what the GLB export MISSED. It is
// no longer what decides whether a pane is glass — the mesh's own chunk->material assignment is
// (see window_geom.js). Two independent answers to "is this glass", and the gap between them is
// a number we print rather than a difference we hide.
const isGlassMat = makeGlassTest(readCsv('ncz_materials.csv'));
const asset = {};
// "The CSV says glass but we have no geometry" is TWO DIFFERENT FACTS, and adding them together
// produces one big scary number that hides the only one worth acting on:
//
//   NOT EXPORTED — the GLB is not on disk. A HOLE. The building goes dark and it is our fault.
//   NO GLASS     — the GLB is on disk and has no glass chunk. CORRECT, and the CSV is wrong.
//
// The CSV reads the material LIBRARY; the mesh reads the material ASSIGNMENT (world-asset-
// reference S3). `cct_cpz_building_a_shield_e_24m_h16m` ADVERTISES window_parallax_interior and
// assigns it to no chunk in any appearance — its GLB has a single submesh, the concrete. It is a
// solid cladding panel. Verified on 5 of these; all 5 are glassless and the GLB is right.
//
// 308 assets / 396k placed copies land in the second bucket. Reporting them as "missing" would
// send the next person to fix an export that is not broken.
const noGlass = {};                           // exported, genuinely renders no glass  — CORRECT
const notExported = {};                       // no GLB on disk                        — A HOLE
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  const g = GEOM[(a.path || '').toLowerCase()];
  if (g) { asset[a.id] = g; continue; }
  if (!isGlassMat((a.mat_names || '').split('|'), (a.mat_paths || '').split('|'))) continue;
  const glb = path.join(RAW, a.path.replace(/\.mesh$/i, '.glb'));
  if (fs.existsSync(glb)) noGlass[a.id] = a.path;
  else notExported[a.id] = a.path;
}

/**
 * Which chunks of this instance's appearance are WINDOWS?
 *
 * EMISSIVE ONES. Not "glass" — 43% of this city's glass area (40,300 m2) never lights up:
 * `glass.mt` on doors, balustrades, shopfronts and the Corpo Plaza roundabout canopy. It is
 * glass. It is not a window, and counting it as one lights the wrong city.
 *
 * The material says which is which — `EmissiveEV`, and window_geom.js records it per (appearance,
 * chunk) because the SAME chunk can be an emissive window in one appearance and plain glass in
 * another. `--allglass` restores the old behaviour for comparison.
 *
 * An appearance the mesh does not define (or a blank `app`) falls back to the mesh's default —
 * which is what the engine does — and is counted.
 */
const ALL_GLASS = process.argv.includes('--allglass');
let appFallback = 0;
function glazed(g, appId) {
  const name = APP_NAME[appId];
  const a = (name && g.apps[name]) || null;
  if (!a && name && name !== 'default' && name !== '' && name !== 'None') appFallback++;
  const rec = a || g.apps[Object.keys(g.apps)[0]] || { g: [], e: [] };
  return ALL_GLASS ? (rec.g || []) : (rec.e || []);
}

/**
 * The area of a planar patch with unit normal `n` after scaling by diag(sx,sy,sz).
 *
 * NOT "multiply the two non-thin axes". Sloped glazing has no thin AXIS — Corpo Plaza's
 * `*_slope_window` panes are flat quads tilted off every axis, and 61% of glass chunks are
 * AABB-thick for exactly this reason. For a plane, the exact factor is  |det S| * |S^-T n|,
 * which is 1.0 for unit scale and correct at any orientation.
 */
function areaScale(n, sx, sy, sz) {
  if (sx === 1 && sy === 1 && sz === 1) return 1;
  const det = sx * sy * sz;
  return det * Math.hypot(n[0] / sx, n[1] / sy, n[2] / sz);
}

// ── ACCUMULATE ──────────────────────────────────────────────────────────────
const gArea = new Float64Array(NB);           // glass area landed on each box
const gCount = new Uint32Array(NB);
const BANDS = 10;
const prof = new Float64Array(BANDS);         // area-weighted vertical profile, box-relative
const face = { px: 0, nx: 0, py: 0, ny: 0, roof: 0 };
let panes = 0, joined = 0, orphan = 0, nearHits = 0;
let below = 0, above = 0, tooFlat = 0, profiled = 0;
const orphanZ = [];
// The coverage counters. A pane that goes dark must say WHY, in a number, next to the total.
let missGeom = 0, csvFalsePos = 0, noGlassInApp = 0;
let panelAreaWould = 0, glassAreaReal = 0;  // the instance-WEIGHTED overcount, the honest one

function pane(a, x, y, z, q, sx, sy, sz, appId) {
  const g = asset[a];
  if (g === undefined) {
    // Neither silently dropped nor given a fallback area — counted, and split by CAUSE.
    if (notExported[a] !== undefined) missGeom++;        // a hole. Our fault.
    else if (noGlass[a] !== undefined) csvFalsePos++;    // the CSV was wrong. Correctly dark.
    return;
  }
  panes++;
  sx = sx || 1; sy = sy || 1; sz = sz || 1;

  // THE AREA. Sum the glass CHUNKS this instance's appearance actually glazes — the real
  // window submeshes, one-sided, scaled into world space. Never a bounding box.
  const chunks = glazed(g, appId);
  let area = 0;
  let nX = 0, nY = 0, nZ = 0;                 // area-weighted mean glass normal, LOCAL space
  for (const c of chunks) {
    const ch = g.chunks[c];
    if (!ch) continue;
    const wa = ch.area * areaScale(ch.n, sx, sy, sz);
    area += wa;
    nX += ch.n[0] * wa; nY += ch.n[1] * wa; nZ += ch.n[2] * wa;
  }
  if (!(area > 0)) { noGlassInApp++; return; }   // this appearance glazes nothing. Legitimate.

  // What the OLD model would have lit for this same placed copy: the whole facade slab. Kept
  // ONLY to report the instance-weighted overcount — the per-asset ratio is meaningless because
  // a mesh placed once would count the same as one placed 40,000 times.
  glassAreaReal += area;
  panelAreaWould += g.panelArea * (sx * sy);

  // THE NORMAL is now the GLASS's own normal, not the panel's thinnest axis. On a flat facade
  // panel these agree; on sloped glazing the panel has no thin axis at all, and the old rule
  // was picking a direction out of an axis-aligned bounding box that does not describe the
  // surface. Face assignment and the roof/wall split both read this.
  const nl0 = Math.hypot(nX, nY, nZ) || 1;
  const n = qRot(q, [nX / nl0, nY / nl0, nZ / nl0]);
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;

  // WHICH BOX DOES THIS PANE BELONG TO?
  //
  // EVERY TEST BELOW IS IN THE BOX'S OWN FRAME. Rotate the pane's position and normal by the
  // box's inverse quaternion and the box becomes axis-aligned again — so "which wall is this
  // window on" is the simple question it always looked like, asked of the RIGHT wall.
  //
  // Doing it in world space against the AABB is what broke this: a 33-deg-yawed slab has walls
  // facing NNE/WNW/SSW/ESE, but its bounding box has walls facing N/E/S/W and standing 22 m
  // further out. A window on the real wall matched nothing and was silently dropped.
  //
  // ASSIGN=volume (the shipped rule): the smallest box CONTAINING the pane. Buildings are
  // interpenetrating slab SOUP, so "contains" is satisfied by every slab the pane sits inside,
  // and "smallest" can hand a facade window to a tiny INTERIOR slab. Kept because it is what the
  // shipped bake used — and it is now at least being asked of the right boxes.
  //
  // ASSIGN=surface: a window is mounted ON A FACE. Find the box whose FACE it sits on — the
  // normal must AGREE with that face's. An interior slab has no face there, so it cannot claim it.
  //
  // ASSIGN=near: every box containing the pane gets credit, non-exclusively (facemask reasoning —
  // stop trying to reach a per-box verdict in slab soup; the fragment decides).
  const cand = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
  let best = -1, bestScore = Infinity;

  // pane position + normal in box b's frame
  const lp = (b) => toLocal(b, [x - bx[b], y - by[b], z - bz[b]]);
  const ln = (b) => toLocal(b, [nx, ny, nz]);
  const inBox = (b, p) => Math.abs(p[0]) <= thx[b] + MARGIN
    && Math.abs(p[1]) <= thy[b] + MARGIN
    && Math.abs(p[2]) <= thz[b] + MARGIN;

  if (cand && ASSIGN !== 'near') {
    for (const b of cand) {
      const p = lp(b);
      if (ASSIGN === 'volume') {
        if (!inBox(b, p)) continue;
        const vol = thx[b] * thy[b] * thz[b];       // the TRUE volume, not the AABB's
        if (vol < bestScore) { bestScore = vol; best = b; }
        continue;
      }
      // --- surface assignment, in the box's own frame ---
      const m = ln(b);
      const ax = Math.abs(m[0]) >= Math.abs(m[1]) && Math.abs(m[0]) >= Math.abs(m[2]) ? 0
        : Math.abs(m[1]) >= Math.abs(m[2]) ? 1 : 2;
      const th = [thx[b], thy[b], thz[b]];
      let outside = false;
      for (let k = 0; k < 3; k++) {
        if (k === ax) continue;
        if (Math.abs(p[k]) > th[k] + MARGIN) { outside = true; break; }
      }
      if (outside) continue;
      const d = Math.abs(p[ax] - Math.sign(m[ax] || 1) * th[ax]);
      if (d > MARGIN) continue;                     // not mounted on this box's face
      if (d < bestScore) { bestScore = d; best = b; }
    }
  }

  // Record which of the box's OWN faces the glass is on, and where up the box it sits. Both are
  // box-local now — a yawed tower's "+X wall" is its wall, not a compass direction.
  const account = (b) => {
    const p = lp(b), m = ln(b);
    const h = 2 * thz[b];
    if (h > 3) {
      const t = (p[2] + thz[b]) / h;
      if (t < 0) below++; else if (t >= 1) above++;
      else { prof[Math.floor(t * BANDS)] += area; profiled++; }
    } else tooFlat++;
    if (Math.abs(m[2]) > 0.940) face.roof += area;
    else if (Math.abs(m[0]) >= Math.abs(m[1])) (m[0] >= 0 ? face.px += area : face.nx += area);
    else (m[1] >= 0 ? face.py += area : face.ny += area);
  };

  if (ASSIGN === 'near') {
    let hits = 0, first = -1;
    if (cand) {
      for (const b of cand) {
        if (!inBox(b, lp(b))) continue;
        gArea[b] += area; gCount[b]++; hits++;
        if (first < 0) first = b;
      }
    }
    if (!hits) { orphan++; orphanZ.push(z); return; }
    joined++;
    nearHits += hits;
    account(first);
    return;
  }

  if (best < 0) { orphan++; orphanZ.push(z); return; }

  joined++;
  gArea[best] += area;
  gCount[best]++;
  account(best);
  // `account` does the vertical profile and the face split, both in the box's own frame.
  //
  // DO NOT CLAMP the profile. The join allows a MARGIN, so a pane may legitimately sit slightly
  // below a box's base or above its top. Clamping those into t=0 / t=1 dumps them into the end
  // bands and MANUFACTURES a U-shaped profile out of the join margin itself. They are counted
  // (`below` / `above`) and excluded — a pane outside the box's own height is not evidence about
  // where glass sits on a facade, it is evidence about how badly the box fits the building.
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
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });
  // ... AND the nodes that were never instanced. Both, or 11% of the city's glass vanishes.
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    const x = +f[C.x], y = +f[C.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
    pane(f[C.asset], x, y, +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });

  // ── 0. COVERAGE — before any aggregate, what did we FAIL to measure? ──────
  // Every hole in this pipeline was a silent filter that produced a complete-looking number.
  // None was caught by tooling; each was caught by someone reading a total and saying "that
  // cannot be right". So the misses are printed FIRST, above the numbers they would corrupt.
  console.log('\n=== 0. COVERAGE — what has NO window geometry, and why\n');
  const holes = Object.keys(notExported).length;
  console.log(`  glass assets WITH geometry      ${Object.keys(asset).length}`);
  console.log(`  CSV says glass, mesh renders none ${Object.keys(noGlass).length}  (${csvFalsePos.toLocaleString()} placed copies)`);
  console.log('     ^ CORRECT, and not a hole. The CSV reads the material LIBRARY; the mesh reads the');
  console.log('       ASSIGNMENT. `cct_cpz_building_a_shield_*` advertises glass and assigns it to no');
  console.log('       chunk — one submesh, all concrete. It is cladding. The GLB is right.');
  console.log(`\n  NOT EXPORTED (no GLB)           ${holes}  (${missGeom.toLocaleString()} placed copies)`);
  console.log(`  panes whose appearance glazes 0 ${noGlassInApp.toLocaleString()}   (legitimate — e.g. a boarded-up variant)`);
  console.log(`  appearance not on the mesh      ${appFallback.toLocaleString()}   (fell back to the mesh default, as the engine does)`);
  if (holes) {
    console.log('\n  THESE ARE REAL HOLES — buildings go dark and it is our fault:');
    for (const p of Object.values(notExported).slice(0, 8)) console.log(`    ${p}`);
    console.log('\n  FIX IN THE EXPORT (scripts/wkit/export_glass_meshes.wscript), not here.');
  } else {
    console.log('\n  NO HOLES: every glass-bearing asset in the city has its window geometry.');
  }

  console.log('\n=== 0b. THE OVERCOUNT, INSTANCE-WEIGHTED — the honest ratio\n');
  console.log(`  panel area, all placed copies   ${(panelAreaWould / 1e6).toFixed(2)}M m2   <- what we have been lighting`);
  console.log(`  TRUE glass area, same copies    ${(glassAreaReal / 1e6).toFixed(2)}M m2   <- the window submeshes`);
  console.log(`  we were lighting                ${(panelAreaWould / glassAreaReal).toFixed(2)}x too much glass`);

  // ── 1. THE JOIN RATE — this is the validation, not a statistic ────────────
  console.log('=== 1. DO THE REAL WINDOWS LAND ON THE BOXES WE RENDER?\n');
  console.log(`  glass panes             : ${panes.toLocaleString()}`);
  console.log(`  landed on a box         : ${joined.toLocaleString()}  (${(100 * joined / panes).toFixed(1)}%)   <- margin ${MARGIN} m`);
  console.log(`  orphaned (no box there) : ${orphan.toLocaleString()}  (${(100 * orphan / panes).toFixed(1)}%)`);
  console.log(`\n  The alignment test puts our cloud at ~86% recall against real architecture.`);
  console.log(`  A join rate near that is the pass mark. Far below ⇒ our boxes are not where`);
  console.log(`  the buildings are. Near 100% ⇒ the margin is catching panes that belong to nothing.`);

  // ── 2. PER-BOX GLASS SHARE — the number the shader wants ──────────────────
  // A box's facade is its four sides: perimeter x height.
  console.log('\n=== 2. PER-BOX GLASS SHARE — glass area / facade area\n');
  const lit = [];
  for (let b = 0; b < NB; b++) {
    if (!gCount[b]) continue;
    // THE TRUE facade — perimeter x height of the box we DRAW. Using the AABB here inflates the
    // denominator (a 12 x 61 m yawed slab bounds to 57 x 43) and silently dilutes every share.
    const facade = 4 * (thx[b] + thy[b]) * (2 * thz[b]);
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
    const foot = Math.max(2 * thx[b], 2 * thy[b]);      // the box's TRUE footprint, not its bound
    const hgt = 2 * thz[b];
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
    D.fA += 4 * (thx[b] + thy[b]) * (2 * thz[b]);
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
        const facade = 4 * (thx[b] + thy[b]) * (2 * thz[b]);   // TRUE facade — see section 2
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
