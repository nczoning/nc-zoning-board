#!/usr/bin/env node
/**
 * asset_planes.js: stage 2 by per-ASSET SURFACE decomposition. The sibling
 * experiment to asset_boxes.js: no voxel grid anywhere in the pipeline.
 *
 * The premise under test: the eye judging the map sees FACES of buildings,
 * never insides, so a cloud that covers every visible surface with oriented
 * slabs looks like solid mass while keeping every authored angle exact. Each
 * unique mesh's LOD2 triangles cluster into near-coplanar patches (running
 * area-weighted plane fit, normal sign canonicalised so a wall's inner and
 * outer shell land in ONE cluster and the slab thickness covers both);
 * patches split by 2D connectivity so two coplanar walls across a courtyard
 * stay separate; each patch becomes ONE slab: min-area rectangle (convex
 * hull + rotating calipers) in the plane, thickness from the patch's own
 * offset spread. Placements stamp the cached slabs exactly as asset_boxes
 * does, quats composed.
 *
 * Known risks, accepted going in: seams where dirty kit geometry clusters
 * apart, curved surfaces facet into many narrow slabs, trim inflates the
 * count. Dropped patches are counted and logged, never silent.
 *
 * Usage: node scripts/asset_planes.js pacifica [--ntol 8] [--dtol 0.5]
 *        [--minarea 0.6] [--minthick 0.3] [--cell 1.0]
 * Then:  node scripts/encode_hull_dds.js pacifica --outdir planes
 * View:  ?assets=planes  (A/B against ?assets=rebuilt in a second tab)
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

const BBOX_SMALL = flag('bboxsmall', 4); // metres: assets under this become ONE oriented bbox,
                                         // not plates; a crate IS a box, and shelling props
                                         // into six thin faces reads as scattered squares
const AGG_SMALL = flag('aggsmall', 4);   // m^2: slabs under this can be absorbed or clustered
const AGG_D     = flag('aggd', 0.75);    // metres: absorption reach and cluster adjacency
const AGG_RATIO = flag('aggratio', 3);   // a parent must have this many times the detail's area;
                                         // aggregation is strictly one level deep (detail into
                                         // parent), so the world-merge union error cannot compound
const NTOL     = flag('ntol', 8);       // degrees: normal tolerance joining a plane cluster
const DTOL     = flag('dtol', 0.5);     // metres: offset tolerance (covers double shells)
const MIN_AREA = flag('minarea', 0.6);  // m^2: smaller rectangles drop (counted)
const MIN_THICK = flag('minthick', 0.3);// metres: slab minimum thickness
const CELL2D   = flag('cell', 1.0);     // metres: in-plane connectivity cell
const LOD      = flag('lod', 2);
const MIN_SIZE = flag('minsize', 0.3);
const MAX_SIZE = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW    = flag('below', 16);

if (!name) { console.error('usage: node scripts/asset_planes.js <district>'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, TYPE = meta.types || {}, PATHS = meta.assetPaths || {};

const terrain = indexTris(loadTerrain());
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

console.log(`district ${name} (surface decomposition, no grid)`);

// ── Classify placements (identical policy to asset_boxes.js) ──────────────
const builders = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0;
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const assetPath = PATHS[box[o + 10]] || '';
  // Terrain-shaped meshes under a \terrain\ path (landfill mounds) are
  // ground, not architecture: surfaced, they facet into hundreds of tilted
  // squares each. The by-NAME terrain rule in categorize() misses them; kept
  // local to this experiment until the grid path judges the same exclusion.
  if (assetPath.includes('\\terrain\\') || assetPath.includes('/terrain/')) { skippedNever++; continue; }
  const cat = categorize(assetPath, TYPE[box[o + 11]] || '');
  if (cat !== 'building' && cat !== 'proxy' && cat !== 'infrastructure') { skippedNever++; continue; }
  if (largest > MAX_SIZE) { skippedHuge++; continue; }
  if (cat === 'proxy') {
    if (largest > PROXY_MAX) { skippedProxy++; continue; }
    proxies.push(i);
  } else builders.push(i);
}
console.log(`  input     ${builders.length.toLocaleString()} placements + ${proxies.length.toLocaleString()} proxies held back`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} small, ${skippedHuge.toLocaleString()} huge, ${skippedNever.toLocaleString()} never, ${skippedProxy.toLocaleString()} area proxies`);

// ── Per-asset surface decomposition, cached ───────────────────────────────
const cache = new Map();
let decomposed = 0, noTris = 0, totalAssetBoxes = 0, droppedSmallPatch = 0;
let aggAbsorbed = 0, aggClusters = 0, aggClustered = 0;
// --stats: per-asset accounting of the small near-square slabs that read as
// visual noise, to name the top contributors instead of guessing.
const STATS = args.includes('--stats');
const assetStats = new Map();   // cache key -> {path, slabs, smallSq, stamps}

const COS_NTOL = Math.cos(NTOL * Math.PI / 180);

function decompose(aid, sx, sy, sz) {
  const key = `${aid}|${sx.toFixed(2)},${sy.toFixed(2)},${sz.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let tris = null;
  const p = PATHS[aid] || '';
  if (p) {
    let file = glbPathFor(LOD_ROOT, p);
    if (!fs.existsSync(file)) file = glbPathFor(RAW_ROOT, p);
    if (fs.existsSync(file)) { try { tris = meshTriangles(file, LOD); if (!tris.length) tris = null; } catch { tris = null; } }
  }
  if (!tris) { cache.set(key, null); noTris++; return null; }

  // Small assets are ONE oriented bbox: at map distance a crate, trash bag
  // or planter is its box, and plates would be six squares in its place.
  {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const vx = tris[t] * sx, vy = tris[t + 1] * sy, vz = tris[t + 2] * sz;
      if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
      if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
      if (vz < z0) z0 = vz; if (vz > z1) z1 = vz;
    }
    if (Math.max(x1 - x0, y1 - y0, z1 - z0) < BBOX_SMALL) {
      const out1 = Float32Array.from([
        (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
        Math.max(0.05, (x1 - x0) / 2), Math.max(0.05, (y1 - y0) / 2), Math.max(0.05, (z1 - z0) / 2),
        0, 0, 0, 1,
      ]);
      cache.set(key, out1);
      decomposed++;
      totalAssetBoxes += 1;
      if (STATS) assetStats.set(key, { path: p, slabs: 1, smallSq: 0, stamps: 0 });
      return out1;
    }
  }

  // Per-triangle plane data, scaled. Normal sign is canonicalised (largest
  // component positive) so a wall's two shells share a cluster.
  const T = tris.length / 9;
  const tn = new Float64Array(T * 3);   // unit normal
  const td = new Float64Array(T);       // plane offset n . centroid
  const ta = new Float64Array(T);       // area
  const tc = new Float64Array(T * 3);   // centroid
  let valid = 0;
  const order = [];
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    const ax = tris[o9] * sx, ay = tris[o9 + 1] * sy, az = tris[o9 + 2] * sz;
    const bx = tris[o9 + 3] * sx, by = tris[o9 + 4] * sy, bz = tris[o9 + 5] * sz;
    const cx = tris[o9 + 6] * sx, cy = tris[o9 + 7] * sy, cz = tris[o9 + 8] * sz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l2 = Math.hypot(nx, ny, nz);
    if (!(l2 > 1e-9)) continue;
    nx /= l2; ny /= l2; nz /= l2;
    const flip = (Math.abs(nx) >= Math.abs(ny) && Math.abs(nx) >= Math.abs(nz)) ? nx < 0
      : (Math.abs(ny) >= Math.abs(nz)) ? ny < 0 : nz < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    tn[t * 3] = nx; tn[t * 3 + 1] = ny; tn[t * 3 + 2] = nz;
    td[t] = nx * mx + ny * my + nz * mz;
    ta[t] = l2 * 0.5;
    tc[t * 3] = mx; tc[t * 3 + 1] = my; tc[t * 3 + 2] = mz;
    order.push(t);
    valid++;
  }
  if (!valid) { cache.set(key, null); noTris++; return null; }
  order.sort((a, b) => ta[b] - ta[a]);   // big triangles seed clusters

  // Running plane clusters: area-weighted normal + offset.
  const clusters = [];   // {nx,ny,nz, d, area, tris: []}
  for (const t of order) {
    const nx = tn[t * 3], ny = tn[t * 3 + 1], nz = tn[t * 3 + 2];
    let best = null;
    for (const c of clusters) {
      if (nx * c.nx + ny * c.ny + nz * c.nz < COS_NTOL) continue;
      // Offset against the CLUSTER plane, so a tilted triangle far along the
      // plane does not drift the test.
      const d = c.nx * tc[t * 3] + c.ny * tc[t * 3 + 1] + c.nz * tc[t * 3 + 2];
      if (Math.abs(d - c.d) > DTOL) continue;
      best = c; break;
    }
    if (!best) { clusters.push({ nx, ny, nz, d: td[t], area: ta[t], tris: [t] }); continue; }
    const w = best.area, w2 = ta[t];
    best.nx = (best.nx * w + nx * w2); best.ny = (best.ny * w + ny * w2); best.nz = (best.nz * w + nz * w2);
    const l = Math.hypot(best.nx, best.ny, best.nz) || 1;
    best.nx /= l; best.ny /= l; best.nz /= l;
    best.d = (best.d * w + (best.nx * tc[t * 3] + best.ny * tc[t * 3 + 1] + best.nz * tc[t * 3 + 2]) * w2) / (w + w2);
    best.area += w2;
    best.tris.push(t);
  }

  const slabs = [];   // {c:[3], h:[3], U, V, N, q, area} before aggregation
  for (const c of clusters) {
    // In-plane frame.
    const n2 = [c.nx, c.ny, c.nz];
    const ref = Math.abs(n2[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [
      n2[1] * ref[2] - n2[2] * ref[1],
      n2[2] * ref[0] - n2[0] * ref[2],
      n2[0] * ref[1] - n2[1] * ref[0],
    ];
    const e1l = Math.hypot(...e1); e1 = [e1[0] / e1l, e1[1] / e1l, e1[2] / e1l];
    const e2 = [
      n2[1] * e1[2] - n2[2] * e1[1],
      n2[2] * e1[0] - n2[0] * e1[2],
      n2[0] * e1[1] - n2[1] * e1[0],
    ];

    // 2D connectivity split over a coarse in-plane hash of triangle cells.
    const cellOf = new Map();   // "cx,cy" -> cell id
    const cellTris = [];        // cell id -> [tri...]
    const cellXY = [];
    for (const t of c.tris) {
      const px = tc[t * 3], py = tc[t * 3 + 1], pz = tc[t * 3 + 2];
      const cx = Math.floor((e1[0] * px + e1[1] * py + e1[2] * pz) / CELL2D);
      const cy = Math.floor((e2[0] * px + e2[1] * py + e2[2] * pz) / CELL2D);
      const k = `${cx},${cy}`;
      let id = cellOf.get(k);
      if (id === undefined) { id = cellTris.length; cellOf.set(k, id); cellTris.push([]); cellXY.push([cx, cy]); }
      cellTris[id].push(t);
    }
    const cellComp = new Int32Array(cellTris.length).fill(-1);
    let nComp = 0;
    for (let seed = 0; seed < cellTris.length; seed++) {
      if (cellComp[seed] !== -1) continue;
      const stack = [seed];
      cellComp[seed] = nComp;
      while (stack.length) {
        const id = stack.pop();
        const [cx, cy] = cellXY[id];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nid = cellOf.get(`${cx + dx},${cy + dy}`);
          if (nid !== undefined && cellComp[nid] === -1) { cellComp[nid] = nComp; stack.push(nid); }
        }
      }
      nComp++;
    }

    // One slab per connected patch: min-area rectangle over the patch's
    // projected VERTICES (convex hull + rotating calipers), thickness from
    // the offset spread.
    for (let comp = 0; comp < nComp; comp++) {
      const pts = [];   // projected vertices [x,y]
      let d0 = Infinity, d1 = -Infinity, area = 0;
      for (let id = 0; id < cellTris.length; id++) {
        if (cellComp[id] !== comp) continue;
        for (const t of cellTris[id]) {
          area += ta[t];
          const o9 = t * 9;
          for (let v = 0; v < 3; v++) {
            const px = tris[o9 + v * 3] * sx, py = tris[o9 + v * 3 + 1] * sy, pz = tris[o9 + v * 3 + 2] * sz;
            pts.push([e1[0] * px + e1[1] * py + e1[2] * pz, e2[0] * px + e2[1] * py + e2[2] * pz]);
            const d = n2[0] * px + n2[1] * py + n2[2] * pz;
            if (d < d0) d0 = d; if (d > d1) d1 = d;
          }
        }
      }
      if (area < MIN_AREA) { droppedSmallPatch++; continue; }

      // Convex hull (Andrew monotone chain).
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower = [];
      for (const pt of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
        lower.push(pt);
      }
      const upper = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        const pt = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
        upper.push(pt);
      }
      const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
      if (hull.length < 3) { droppedSmallPatch++; continue; }

      // Rotating calipers: the min-area rectangle has one side on a hull edge.
      let bestA = Infinity, bestFrame = null;
      for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length];
        const el = Math.hypot(x2 - x1, y2 - y1);
        if (el < 1e-9) continue;
        const ux = (x2 - x1) / el, uy = (y2 - y1) / el;
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const [hx, hy] of hull) {
          const pu = ux * hx + uy * hy, pv = -uy * hx + ux * hy;
          if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
          if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
        }
        const a = (u1 - u0) * (v1 - v0);
        if (a < bestA) { bestA = a; bestFrame = { ux, uy, u0, u1, v0, v1 }; }
      }
      if (!bestFrame) { droppedSmallPatch++; continue; }
      const { ux, uy, u0, u1, v0, v1 } = bestFrame;

      // Back to 3D: slab axes and centre.
      const U = [ux * e1[0] + uy * e2[0], ux * e1[1] + uy * e2[1], ux * e1[2] + uy * e2[2]];
      const V = [-uy * e1[0] + ux * e2[0], -uy * e1[1] + ux * e2[1], -uy * e1[2] + ux * e2[2]];
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, cn = (d0 + d1) / 2;
      const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
      const hn = Math.max((d1 - d0) / 2, MIN_THICK / 2);
      // The centre uses the cluster normal directly; the handedness flip
      // below only affects the quat's frame, never the geometry.
      const ccx = U[0] * cu + V[0] * cv + n2[0] * cn;
      const ccy = U[1] * cu + V[1] * cv + n2[1] * cn;
      const ccz = U[2] * cu + V[2] * cv + n2[2] * cn;
      // Right-handed check before Shepperd.
      const wx = U[1] * V[2] - U[2] * V[1], wy = U[2] * V[0] - U[0] * V[2], wz = U[0] * V[1] - U[1] * V[0];
      const N = (wx * n2[0] + wy * n2[1] + wz * n2[2] < 0) ? [-n2[0], -n2[1], -n2[2]] : n2;
      const q = matToQuat(U, V, N);
      slabs.push({ c: [ccx, ccy, ccz], h: [hu, hv, hn], U, V, N, q, area });
    }
  }

  // ── Aggregation, no grid ────────────────────────────────────────────────
  // Detail below AGG_SMALL is absorbed into a parent slab whose face it sits
  // on (one level deep: parents never fuse with parents, so union error has
  // nothing to compound through). Survivors that sit near each OTHER cluster
  // into one box oriented by their largest member. Isolated smalls stay.
  {
    const corners = s => {
      const out8 = [];
      for (let i = 0; i < 8; i++) {
        const su = i & 1 ? s.h[0] : -s.h[0], sv = i & 2 ? s.h[1] : -s.h[1], sn = i & 4 ? s.h[2] : -s.h[2];
        out8.push([
          s.c[0] + s.U[0] * su + s.V[0] * sv + s.N[0] * sn,
          s.c[1] + s.U[1] * su + s.V[1] * sv + s.N[1] * sn,
          s.c[2] + s.U[2] * su + s.V[2] * sv + s.N[2] * sn,
        ]);
      }
      return out8;
    };

    // Absorption: smalls ascending, parents descending, first fit wins.
    const byArea = slabs.map((s, i) => i).sort((a, b) => slabs[a].area - slabs[b].area);
    const dead = new Uint8Array(slabs.length);
    for (const si of byArea) {
      const s = slabs[si];
      if (s.area >= AGG_SMALL) break;
      const pts = corners(s);
      for (let pi = byArea.length - 1; pi >= 0; pi--) {
        const p = slabs[byArea[pi]];
        if (p === s || dead[byArea[pi]]) continue;
        if (p.area < s.area * AGG_RATIO) break;   // descending: none big enough remains
        let mu = 0, mv = 0, mn = 0, ok = true;
        for (const pt of pts) {
          const dx = pt[0] - p.c[0], dy = pt[1] - p.c[1], dz = pt[2] - p.c[2];
          const au = Math.abs(dx * p.U[0] + dy * p.U[1] + dz * p.U[2]);
          const av = Math.abs(dx * p.V[0] + dy * p.V[1] + dz * p.V[2]);
          const an = Math.abs(dx * p.N[0] + dy * p.N[1] + dz * p.N[2]);
          if (au > p.h[0] + AGG_D || av > p.h[1] + AGG_D || an > p.h[2] + AGG_D) { ok = false; break; }
          if (au > mu) mu = au; if (av > mv) mv = av; if (an > mn) mn = an;
        }
        if (!ok) continue;
        p.h[0] = Math.max(p.h[0], mu); p.h[1] = Math.max(p.h[1], mv); p.h[2] = Math.max(p.h[2], mn);
        dead[si] = 1; aggAbsorbed++;
        break;
      }
    }

    // Clustering: surviving smalls, union-find over expanded AABB overlap.
    const smallIdx = [];
    for (let i = 0; i < slabs.length; i++) if (!dead[i] && slabs[i].area < AGG_SMALL) smallIdx.push(i);
    const uf = new Int32Array(smallIdx.length).map((_, i) => i);
    const find = i => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
    const aabbs = smallIdx.map(i => {
      const s = slabs[i];
      const rx = Math.abs(s.U[0]) * s.h[0] + Math.abs(s.V[0]) * s.h[1] + Math.abs(s.N[0]) * s.h[2];
      const ry = Math.abs(s.U[1]) * s.h[0] + Math.abs(s.V[1]) * s.h[1] + Math.abs(s.N[1]) * s.h[2];
      const rz = Math.abs(s.U[2]) * s.h[0] + Math.abs(s.V[2]) * s.h[1] + Math.abs(s.N[2]) * s.h[2];
      const e = AGG_D / 2;
      return [s.c[0] - rx - e, s.c[0] + rx + e, s.c[1] - ry - e, s.c[1] + ry + e, s.c[2] - rz - e, s.c[2] + rz + e];
    });
    for (let a = 0; a < smallIdx.length; a++) for (let b = a + 1; b < smallIdx.length; b++) {
      const A = aabbs[a], B = aabbs[b];
      if (A[0] <= B[1] && B[0] <= A[1] && A[2] <= B[3] && B[2] <= A[3] && A[4] <= B[5] && B[4] <= A[5]) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) uf[ra] = rb;
      }
    }
    const groups = new Map();
    for (let a = 0; a < smallIdx.length; a++) {
      const r = find(a);
      let g = groups.get(r); if (!g) groups.set(r, g = []);
      g.push(smallIdx[a]);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      // One box in the largest member's frame; extents from every corner.
      const lead = slabs[g.reduce((m, i) => slabs[i].area > slabs[m].area ? i : m, g[0])];
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, n0 = Infinity, n1 = -Infinity;
      for (const i of g) {
        for (const pt of corners(slabs[i])) {
          const du = pt[0] * lead.U[0] + pt[1] * lead.U[1] + pt[2] * lead.U[2];
          const dv = pt[0] * lead.V[0] + pt[1] * lead.V[1] + pt[2] * lead.V[2];
          const dn = pt[0] * lead.N[0] + pt[1] * lead.N[1] + pt[2] * lead.N[2];
          if (du < u0) u0 = du; if (du > u1) u1 = du;
          if (dv < v0) v0 = dv; if (dv > v1) v1 = dv;
          if (dn < n0) n0 = dn; if (dn > n1) n1 = dn;
        }
        dead[i] = 1;
      }
      aggClustered += g.length; aggClusters++;
      const cu2 = (u0 + u1) / 2, cv2 = (v0 + v1) / 2, cn2 = (n0 + n1) / 2;
      slabs.push({
        c: [
          lead.U[0] * cu2 + lead.V[0] * cv2 + lead.N[0] * cn2,
          lead.U[1] * cu2 + lead.V[1] * cv2 + lead.N[1] * cn2,
          lead.U[2] * cu2 + lead.V[2] * cv2 + lead.N[2] * cn2,
        ],
        h: [(u1 - u0) / 2, (v1 - v0) / 2, (n1 - n0) / 2],
        U: lead.U, V: lead.V, N: lead.N, q: lead.q,
        area: (u1 - u0) * (v1 - v0),
      });
    }

    var boxes = [];
    for (let i = 0; i < slabs.length; i++) {
      if (i < dead.length && dead[i]) continue;
      const s = slabs[i];
      boxes.push(s.c[0], s.c[1], s.c[2], s.h[0], s.h[1], s.h[2], s.q[0], s.q[1], s.q[2], s.q[3]);
    }
  }

  const out = boxes.length ? Float32Array.from(boxes) : null;
  cache.set(key, out);
  decomposed++;
  totalAssetBoxes += boxes.length / 10;
  if (STATS) {
    let smallSq = 0;
    for (let k = 0; k < boxes.length; k += 10) {
      const hu = boxes[k + 3], hv = boxes[k + 4];
      if (Math.min(hu, hv) / Math.max(hu, hv) > 0.6 && Math.max(hu, hv) < 1.25) smallSq++;
    }
    assetStats.set(key, { path: p, slabs: boxes.length / 10, smallSq, stamps: 0 });
  }
  return out;
}

// ── Stamp placements (identical to asset_boxes.js) ────────────────────────
const out = [];
let stamped = 0, bboxFallback = 0;

function emitPlacement(i) {
  const o = i * S;
  const local = decompose(box[o + 10], box[o + 16], box[o + 17], box[o + 18]);
  if (STATS && local) {
    const sk = `${box[o + 10]}|${box[o + 16].toFixed(2)},${box[o + 17].toFixed(2)},${box[o + 18].toFixed(2)}`;
    const st = assetStats.get(sk);
    if (st) st.stamps++;
  }
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  if (!local) {
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
    const q = quatMul(pq, [local[k + 6], local[k + 7], local[k + 8], local[k + 9]]);
    out.push({
      c: [
        px + m[0] * lx + m[1] * ly + m[2] * lz,
        py + m[3] * lx + m[4] * ly + m[5] * lz,
        pz + m[6] * lx + m[7] * ly + m[8] * lz,
      ],
      h: [local[k + 3], local[k + 4], local[k + 5]],
      q,
    });
  }
  stamped++;
}

for (const i of builders) emitPlacement(i);
console.log(`  decomposed ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local slabs ` +
            `(${noTris.toLocaleString()} assets with no triangles, ${droppedSmallPatch.toLocaleString()} patches under ${MIN_AREA} m^2 dropped)`);
console.log(`  aggregate ${aggAbsorbed.toLocaleString()} details absorbed into parent faces; ` +
            `${aggClustered.toLocaleString()} smalls -> ${aggClusters.toLocaleString()} cluster boxes`);
console.log(`  stamped   ${stamped.toLocaleString()} placements -> ${out.length.toLocaleString()} slabs (${bboxFallback.toLocaleString()} bbox fallbacks)`);

// ── Terrain clip ──────────────────────────────────────────────────────────
const kept = [];
let buried = 0;
for (const b of out) {
  const g = heightAtCet(terrain, b.c[0], b.c[1]);
  if (g !== null && b.c[2] + b.h[2] <= g - BELOW) { buried++; continue; }
  kept.push(b);
}
console.log(`  terrain   ${buried.toLocaleString()} buried slabs cut`);

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

// ── --stats: top contributors of small near-square slabs ──────────────────
if (STATS) {
  const rows = [...assetStats.values()]
    .map(s => ({ ...s, total: s.smallSq * s.stamps }))
    .filter(s => s.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 25);
  console.log('\n  TOP small-square contributors (smallSq/asset x stamps = total):');
  for (const s of rows) {
    console.log(`    ${String(s.total).padStart(8)}  ${s.smallSq}x${s.stamps}  (${s.slabs}/asset)  ${s.path}`);
  }
}

// ── Shape stats + write ───────────────────────────────────────────────────
{
  const dims = kept.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  console.log(`  shape     median largest dim ${med.toFixed(1)} m`);
}
console.log(`  BOXES     ${kept.length.toLocaleString()} after surface decomposition (0 axis + ${kept.length.toLocaleString()} oriented)`);

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
  district: name, bounds: meta.bounds, generator: 'assetplanes',
  ntol: NTOL, dtol: DTOL, minArea: MIN_AREA, minThick: MIN_THICK, cell2d: CELL2D,
  lod: LOD, minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW,
  decomposed, noTris, droppedSmallPatch, stamped, bboxFallback, buried, proxyUsed, proxyCovered,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin (generator assetplanes; encode with --outdir planes)`);
