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
// Cell-counted thresholds scale with the cell, so changing resolution changes
// the resolution and nothing else. The defaults are quoted at a 4 m cell:
// 24 cells is 1,536 m3 of clutter, 3 cells is a 12 m column.
const SCALE = 4 / VOXEL;
const MIN_MASS = flag('minmass', Math.round(24 * SCALE ** 3)); // drop components smaller than this many cells
// Streaming level is not a proxy's SIZE. At L5 and L6 the proxy directories
// hold district shells (downtown.mesh, 1,536 m) and individual towers
// (cct_cpz_building_militech_uf_v2.mesh, 337 m) side by side, and a level-based
// cut takes the towers with the shells: it left 21.4% of city_center's windows
// more than 8 m from any geometry, clustered on Corpo Plaza, whose towers reach
// the dump mainly as their L5/L6 proxy. Redundancy is what actually
// distinguishes them, and pass 2 measures it directly, so the level cut is off
// by default and kept only as a lever.
const PROXY_L  = flag('proxylevel', 99); // drop area-proxy NODE TYPES at this level and above
const PROXY_COVER = flag('proxycover', 0.25); // a proxy is redundant once this much of it is already solid

// TRIANGLES WHERE THERE ARE TRIANGLES. A bounding box has no shape: one Corpo
// Plaza proxy carries 10,358 triangles across 608 m and voxelises as a single
// rectangle. Where the mesh has been exported, its real geometry is rasterised
// instead, which keeps the building's silhouette AND its rotation, since a
// transformed triangle is already oriented.
//
// Placements below MESH_MIN keep using their box: at a 2 m cell a bollard and
// its bounding box occupy the same cells, and reading a GLB for each one costs
// far more than it returns.
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
const MESH_MIN = flag('meshmin', 6);   // metres; below this a box is the same answer
const useMeshes = !args.includes('--boxes');
const { glbPathFor, meshTriangles } = require('./glb_lib');

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

// Never geometry, at any level. An occluder is an invisible helper volume the
// engine uses to cull what is behind it, and city_center places one editor
// occluder box that alone marks 30,708 cells. Terrain is not a building and
// the hull is clipped against the terrain surface anyway.
const NEVER = new Set([
  'StaticOccluderMesh', 'StaticLight', 'Advertisement', 'WaterPatch', 'Foliage', 'Mirror',
  'TerrainProxyMesh',
]);

/**
 * A PROXY is the game's low-detail stand-in for geometry that is not streamed
 * at distance: one coarse box where the real building is a hundred kit panels.
 *
 * Voxelising both yields a pile of rectangles. Measured on city_center with
 * both included, 69.2% of the cloud comes from sectors\_external\proxy and
 * only 7.9% from real architecture: a proxy marks thousands of cells as one
 * solid mass, while the detailed meshes describing the same building mark a
 * few hundred each and are swallowed by it. Four sector-scale proxies alone
 * (exterior.mesh, ccd_06_architecture.mesh) account for 9.9% of the district
 * and render as a slab the size of its bbox.
 *
 * They cannot simply be dropped: thousands of tall glazed towers exist in the
 * dump ONLY as their proxy. So real geometry wins, and a proxy is voxelised
 * only where nothing real already occupies its footprint.
 */
// Proxies live in three places, not one. Matching only the first lets a
// subdistrict proxy through as if it were real geometry, and it then wins the
// grid outright because nothing tests it for redundancy:
//   sectors\_external\proxy\<hash>\<name>.mesh
//   ...\_proxyhelper\<name>_mproxy.mesh   (beside the sector or the prefab)
//   any file whose name ends _mproxy
const isProxy = p =>
  p.includes('\\_external\\proxy\\') || p.includes('\\_proxyhelper\\') || p.endsWith('_mproxy.mesh');
const isTerrain = p => p.includes('\\_global\\terrain\\');

