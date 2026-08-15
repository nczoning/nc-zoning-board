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

// ── Small vector helpers and the matrix -> quaternion used by every generator
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// A carve plane within a whisker of a world axis is one: snapping keeps the
// axis-aligned majority on identity quats instead of float-dusty ones.
const AXIS_SNAP = 0.9999;
const snapAxis = (a) => {
  for (let k = 0; k < 3; k++) {
    if (a[k] > AXIS_SNAP) { const u = [0, 0, 0]; u[k] = 1; return u; }
    if (a[k] < -AXIS_SNAP) { const u = [0, 0, 0]; u[k] = -1; return u; }
  }
  return a;
};
const isUnitAxis = (a) => Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) === 1;

// Rotation matrix (columns = basis vectors) -> quaternion. Shepperd's method.
function matToQuat(u, v, n) {
  const m00 = u[0], m10 = u[1], m20 = u[2];
  const m01 = v[0], m11 = v[1], m21 = v[2];
  const m02 = n[0], m12 = n[1], m22 = n[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return [x / l, y / l, z / l, w / l];
}

// Area of this cell's own face on one of its bounding planes. Ranking the
// planes by their MESH-wide area picks the mesh's biggest surfaces, which is
// not the same question: a slanted cell bounded by one huge axis-aligned wall
// would be measured along the wall and lose its slope. The face the cell
// actually has is what the box should sit on.
function faceArea(plane, V) {
  const on = V.filter(([x, y, z]) => Math.abs(plane.nx * x + plane.ny * y + plane.nz * z - plane.d) < 1e-4);
  if (on.length < 3) return 0;
  const c = [0, 0, 0];
  for (const p of on) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= on.length; c[1] /= on.length; c[2] /= on.length;
  const n = [plane.nx, plane.ny, plane.nz];
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const k = dot3(a, n);
  const e1 = norm3([a[0] - n[0] * k, a[1] - n[1] * k, a[2] - n[2] * k]);
  const e2 = cross3(n, e1);
  const pts = on.map(p => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [dot3(d, e1), dot3(d, e2)];
  }).sort((p, q) => Math.atan2(p[1], p[0]) - Math.atan2(q[1], q[0]));
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s) / 2;
}

