#!/usr/bin/env node
/**
 * scripts/window_place.js
 * ─────────────────────────────────────────────────────────────────────────
 * WHERE ARE THE WINDOWS, IN METRES?
 *
 * The night model was statistical because instanced nodes had no position. They always
 * did — see [[instanced-transforms-were-always-readable]]. `ncz_instances.csv` now carries
 * one row per PLACED COPY: exact CET XYZ, a quaternion, and a scale. Joined to each mesh's
 * local bounding box (`ncz_assets.csv`) and its building (`ncz_prefabs.csv`), every window
 * pane in Night City is a measured object.
 *
 * A placement dataset is the UNION of two sources, and using either alone is a hole:
 *
 *     ncz_instances.csv   one row per copy of an INSTANCED node   (inst > 1)
 *     ncz_nodes.csv       the nodes that were never instanced     (inst == 1)
 *
 * VALIDATE BEFORE MEASURING. Exact positions make two load-bearing assumptions falsifiable
 * for the first time, so this script tests them BEFORE it reports a single aggregate:
 *
 *   1. COVERAGE — what fraction of glass has a real position now? (Was 11.3%.) An aggregate
 *      without its denominator's coverage is not a measurement, it is a mood.
 *   2. COMPACTNESS — a prefab is claimed to be A BUILDING. Then its parts must be within a
 *      building's diameter of each other. If a prefab's panes sprawl 400 m, its ref is
 *      mis-attributed and per-building anything is nonsense. (Suspect: ~492 panes hang off
 *      prefabs named `building_exhaust_vent_large_b`.)
 *
 * Only then:
 *   3. Per-building glass share, AREA-weighted (the 25% median was by instance COUNT).
 *   4. The vertical profile — where on a facade does glass actually sit?
 *   5. Facade orientation — wall / raked / roof, from the real quaternion.
 *
 * Reports. Decides nothing. Writes no model.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const SEP = /[\\/]/;
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;
const WIN = /window_parallax_interior|window_interior_uv/i;

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

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];

// ── Quaternion rotate (CET: i,j,k,r == x,y,z,w; Z is UP) ────────────────────
function qRot(q, v) {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
}

// ── ASSETS: local box + is-it-glass ─────────────────────────────────────────
const matRoot = {};
for (const m of readCsv('ncz_materials.csv')) {
  matRoot[m.path.toLowerCase()] = (m.root_mt || '').split(SEP).pop();
}

const asset = {};   // id → { path, dims:[dx,dy,dz], glass:bool }
let noBox = 0;
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;   // architecture + megabuilding only; not props, not proxies
  const dx = +a.bbx1 - +a.bbx0, dy = +a.bby1 - +a.bby0, dz = +a.bbz1 - +a.bbz0;
  const ok = [dx, dy, dz].every((v) => Number.isFinite(v) && v > 0);
  if (!ok) noBox++;
  const names = (a.mat_names || '').split('|');
  const paths = (a.mat_paths || '').split('|');
  // Glass is decided by the resolved .mi → root .mt chain, NEVER by the mesh name: a glass
  // panel's material is `..._h400_w300_mlt.mi` and contains no window name at all.
  const glass = names.some((n) => WIN.test(n))
             || paths.some((p) => WIN.test(p) || WIN.test(matRoot[p.toLowerCase()] || ''));
  asset[a.id] = { path: a.path, dims: ok ? [dx, dy, dz] : null, glass };
}

// ── PREFABS: id → ref path (the building link) ──────────────────────────────
const refOf = {};
for (const p of readCsv('ncz_prefabs.csv')) refOf[p.id] = p.ref;

// ── ACCUMULATORS ────────────────────────────────────────────────────────────
const B = {};        // prefab id → building aggregate
const panes = [];    // every glass pane: { pf, z, area, roof }
let glassPlaced = 0, glassNoPos = 0, glassNoBox = 0, wallPlaced = 0;
let rows = 0, fromInst = 0, fromNodes = 0;

// The placed box: the mesh's LOCAL dims × this copy's scale. Exact — a copy is the same
// mesh at the same scale, no inference, no sampling.
// The PANEL AREA is the product of the two LARGEST dims: a window pane is a thin slab and
// its face is what you see. Its NORMAL is the thinnest local axis, rotated into the world.
function part(a, pf, x, y, z, q, sx, sy, sz) {
  const A = asset[a];
  if (!A) return;                       // not architecture — decoration, props, proxies
  if (!A.dims) { if (A.glass) glassNoBox++; return; }

  const d = [A.dims[0] * (sx || 1), A.dims[1] * (sy || 1), A.dims[2] * (sz || 1)];
  const order = [0, 1, 2].sort((i, j) => d[i] - d[j]);   // thin → thick
  const thin = order[0];
  const area = d[order[1]] * d[order[2]];

  const axis = [0, 0, 0]; axis[thin] = 1;
  const n = qRot(q, axis);
  const roof = Math.abs(n[2]) / (Math.hypot(n[0], n[1], n[2]) || 1);   // 0 = wall, 1 = roof

  const b = B[pf] || (B[pf] = {
    gA: 0, wA: 0, gN: 0, wN: 0,
    x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity,
  });
  if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  if (z < b.z0) b.z0 = z; if (z > b.z1) b.z1 = z;

  if (A.glass) {
    b.gA += area; b.gN++;
    glassPlaced++;
    panes.push({ pf, z, area, roof });
  } else {
    b.wA += area; b.wN++;
    wallPlaced++;
  }
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
  if (!fs.existsSync(path.join(RAW, 'ncz_instances.csv'))) {
    console.error('ncz_instances.csv is not there. Run scripts/wkit/dump_night_raw.wscript first.');
    process.exit(1);
  }

  // 1. INSTANCED COPIES — one row per copy, each with its own transform.
  await stream('ncz_instances.csv', (f, C) => {
    rows++; fromInst++;
    part(f[C.asset], f[C.prefab] || '(none)',
      +f[C.x], +f[C.y], +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]],
      +f[C.sx], +f[C.sy], +f[C.sz]);
  });

  // 2. THE NODES THAT WERE NEVER INSTANCED — inst == 1, position on the node itself.
  //    Skipping these would drop 17,849 glass panes (11% of the city's glass).
  await stream('ncz_nodes.csv', (f, C) => {
    const inst = Math.max(1, +f[C.inst] || 1);
    if (inst > 1) return;                       // already counted, per-copy, above
    const x = +f[C.x], y = +f[C.y], z = +f[C.z];
    const A = asset[f[C.asset]];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
      if (A && A.glass) glassNoPos++;
      return;
    }
    rows++; fromNodes++;
    part(f[C.asset], f[C.prefab] || '(none)', x, y, z,
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]],
      +f[C.sx], +f[C.sy], +f[C.sz]);
  });

  // ── 1. COVERAGE ───────────────────────────────────────────────────────────
  const gTot = glassPlaced + glassNoPos + glassNoBox;
  console.log('=== 1. COVERAGE — how much of the glass is actually placed?\n');
  console.log(`  arch parts placed      : ${rows.toLocaleString()}  (${fromInst.toLocaleString()} instanced copies + ${fromNodes.toLocaleString()} single nodes)`);
  console.log(`  GLASS panes with XYZ   : ${glassPlaced.toLocaleString().padStart(9)}  (${(100 * glassPlaced / gTot).toFixed(1)}%)`);
  console.log(`  glass with NO position : ${glassNoPos.toLocaleString().padStart(9)}  (${(100 * glassNoPos / gTot).toFixed(1)}%)`);
  console.log(`  glass with NO mesh box : ${glassNoBox.toLocaleString().padStart(9)}  (${(100 * glassNoBox / gTot).toFixed(1)}%)`);
  console.log(`  wall parts with XYZ    : ${wallPlaced.toLocaleString()}`);
  if (glassPlaced / gTot < 0.9) {
    console.error('\n  !! COVERAGE TOO LOW to build a placement model on. Fix the dump, not the model.');
    process.exit(2);
  }

  // ── 2. COMPACTNESS — is a "building" actually building-sized? ─────────────
  const ids = Object.keys(B).filter((k) => k !== '(none)' && B[k].gN >= 4);
  const diag = ids.map((k) => ({ k, d: Math.hypot(B[k].x1 - B[k].x0, B[k].y1 - B[k].y0) }))
    .sort((a, b) => a.d - b.d);
  const ds = diag.map((o) => o.d);
  console.log('\n=== 2. COMPACTNESS — a prefab claims to be ONE BUILDING. Is it?\n');
  console.log(`  prefabs with >=4 glass panes: ${ids.length.toLocaleString()}`);
  console.log(`  XY footprint diagonal: p10 ${pct(ds, 0.1).toFixed(0)} m   median ${pct(ds, 0.5).toFixed(0)} m   p90 ${pct(ds, 0.9).toFixed(0)} m   max ${ds[ds.length - 1].toFixed(0)} m`);
  const sprawl = diag.filter((o) => o.d > 150);
  console.log(`\n  prefabs sprawling >150 m (NOT a building — a mis-attributed ref): ${sprawl.length}`);
  for (const o of sprawl.slice(-5).reverse()) {
    const leaf = ((refOf[o.k] || '?').split('/').pop() || '?');
    console.log(`    ${o.d.toFixed(0).padStart(5)} m   ${B[o.k].gN.toString().padStart(4)} panes   ${leaf}`);
  }
  console.log('\n  A building is tens of metres across. If the median is building-sized, prefab =');
  console.log('  building identity holds, and startIndex is landing panes on the right object.');

  // ── 3. PER-BUILDING GLASS SHARE, AREA-WEIGHTED ───────────────────────────
  const both = ids.filter((k) => B[k].wA > 0);
  const shareA = both.map((k) => B[k].gA / (B[k].gA + B[k].wA)).sort((a, b) => a - b);
  const shareN = both.map((k) => B[k].gN / (B[k].gN + B[k].wN)).sort((a, b) => a - b);
  console.log('\n=== 3. PER-BUILDING GLASS SHARE — area-weighted vs the old count-weighted\n');
  console.log(`  buildings with BOTH glass and wall: ${both.length.toLocaleString()}\n`);
  console.log(`  by instance COUNT (the old number): p10 ${(100 * pct(shareN, 0.1)).toFixed(1)}%   median ${(100 * pct(shareN, 0.5)).toFixed(1)}%   p90 ${(100 * pct(shareN, 0.9)).toFixed(1)}%`);
  console.log(`  by AREA           (the real one)  : p10 ${(100 * pct(shareA, 0.1)).toFixed(1)}%   median ${(100 * pct(shareA, 0.5)).toFixed(1)}%   p90 ${(100 * pct(shareA, 0.9)).toFixed(1)}%`);

  // ── 4. THE VERTICAL PROFILE ──────────────────────────────────────────────
  // Where on a facade does glass sit? Height above the building's own base, so a 200 m
  // tower and a 6 m shack are comparable. Weighted by AREA — a big pane is more window
  // than a small one, and the shader cares about area, not about pane count.
  console.log('\n=== 4. VERTICAL PROFILE — where on the facade is the glass?\n');
  const BANDS = 10;
  const byBand = new Array(BANDS).fill(0);
  let profiled = 0, flat = 0, noPf = 0, absurd = 0;
  const hts = [];
  for (const p of panes) {
    // A pane with NO prefab has no building to be measured against. Its parts all pile into
    // one `(none)` bucket whose bounding box is THE WHOLE CITY — so "height above its base"
    // comes out as up to 1,042 m, which is not a fact about windows, it is a fact about a
    // bucket. Excluded, and COUNTED, rather than silently averaged in.
    if (p.pf === '(none)') { noPf++; continue; }
    const b = B[p.pf];
    if (!b) continue;
    const h = b.z1 - b.z0;
    if (!(h > 3)) { flat++; continue; }          // a building with no height: nothing to profile
    // Night City's tallest structure is a few hundred metres. A "building" taller than that
    // is a mis-attributed prefab ref, not architecture. Refuse it rather than let it set the
    // top of the scale for everything else.
    if (h > 450) { absurd++; continue; }
    const t = Math.min(0.999, Math.max(0, (p.z - b.z0) / h));
    byBand[Math.floor(t * BANDS)] += p.area;
    hts.push(p.z - b.z0);
    profiled++;
  }
  const gsum = byBand.reduce((a, b) => a + b, 0);
  console.log(`  panes profiled: ${profiled.toLocaleString()}`);
  console.log(`    excluded: ${noPf.toLocaleString()} with no prefab (no building to measure against)`);
  console.log(`              ${flat.toLocaleString()} in buildings <3 m tall`);
  console.log(`              ${absurd.toLocaleString()} in "buildings" >450 m tall (mis-attributed refs)\n`);
  console.log('  height on building      glass area');
  for (let i = BANDS - 1; i >= 0; i--) {
    const f = gsum ? byBand[i] / gsum : 0;
    const bar = '#'.repeat(Math.round(50 * f / (Math.max(...byBand) / gsum || 1)));
    console.log(`   ${String(i * 10).padStart(3)}-${String((i + 1) * 10).padEnd(3)}%   ${(100 * f).toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log('\n  Flat ⇒ glass is spread evenly up the facade (a curtain wall).');
  console.log('  Peaked ⇒ glass CLUSTERS at a height — which is what the frames show.');

  // Absolute height too: a shopfront band would show up here and not above. Same population
  // as the profile above — no `(none)` bucket, no 1 km "buildings".
  const zs = hts.sort((a, b) => a - b);
  console.log(`\n  height above own base, metres: p10 ${pct(zs, 0.1).toFixed(1)}  median ${pct(zs, 0.5).toFixed(1)}  p90 ${pct(zs, 0.9).toFixed(1)}  max ${zs[zs.length - 1].toFixed(0)}`);

  // And how tall are the buildings we are profiling? If the glass sits at 50-60% of height,
  // the metres that represents depends entirely on this, and it is the number that tells us
  // whether "a building" here means a 6 m shack or a 200 m tower.
  const bh = ids.filter((k) => B[k].wA > 0).map((k) => B[k].z1 - B[k].z0)
    .filter((h) => h > 3 && h <= 450).sort((a, b) => a - b);
  console.log(`  building height, metres     : p10 ${pct(bh, 0.1).toFixed(1)}  median ${pct(bh, 0.5).toFixed(1)}  p90 ${pct(bh, 0.9).toFixed(1)}  max ${bh[bh.length - 1].toFixed(0)}`);

  // ── 5. FACADE ORIENTATION ────────────────────────────────────────────────
  // Our buildings are axis-aligned BOXES: their side faces are the walls the shader lights,
  // and `onWall` kills anything within ~55 deg of horizontal. So how much of the real glass
  // is WALL glass, and how much are we discarding as roof?
  console.log('\n=== 5. ORIENTATION — how much glass is wall, and how much is roof?\n');
  let wA = 0, aA = 0, rA = 0;
  for (const p of panes) {
    if (p.roof < 0.342) wA += p.area;         // < 20 deg from vertical: a WALL
    else if (p.roof < 0.940) aA += p.area;    // 20-70 deg: a RAKED facade
    else rA += p.area;                        // > 70 deg: a ROOF
  }
  const tA = wA + aA + rA;
  console.log(`  WALL   (<20 deg from vertical) : ${(100 * wA / tA).toFixed(1)}%   ${(wA / 1e3).toFixed(1)}k m2`);
  console.log(`  RAKED  (20-70 deg)             : ${(100 * aA / tA).toFixed(1)}%   ${(aA / 1e3).toFixed(1)}k m2`);
  console.log(`  ROOF   (>70 deg)               : ${(100 * rA / tA).toFixed(1)}%   ${(rA / 1e3).toFixed(1)}k m2   <- killed by onWall today`);
})();
