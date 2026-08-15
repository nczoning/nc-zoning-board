#!/usr/bin/env node
/**
 * asset_carve.js: stage 2 decomposition at FEATURE granularity.
 *
 * The premise (the maintainer's, watching kit meshes in WolvenKit): an
 * authored kit piece visibly decomposes into a handful of different-sized
 * boxes whose faces are the mesh's own surfaces. Neither prior method sees
 * that structure: the voxel grid imposes a uniform resolution, the surface
 * method imposes triangle granularity. This one asks the mesh for its OWN
 * structure: its triangles lie on a small set of dominant planes; those
 * planes carve mesh-local space into convex cells (a BSP with no heuristic
 * split choices, every cut an authored surface); cells whose boundary is
 * backed by mesh surface facing OUT of them are solid; each solid cell is
 * one box, measured in its own frame.
 *
 * What falls out by construction: box faces sit exactly on authored
 * geometry (no quantization, native angles); a wall's two shells enclose
 * ONE solid box (no seam caps, no double plates); trim inside a cell
 * vanishes into it (aggregation at feature scale); a curved vault becomes
 * a few stacked wedge cells, not one shard per facet triangle.
 *
 * Usage: node scripts/asset_carve.js <district>            (whole district)
 *        node scripts/asset_carve.js <district> --asset <substring>
 *                                                (one asset, verbose + JSON)
 * Then:  node scripts/cull_hidden.js <district>            (remove unseeable)
 *        node scripts/encode_hull_dds.js <district> --outdir carve
 * View:  ?assets=carve&only=<district>  (A/B against ?assets=rebuilt)
 *
 * Interiors are carved by default: the removal of what the game hides is
 * cull_hidden.js's world-space job, not a per-asset guess. --nointeriors is
 * the cheap fallback if the runtime or the payload says otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { glbPathFor, meshTriangles } = require('./glb_lib');
const { categorize } = require('./asset_category');
const { loadTerrain, indexTris, heightAtCet } = require('./terrain_lib');

const LOD_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw_alllod';
const RAW_ROOT = 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';

const args = process.argv.slice(2);
const name = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };
const strFlag = (k) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : null; };

const ASSET     = strFlag('asset');       // single-asset unit mode
const MAXPLANES = flag('maxplanes', 24);  // dominant planes kept per mesh
const NTOL      = flag('ntol', 8);        // degrees: plane clustering cone
const DTOL      = flag('dtol', 0.15);     // metres: coplanar offset tolerance (shells stay separate)
const MIN_SUPPORT = flag('minsupport', 0.5); // m^2: a plane needs this much triangle area to carve
const MIN_CELL  = flag('mincell', 0.05);  // metres: cells thinner than this are slivers
const MIN_BACKED = flag('minbacked', 0.5);// share of a cell's skin that must be real mesh
const MAX_CELLS = flag('maxcells', 4000); // safety valve: a BSP is exponential in the worst case
const LOD       = flag('lod', 2);
const MIN_SIZE  = flag('minsize', 0.3);
const MAX_SIZE  = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW     = flag('below', 16);
// metres: an asset that carves to nothing falls back to its bounding box only
// under this size, where "the asset IS a box" is a fair statement (a crate, a
// planter). Above it the same fallback asserts the same thing about a
// landmark and lands a district-sized slab over the bench, so the placement
// is dropped and counted instead.
const BBOX_SMALL = flag('bboxsmall', 4);
const NO_INTERIORS = args.includes('--nointeriors');
const INTERIOR_RE = /[\\/]int_|interior|[\\/]decoration[\\/]|[\\/]furniture[\\/]|[\\/]shop[\\/]/i;

if (!name) { console.error('usage: node scripts/asset_carve.js <district> [--asset <substring>]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, TYPE = meta.types || {}, PATHS = meta.assetPaths || {};

const COS_NTOL = Math.cos(NTOL * Math.PI / 180);

// ── Vector, quaternion and cell-geometry helpers ──────────────────────────
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

const quatToMat = (qx, qy, qz, qw) => [
  1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
  2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
  2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
];
// Hamilton product: the composed rotation applies b first, then a.
const quatMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

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

// A cell is a convex polytope kept as bounding planes; its corners come from
// 3-plane intersection, exact for the small plane counts here.
function cellVertices(cellPlanes) {
  const V = [];
  const np = cellPlanes.length;
  for (let a = 0; a < np; a++) for (let b = a + 1; b < np; b++) for (let c = b + 1; c < np; c++) {
    const A = cellPlanes[a], B = cellPlanes[b], C = cellPlanes[c];
    const m = [A.nx, A.ny, A.nz, B.nx, B.ny, B.nz, C.nx, C.ny, C.nz];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-9) continue;
    const d = [A.d, B.d, C.d];
    const x = (d[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (d[1] * m[8] - m[5] * d[2]) + m[2] * (d[1] * m[7] - m[4] * d[2])) / det;
    const y = (m[0] * (d[1] * m[8] - m[5] * d[2]) - d[0] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * d[2] - d[1] * m[6])) / det;
    const z = (m[0] * (m[4] * d[2] - d[1] * m[7]) - m[1] * (m[3] * d[2] - d[1] * m[6]) + d[0] * (m[3] * m[7] - m[4] * m[6])) / det;
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

// The cell's own frame: a cell is bounded by authored surfaces, so its box is
// measured along them, not along the world axes. Its largest authored face
// gives N; the most nearly perpendicular next one gives U.
function cellFrame(faces) {
  const carved = faces.filter(f => f.p.area > 0 && f.a > 1e-6).sort((x, y) => y.a - x.a).map(f => f.p);
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

// ── The carve itself: triangles in, local stride-10 boxes out ─────────────
const carveStats = { capped: 0, unbacked: 0, slivers: 0, cells: 0 };

function carveMesh(tris, sx, sy, sz, verbose) {
  const T = tris.length / 9;
  if (!T) return null;

  // Scaled triangle data. The normal is kept SIGNED: it points out of the
  // solid, which is what makes a plane a carve boundary rather than a fit.
  const tn = new Float64Array(T * 3), td = new Float64Array(T), ta = new Float64Array(T);
  const tv = new Float64Array(T * 9);
  const tc = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    for (let v = 0; v < 9; v += 3) {
      tv[o9 + v] = tris[o9 + v] * sx;
      tv[o9 + v + 1] = tris[o9 + v + 1] * sy;
      tv[o9 + v + 2] = tris[o9 + v + 2] * sz;
    }
    const ux = tv[o9 + 3] - tv[o9], uy = tv[o9 + 4] - tv[o9 + 1], uz = tv[o9 + 5] - tv[o9 + 2];
    const vx = tv[o9 + 6] - tv[o9], vy = tv[o9 + 7] - tv[o9 + 1], vz = tv[o9 + 8] - tv[o9 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    ta[t] = l * 0.5;
    if (l > 1e-9) { nx /= l; ny /= l; nz /= l; }
    tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
    tc[t * 3] = (tv[o9] + tv[o9 + 3] + tv[o9 + 6]) / 3;
    tc[t * 3 + 1] = (tv[o9 + 1] + tv[o9 + 4] + tv[o9 + 7]) / 3;
    tc[t * 3 + 2] = (tv[o9 + 2] + tv[o9 + 5] + tv[o9 + 8]) / 3;
    td[t] = nx * tc[t * 3] + ny * tc[t * 3 + 1] + nz * tc[t * 3 + 2];
  }

  // Dominant planes: cluster by SIGNED normal cone + offset. Signed, so the
  // two shells of a wall stay two planes: each is an oriented boundary.
  const planes = [];
  const order = Array.from({ length: T }, (_, t) => t).sort((a, b) => ta[b] - ta[a]);
  for (const t of order) {
    if (!(ta[t] > 0)) continue;
    const nx = tn[t * 3], ny = tn[t * 3 + 1], nz = tn[t * 3 + 2];
    let bestP = null;
    for (const pl of planes) {
      if (nx * pl.nx + ny * pl.ny + nz * pl.nz < COS_NTOL) continue;
      if (Math.abs(pl.nx * tc[t * 3] + pl.ny * tc[t * 3 + 1] + pl.nz * tc[t * 3 + 2] - pl.d) > DTOL) continue;
      bestP = pl; break;
    }
    if (!bestP) { planes.push({ nx, ny, nz, d: td[t], area: ta[t], tris: [t] }); continue; }
    bestP.area += ta[t];
    bestP.tris.push(t);
  }
  planes.sort((a, b) => b.area - a.area);
  const carvers = planes.filter(p => p.area >= MIN_SUPPORT).slice(0, MAXPLANES);
  if (verbose) {
    console.log(`${planes.length} planes clustered, ${carvers.length} carvers (>= ${MIN_SUPPORT} m^2, top ${MAXPLANES})`);
    for (const p of carvers.slice(0, 12)) {
      console.log(`  n(${p.nx.toFixed(2)},${p.ny.toFixed(2)},${p.nz.toFixed(2)}) d=${p.d.toFixed(2)} area=${p.area.toFixed(1)} tris=${p.tris.length}`);
    }
  }
  if (!carvers.length) return null;

  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < tv.length; i += 3) {
    if (tv[i] < bx0) bx0 = tv[i]; if (tv[i] > bx1) bx1 = tv[i];
    if (tv[i + 1] < by0) by0 = tv[i + 1]; if (tv[i + 1] > by1) by1 = tv[i + 1];
    if (tv[i + 2] < bz0) bz0 = tv[i + 2]; if (tv[i + 2] > bz1) bz1 = tv[i + 2];
  }

  // Triangles lying on an arbitrary plane, either facing: the skin test asks
  // whether a face is real mesh, not which way that mesh looks.
  function bboxPlane(nx, ny, nz, d) {
    const list = [];
    for (let t = 0; t < T; t++) {
      if (Math.abs(tn[t * 3] * nx + tn[t * 3 + 1] * ny + tn[t * 3 + 2] * nz) < COS_NTOL) continue;
      if (Math.abs(nx * tc[t * 3] + ny * tc[t * 3 + 1] + nz * tc[t * 3 + 2] - d) > DTOL) continue;
      list.push(t);
    }
    // area 0 marks a bbox wall: it is not an authored carve, so it never
    // votes on the cell's frame. It still carries its triangles, because the
    // bbox is the mesh's own extent and its faces usually sit exactly on the
    // outer shell, which the skin test has to count.
    return { nx, ny, nz, d, area: 0, tris: list };
  }

  let cells = [{
    planes: [
      bboxPlane(1, 0, 0, bx1), bboxPlane(-1, 0, 0, -bx0),
      bboxPlane(0, 1, 0, by1), bboxPlane(0, -1, 0, -by0),
      bboxPlane(0, 0, 1, bz1), bboxPlane(0, 0, -1, -bz0),
    ],
  }];
  let capped = false;
  for (const p of carvers) {
    if (cells.length >= MAX_CELLS) { capped = true; break; }
    const next = [];
    for (const cell of cells) {
      const V = cellVertices(cell.planes);
      if (V.length < 4) continue;   // degenerate
      let neg = 0, pos = 0;
      for (const [x, y, z] of V) {
        const s = p.nx * x + p.ny * y + p.nz * z - p.d;
        if (s > 1e-6) pos++; else if (s < -1e-6) neg++;
      }
      if (!pos || !neg) { next.push(cell); continue; }
      // Both halves keep the plane's triangle list: it is the same geometric
      // surface, and the skin test needs it without re-searching the mesh.
      next.push({ planes: [...cell.planes, { nx: p.nx, ny: p.ny, nz: p.nz, d: p.d, area: p.area, tris: p.tris }] });
      next.push({ planes: [...cell.planes, { nx: -p.nx, ny: -p.ny, nz: -p.nz, d: -p.d, area: p.area, tris: p.tris }] });
    }
    cells = next;
  }
  if (capped) carveStats.capped++;
  carveStats.cells += cells.length;
  if (verbose) console.log(`${cells.length} cells after carve${capped ? ` (CAPPED at ${MAX_CELLS})` : ''}`);

  // Candidate cells: measured in their own frame, slivers dropped there too,
  // because an axis-aligned min/max reads a thin slanted cell as a fat one.
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

    const faces = cell.planes.map(p => ({ p, a: faceArea(p, V) })).filter(f => f.a > 1e-6);
    const F = cellFrame(faces);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of V) {
      for (let k = 0; k < 3; k++) {
        const s = dot3(p, F[k]);
        if (s < lo[k]) lo[k] = s;
        if (s > hi[k]) hi[k] = s;
      }
    }
    const half = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    if (half[0] * 2 < MIN_CELL || half[1] * 2 < MIN_CELL || half[2] * 2 < MIN_CELL) { carveStats.slivers++; continue; }
    const mid = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
    const centre = [
      F[0][0] * mid[0] + F[1][0] * mid[1] + F[2][0] * mid[2],
      F[0][1] * mid[0] + F[1][1] * mid[1] + F[2][1] * mid[2],
      F[0][2] * mid[0] + F[1][2] * mid[1] + F[2][2] * mid[2],
    ];

    results.push({
      cell, faces, c: [cx, cy, cz], bbox: [vx0, vy0, vz0, vx1, vy1, vz1],
      centre, half, quat: F === IDENT ? [0, 0, 0, 1] : matToQuat(F[0], F[1], F[2]),
      oriented: F !== IDENT, outVote: 0, inVote: 0, backedFrac: 0,
    });
  }

  // Solid vote: every mesh triangle lying on a cell's boundary votes with its
  // area; a normal pointing away from the cell centroid says the solid is on
  // the cell's side.
  for (const r of results) {
    let outVote = 0, inVote = 0;
    const [vx0, vy0, vz0, vx1, vy1, vz1] = r.bbox;
    for (let t = 0; t < T; t++) {
      const mx = tc[t * 3], my = tc[t * 3 + 1], mz = tc[t * 3 + 2];
      if (mx < vx0 - 0.05 || mx > vx1 + 0.05 || my < vy0 - 0.05 || my > vy1 + 0.05 ||
          mz < vz0 - 0.05 || mz > vz1 + 0.05) continue;
      let onBoundary = false;
      for (const cp of r.cell.planes) {
        if (Math.abs(cp.nx * mx + cp.ny * my + cp.nz * mz - cp.d) < DTOL) { onBoundary = true; break; }
      }
      if (!onBoundary) continue;
      const dot = tn[t * 3] * (mx - r.c[0]) + tn[t * 3 + 1] * (my - r.c[1]) + tn[t * 3 + 2] * (mz - r.c[2]);
      if (dot > 0) outVote += ta[t]; else inVote += ta[t];
    }
    r.outVote = outVote; r.inVote = inVote;
  }

  // Skin test: is this box's boundary actually the mesh? The vote alone calls
  // phantom cells solid, because the volume spanning two distant ribs is
  // backed by surface on a face or two and open everywhere else. The carve's
  // own premise settles it: every box face is supposed to BE an authored
  // surface, so a cell whose boundary is mostly not mesh is a BSP artifact.
  //
  // Ray parity does not separate these, so do not reach for it: phantom slabs
  // escape the mesh 6/6 and so does a legitimate wall core (1/6), whose end
  // caps fall under MIN_SUPPORT. Backed fraction separates cleanly: wall and
  // pillar 0.98/0.99, real skylight members 0.75-0.98, phantoms 0.00-0.46.
  for (const r of results) {
    let faceTot = 0, faceBacked = 0;
    for (const { p: cp, a: fa } of r.faces) {
      faceTot += fa;
      let backed = 0;
      for (const t of cp.tris) {
        const mx = tc[t * 3], my = tc[t * 3 + 1], mz = tc[t * 3 + 2];
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
  carveStats.unbacked += voted.length - solid.length;
  if (verbose) {
    console.log(`${results.length} candidate cells, ${voted.length} voted solid, ${voted.length - solid.length} dropped as unbacked (< ${MIN_BACKED} of skin is mesh)`);
    for (const r of solid) {
      console.log(`  box c(${r.centre.map(v => v.toFixed(2)).join(',')}) ` +
                  `size(${r.half.map(v => (v * 2).toFixed(2)).join(',')}) ` +
                  `${r.oriented ? `quat(${r.quat.map(v => v.toFixed(3)).join(',')}) ` : 'axis-aligned '}` +
                  `votes out=${r.outVote.toFixed(2)} in=${r.inVote.toFixed(2)} backed=${r.backedFrac.toFixed(2)}`);
    }
    console.log(`${solid.filter(r => r.oriented).length}/${solid.length} boxes carry a non-identity frame`);
  }
  if (!solid.length) return null;

  const outArr = new Float32Array(solid.length * 10);
  solid.forEach((r, i) => {
    const o = i * 10;
    outArr[o] = r.centre[0]; outArr[o + 1] = r.centre[1]; outArr[o + 2] = r.centre[2];
    outArr[o + 3] = r.half[0]; outArr[o + 4] = r.half[1]; outArr[o + 5] = r.half[2];
    outArr[o + 6] = r.quat[0]; outArr[o + 7] = r.quat[1]; outArr[o + 8] = r.quat[2]; outArr[o + 9] = r.quat[3];
  });
  return outArr;
}

// ── Per-asset carve, cached by (asset, scale) ─────────────────────────────
const cache = new Map();
let decomposed = 0, noTris = 0, totalAssetBoxes = 0, noSolid = 0;
const t0 = Date.now();

function trisFor(aid) {
  const p = PATHS[aid] || '';
  if (!p) return null;
  let file = glbPathFor(LOD_ROOT, p);
  if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, p);
  if (!fs.existsSync(file)) return null;
  try { const t = meshTriangles(file, LOD); return t.length ? t : null; } catch { return null; }
}

function decompose(aid, sx, sy, sz) {
  const key = `${aid}|${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const tris = trisFor(aid);
  if (!tris) { cache.set(key, null); noTris++; return null; }
  const local = carveMesh(tris, sx, sy, sz, false);
  cache.set(key, local);
  decomposed++;
  if (!local) noSolid++; else totalAssetBoxes += local.length / 10;
  if (decomposed % 250 === 0) {
    console.log(`    carved ${decomposed.toLocaleString()} (asset, scale) pairs, ${Math.round(totalAssetBoxes).toLocaleString()} local boxes, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  return local;
}

// ── --asset: one asset in, verbose report + JSON out, exit ────────────────
if (ASSET) {
  let found = null;
  for (let i = 0; i < meta.boxes && !found; i++) {
    const o = i * S;
    const ap = PATHS[box[o + 10]] || '';
    if (ap.toLowerCase().includes(ASSET.toLowerCase())) {
      found = { aid: box[o + 10], path: ap, sx: box[o + 16], sy: box[o + 17], sz: box[o + 18] };
    }
  }
  if (!found) { console.error(`no asset matching "${ASSET}"`); process.exit(1); }
  console.log(`asset ${found.path} scale ${found.sx},${found.sy},${found.sz}`);
  const tris = trisFor(found.aid);
  if (!tris) { console.error('no triangles'); process.exit(1); }
  console.log(`${tris.length / 9} triangles`);
  const local = carveMesh(tris, found.sx, found.sy, found.sz, true);
  const scaled = [];
  for (let t = 0; t < tris.length; t += 3) {
    scaled.push(tris[t] * found.sx, tris[t + 1] * found.sy, tris[t + 2] * found.sz);
  }
  const outFile = path.join(dataDir, 'debug-asset.json');
  fs.writeFileSync(outFile, JSON.stringify({
    path: found.path, scale: [found.sx, found.sy, found.sz],
    tris: scaled, slabs: local ? Array.from(local) : [],
  }));
  console.log(`\nwrote ${outFile} (${(local ? local.length : 0) / 10} boxes)`);
  process.exit(0);
}

// ── Classify placements (identical policy to asset_boxes.js) ──────────────
console.log(`district ${name} (feature carve)`);
const terrain = indexTris(loadTerrain());
const builders = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0, skippedInterior = 0;
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const assetPath = PATHS[box[o + 10]] || '';
  // Terrain-shaped meshes under a \terrain\ path (landfill mounds) are
  // ground, not architecture, and the by-NAME terrain rule in categorize()
  // misses them. Excluded here as the surface sibling excludes them, until
  // the grid path judges the same exclusion.
  if (assetPath.includes('\\terrain\\') || assetPath.includes('/terrain/')) { skippedNever++; continue; }
  if (NO_INTERIORS && INTERIOR_RE.test(assetPath)) { skippedInterior++; continue; }
  const cat = categorize(assetPath, TYPE[box[o + 11]] || '');
  if (cat !== 'building' && cat !== 'proxy' && cat !== 'infrastructure') { skippedNever++; continue; }
  if (largest > MAX_SIZE) { skippedHuge++; continue; }
  if (cat === 'proxy') {
    if (largest > PROXY_MAX) { skippedProxy++; continue; }
    proxies.push(i);
  } else builders.push(i);
}
console.log(`  input     ${builders.length.toLocaleString()} placements + ${proxies.length.toLocaleString()} proxies held back`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} small, ${skippedHuge.toLocaleString()} huge, ${skippedNever.toLocaleString()} never, ${skippedProxy.toLocaleString()} area proxies, ${skippedInterior.toLocaleString()} interior/furnishing`);

// ── Stamp placements (identical to asset_boxes.js) ────────────────────────
const out = [];
let stamped = 0, bboxFallback = 0, droppedBig = 0;
const droppedBigAssets = new Map();

function emitPlacement(i) {
  const o = i * S;
  const local = decompose(box[o + 10], box[o + 16], box[o + 17], box[o + 18]);
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  if (!local) {
    const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
    if (largest >= BBOX_SMALL) {
      droppedBig++;
      const p = PATHS[box[o + 10]] || '(none)';
      const e = droppedBigAssets.get(p) || { n: 0, max: 0 };
      e.n++; e.max = Math.max(e.max, largest);
      droppedBigAssets.set(p, e);
      return;
    }
    out.push({
      c: [box[o], box[o + 1], box[o + 2]],
      h: [box[o + 3], box[o + 4], box[o + 5]],
      q: [qx, qy, qz, qw],
    });
    bboxFallback++;
    return;
  }
  const m = quatToMat(qx, qy, qz, qw);
  const pq = [qx, qy, qz, qw];
  const px = box[o + 13], py = box[o + 14], pz = box[o + 15];
  for (let k = 0; k < local.length; k += 10) {
    const lx = local[k], ly = local[k + 1], lz = local[k + 2];
    out.push({
      c: [
        px + m[0] * lx + m[1] * ly + m[2] * lz,
        py + m[3] * lx + m[4] * ly + m[5] * lz,
        pz + m[6] * lx + m[7] * ly + m[8] * lz,
      ],
      h: [local[k + 3], local[k + 4], local[k + 5]],
      q: quatMul(pq, [local[k + 6], local[k + 7], local[k + 8], local[k + 9]]),
    });
  }
  stamped++;
}

for (const i of builders) emitPlacement(i);
console.log(`  carved    ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local boxes ` +
            `(${noTris.toLocaleString()} with no triangles, ${noSolid.toLocaleString()} with no solid cell)`);
console.log(`  cells     ${carveStats.cells.toLocaleString()} carved, ${carveStats.slivers.toLocaleString()} slivers, ` +
            `${carveStats.unbacked.toLocaleString()} voted-but-unbacked dropped, ${carveStats.capped.toLocaleString()} meshes hit the ${MAX_CELLS} cell cap`);
console.log(`  stamped   ${stamped.toLocaleString()} placements -> ${out.length.toLocaleString()} boxes ` +
            `(${bboxFallback.toLocaleString()} bbox fallbacks under ${BBOX_SMALL} m, ${droppedBig.toLocaleString()} larger placements DROPPED as unrepresented)`);
if (droppedBigAssets.size) {
  const worst = [...droppedBigAssets.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, 10);
  console.log(`  dropped   ${droppedBigAssets.size.toLocaleString()} distinct assets carved to nothing; largest:`);
  for (const [p, e] of worst) console.log(`    ${e.max.toFixed(0).padStart(5)} m x${e.n}  ${p}`);
}

// ── Terrain clip ──────────────────────────────────────────────────────────
const kept = [];
let buried = 0;
for (const b of out) {
  const g = heightAtCet(terrain, b.c[0], b.c[1]);
  if (g !== null && b.c[2] + b.h[2] <= g - BELOW) { buried++; continue; }
  kept.push(b);
}
console.log(`  terrain   ${buried.toLocaleString()} buried boxes cut`);

// ── Proxies where uncovered (hash probe, as asset_boxes) ──────────────────
const CELL = 32;
const hash = new Map();
const boxesAt = (x, y) => hash.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) || [];
function indexBox(b, i) {
  const r = Math.hypot(b.h[0], b.h[1]);
  for (let cx = Math.floor((b.c[0] - r) / CELL); cx <= Math.floor((b.c[0] + r) / CELL); cx++)
    for (let cy = Math.floor((b.c[1] - r) / CELL); cy <= Math.floor((b.c[1] + r) / CELL); cy++) {
      const k = `${cx},${cy}`;
      let l = hash.get(k); if (!l) hash.set(k, l = []);
      l.push(i);
    }
}
kept.forEach((b, i) => indexBox(b, i));
const mats = kept.map(b => quatToMat(b.q[0], b.q[1], b.q[2], b.q[3]));
function insideAny(x, y, z) {
  for (const i of boxesAt(x, y)) {
    const b = kept[i], m = mats[i];
    const dx = x - b.c[0], dy = y - b.c[1], dz = z - b.c[2];
    const bx = m[0] * dx + m[3] * dy + m[6] * dz;
    const by = m[1] * dx + m[4] * dy + m[7] * dz;
    const bz = m[2] * dx + m[5] * dy + m[8] * dz;
    if (Math.abs(bx) <= b.h[0] && Math.abs(by) <= b.h[1] && Math.abs(bz) <= b.h[2]) return true;
  }
  return false;
}
let proxyUsed = 0, proxyCovered = 0;
proxies.sort((a, b) =>
  box[a * S + 3] * box[a * S + 4] * box[a * S + 5] - box[b * S + 3] * box[b * S + 4] * box[b * S + 5]);
for (const i of proxies) {
  const o = i * S;
  const m = quatToMat(box[o + 6], box[o + 7], box[o + 8], box[o + 9]);
  let occ = 0;
  for (let fz = -1; fz <= 1; fz++) for (let fy = -1; fy <= 1; fy++) for (let fx = -1; fx <= 1; fx++) {
    const lx = fx * box[o + 3] * 0.66, ly = fy * box[o + 4] * 0.66, lz = fz * box[o + 5] * 0.66;
    if (insideAny(box[o] + m[0] * lx + m[1] * ly + m[2] * lz,
                  box[o + 1] + m[3] * lx + m[4] * ly + m[5] * lz,
                  box[o + 2] + m[6] * lx + m[7] * ly + m[8] * lz)) occ++;
  }
  if (occ / 27 >= PROXY_COVER) { proxyCovered++; continue; }
  const before = kept.length;
  const localBase = out.length;
  emitPlacement(i);
  for (let j = localBase; j < out.length; j++) {
    const b = out[j];
    const g = heightAtCet(terrain, b.c[0], b.c[1]);
    if (g !== null && b.c[2] + b.h[2] <= g - BELOW) continue;
    indexBox(b, kept.length);
    kept.push(b);
    mats.push(quatToMat(b.q[0], b.q[1], b.q[2], b.q[3]));
  }
  if (kept.length > before) proxyUsed++;
}
console.log(`  proxies   ${proxyUsed.toLocaleString()} stamped where uncovered, ${proxyCovered.toLocaleString()} rejected as covered`);

// ── Shape stats + write ───────────────────────────────────────────────────
{
  const dims = kept.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  const oriented = kept.filter(b => b.q[3] !== 1 || b.q[0] !== 0 || b.q[1] !== 0 || b.q[2] !== 0).length;
  console.log(`  shape     median largest dim ${med.toFixed(1)} m, ${oriented.toLocaleString()} oriented`);
}
console.log(`  BOXES     ${kept.length.toLocaleString()} after the feature carve, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const buf = new Float32Array(kept.length * 10);
kept.forEach((b, i) => {
  const o = i * 10;
  buf[o] = b.c[0]; buf[o + 1] = b.c[1]; buf[o + 2] = b.c[2];
  buf[o + 3] = b.h[0]; buf[o + 4] = b.h[1]; buf[o + 5] = b.h[2];
  buf[o + 6] = b.q[0]; buf[o + 7] = b.q[1]; buf[o + 8] = b.q[2]; buf[o + 9] = b.q[3];
});
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.bin`), Buffer.from(buf.buffer));
fs.rmSync(path.join(dataDir, `district-hull-${name}.presnap.bin`), { force: true });
fs.writeFileSync(path.join(dataDir, `district-hull-${name}.json`), JSON.stringify({
  district: name, bounds: meta.bounds, generator: 'assetcarve',
  ntol: NTOL, dtol: DTOL, minSupport: MIN_SUPPORT, maxPlanes: MAXPLANES,
  minCell: MIN_CELL, minBacked: MIN_BACKED, maxCells: MAX_CELLS,
  lod: LOD, minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW, interiors: !NO_INTERIORS,
  decomposed, noTris, noSolid, stamped, bboxFallback, buried, proxyUsed, proxyCovered,
  cellsCarved: carveStats.cells, slivers: carveStats.slivers,
  unbacked: carveStats.unbacked, capped: carveStats.capped,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin (generator assetcarve; cull with cull_hidden.js, encode with --outdir carve)`);
