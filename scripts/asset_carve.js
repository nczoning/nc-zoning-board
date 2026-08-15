#!/usr/bin/env node
/**
 * asset_carve.js: PROTOTYPE stage-2 decomposition at FEATURE granularity.
 *
 * The premise (the maintainer's, watching kit meshes in WolvenKit): an
 * authored kit piece visibly decomposes into a handful of different-sized
 * boxes whose faces are the mesh's own surfaces. Neither prior method sees
 * that structure: the voxel grid imposes a uniform resolution, the surface
 * method imposes triangle granularity. This one asks the mesh for its OWN
 * structure: its triangles lie on a small set of dominant planes; those
 * planes carve mesh-local space into convex cells (a BSP with no
 * heuristic split choices, every cut an authored surface); cells whose
 * boundary is backed by mesh surface facing OUT of them are solid; each
 * solid cell is one box.
 *
 * What falls out by construction: box faces sit exactly on authored
 * geometry (no quantization, native angles); a wall's two shells enclose
 * ONE solid box (no seam caps, no double plates); trim inside a cell
 * vanishes into it (aggregation at feature scale); a curved vault becomes
 * a few stacked wedge cells, not one shard per facet triangle.
 *
 * Prototype scope: single asset, numeric report + debug JSON. District
 * scale comes only after the unit tests look right.
 *
 * Usage: node scripts/asset_carve.js <district> --asset <path substring>
 *        [--maxplanes 24] [--ntol 8] [--dtol 0.15] [--minsupport 0.5]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor, meshTriangles } = require('./glb_lib');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };
const strFlag = (k) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : null; };

const ASSET    = strFlag('asset');
const MAXPLANES = flag('maxplanes', 24); // dominant planes kept per mesh
const NTOL     = flag('ntol', 8);        // degrees: plane clustering cone
const DTOL     = flag('dtol', 0.15);     // metres: coplanar offset tolerance (shells stay separate)
const MIN_SUPPORT = flag('minsupport', 0.5); // m^2: a plane needs this much triangle area to carve
const LOD      = flag('lod', 2);
const MIN_CELL = flag('mincell', 0.05);  // metres: cells thinner than this are dropped as slivers

if (!name || !ASSET) { console.error('usage: node scripts/asset_carve.js <district> --asset <substring>'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, PATHS = meta.assetPaths || {};

// ── Find the asset ────────────────────────────────────────────────────────
let found = null;
for (let i = 0; i < meta.boxes && !found; i++) {
  const o = i * S;
  const ap = PATHS[box[o + 10]] || '';
  if (ap.toLowerCase().includes(ASSET.toLowerCase())) {
    found = { path: ap, sx: box[o + 16], sy: box[o + 17], sz: box[o + 18] };
  }
}
if (!found) { console.error(`no asset matching "${ASSET}"`); process.exit(1); }
console.log(`asset ${found.path} scale ${found.sx},${found.sy},${found.sz}`);

let file = glbPathFor(LOD_ROOT, found.path);
if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, found.path);
const tris = meshTriangles(file, LOD);
const T = tris.length / 9;
console.log(`${T} triangles`);

// Scaled triangle data: normal (kept signed: it points OUT of the solid),
// offset, area, vertices.
const tn = new Float64Array(T * 3), td = new Float64Array(T), ta = new Float64Array(T);
const tv = new Float64Array(T * 9);
for (let t = 0; t < T; t++) {
  const o9 = t * 9;
  for (let v = 0; v < 9; v += 3) {
    tv[o9 + v] = tris[o9 + v] * found.sx;
    tv[o9 + v + 1] = tris[o9 + v + 1] * found.sy;
    tv[o9 + v + 2] = tris[o9 + v + 2] * found.sz;
  }
  const ux = tv[o9 + 3] - tv[o9], uy = tv[o9 + 4] - tv[o9 + 1], uz = tv[o9 + 5] - tv[o9 + 2];
  const vx = tv[o9 + 6] - tv[o9], vy = tv[o9 + 7] - tv[o9 + 1], vz = tv[o9 + 8] - tv[o9 + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  ta[t] = l * 0.5;
  if (l > 1e-9) { nx /= l; ny /= l; nz /= l; }
  tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
  td[t] = nx * (tv[o9] + tv[o9 + 3] + tv[o9 + 6]) / 3 +
          ny * (tv[o9 + 1] + tv[o9 + 4] + tv[o9 + 7]) / 3 +
          nz * (tv[o9 + 2] + tv[o9 + 5] + tv[o9 + 8]) / 3;
}

// ── Dominant planes: cluster by SIGNED normal cone + offset ───────────────
// Signed, unlike asset_planes: the two shells of a wall are two distinct
// planes here, because each is a carve boundary with an orientation.
const COS_NTOL = Math.cos(NTOL * Math.PI / 180);
const planes = [];   // {nx,ny,nz,d, area, tris:[]}
const order = Array.from({ length: T }, (_, t) => t).sort((a, b) => ta[b] - ta[a]);
for (const t of order) {
  if (!(ta[t] > 0)) continue;
  const nx = tn[t * 3], ny = tn[t * 3 + 1], nz = tn[t * 3 + 2];
  let bestP = null;
  for (const pl of planes) {
    if (nx * pl.nx + ny * pl.ny + nz * pl.nz < COS_NTOL) continue;
    const d = pl.nx * (tv[t * 9] + tv[t * 9 + 3] + tv[t * 9 + 6]) / 3 +
              pl.ny * (tv[t * 9 + 1] + tv[t * 9 + 4] + tv[t * 9 + 7]) / 3 +
              pl.nz * (tv[t * 9 + 2] + tv[t * 9 + 5] + tv[t * 9 + 8]) / 3;
    if (Math.abs(d - pl.d) > DTOL) continue;
    bestP = pl; break;
  }
  if (!bestP) { planes.push({ nx, ny, nz, d: td[t], area: ta[t], tris: [t] }); continue; }
  bestP.area += ta[t];
  bestP.tris.push(t);
}
planes.sort((a, b) => b.area - a.area);
const carvers = planes.filter(p => p.area >= MIN_SUPPORT).slice(0, MAXPLANES);
console.log(`${planes.length} planes clustered, ${carvers.length} carvers (>= ${MIN_SUPPORT} m^2, top ${MAXPLANES})`);
for (const p of carvers.slice(0, 12)) {
  console.log(`  n(${p.nx.toFixed(2)},${p.ny.toFixed(2)},${p.nz.toFixed(2)}) d=${p.d.toFixed(2)} area=${p.area.toFixed(1)} tris=${p.tris.length}`);
}

// ── BSP carve: start from the mesh bbox, split by each carver plane ───────
// A cell is a convex polytope kept as {planes: [{n,d}...]} plus a sampled
// interior point and bbox, maintained by clipping a vertex cloud.
let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
for (let i = 0; i < tv.length; i += 3) {
  if (tv[i] < bx0) bx0 = tv[i]; if (tv[i] > bx1) bx1 = tv[i];
  if (tv[i + 1] < by0) by0 = tv[i + 1]; if (tv[i + 1] > by1) by1 = tv[i + 1];
  if (tv[i + 2] < bz0) bz0 = tv[i + 2]; if (tv[i + 2] > bz1) bz1 = tv[i + 2];
}

// Cells as corner-point sets (convex hull implicit): clip a box's 8 corners
// is not enough once planes are oblique, so each cell keeps its bounding
// planes and derives vertices by 3-plane intersection (exact for the small
// plane counts here).
function cellVertices(cellPlanes) {
  const V = [];
  const np = cellPlanes.length;
  for (let a = 0; a < np; a++) for (let b = a + 1; b < np; b++) for (let c = a + 1; c < np; c++) {
    if (c === b) continue;
    const A = cellPlanes[a], B = cellPlanes[b], C = cellPlanes[c];
    // Solve [nA;nB;nC] x = [dA;dB;dC]
    const m = [A.nx, A.ny, A.nz, B.nx, B.ny, B.nz, C.nx, C.ny, C.nz];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-9) continue;
    const d = [A.d, B.d, C.d];
    const x = (d[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (d[1] * m[8] - m[5] * d[2]) + m[2] * (d[1] * m[7] - m[4] * d[2])) / det;
    const y = (m[0] * (d[1] * m[8] - m[5] * d[2]) - d[0] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * d[2] - d[1] * m[6])) / det;
    const z = (m[0] * (m[4] * d[2] - d[1] * m[7]) - m[1] * (m[3] * d[2] - d[1] * m[6]) + d[0] * (m[3] * m[7] - m[4] * m[6])) / det;
    // Inside all other planes?
    let ok = true;
    for (let k = 0; k < np; k++) {
      if (k === a || k === b || k === c) continue;
      const P = cellPlanes[k];
      if (P.nx * x + P.ny * y + P.nz * z > P.d + 1e-6) { ok = false; break; }
    }
    if (ok) V.push([x, y, z]);
  }
  return V;
}

// Root cell: the mesh bbox as 6 inward planes (n.x <= d form).
let cells = [{
  planes: [
    { nx: 1, ny: 0, nz: 0, d: bx1 }, { nx: -1, ny: 0, nz: 0, d: -bx0 },
    { nx: 0, ny: 1, nz: 0, d: by1 }, { nx: 0, ny: -1, nz: 0, d: -by0 },
    { nx: 0, ny: 0, nz: 1, d: bz1 }, { nx: 0, ny: 0, nz: -1, d: -bz0 },
  ],
}];
for (const p of carvers) {
  const next = [];
  for (const cell of cells) {
    // Does the plane cross this cell? Check vertex signs.
    const V = cellVertices(cell.planes);
    if (V.length < 4) continue;   // degenerate
    let neg = 0, pos = 0;
    for (const [x, y, z] of V) {
      const s = p.nx * x + p.ny * y + p.nz * z - p.d;
      if (s > 1e-6) pos++; else if (s < -1e-6) neg++;
    }
    if (!pos || !neg) { next.push(cell); continue; }
    next.push({ planes: [...cell.planes, { nx: p.nx, ny: p.ny, nz: p.nz, d: p.d }] });
    next.push({ planes: [...cell.planes, { nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d }] });
  }
  cells = next;
}
console.log(`${cells.length} cells after carve`);

// ── Solid test: mesh surface backs the cell boundary facing OUTWARD ───────
// For each cell, sample its centroid; for each carver plane coincident with
// one of the cell's own planes, check whether mesh triangles on that plane
// near the cell face have normals pointing OUT of the cell. Vote by area.
// Cells with no votes are air.
const results = [];
for (const cell of cells) {
  const V = cellVertices(cell.planes);
  if (V.length < 4) continue;
  let cx = 0, cy = 0, cz = 0;
  for (const [x, y, z] of V) { cx += x; cy += y; cz += z; }
  cx /= V.length; cy /= V.length; cz /= V.length;
  let vx0 = Infinity, vy0 = Infinity, vz0 = Infinity, vx1 = -Infinity, vy1 = -Infinity, vz1 = -Infinity;
  for (const [x, y, z] of V) {
    if (x < vx0) vx0 = x; if (x > vx1) vx1 = x;
    if (y < vy0) vy0 = y; if (y > vy1) vy1 = y;
    if (z < vz0) vz0 = z; if (z > vz1) vz1 = z;
  }
  if (vx1 - vx0 < MIN_CELL || vy1 - vy0 < MIN_CELL || vz1 - vz0 < MIN_CELL) continue;

  results.push({ cell, V, c: [cx, cy, cz], bbox: [vx0, vy0, vz0, vx1, vy1, vz1], outVote: 0, inVote: 0 });
}

// Solid vote: every mesh triangle lying on a cell's boundary votes with its
// area; a normal pointing away from the cell centroid says the solid is on
// the cell's side.
for (const r of results) {
  let outVote = 0, inVote = 0;
  const [vx0, vy0, vz0, vx1, vy1, vz1] = r.bbox;
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    const mx = (tv[o9] + tv[o9 + 3] + tv[o9 + 6]) / 3;
    const my = (tv[o9 + 1] + tv[o9 + 4] + tv[o9 + 7]) / 3;
    const mz = (tv[o9 + 2] + tv[o9 + 5] + tv[o9 + 8]) / 3;
    if (mx < vx0 - 0.05 || mx > vx1 + 0.05 || my < vy0 - 0.05 || my > vy1 + 0.05 ||
        mz < vz0 - 0.05 || mz > vz1 + 0.05) continue;
    let onBoundary = false;
    for (const cp of r.cell.planes) {
      if (Math.abs(cp.nx * mx + cp.ny * my + cp.nz * mz - cp.d) < DTOL) { onBoundary = true; break; }
    }
    if (!onBoundary) continue;
    const dx = mx - r.c[0], dy = my - r.c[1], dz = mz - r.c[2];
    const dot = tn[t * 3] * dx + tn[t * 3 + 1] * dy + tn[t * 3 + 2] * dz;
    if (dot > 0) outVote += ta[t]; else inVote += ta[t];
  }
  r.outVote = outVote; r.inVote = inVote;
}

const solid = results.filter(r => r.outVote > 0.2 && r.outVote > r.inVote * 2);
console.log(`${results.length} candidate cells, ${solid.length} solid`);
const boxesOut = [];
for (const r of solid) {
  const [vx0, vy0, vz0, vx1, vy1, vz1] = r.bbox;
  boxesOut.push(
    (vx0 + vx1) / 2, (vy0 + vy1) / 2, (vz0 + vz1) / 2,
    (vx1 - vx0) / 2, (vy1 - vy0) / 2, (vz1 - vz0) / 2,
    0, 0, 0, 1,
  );
  console.log(`  box c(${((vx0 + vx1) / 2).toFixed(2)},${((vy0 + vy1) / 2).toFixed(2)},${((vz0 + vz1) / 2).toFixed(2)}) ` +
              `size(${(vx1 - vx0).toFixed(2)},${(vy1 - vy0).toFixed(2)},${(vz1 - vz0).toFixed(2)}) ` +
              `votes out=${r.outVote.toFixed(2)} in=${r.inVote.toFixed(2)}`);
}

const outFile = path.join(dataDir, 'debug-asset.json');
fs.writeFileSync(outFile, JSON.stringify({
  path: found.path, scale: [found.sx, found.sy, found.sz],
  tris: Array.from(tv), slabs: boxesOut,
}));
console.log(`\nwrote ${outFile} (${boxesOut.length / 10} boxes)`);
