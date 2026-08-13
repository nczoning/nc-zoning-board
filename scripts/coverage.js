#!/usr/bin/env node
/**
 * coverage.js: how much of the real building has NO box near it.
 *
 * Every metric this pipeline has measures the same direction: take a window,
 * find the nearest box, report the distance. That scores how ACCURATE the boxes
 * that exist are, and it is blind by construction to the boxes that do not.
 * A cloud can delete half a facade and score better, because the half it kept
 * got tighter and the half it dropped stopped being asked about.
 *
 * The maintainer's report has been the same for three rounds: "what is there is
 * more accurate, but what is missing makes it look worse". That is this metric
 * missing, not an opinion.
 *
 * So this runs the other direction. Sample the REAL geometry's surface, and for
 * each sample ask whether any box is within D. Uncovered samples are holes, and
 * they come back with coordinates so they can be looked at.
 *
 * It also compares the clouds as objects: CDPR ships 41,291 boxes for
 * city_center against this pipeline's 413,308, and knowing whether theirs are
 * bigger, fewer and more oriented says more about the look than either score.
 *
 * Usage:
 *   node scripts/coverage.js city_center
 *   node scripts/coverage.js city_center --cloud cdpr
 *   node scripts/coverage.js watson --samples 400000
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : d; };
const CLOUD = flag('cloud', 'hull');
const WANT = Number(flag('samples', 250000));
const MIN_DIM = Number(flag('mindim', 2));
const THRESH = [0, 0.5, 1, 2, 4, 8];

if (!name) { console.error('usage: node scripts/coverage.js <district> [--cloud hull|cdpr]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const braw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(braw.buffer, braw.byteOffset, braw.length / 4);
const S = meta.stride, PATHS = meta.assetPaths || {}, TYPE = meta.types || {};

// ── The cloud under test ──────────────────────────────────────────────────
const B = [];
if (CLOUD === 'hull') {
  const raw = fs.readFileSync(path.join(dataDir, `district-hull-${name}.bin`));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  for (let i = 0; i < f.length / 10; i++) {
    const o = i * 10;
    B.push({ c: [f[o], f[o + 1], f[o + 2]], h: [f[o + 3], f[o + 4], f[o + 5]], q: [f[o + 6], f[o + 7], f[o + 8], f[o + 9]] });
  }
} else {
  const META = require('./district_meta').DISTRICTS[name];
  const set = (args.includes('--vanilla') || META.noFixed) ? 'assets/dds' : 'assets/dds/fixed';
  const buf = fs.readFileSync(path.join(__dirname, '..', set, META.dds));
  const hdr = new Uint32Array(buf.buffer, buf.byteOffset, 32);
  const texH = hdr[3], texW = hdr[4], blockW = texW / 3;
  const px = new Uint16Array(buf.buffer, buf.byteOffset + 148, (buf.length - 148) / 2);
  const U16 = 65535, ALPHA = 655;
  for (let y = 0; y < texH; y++) {
    for (let x = 0; x < blockW; x++) {
      const pi = (y * texW + x) * 4, ri = (y * texW + x + blockW) * 4, si = (y * texW + x + 2 * blockW) * 4;
      if (px[pi + 3] < ALPHA) continue;
      if (px[si] < ALPHA && px[si + 1] < ALPHA && px[si + 2] < ALPHA) continue;
      const c = [
        META.transMin[0] + (META.transMax[0] - META.transMin[0]) * (px[pi] / U16) + META.offset[0],
        META.transMin[1] + (META.transMax[1] - META.transMin[1]) * (px[pi + 1] / U16) + META.offset[1],
        META.transMin[2] + (META.transMax[2] - META.transMin[2]) * (px[pi + 2] / U16),
      ];
      let q = [px[ri] / U16 * 2 - 1, px[ri + 1] / U16 * 2 - 1, px[ri + 2] / U16 * 2 - 1, px[ri + 3] / U16 * 2 - 1];
      const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      B.push({
        c, q: [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql],
        h: [px[si] / U16 * META.cubeSize, px[si + 1] / U16 * META.cubeSize, px[si + 2] / U16 * META.cubeSize],
      });
    }
  }
}

// Precompute each box's rotation and world AABB, and index them.
const CELL = 16;
const grid = new Map();
for (let i = 0; i < B.length; i++) {
  const b = B[i];
  const [qx, qy, qz, qw] = b.q;
  b.m = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  const e = [
    Math.abs(b.m[0]) * b.h[0] + Math.abs(b.m[1]) * b.h[1] + Math.abs(b.m[2]) * b.h[2],
    Math.abs(b.m[3]) * b.h[0] + Math.abs(b.m[4]) * b.h[1] + Math.abs(b.m[5]) * b.h[2],
    Math.abs(b.m[6]) * b.h[0] + Math.abs(b.m[7]) * b.h[1] + Math.abs(b.m[8]) * b.h[2],
  ];
  const pad = THRESH[THRESH.length - 1];
  for (let x = Math.floor((b.c[0] - e[0] - pad) / CELL); x <= Math.floor((b.c[0] + e[0] + pad) / CELL); x++) {
    for (let y = Math.floor((b.c[1] - e[1] - pad) / CELL); y <= Math.floor((b.c[1] + e[1] + pad) / CELL); y++) {
      for (let z = Math.floor((b.c[2] - e[2] - pad) / CELL); z <= Math.floor((b.c[2] + e[2] + pad) / CELL); z++) {
        const k = `${x},${y},${z}`;
        let l = grid.get(k); if (!l) grid.set(k, l = []);
        l.push(i);
      }
    }
  }
}

/** Distance from a world point to the nearest box surface, 0 when inside. */
function distToCloud(px, py, pz) {
  const l = grid.get(`${Math.floor(px / CELL)},${Math.floor(py / CELL)},${Math.floor(pz / CELL)}`);
  if (!l) return Infinity;
  let best = Infinity;
  for (const i of l) {
    const b = B[i], m = b.m;
    const dx = px - b.c[0], dy = py - b.c[1], dz = pz - b.c[2];
    // Into the box's own frame, then the standard point-to-box distance.
    const lx = m[0] * dx + m[3] * dy + m[6] * dz;
    const ly = m[1] * dx + m[4] * dy + m[7] * dz;
    const lz = m[2] * dx + m[5] * dy + m[8] * dz;
    const ox = Math.max(0, Math.abs(lx) - b.h[0]);
    const oy = Math.max(0, Math.abs(ly) - b.h[1]);
    const oz = Math.max(0, Math.abs(lz) - b.h[2]);
    const d = Math.hypot(ox, oy, oz);
    if (d < best) { best = d; if (best === 0) return 0; }
  }
  return best;
}

