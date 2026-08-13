#!/usr/bin/env node
/**
 * snap_hull.js: move the box cloud's outer faces onto the walls they stand for.
 *
 * A voxel grid decides where a surface is to the nearest cell, so at a 2 m cell
 * every facade sits up to a metre from the wall it represents, and two panels
 * of the same wall can land on opposite sides of the same boundary. That is
 * what the seams and the pixel-art look are made of, and no amount of merging
 * touches it: merging changes how many boxes there are, not where their faces
 * sit.
 *
 * The real geometry is on disk now, so the face can be asked where the wall
 * actually is. Per outer face: sample it, cast short rays along its normal
 * through a BVH of the true meshes, and if the samples agree on a plane within
 * SNAP, move the face there.
 *
 * INTERIOR FACES ARE LEFT ALONE. A face shared with the box next door is not a
 * surface, it is a join, and moving one side of a join opens a crack that shows
 * straight through the building. Only faces with no box behind them move.
 *
 * Every rule errs toward NOT moving: too few hits, or hits that disagree, and
 * the face stays where the grid put it. A cloud that is occasionally still
 * quantised is a cloud; a cloud with faces snapped onto whatever happened to be
 * nearby is confetti.
 *
 * Usage:
 *   node scripts/snap_hull.js city_center
 *   node scripts/snap_hull.js city_center --snap 1.5 --lod 1
 *   node scripts/snap_hull.js city_center --restore     # put the pre-snap cloud back
 *
 * Rewrites data/district-hull-<district>.bin, keeping the original beside it as
 * .presnap.bin so a score can be taken either way.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { MeshBvh, SceneBvh } = require('./bvh');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };

const SNAP = flag('snap', 2.5);        // metres a face may travel
const LOD = flag('lod', 1);            // LOD mask to measure against; 1 is finest
const MIN_DIM = flag('mindim', 1);     // ignore occluder meshes under this
const SAMPLES = 3;                     // per face axis, so 9 rays a face
const MIN_HIT = flag('minhit', 3);     // of 9, before a face may move
const SPREAD = flag('spread', 0.6);   // metres the hits may disagree by

if (!name) {
  console.error('usage: node scripts/snap_hull.js <district> [--snap 1.2] [--restore]');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
const hullPath = path.join(dataDir, `district-hull-${name}.bin`);
const backPath = path.join(dataDir, `district-hull-${name}.presnap.bin`);

if (args.includes('--restore')) {
  if (!fs.existsSync(backPath)) { console.error('no .presnap.bin to restore'); process.exit(1); }
  fs.copyFileSync(backPath, hullPath);
  console.log(`restored ${path.relative(process.cwd(), hullPath)} from .presnap.bin`);
  process.exit(0);
}

// The pre-snap cloud is the input every time, so re-running with a different
// SNAP measures that SNAP rather than compounding the last one.
if (!fs.existsSync(backPath)) fs.copyFileSync(hullPath, backPath);
const raw = fs.readFileSync(backPath);
const hull = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const nBox = hull.length / 10;
console.log(`district ${name}`);
console.log(`  hull      ${nBox.toLocaleString()} boxes`);

// ── The real geometry ─────────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const braw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(braw.buffer, braw.byteOffset, braw.length / 4);
const S = meta.stride, PATHS = meta.assetPaths || {}, TYPE = meta.types || {};

const blas = new Map();
const scene = new SceneBvh();
let tris = 0, placed = 0;
const t0 = Date.now();
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  if (Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2 < MIN_DIM) continue;
  const depot = PATHS[box[o + 10]];
  if (!depot) continue;
  const kind = categorize(depot, TYPE[box[o + 11]] || '');
  if (kind === 'never' || kind === 'boundary' || kind === 'proxy') continue;
  const aid = box[o + 10];
  let b = blas.get(aid);
  if (b === undefined) {
    b = null;
    let file = glbPathFor(LOD_ROOT, depot);
    if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, depot);
    if (fs.existsSync(file)) {
      try { const t = meshTriangles(file, LOD); if (t.length) { b = new MeshBvh(t); tris += t.length / 9; } }
      catch { b = null; }
    }
    blas.set(aid, b);
  }
  if (!b) continue;
  scene.add(b, [box[o + 13], box[o + 14], box[o + 15]],
    [box[o + 6], box[o + 7], box[o + 8], box[o + 9]],
    [box[o + 16], box[o + 17], box[o + 18]], i);
  placed++;
}
for (const b of blas.values()) if (b) b.trimBounds();
scene.build();
console.log(`  geometry  ${placed.toLocaleString()} placements, ${Math.round(tris).toLocaleString()} triangles, ` +
            `bvh in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── Box index, for telling a surface from a join ──────────────────────────
const CELL = 8;
const grid = new Map();
const keyOf = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
const boxAabb = new Float32Array(nBox * 6);
for (let i = 0; i < nBox; i++) {
  const o = i * 10;
  const qx = hull[o + 6], qy = hull[o + 7], qz = hull[o + 8], qw = hull[o + 9];
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const ex = Math.abs(m00) * hull[o + 3] + Math.abs(m01) * hull[o + 4] + Math.abs(m02) * hull[o + 5];
  const ey = Math.abs(m10) * hull[o + 3] + Math.abs(m11) * hull[o + 4] + Math.abs(m12) * hull[o + 5];
  const ez = Math.abs(m20) * hull[o + 3] + Math.abs(m21) * hull[o + 4] + Math.abs(m22) * hull[o + 5];
  const b = i * 6;
  boxAabb[b] = hull[o] - ex; boxAabb[b + 1] = hull[o + 1] - ey; boxAabb[b + 2] = hull[o + 2] - ez;
  boxAabb[b + 3] = hull[o] + ex; boxAabb[b + 4] = hull[o + 1] + ey; boxAabb[b + 5] = hull[o + 2] + ez;
  for (let x = Math.floor(boxAabb[b] / CELL); x <= Math.floor(boxAabb[b + 3] / CELL); x++) {
    for (let y = Math.floor(boxAabb[b + 1] / CELL); y <= Math.floor(boxAabb[b + 4] / CELL); y++) {
      for (let z = Math.floor(boxAabb[b + 2] / CELL); z <= Math.floor(boxAabb[b + 5] / CELL); z++) {
        const k = `${x},${y},${z}`;
        let l = grid.get(k); if (!l) grid.set(k, l = []);
        l.push(i);
      }
    }
  }
}

/** Is this point inside any box other than `self`? */
function insideAnother(px, py, pz, self) {
  const l = grid.get(keyOf(px, py, pz));
  if (!l) return false;
  for (const i of l) {
    if (i === self) continue;
    const b = i * 6;
    if (px < boxAabb[b] || px > boxAabb[b + 3]) continue;
    if (py < boxAabb[b + 1] || py > boxAabb[b + 4]) continue;
    if (pz < boxAabb[b + 2] || pz > boxAabb[b + 5]) continue;
    // Inside the AABB; now the oriented test.
    const o = i * 10;
    const qx = hull[o + 6], qy = hull[o + 7], qz = hull[o + 8], qw = hull[o + 9];
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
    const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
    const dx = px - hull[o], dy = py - hull[o + 1], dz = pz - hull[o + 2];
    const lx = m00 * dx + m10 * dy + m20 * dz;
    const ly = m01 * dx + m11 * dy + m21 * dz;
    const lz = m02 * dx + m12 * dy + m22 * dz;
    if (Math.abs(lx) <= hull[o + 3] && Math.abs(ly) <= hull[o + 4] && Math.abs(lz) <= hull[o + 5]) return true;
  }
  return false;
}