const MIN_COL = flag('mincol', Math.round(3 * SCALE)); // drop columns with fewer than this many solid cells
const BELOW   = flag('below', 16);   // keep this many metres below the terrain surface, cut deeper than that

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
let voxelised = 0, skippedSmall = 0, skippedHuge = 0, skippedProxy = 0, skippedNever = 0, tests = 0;
const hugeSamples = [];
// Cells attributed to whichever asset marked them FIRST. Approximate by
// definition (boxes overlap), and enough to name what is filling the grid.
const cellsByAsset = Object.create(null);

const assetPath = meta.assetPaths || {};

/** Which pass a placement belongs to, or null when it is never geometry. */
function classify(i) {
  const o = i * S;
  const hx = box[o + 3], hy = box[o + 4], hz = box[o + 5];
  const largest = Math.max(hx, hy, hz) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; return null; }
  const nodeType = TYPE[box[o + 11]];
  if (NEVER.has(nodeType)) { skippedNever++; return null; }
  const p = assetPath[box[o + 10]] || '';
  if (isTerrain(p)) { skippedNever++; return null; }
  // At L5 and above a proxy stands in for a whole subdistrict whatever the
  // node type says. exterior.mesh is typed BuildingProxyMesh and sits at L6,
  // and it is a shell the size of the district, so the "a building proxy IS a
  // building" exemption only holds below that level.
  if (S >= 13 && box[o + 12] >= PROXY_L && (AREA_PROXY.has(nodeType) || isProxy(p))) { skippedProxy++; return null; }
  // A placement bigger than any building is not a building. ncz_assets.csv
  // carries sentinel bounds (100 km meshes) alongside genuinely world-scale
  // geometry like ocean patches, and one of them fills the whole grid. This is
  // the size classifier doing its job, so it reports what it drops.
  if (largest > MAX_SIZE) {
    skippedHuge++;
    if (hugeSamples.length < 8) {
      hugeSamples.push(`${(hx * 2).toFixed(0)} x ${(hy * 2).toFixed(0)} x ${(hz * 2).toFixed(0)} m ` +
                       `at ${box[o].toFixed(0)},${box[o + 1].toFixed(0)},${box[o + 2].toFixed(0)}`);
    }
    return null;
  }
  return isProxy(p) ? 'proxy' : 'real';
}

/**
 * Visit every grid cell the oriented box i covers.
 * `mode` 'mark' writes them solid; 'probe' only counts how many are already
 * solid, which is how a proxy asks whether real geometry got there first.
 */
function visit(i, mode) {
  const o = i * S;
  const aid = box[o + 10];
  const cx = box[o], cy = box[o + 1], cz = box[o + 2];
  const hx = box[o + 3], hy = box[o + 4], hz = box[o + 5];
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  let seen = 0, occupied = 0;

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
  if (x1 < 0 || y1 < 0 || z1 < 0 || x0 >= NX || y0 >= NY || z0 >= NZ) return { seen: 0, occupied: 0 };
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0);
  x1 = Math.min(NX - 1, x1); y1 = Math.min(NY - 1, y1); z1 = Math.min(NZ - 1, z1);

  // Slack exists so a wall panel thinner than a cell still registers. Applying
  // it on every axis instead inflates a 20 m box to 24 m, which is a 1.7x
  // volume error across the whole city, so it is granted per axis and only
  // where the box really is thinner than a cell.
  const sx = (hx * 2 < VOXEL) ? VOXEL * 0.5 : 0;
  const sy = (hy * 2 < VOXEL) ? VOXEL * 0.5 : 0;
  const sz = (hz * 2 < VOXEL) ? VOXEL * 0.5 : 0;

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
          if (Math.abs(bx) > hx + sx || Math.abs(by) > hy + sy || Math.abs(bz) > hz + sz) continue;
        }
        const k = idx(x, y, z);
        seen++;
        if (solid[k]) { occupied++; continue; }
        if (mode === 'mark') { solid[k] = 1; voxelised++; cellsByAsset[aid] = (cellsByAsset[aid] || 0) + 1; }
      }
    }
  }
  return { seen, occupied };
}

/**
 * Mark the cells a triangle passes through, by sampling it on a barycentric
 * lattice at half a cell. A triangle-versus-box overlap test per candidate cell
 * is exact and far slower; at this cell size the sampled result is the same
 * set of cells for anything but a sliver, and a sliver contributes no volume.
 */