// ── Sample the real surface ───────────────────────────────────────────────
const cache = new Map();
function trisFor(depot) {
  if (cache.has(depot)) return cache.get(depot);
  let t = null;
  let file = glbPathFor(LOD_ROOT, depot);
  if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, depot);
  if (fs.existsSync(file)) { try { t = meshTriangles(file, 1); if (!t.length) t = null; } catch { t = null; } }
  cache.set(depot, t);
  return t;
}

const eligible = [];
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  if (Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2 < MIN_DIM) continue;
  const depot = PATHS[box[o + 10]];
  if (!depot) continue;
  const kind = categorize(depot, TYPE[box[o + 11]] || '');
  if (kind !== 'building') continue;
  eligible.push(i);
}
const step = Math.max(1, Math.floor(eligible.length / Math.max(1, Math.floor(WANT / 8))));
console.log(`district ${name}   cloud ${CLOUD}: ${B.length.toLocaleString()} boxes`);
console.log(`  sampling  every ${step} of ${eligible.length.toLocaleString()} building placements\n`);

// The pipeline deliberately cuts geometry buried deeper than BELOW metres
// under the terrain surface (basements, metro, quest blackout volumes), so the
// metric must not ask about it: on pacifica, one buried quest shroud
// (q110_black_box, sheets at z -80 to -650) was 66% of all sampled area and
// drowned every real number.
const { loadTerrain, indexTris, heightAtCet } = require('./terrain_lib');
const BELOW = Number(flag('below', 16));
const terrain = indexTris(loadTerrain());

const hist = new Array(THRESH.length + 1).fill(0);
let area = 0, uncovered = 0, samples = 0, buried = 0;
const holes = new Map();   // 32 m cell -> uncovered area, for somewhere to look
const byAsset = new Map(); // depot path -> uncovered area, for what kind of thing it is