// The cell's own frame: a cell is bounded by authored surfaces, so its box
// should be measured along them, not along the world axes. Its largest
// authored face gives N; the most nearly perpendicular next one gives U.
function cellFrame(cellPlanes, V) {
  const carved = cellPlanes.filter(p => p.area > 0)
    .map(p => ({ p, a: faceArea(p, V) }))
    .filter(e => e.a > 1e-6)
    .sort((x, y) => y.a - x.a)
    .map(e => e.p);
  if (!carved.length) return IDENT;
  const n = norm3([carved[0].nx, carved[0].ny, carved[0].nz]);
  let u = null;
  for (let i = 1; i < carved.length && !u; i++) {
    const c = [carved[i].nx, carved[i].ny, carved[i].nz];
    const k = dot3(c, n);
    const p = [c[0] - n[0] * k, c[1] - n[1] * k, c[2] - n[2] * k];
    if (Math.hypot(p[0], p[1], p[2]) < 0.15) continue;  // parallel: no new axis
    u = norm3(p);
  }
  if (!u) {
    // Only one plane direction bounds this cell: the roll about N is free, so
    // take the world axis least aligned with it and keep the box level.
    const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const k = dot3(a, n);
    u = norm3([a[0] - n[0] * k, a[1] - n[1] * k, a[2] - n[2] * k]);
  }
  const f = [snapAxis(u), snapAxis(cross3(n, u)), snapAxis(n)];
  return f.every(isUnitAxis) ? IDENT : f;
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

// Triangles lying on an arbitrary plane, either facing: the skin test asks
// whether a face is real mesh, not which way that mesh looks.
function bboxPlane(nx, ny, nz, d) {
  const tris = [];
  for (let t = 0; t < T; t++) {
    if (Math.abs(tn[t * 3] * nx + tn[t * 3 + 1] * ny + tn[t * 3 + 2] * nz) < COS_NTOL) continue;
    const o9 = t * 9;
    const mx = (tv[o9] + tv[o9 + 3] + tv[o9 + 6]) / 3;
    const my = (tv[o9 + 1] + tv[o9 + 4] + tv[o9 + 7]) / 3;
    const mz = (tv[o9 + 2] + tv[o9 + 5] + tv[o9 + 8]) / 3;
    if (Math.abs(nx * mx + ny * my + nz * mz - d) > DTOL) continue;
    tris.push(t);
  }
  return { nx, ny, nz, d, area: 0, tris };
}

// Root cell: the mesh bbox as 6 inward planes (n.x <= d form).
let cells = [{
  planes: [
    // area 0 marks a bbox wall: it is not an authored carve, so it never
    // votes on the cell's frame. It still carries its triangles, because the
    // bbox is the mesh's own extent and its faces usually sit exactly on the
    // outer shell, which the skin test has to count.
    bboxPlane(1, 0, 0, bx1), bboxPlane(-1, 0, 0, -bx0),
    bboxPlane(0, 1, 0, by1), bboxPlane(0, -1, 0, -by0),
    bboxPlane(0, 0, 1, bz1), bboxPlane(0, 0, -1, -bz0),
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
    // Both halves keep the plane's triangle list: it is the same geometric
    // surface, and the backed-area test needs it without re-searching the mesh.
    next.push({ planes: [...cell.planes, { nx: p.nx, ny: p.ny, nz: p.nz, d: p.d, area: p.area, tris: p.tris }] });
    next.push({ planes: [...cell.planes, { nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d, area: p.area, tris: p.tris }] });
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

  // Measure the cell along its own carve planes. An axis-aligned min/max
  // would flatten every angle the carve just recovered, and would read a
  // thin slanted cell as a fat one, so the sliver test lives here too.
  const F = cellFrame(cell.planes, V);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of V) {
    for (let k = 0; k < 3; k++) {
      const s = dot3(p, F[k]);
      if (s < lo[k]) lo[k] = s;
      if (s > hi[k]) hi[k] = s;
    }
  }
  const half = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  if (half[0] * 2 < MIN_CELL || half[1] * 2 < MIN_CELL || half[2] * 2 < MIN_CELL) continue;
  const mid = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
  const centre = [
    F[0][0] * mid[0] + F[1][0] * mid[1] + F[2][0] * mid[2],
    F[0][1] * mid[0] + F[1][1] * mid[1] + F[2][1] * mid[2],
    F[0][2] * mid[0] + F[1][2] * mid[1] + F[2][2] * mid[2],
  ];
  const quat = F === IDENT ? [0, 0, 0, 1] : matToQuat(F[0], F[1], F[2]);

  results.push({
    cell, V, c: [cx, cy, cz], bbox: [vx0, vy0, vz0, vx1, vy1, vz1],
    centre, half, quat, oriented: F !== IDENT, outVote: 0, inVote: 0,
    nCarve: cell.planes.filter(p => p.area > 0).length,
  });
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

// ── Skin test: is this box's boundary actually the mesh? ──────────────────
// The vote alone calls phantom cells solid: the volume spanning two distant
// ribs is backed by surface on a face or two and open everywhere else, and
// those faces out-vote nothing. The carve's own premise settles it: every
// box face is supposed to BE an authored surface, so a cell whose boundary
// is mostly not mesh is a BSP artifact, not a feature.
//
// Ray parity does not separate these, so do not reach for it: phantom slabs
// escape the mesh 6/6 and so does a legitimate wall core (1/6), whose end
// caps fall under MIN_SUPPORT. Backed fraction separates cleanly: wall and
// pillar 0.98/0.99, real skylight members 0.75-0.98, phantoms 0.00-0.46.
const MIN_BACKED = flag('minbacked', 0.5);  // majority of the skin must be real mesh
for (const r of results) {
  let faceTot = 0, faceBacked = 0;
  for (const cp of r.cell.planes) {
    const fa = faceArea(cp, r.V);
    if (fa <= 1e-6) continue;
    faceTot += fa;
    if (!cp.tris) continue;              // a bbox wall is never backed
    let backed = 0;
    for (const t of cp.tris) {
      const o9 = t * 9;
      const mx = (tv[o9] + tv[o9 + 3] + tv[o9 + 6]) / 3;
      const my = (tv[o9 + 1] + tv[o9 + 4] + tv[o9 + 7]) / 3;
      const mz = (tv[o9 + 2] + tv[o9 + 5] + tv[o9 + 8]) / 3;
      let inside = true;
      for (const q of r.cell.planes) {
        if (q === cp) continue;
        if (q.nx * mx + q.ny * my + q.nz * mz > q.d + DTOL) { inside = false; break; }
      }
      if (inside) backed += ta[t];
    }
    faceBacked += Math.min(backed, fa);
  }
  r.backedFrac = faceTot > 0 ? faceBacked / faceTot : 0;
}

const voted = results.filter(r => r.outVote > 0.2 && r.outVote > r.inVote * 2);
const solid = voted.filter(r => r.backedFrac >= MIN_BACKED);
console.log(`${voted.length - solid.length} voted cells dropped as unbacked (< ${MIN_BACKED} of skin is mesh)`);
console.log(`${results.length} candidate cells, ${solid.length} solid`);
const boxesOut = [];
let orientedCount = 0;
for (const r of solid) {
  if (r.oriented) orientedCount++;
  boxesOut.push(
    r.centre[0], r.centre[1], r.centre[2],
    r.half[0], r.half[1], r.half[2],
    r.quat[0], r.quat[1], r.quat[2], r.quat[3],
  );
  console.log(`  box c(${r.centre.map(v => v.toFixed(2)).join(',')}) ` +
              `size(${r.half.map(v => (v * 2).toFixed(2)).join(',')}) ` +
              `${r.oriented ? `quat(${r.quat.map(v => v.toFixed(3)).join(',')}) ` : 'axis-aligned '}` +
              `votes out=${r.outVote.toFixed(2)} in=${r.inVote.toFixed(2)} carve=${r.nCarve} backed=${r.backedFrac.toFixed(2)}`);
}
console.log(`${orientedCount}/${solid.length} boxes carry a non-identity frame`);

const outFile = path.join(dataDir, 'debug-asset.json');
fs.writeFileSync(outFile, JSON.stringify({
  path: found.path, scale: [found.sx, found.sy, found.sz],
  tris: Array.from(tv), slabs: boxesOut,
}));
console.log(`\nwrote ${outFile} (${boxesOut.length / 10} boxes)`);