// ── Snap ──────────────────────────────────────────────────────────────────
let moved = 0, held = 0, interior = 0, totalShift = 0;
const shifts = [];

for (let i = 0; i < nBox; i++) {
  const o = i * 10;
  const qx = hull[o + 6], qy = hull[o + 7], qz = hull[o + 8], qw = hull[o + 9];
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const axis = [[m00, m10, m20], [m01, m11, m21], [m02, m12, m22]];

  for (let a = 0; a < 3; a++) {
    for (let s = -1; s <= 1; s += 2) {
      const n = axis[a];
      const half = hull[o + 3 + a];
      const fc = [
        hull[o] + n[0] * s * half,
        hull[o + 1] + n[1] * s * half,
        hull[o + 2] + n[2] * s * half,
      ];
      // A join, not a surface: something else already fills the space behind.
      if (insideAnother(fc[0] + n[0] * s * 0.05, fc[1] + n[1] * s * 0.05, fc[2] + n[2] * s * 0.05, i)) {
        interior++; continue;
      }

      const u = axis[(a + 1) % 3], v = axis[(a + 2) % 3];
      const hu = hull[o + 3 + (a + 1) % 3], hv = hull[o + 3 + (a + 2) % 3];
      const offs = [];
      for (let p = 0; p < SAMPLES; p++) {
        for (let q = 0; q < SAMPLES; q++) {
          const fu = (p / (SAMPLES - 1) - 0.5) * 1.6 * hu;
          const fv = (q / (SAMPLES - 1) - 0.5) * 1.6 * hv;
          const px = fc[0] + u[0] * fu + v[0] * fv + n[0] * s * SNAP;
          const py = fc[1] + u[1] * fu + v[1] * fv + n[1] * s * SNAP;
          const pz = fc[2] + u[2] * fu + v[2] * fv + n[2] * s * SNAP;
          const t = scene.hit(px, py, pz, -n[0] * s, -n[1] * s, -n[2] * s, 2 * SNAP).t;
          if (t < 2 * SNAP) offs.push(SNAP - t);
        }
      }
      if (offs.length < MIN_HIT) { held++; continue; }
      offs.sort((x, y) => x - y);
      const mid = offs[offs.length >> 1];
      // Agreement, measured on the middle of the distribution so one ray that
      // found a balcony cannot drag a whole facade.
      const lo = offs[Math.floor(offs.length * 0.25)], hi = offs[Math.floor(offs.length * 0.75)];
      if (hi - lo > SPREAD) { held++; continue; }
      if (Math.abs(mid) < 0.01) { held++; continue; }

      // Move this face and leave the opposite one. Along the local axis the
      // face sits at s*half and travels to s*(half + mid), so the centre takes
      // half the trip and the extent takes the other half.
      const newHalf = half + mid * 0.5;
      if (newHalf < 0.05) { held++; continue; }
      hull[o] += n[0] * s * mid * 0.5;
      hull[o + 1] += n[1] * s * mid * 0.5;
      hull[o + 2] += n[2] * s * mid * 0.5;
      hull[o + 3 + a] = newHalf;
      moved++; totalShift += Math.abs(mid); shifts.push(Math.abs(mid));
    }
  }
  if (i % 20000 === 0 && i) process.stdout.write(`\r  snapping  ${i.toLocaleString()} / ${nBox.toLocaleString()}   `);
}
process.stdout.write('\r' + ' '.repeat(50) + '\r');

shifts.sort((a, b) => a - b);
const faces = nBox * 6;
console.log(`  faces     ${faces.toLocaleString()} total`);
console.log(`    joins   ${interior.toLocaleString()} (${(100 * interior / faces).toFixed(1)}%) left alone`);
console.log(`    held    ${held.toLocaleString()} (${(100 * held / faces).toFixed(1)}%) no agreement`);
console.log(`    MOVED   ${moved.toLocaleString()} (${(100 * moved / faces).toFixed(1)}%), ` +
            `median ${(shifts[shifts.length >> 1] || 0).toFixed(2)} m, mean ${(totalShift / Math.max(1, moved)).toFixed(2)} m`);

fs.writeFileSync(hullPath, Buffer.from(hull.buffer, 0, nBox * 10 * 4));
console.log(`  wrote ${path.relative(process.cwd(), hullPath)} (original at .presnap.bin)`);