for (let e = 0; e < eligible.length; e += step) {
  const i = eligible[e], o = i * S;
  const tris = trisFor(PATHS[box[o + 10]]);
  if (!tris) continue;
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const px0 = box[o + 13], py0 = box[o + 14], pz0 = box[o + 15];
  const sx = box[o + 16], sy = box[o + 17], sz = box[o + 18];

  const nTri = tris.length / 9;
  const tStep = Math.max(1, Math.floor(nTri / 8));
  for (let k = 0; k < nTri; k += tStep) {
    const t = k * 9;
    // Centroid and area in world space.
    const ax = tris[t] * sx, ay = tris[t + 1] * sy, az = tris[t + 2] * sz;
    const bx = tris[t + 3] * sx, by = tris[t + 4] * sy, bz = tris[t + 5] * sz;
    const cx2 = tris[t + 6] * sx, cy2 = tris[t + 7] * sy, cz2 = tris[t + 8] * sz;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const a2 = 0.5 * Math.hypot(nx, ny, nz);
    if (!(a2 > 0)) continue;
    const lx = (ax + bx + cx2) / 3, ly = (ay + by + cy2) / 3, lz = (az + bz + cz2) / 3;
    const wx = px0 + m00 * lx + m01 * ly + m02 * lz;
    const wy = py0 + m10 * lx + m11 * ly + m12 * lz;
    const wz = pz0 + m20 * lx + m21 * ly + m22 * lz;

    const g = heightAtCet(terrain, wx, wy);
    if (g !== null && wz < g - BELOW) { buried++; continue; }

    const d = distToCloud(wx, wy, wz);
    samples++; area += a2;
    let bucket = THRESH.length;
    for (let b = 0; b < THRESH.length; b++) if (d <= THRESH[b]) { bucket = b; break; }
    hist[bucket] += a2;
    if (bucket === THRESH.length) {
      uncovered += a2;
      const key = `${Math.round(wx / 32) * 32},${Math.round(wy / 32) * 32}`;
      holes.set(key, (holes.get(key) || 0) + a2);
      // WHICH ASSET is unrepresented matters more than where. A hole shared by
      // two clouds built by different people from the same world is not a bug
      // in either cloud; it is a class of thing both of them decided to leave
      // out, and the name says which class.
      const p = PATHS[box[o + 10]] || '?';
      const e2 = byAsset.get(p) || { area: 0, n: 0 };
      e2.area += a2; e2.n++;
      byAsset.set(p, e2);
    }
  }
}

console.log(`  samples   ${samples.toLocaleString()} triangles, ${Math.round(area).toLocaleString()} m2 of real surface ` +
            `(${buried.toLocaleString()} buried > ${BELOW} m below terrain, skipped)\n`);
console.log('  real surface within D of a box, by AREA:');
let cum = 0;
for (let b = 0; b < THRESH.length; b++) {
  cum += hist[b];
  console.log(`    <= ${String(THRESH[b]).padStart(3)} m   ${(100 * cum / area).toFixed(1)}%`);
}
console.log(`    BEYOND    ${(100 * uncovered / area).toFixed(1)}%   <- geometry the cloud does not represent`);

const worst = [...holes].sort((a, b) => b[1] - a[1]).slice(0, 12);
if (worst.length) {
  console.log('\n  the biggest holes (32 m cells, CET x,y):');
  for (const [k, a2] of worst) console.log(`    ${k.padEnd(18)} ${Math.round(a2).toLocaleString()} m2 uncovered`);
}

const topAsset = [...byAsset].sort((a, b) => b[1].area - a[1].area).slice(0, 14);
if (topAsset.length) {
  console.log('\n  the assets the cloud does not represent:');
  for (const [p, e] of topAsset) {
    console.log(`    ${String(Math.round(e.area)).padStart(8)} m2  ${String(e.n).padStart(6)} tris  ` +
                p.split('\\').slice(-2).join('\\'));
  }
}

// The clouds as objects, which says more about the look than either score.
const dims = B.map(b => [b.h[0] * 2, b.h[1] * 2, b.h[2] * 2]);
const vol = dims.reduce((s, d) => s + d[0] * d[1] * d[2], 0);
const maxd = dims.map(d => Math.max(...d)).sort((a, b) => a - b);
const yawed = B.filter(b => Math.abs(b.q[2]) > 1e-3 || Math.abs(b.q[0]) > 1e-3).length;
console.log(`\n  the cloud itself:`);
console.log(`    boxes         ${B.length.toLocaleString()}`);
console.log(`    total volume  ${(vol / 1e6).toFixed(2)} km3`);
console.log(`    largest dim   p50 ${maxd[maxd.length >> 1].toFixed(1)} m   p90 ${maxd[Math.floor(maxd.length * 0.9)].toFixed(1)} m   max ${maxd[maxd.length - 1].toFixed(0)} m`);
console.log(`    oriented      ${(100 * yawed / B.length).toFixed(1)}%`);