function markTriangle(ax, ay, az, bx, by, bz, cx, cy, cz, aid) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const area = 0.5 * Math.hypot(nx, ny, nz);
  if (!(area > 0)) return;
  const step = VOXEL * 0.5;
  let n = Math.ceil(Math.sqrt(area) / step) + 1;
  if (n > 512) n = 512;   // a single triangle cannot be worth more than this
  for (let i = 0; i <= n; i++) {
    for (let j = 0; i + j <= n; j++) {
      const s = i / n, t = j / n;
      const px = ax + ux * s + vx * t;
      const py = ay + uy * s + vy * t;
      const pz = az + uz * s + vz * t;
      const gx = ((px - minX) / VOXEL) | 0;
      const gy = ((py - minY) / VOXEL) | 0;
      const gz = ((pz - minZ) / VOXEL) | 0;
      if (gx < 0 || gy < 0 || gz < 0 || gx >= NX || gy >= NY || gz >= NZ) continue;
      const k = idx(gx, gy, gz);
      tests++;
      if (!solid[k]) { solid[k] = 1; voxelised++; cellsByAsset[aid] = (cellsByAsset[aid] || 0) + 1; }
    }
  }
}

/** Rasterise placement i from its mesh's triangles, already in CET-local space. */
function visitMesh(i, tris) {
  const o = i * S;
  const aid = box[o + 10];
  // The PLACEMENT transform, not the derived box: position, rotation, scale,
  // applied to mesh-local vertices in that order.
  const px = box[o + 13], py = box[o + 14], pz = box[o + 15];
  const sx = box[o + 16], sy = box[o + 17], sz = box[o + 18];
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
  const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
  const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
  const p = new Float32Array(9);
  for (let t = 0; t < tris.length; t += 9) {
    for (let v = 0; v < 3; v++) {
      const lx = tris[t + v * 3] * sx, ly = tris[t + v * 3 + 1] * sy, lz = tris[t + v * 3 + 2] * sz;
      p[v * 3]     = px + m00 * lx + m01 * ly + m02 * lz;
      p[v * 3 + 1] = py + m10 * lx + m11 * ly + m12 * lz;
      p[v * 3 + 2] = pz + m20 * lx + m21 * ly + m22 * lz;
    }
    markTriangle(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], aid);
  }
}

// Placements grouped by asset, so each GLB is read once however many times its
// mesh is placed. Reading per placement would re-parse the same megabytes
// hundreds of times.
const byAsset = new Map();
const proxies = [];
for (let i = 0; i < nBox; i++) {
  const kind = classify(i);
  if (kind === null) continue;
  if (kind === 'proxy') { proxies.push(i); continue; }
  const aid = box[i * S + 10];
  let g = byAsset.get(aid); if (!g) byAsset.set(aid, g = []);
  g.push(i);
}

let meshHits = 0, meshMisses = 0, meshPlacements = 0, meshTris = 0;
for (const [aid, list] of byAsset) {
  let tris = null;
  const p = assetPath[aid] || '';
  const big = list.some(i => Math.max(box[i * S + 3], box[i * S + 4], box[i * S + 5]) * 2 >= MESH_MIN);
  if (useMeshes && p && big) {
    const file = glbPathFor(RAW_ROOT, p);
    if (fs.existsSync(file)) {
      try { tris = meshTriangles(file); if (!tris.length) tris = null; } catch { tris = null; }
    }
    if (tris) { meshHits++; meshTris += tris.length / 9; } else meshMisses++;
  }
  for (const i of list) {
    if (tris) { visitMesh(i, tris); meshPlacements++; } else visit(i, 'mark');
  }
}
const realCells = voxelised;

// Pass 2: a proxy fills in only where real geometry did not reach. Sorted
// SMALLEST first: a building-scale proxy fills its own gap, and by the time a
// larger shell is tested the space it claims is already solid, so it is
// rejected. Largest first inverts that and lets the emptiest grid accept the
// coarsest geometry.
let proxyUsed = 0, proxyCovered = 0;
proxies.sort((a, b) =>
  box[a * S + 3] * box[a * S + 4] * box[a * S + 5] - box[b * S + 3] * box[b * S + 4] * box[b * S + 5]);
