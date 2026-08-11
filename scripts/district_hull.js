#!/usr/bin/env node
/**
 * district_hull.js: stage 2 of the box-cloud rebuild, and the only genuinely
 * unknown step. Everything either side of it is arithmetic already done.
 *
 * Takes stage 1's oriented world boxes and turns them into a compact set of
 * solid building boxes:
 *
 *   1. VOXELISE every box into a grid (default 4 m cells).
 *   2. FILL the interiors. Flood the empty space inward from the grid boundary;
 *      any empty cell the flood cannot reach is enclosed, so it becomes solid.
 *      This is what stops interior floor meshes from becoming boxes of their
 *      own, and it turns a hollow shell of modular wall panels into one solid
 *      building. An open courtyard stays empty because it connects to the sky.
 *   3. LABEL connected components and drop the small ones. Street clutter is
 *      dropped here, by the size of the mass it belongs to, never by the size
 *      of a single placement: a tower is built from 3 m kit panels, so gating
 *      per placement would delete the city.
 *   4. GREEDY-MERGE each surviving component back into axis-aligned boxes.
 *
 * The output is scored by scripts/window_faces.js: real windows land on a
 * correct cloud's faces at a tight margin, per building, for free.
 *
 * KNOWN APPROXIMATION: a voxel grid is axis-aligned, so a rotated tower comes
 * back as a stepped approximation. Whether that costs enough to matter is a
 * question for the window score, not for an opinion.
 *
 * Usage:
 *   node scripts/district_hull.js city_center
 *   node scripts/district_hull.js city_center --voxel 4 --minsize 2 --minmass 24
 *
 * Output: data/district-hull-<name>.bin   (10 float32 per box, stage 1 layout)
 *         data/district-hull-<name>.json  (every count the run produced)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };

const VOXEL    = flag('voxel', 4);      // cell size in metres
const MIN_SIZE = flag('minsize', 2);    // skip placements whose largest dimension is under this
const MAX_SIZE = flag('maxsize', 1000); // and whose largest dimension is over this
const MIN_MASS = flag('minmass', 24);   // drop components smaller than this many voxels
const PROXY_L  = flag('proxylevel', 5); // drop area-proxy meshes at this streaming level and above

// Area proxies are low-detail stand-ins for a whole subdistrict, and the real
// geometry they stand in for is in the dump as well, so keeping both double
// counts and fills the grid with solid blocks a kilometre across. Measured on
// city_center: GenericProxyMesh at L5-L6 is 3.7 km3 across 206 placements,
// against a district volume of 1.68 km3.
//
// BuildingProxyMesh is deliberately NOT in this set at any level. A building
// proxy IS a building: the game bakes its lit windows in, and thousands of
// tall glazed towers exist in the dump only as their proxy.
const AREA_PROXY = new Set([
  'GenericProxyMesh', 'TerrainProxyMesh', 'RoadProxyMesh',
  'DestructibleProxyMesh', 'InvalidProxyMesh',
]);

if (!name) {
  console.error('usage: node scripts/district_hull.js <district> [--voxel 4] [--minsize 2] [--minmass 24]');
  process.exit(1);
}

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw  = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box  = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const nBox = meta.boxes;
const S    = meta.stride;
const TYPE = meta.types || {};

const [minX, minY, minZ] = meta.bounds.min;
const [maxX, maxY, maxZ] = meta.bounds.max;
const NX = Math.ceil((maxX - minX) / VOXEL);
const NY = Math.ceil((maxY - minY) / VOXEL);
const NZ = Math.ceil((maxZ - minZ) / VOXEL);
const N  = NX * NY * NZ;

console.log(`district ${name}`);
console.log(`  grid      ${NX} x ${NY} x ${NZ} = ${N.toLocaleString()} cells at ${VOXEL} m`);
console.log(`  input     ${nBox.toLocaleString()} oriented boxes`);

const idx = (x, y, z) => (z * NY + y) * NX + x;

// ── 1. Voxelise ───────────────────────────────────────────────────────────
// Per box, walk the cells its world AABB touches and keep the ones whose
// centre falls inside the ORIENTED box (inverse-rotate the centre into box
// space). Testing against the AABB instead would fatten every rotated tower.
const solid = new Uint8Array(N);
let voxelised = 0, skippedSmall = 0, skippedHuge = 0, skippedProxy = 0, tests = 0;
const hugeSamples = [];

for (let i = 0; i < nBox; i++) {
  const o = i * S;
  const cx = box[o], cy = box[o + 1], cz = box[o + 2];
  const hx = box[o + 3], hy = box[o + 4], hz = box[o + 5];
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];

  const largest = Math.max(hx, hy, hz) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  if (S >= 13 && AREA_PROXY.has(TYPE[box[o + 11]]) && box[o + 12] >= PROXY_L) { skippedProxy++; continue; }
  // A placement bigger than any building is not a building. ncz_assets.csv
  // carries sentinel bounds (100 km meshes) alongside genuinely world-scale
  // geometry like ocean patches, and one of them fills the whole grid. This is
  // the size classifier doing its job, so it reports what it drops.
  if (largest > MAX_SIZE) {
    skippedHuge++;
    if (hugeSamples.length < 8) hugeSamples.push(`${(hx * 2).toFixed(0)} x ${(hy * 2).toFixed(0)} x ${(hz * 2).toFixed(0)} m at ${cx.toFixed(0)},${cy.toFixed(0)},${cz.toFixed(0)}`);
    continue;
  }

  // World AABB of the oriented box: the rotated half-extent projection.
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const ex = Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz;
  const ey = Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz;
  const ez = Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz;

  let x0 = Math.floor((cx - ex - minX) / VOXEL), x1 = Math.floor((cx + ex - minX) / VOXEL);
  let y0 = Math.floor((cy - ey - minY) / VOXEL), y1 = Math.floor((cy + ey - minY) / VOXEL);
  let z0 = Math.floor((cz - ez - minZ) / VOXEL), z1 = Math.floor((cz + ez - minZ) / VOXEL);
  if (x1 < 0 || y1 < 0 || z1 < 0 || x0 >= NX || y0 >= NY || z0 >= NZ) continue;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0);
  x1 = Math.min(NX - 1, x1); y1 = Math.min(NY - 1, y1); z1 = Math.min(NZ - 1, z1);

  // A box smaller than a cell still marks the cell it sits in, so kit panels
  // and thin slabs are not lost to the grid.
  const single = (x0 === x1 && y0 === y1 && z0 === z1);
  for (let z = z0; z <= z1; z++) {
    const wz = minZ + (z + 0.5) * VOXEL - cz;
    for (let y = y0; y <= y1; y++) {
      const wy = minY + (y + 0.5) * VOXEL - cy;
      for (let x = x0; x <= x1; x++) {
        tests++;
        if (!single) {
          const wx = minX + (x + 0.5) * VOXEL - cx;
          // Inverse rotation is the transpose: project onto the box axes.
          const bx = m00 * wx + m10 * wy + m20 * wz;
          const by = m01 * wx + m11 * wy + m21 * wz;
          const bz = m02 * wx + m12 * wy + m22 * wz;
          if (Math.abs(bx) > hx + VOXEL * 0.5 || Math.abs(by) > hy + VOXEL * 0.5 || Math.abs(bz) > hz + VOXEL * 0.5) continue;
        }
        const k = idx(x, y, z);
        if (!solid[k]) { solid[k] = 1; voxelised++; }
      }
    }
  }
}
console.log(`  voxelised ${voxelised.toLocaleString()} cells occupied (${(100 * voxelised / N).toFixed(1)}% of the grid)`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} under ${MIN_SIZE} m, ${skippedHuge.toLocaleString()} over ${MAX_SIZE} m, ` +
            `${skippedProxy.toLocaleString()} area proxies at L${PROXY_L}+, ${tests.toLocaleString()} cell tests`);
if (hugeSamples.length) hugeSamples.forEach(s => console.log(`            dropped as too large: ${s}`));

// ── 2. Fill enclosed space ────────────────────────────────────────────────
// Flood the empty cells inward from every face of the grid. Anything empty the
// flood never reaches is sealed, so it is interior and becomes solid.
const OUTSIDE = 2;
const stack = new Int32Array(N);
let sp = 0;
const push = k => { if (solid[k] === 0) { solid[k] = OUTSIDE; stack[sp++] = k; } };

for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) { push(idx(0, y, z)); push(idx(NX - 1, y, z)); }
for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) { push(idx(x, 0, z)); push(idx(x, NY - 1, z)); }
for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) { push(idx(x, y, 0)); push(idx(x, y, NZ - 1)); }

while (sp > 0) {
  const k = stack[--sp];
  const x = k % NX, y = ((k / NX) | 0) % NY, z = (k / (NX * NY)) | 0;
  if (x > 0)      push(k - 1);
  if (x < NX - 1) push(k + 1);
  if (y > 0)      push(k - NX);
  if (y < NY - 1) push(k + NX);
  if (z > 0)      push(k - NX * NY);
  if (z < NZ - 1) push(k + NX * NY);
}

let filled = 0;
for (let k = 0; k < N; k++) {
  if (solid[k] === OUTSIDE) solid[k] = 0;
  else if (solid[k] === 0)  { solid[k] = 1; filled++; }
}
console.log(`  filled    ${filled.toLocaleString()} enclosed cells (interiors absorbed)`);

// ── 3. Label components, drop the small ones ──────────────────────────────
const label = new Int32Array(N);
let nComp = 0, kept = 0, keptCells = 0, droppedCells = 0;
const compSize = [0];

for (let s = 0; s < N; s++) {
  if (solid[s] !== 1 || label[s] !== 0) continue;
  const id = ++nComp;
  let size = 0;
  sp = 0; stack[sp++] = s; label[s] = id;
  while (sp > 0) {
    const k = stack[--sp];
    size++;
    const x = k % NX, y = ((k / NX) | 0) % NY, z = (k / (NX * NY)) | 0;
    const nb = [];
    if (x > 0)      nb.push(k - 1);
    if (x < NX - 1) nb.push(k + 1);
    if (y > 0)      nb.push(k - NX);
    if (y < NY - 1) nb.push(k + NX);
    if (z > 0)      nb.push(k - NX * NY);
    if (z < NZ - 1) nb.push(k + NX * NY);
    for (const n of nb) if (solid[n] === 1 && label[n] === 0) { label[n] = id; stack[sp++] = n; }
  }
  compSize[id] = size;
  if (size >= MIN_MASS) { kept++; keptCells += size; } else droppedCells += size;
}
console.log(`  components ${nComp.toLocaleString()} found, ${kept.toLocaleString()} kept at >= ${MIN_MASS} cells`);
console.log(`             ${keptCells.toLocaleString()} cells kept, ${droppedCells.toLocaleString()} dropped as clutter`);

// Clear the cells belonging to dropped components.
for (let k = 0; k < N; k++) if (label[k] && compSize[label[k]] < MIN_MASS) solid[k] = 0;

// ── 4. Greedy-merge into axis-aligned boxes ───────────────────────────────
// Grow each seed as far as it goes in x, then y, then z, claiming as it goes.
const claimed = new Uint8Array(N);
const out = [];
for (let z = 0; z < NZ; z++) {
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const k = idx(x, y, z);
      if (solid[k] !== 1 || claimed[k]) continue;

      let ex = x;
      while (ex + 1 < NX && solid[idx(ex + 1, y, z)] === 1 && !claimed[idx(ex + 1, y, z)]) ex++;

      let ey = y;
      grow: while (ey + 1 < NY) {
        for (let i = x; i <= ex; i++) {
          const kk = idx(i, ey + 1, z);
          if (solid[kk] !== 1 || claimed[kk]) break grow;
        }
        ey++;
      }

      let ez = z;
      growZ: while (ez + 1 < NZ) {
        for (let j = y; j <= ey; j++) for (let i = x; i <= ex; i++) {
          const kk = idx(i, j, ez + 1);
          if (solid[kk] !== 1 || claimed[kk]) break growZ;
        }
        ez++;
      }

      for (let c = z; c <= ez; c++) for (let b = y; b <= ey; b++) for (let a = x; a <= ex; a++) claimed[idx(a, b, c)] = 1;
      out.push([x, y, z, ex, ey, ez]);
    }
  }
}
console.log(`  BOXES     ${out.length.toLocaleString()} after greedy merge`);

// ── Write, in stage 1's layout so one reader serves both ──────────────────
const buf = new Float32Array(out.length * 10);
out.forEach(([x0, y0, z0, x1, y1, z1], i) => {
  const o = i * 10;
  buf[o]     = minX + ((x0 + x1 + 1) * 0.5) * VOXEL;
  buf[o + 1] = minY + ((y0 + y1 + 1) * 0.5) * VOXEL;
  buf[o + 2] = minZ + ((z0 + z1 + 1) * 0.5) * VOXEL;
  buf[o + 3] = (x1 - x0 + 1) * VOXEL * 0.5;
  buf[o + 4] = (y1 - y0 + 1) * VOXEL * 0.5;
  buf[o + 5] = (z1 - z0 + 1) * VOXEL * 0.5;
  buf[o + 9] = 1; // identity quaternion: the grid is axis-aligned
});
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.bin`), Buffer.from(buf.buffer));

const sizes = compSize.slice(1).filter(s => s >= MIN_MASS).sort((a, b) => b - a);
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.json`), JSON.stringify({
  district: name, bounds: meta.bounds,
  voxel: VOXEL, minSize: MIN_SIZE, maxSize: MAX_SIZE, minMass: MIN_MASS, proxyLevel: PROXY_L,
  grid: { nx: NX, ny: NY, nz: NZ, cells: N },
  inputBoxes: nBox, skippedSmall, skippedHuge, skippedProxy,
  occupiedCells: voxelised, filledCells: filled,
  components: nComp, componentsKept: kept, cellsKept: keptCells, cellsDropped: droppedCells,
  largestComponents: sizes.slice(0, 20),
  boxes: out.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));

console.log(`\n  wrote data/district-hull-${name}.bin`);
console.log(`  CDPR ships 41,291 boxes for city_center; this run produced ${out.length.toLocaleString()}.`);