for (const i of proxies) {
  const { seen, occupied } = visit(i, 'probe');
  if (seen === 0) continue;
  if (occupied / seen >= PROXY_COVER) { proxyCovered++; continue; }
  visit(i, 'mark');
  proxyUsed++;
}

console.log(`  voxelised ${voxelised.toLocaleString()} cells occupied (${(100 * voxelised / N).toFixed(1)}% of the grid)`);
console.log(`  real      ${realCells.toLocaleString()} cells from real geometry`);
console.log(`  meshes    ${meshHits.toLocaleString()} assets rasterised from ${Math.round(meshTris).toLocaleString()} triangles ` +
            `over ${meshPlacements.toLocaleString()} placements; ${meshMisses.toLocaleString()} assets fell back to their box`);
console.log(`  proxies   ${proxyUsed.toLocaleString()} used where nothing real stood, ${proxyCovered.toLocaleString()} rejected as already covered (>= ${(PROXY_COVER * 100).toFixed(0)}%)`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} under ${MIN_SIZE} m, ${skippedHuge.toLocaleString()} over ${MAX_SIZE} m, ` +
            `${skippedNever.toLocaleString()} never-geometry, ${skippedProxy.toLocaleString()} area proxies at L${PROXY_L}+, ${tests.toLocaleString()} cell tests`);
if (hugeSamples.length) hugeSamples.forEach(s => console.log(`            dropped as too large: ${s}`));

const paths = meta.assetPaths || {};
const ranked = Object.entries(cellsByAsset).sort((a, b) => b[1] - a[1])
  .map(([id, c]) => ({ id: +id, cells: c, path: paths[id] || '?' }));
const topCells = ranked.slice(0, 20);
if (args.includes('--why')) {
  console.log('\n  cells marked, by asset:');
  topCells.forEach(t => console.log(`    ${String(t.cells).padStart(9)}  ${t.path.slice(0, 92)}`));
  console.log();
}
// The full ledger: every asset that marked a cell, ranked. This is the list to
// read when the cloud looks wrong, because "what is in this cloud" is
// otherwise unanswerable once the boxes are merged.
{
  const rows = ['cells,type,level,path'];
  const typeOf = new Map(), lvlOf = new Map();
  for (let i = 0; i < nBox; i++) {
    const o = i * S, aid = box[o + 10];
    if (!typeOf.has(aid)) { typeOf.set(aid, TYPE[box[o + 11]] || '?'); lvlOf.set(aid, box[o + 12]); }
  }
  for (const r of ranked) rows.push(`${r.cells},${typeOf.get(r.id) || '?'},L${lvlOf.get(r.id)},"${r.path}"`);
  fs.writeFileSync(path.join(dataDir, `hull-assets-${name}.csv`), rows.join('\n'));
  console.log(`  ledger    ${ranked.length.toLocaleString()} assets -> data/hull-assets-${name}.csv`);
}

// ── 2. Fill enclosed space ────────────────────────────────────────────────
// Flood the empty cells inward from every face of the grid. Anything empty the
// flood never reaches is sealed, so it is interior and becomes solid.
// A stack sized to the grid would be 845 MB at a 2 m cell. It only ever holds
// the frontier, not everything visited, because a cell is marked the moment it
// is pushed, so it grows on demand instead.
const OUTSIDE = 2;
let stack = new Int32Array(1 << 20);
let sp = 0;
const spush = k => { if (sp === stack.length) { const b = new Int32Array(stack.length * 2); b.set(stack); stack = b; } stack[sp++] = k; };
const push = k => { if (solid[k] === 0) { solid[k] = OUTSIDE; spush(k); } };

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

// ── 2a. Cut the underground away ──────────────────────────────────────────
// Night City has a whole city below the street: basements, car parks, metro.
// It is real geometry and it is in the dump, and the deep part of it does not
// belong on a map of the skyline. CDPR's cloud covers 1.6% of the footprint at
// -20 m; keeping all of the underground takes that to 47.5%.
//
// CUT DEEP, NOT SHALLOW. Tunnel entrances, storm drains and underpasses sit
// below the surrounding terrain height and DO show, so BELOW is deliberately
// generous: everything within BELOW metres of the surface survives, and only
// geometry buried deeper than that is cut. Raising BELOW is the safe
// direction. The precise rule is "cut what cannot be seen", which needs the
// below-terrain mass tested for whether it ever surfaces, and a depth
// threshold is the cheap stand-in until the window score says it matters.
//
// The floor is the terrain surface verify_terrain.js measured, which carries a
// near-constant ~4 m bias of its own, so BELOW absorbs that too.
//
// TERRAIN AND ROADS MAY NOT LINE UP. This clip trusts the terrain GLB to sit
// where the placements think the ground is. If a road deck turns out to float
// or sink relative to it, this is the step that will show it, and the ground
// sheet handling below is the other half of the same question.
const { loadTerrain, indexTris, heightAtCet } = require('./terrain_lib');
const terrain = indexTris(loadTerrain());
let cutUnder = 0, offMesh = 0;
for (let y = 0; y < NY; y++) {
  const cetY = minY + (y + 0.5) * VOXEL;
  for (let x = 0; x < NX; x++) {
    const cetX = minX + (x + 0.5) * VOXEL;
    const g = heightAtCet(terrain, cetX, cetY);
    if (g === null) { offMesh++; continue; }
    const floor = g - BELOW;
    const zTop = Math.min(NZ - 1, Math.floor((floor - minZ) / VOXEL));
    for (let z = 0; z <= zTop; z++) {
      const k = idx(x, y, z);
      if (solid[k] === 1) { solid[k] = 0; cutUnder++; }
    }
  }
}
console.log(`  under     ${cutUnder.toLocaleString()} cells cut below the terrain surface (${offMesh.toLocaleString()} columns off-mesh)`);

// ── 2b. Strip the ground sheet ────────────────────────────────────────────
// Roads, pavements and terrain form a continuous solid layer one or two cells
// thick across the whole district. The ground is a separate mesh, not a
// building: CDPR's cloud covers 15% of the footprint at ground level, and
// keeping the sheet takes that to 85%. A column is ground if it holds fewer
// than MIN_COL solid cells in total: a pavement column is one cell, a building
// column is dozens.
//
// KEEP THIS KNOB. The default is deliberately weak because the road and
// terrain surfaces have not been cross-checked against each other yet. If they
// turn out not to line up, roads sitting proud of or sunk into the terrain is
// exactly what this step and the underground clip above will surface, and the
// gate is then the lever for it rather than something to be reinvented.
let strippedGround = 0;
for (let y = 0; y < NY; y++) {
  for (let x = 0; x < NX; x++) {
    let h = 0;
    for (let z = 0; z < NZ; z++) if (solid[idx(x, y, z)] === 1) h++;
    if (h > 0 && h < MIN_COL) {
      for (let z = 0; z < NZ; z++) if (solid[idx(x, y, z)] === 1) { solid[idx(x, y, z)] = 0; strippedGround++; }
    }
  }
}
console.log(`  ground    ${strippedGround.toLocaleString()} cells stripped from columns under ${MIN_COL} cells tall`);

// ── 3. Label components, drop the small ones ──────────────────────────────
// A per-cell label array would be another 845 MB at a 2 m cell, and the label
// itself is never wanted: only whether the component it belongs to is big
// enough. So components are walked one at a time, their cells collected, and
// the verdict written straight back into `solid`. VISITED (3) survives, and
// the pass ends by folding it back to 1.
const VISITED = 3;
let nComp = 0, kept = 0, keptCells = 0, droppedCells = 0;
let comp = new Int32Array(1 << 16);
const compSizes = [];

for (let s = 0; s < N; s++) {
  if (solid[s] !== 1) continue;
  nComp++;
  let size = 0;
  sp = 0; spush(s); solid[s] = VISITED;
  while (sp > 0) {
    const k = stack[--sp];
    if (size === comp.length) { const b = new Int32Array(comp.length * 2); b.set(comp); comp = b; }
    comp[size++] = k;
    const x = k % NX, y = ((k / NX) | 0) % NY, z = (k / (NX * NY)) | 0;
    if (x > 0      && solid[k - 1] === 1)       { solid[k - 1] = VISITED;       spush(k - 1); }
    if (x < NX - 1 && solid[k + 1] === 1)       { solid[k + 1] = VISITED;       spush(k + 1); }
    if (y > 0      && solid[k - NX] === 1)      { solid[k - NX] = VISITED;      spush(k - NX); }
    if (y < NY - 1 && solid[k + NX] === 1)      { solid[k + NX] = VISITED;      spush(k + NX); }
    if (z > 0      && solid[k - NX * NY] === 1) { solid[k - NX * NY] = VISITED; spush(k - NX * NY); }
    if (z < NZ - 1 && solid[k + NX * NY] === 1) { solid[k + NX * NY] = VISITED; spush(k + NX * NY); }
  }
  if (size >= MIN_MASS) { kept++; keptCells += size; compSizes.push(size); }
  else { droppedCells += size; for (let i = 0; i < size; i++) solid[comp[i]] = 0; }
}
for (let k = 0; k < N; k++) if (solid[k] === VISITED) solid[k] = 1;

console.log(`  components ${nComp.toLocaleString()} found, ${kept.toLocaleString()} kept at >= ${MIN_MASS} cells`);
console.log(`             ${keptCells.toLocaleString()} cells kept, ${droppedCells.toLocaleString()} dropped as clutter`);

// ── 3b. Publish the occupancy grid ────────────────────────────────────────
// The solid volume is final here, and it answers a question the boxes cannot:
// can you SEE a given point from outside? A window several metres inside a box
// is not automatically an error. Recessed facades, light wells, atriums and
// courtyards all put real, visible glass deep inside a building's bounding
// mass, and only the grid knows whether air is reachable from there.
// Bit-packed: 211 million cells is 26 MB this way and 211 MB as bytes.
{
  const bits = new Uint8Array((N + 7) >> 3);
  for (let k = 0; k < N; k++) if (solid[k] === 1) bits[k >> 3] |= (1 << (k & 7));
  fs.writeFileSync(path.join(dataDir, `district-grid-${name}.bin`), Buffer.from(bits.buffer));
}

// ── 4. Greedy-merge into axis-aligned boxes ───────────────────────────────
// Grow each seed as far as it goes in x, then y, then z, claiming as it goes.
// Claiming is recorded in `solid` itself rather than a parallel byte array,
// which is another 211 MB at a 2 m cell.
const CLAIMED = 4;
const out = [];
for (let z = 0; z < NZ; z++) {
  for (let y = 0; y < NY; y++) {
    for (let x = 0; x < NX; x++) {
      const k = idx(x, y, z);
      if (solid[k] !== 1) continue;

      let ex = x;
      while (ex + 1 < NX && solid[idx(ex + 1, y, z)] === 1) ex++;

      let ey = y;
      grow: while (ey + 1 < NY) {
        for (let i = x; i <= ex; i++) if (solid[idx(i, ey + 1, z)] !== 1) break grow;
        ey++;
      }

      let ez = z;
      growZ: while (ez + 1 < NZ) {
        for (let j = y; j <= ey; j++) for (let i = x; i <= ex; i++) if (solid[idx(i, j, ez + 1)] !== 1) break growZ;
        ez++;
      }

      for (let c = z; c <= ez; c++) for (let b = y; b <= ey; b++) for (let a = x; a <= ex; a++) solid[idx(a, b, c)] = CLAIMED;
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

const sizes = compSizes.sort((a, b) => b - a);
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.json`), JSON.stringify({
  district: name, bounds: meta.bounds,
  voxel: VOXEL, minSize: MIN_SIZE, maxSize: MAX_SIZE, minMass: MIN_MASS, minCol: MIN_COL,
  below: BELOW, proxyLevel: PROXY_L,
  gridOrigin: [minX, minY, minZ],
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
