#!/usr/bin/env node
/**
 * asset_boxes.js: stage 2 by per-ASSET decomposition. A mesh's triangles
 * form shapes, mostly flat; each unique mesh becomes a handful of boxes that
 * trace those shapes, and placements stamp the boxes out.
 *
 * Every unique mesh is voxelised ONCE, in its own local frame, at a fine
 * resolution; solidified (outside flood + vertical blind close, the same
 * priors the rotated path uses); greedy-merged into a few boxes; cached per
 * (asset, scale). Placements then stamp the cached boxes out under their own
 * transform. The city is a kit, so ~33k decompositions cover millions of
 * placements, and every box inherits its placement's EXACT rotation: no
 * world grid exists, so nothing can step.
 *
 * What this trades away, knowingly: cross-placement solidity. The world grid
 * fills courtyards and seals buildings whose enclosure comes from NEIGHBOUR
 * placements (glass curtain walls over separate floor plates); a per-asset
 * grid can only close what one asset encloses. Whether that shows on screen
 * is the question this prototype exists to answer.
 *
 * Triangles come from the game's own LOD2 (fallback finer): at box scale,
 * LOD0's extra detail is slivers and trim that cost cells and add noise.
 *
 * Usage: node scripts/asset_boxes.js pacifica [--res 0.75] [--minsize 0.3]
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

const RES      = flag('res', 0.75);   // mesh-local cell, metres
const LOD      = flag('lod', 2);      // LOD mask asked of meshTriangles
const MIN_SIZE = flag('minsize', 0.3);
const MAX_SIZE = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW    = flag('below', 16);
const GAP      = flag('gap', 5);      // cells: vertical blind close inside one asset
const MAX_CELLS = 24e6;               // per-asset grid budget; res coarsens to fit

if (!name) { console.error('usage: node scripts/asset_boxes.js <district>'); process.exit(1); }

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

console.log(`district ${name}`);

// ── Classify placements ───────────────────────────────────────────────────
const builders = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0;
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const cat = categorize(PATHS[box[o + 10]] || '', TYPE[box[o + 11]] || '');
  // Infrastructure ships too (bridge structure, pillars, barriers): same
  // policy as the voxel hull since the incomplete-bridge report.
  if (cat !== 'building' && cat !== 'proxy' && cat !== 'infrastructure') { skippedNever++; continue; }
  if (largest > MAX_SIZE) { skippedHuge++; continue; }
  if (cat === 'proxy') {
    if (largest > PROXY_MAX) { skippedProxy++; continue; }
    proxies.push(i);
  } else builders.push(i);
}
console.log(`  input     ${builders.length.toLocaleString()} placements + ${proxies.length.toLocaleString()} proxies held back`);
console.log(`  skipped   ${skippedSmall.toLocaleString()} small, ${skippedHuge.toLocaleString()} huge, ${skippedNever.toLocaleString()} never, ${skippedProxy.toLocaleString()} area proxies`);

// ── Per-asset decomposition, cached ───────────────────────────────────────
// Key: assetId | quantised scale. Value: { boxes: [cx,cy,cz,hx,hy,hz,...] }
// in mesh-local metres, or null when the mesh has no triangles.
const cache = new Map();
let decomposed = 0, noTris = 0, totalAssetBoxes = 0;

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

  // Scaled local bounds.
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let t = 0; t < tris.length; t += 3) {
    const vx = tris[t] * sx, vy = tris[t + 1] * sy, vz = tris[t + 2] * sz;
    if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
    if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
    if (vz < z0) z0 = vz; if (vz > z1) z1 = vz;
  }
  // Resolution scales with the asset: at map distance a 3 m prop IS its
  // bounding box, and paying eight boxes for a bin lid is where a fifth of
  // the city's box count went. Bigger assets keep ~24 cells across their
  // longest dimension, so towers keep their shape.
  const extent = Math.max(x1 - x0, y1 - y0, z1 - z0);
  if (extent < 4) {
    const out1 = Float32Array.from([
      (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
      Math.max(0.05, (x1 - x0) / 2), Math.max(0.05, (y1 - y0) / 2), Math.max(0.05, (z1 - z0) / 2),
    ]);
    cache.set(key, out1);
    decomposed++;
    totalAssetBoxes += 1;
    return out1;
  }
  let res = Math.max(RES, Math.min(2.5, extent / 24));
  let nx, ny, nz;
  for (;;) {
    nx = Math.max(1, Math.ceil((x1 - x0) / res) + 2);
    ny = Math.max(1, Math.ceil((y1 - y0) / res) + 2);
    nz = Math.max(1, Math.ceil((z1 - z0) / res) + 2);
    if (nx * ny * nz <= MAX_CELLS) break;
    res *= 1.5;
  }
  const gx0 = x0 - res, gy0 = y0 - res, gz0 = z0 - res;
  const lg = new Uint8Array(nx * ny * nz);
  const li = (x, y, z) => (z * ny + y) * nx + x;

  // Rasterise triangles on a barycentric lattice at half a cell.
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t] * sx, ay = tris[t + 1] * sy, az = tris[t + 2] * sz;
    const bx = tris[t + 3] * sx, by = tris[t + 4] * sy, bz = tris[t + 5] * sz;
    const cx = tris[t + 6] * sx, cy = tris[t + 7] * sy, cz = tris[t + 8] * sz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nnx = uy * vz - uz * vy, nny = uz * vx - ux * vz, nnz = ux * vy - uy * vx;
    const area = 0.5 * Math.hypot(nnx, nny, nnz);
    if (!(area > 0)) continue;
    let n = Math.ceil(Math.sqrt(area) / (res * 0.5)) + 1;
    if (n > 512) n = 512;
    for (let a = 0; a <= n; a++) for (let b = 0; a + b <= n; b++) {
      const s = a / n, t2 = b / n;
      const gx = ((ax + ux * s + vx * t2 - gx0) / res) | 0;
      const gy = ((ay + uy * s + vy * t2 - gy0) / res) | 0;
      const gz = ((az + uz * s + vz * t2 - gz0) / res) | 0;
      if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) continue;
      lg[li(gx, gy, gz)] = 1;
    }
  }

  // Solidify: flood the outside from every face except the bottom (buildings
  // have no floor mesh), then close vertical blinds up to GAP cells.
  {
    const ln = nx * ny * nz;
    let stack = new Int32Array(1 << 14), sp = 0;
    const push = k => {
      if (lg[k] !== 0) return;
      lg[k] = 2;
      if (sp === stack.length) { const b = new Int32Array(stack.length * 2); b.set(stack); stack = b; }
      stack[sp++] = k;
    };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(li(0, y, z)); push(li(nx - 1, y, z)); }
    for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(li(x, 0, z)); push(li(x, ny - 1, z)); }
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) push(li(x, y, nz - 1));
    while (sp > 0) {
      const k = stack[--sp];
      const x = k % nx, y = ((k / nx) | 0) % ny, z = (k / (nx * ny)) | 0;
      if (x > 0) push(k - 1);
      if (x < nx - 1) push(k + 1);
      if (y > 0) push(k - nx);
      if (y < ny - 1) push(k + nx);
      if (z > 0) push(k - nx * ny);
      if (z < nz - 1) push(k + nx * ny);
    }
    for (let k = 0; k < ln; k++) { if (lg[k] === 2) lg[k] = 0; else if (lg[k] === 0) lg[k] = 1; }
    if (GAP > 0) {
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        let last = -1;
        for (let z = 0; z < nz; z++) {
          if (!lg[li(x, y, z)]) continue;
          if (last >= 0 && z - last > 1 && z - last - 1 <= GAP) {
            for (let f = last + 1; f < z; f++) lg[li(x, y, f)] = 1;
          }
          last = z;
        }
      }
    }
  }

  // Greedy merge (exact cover), same growth rules as the hull's mergeGrid.
  const boxes = [];
  {
    const CLAIMED = 4;
    const census = (x0c, x1c, y0c, y1c, z0c, z1c) => {
      let s = 0;
      for (let c = z0c; c <= z1c; c++) for (let b = y0c; b <= y1c; b++) for (let a = x0c; a <= x1c; a++) {
        const v = lg[li(a, b, c)];
        if (v === CLAIMED) return -1;
        if (v === 1) s++;
      }
      return s;
    };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (lg[li(x, y, z)] !== 1) continue;
      let ex = x, ey = y, ez = z, grew = true;
      while (grew) {
        grew = false;
        if (ex + 1 < nx) {
          const s = census(ex + 1, ex + 1, y, ey, z, ez);
          if (s > 0 && s === (ey - y + 1) * (ez - z + 1)) { ex++; grew = true; }
        }
        if (ey + 1 < ny) {
          const s = census(x, ex, ey + 1, ey + 1, z, ez);
          if (s > 0 && s === (ex - x + 1) * (ez - z + 1)) { ey++; grew = true; }
        }
        if (ez + 1 < nz) {
          const s = census(x, ex, y, ey, ez + 1, ez + 1);
          if (s > 0 && s === (ex - x + 1) * (ey - y + 1)) { ez++; grew = true; }
        }
      }
      for (let c = z; c <= ez; c++) for (let b = y; b <= ey; b++) for (let a = x; a <= ex; a++) {
        if (lg[li(a, b, c)] === 1) lg[li(a, b, c)] = CLAIMED;
      }
      boxes.push(
        gx0 + (x + ex + 1) * 0.5 * res, gy0 + (y + ey + 1) * 0.5 * res, gz0 + (z + ez + 1) * 0.5 * res,
        (ex - x + 1) * res * 0.5, (ey - y + 1) * res * 0.5, (ez - z + 1) * res * 0.5,
      );
    }
  }
  const out = boxes.length ? Float32Array.from(boxes) : null;
  cache.set(key, out);
  decomposed++;
  totalAssetBoxes += boxes.length / 6;
  return out;
}

// ── Stamp placements ──────────────────────────────────────────────────────
const out = [];
let stamped = 0, bboxFallback = 0;

function emitPlacement(i) {
  const o = i * S;
  const local = decompose(box[o + 10], box[o + 16], box[o + 17], box[o + 18]);
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  if (!local) {
    // No triangles: the placement's own oriented box stands in.
    out.push({
      c: [box[o], box[o + 1], box[o + 2]],
      h: [box[o + 3], box[o + 4], box[o + 5]],
      q: [qx, qy, qz, qw],
    });
    bboxFallback++;
    return;
  }
  const m = quatToMat(qx, qy, qz, qw);
  const px = box[o + 13], py = box[o + 14], pz = box[o + 15];
  for (let k = 0; k < local.length; k += 6) {
    const lx = local[k], ly = local[k + 1], lz = local[k + 2];
    out.push({
      c: [
        px + m[0] * lx + m[1] * ly + m[2] * lz,
        py + m[3] * lx + m[4] * ly + m[5] * lz,
        pz + m[6] * lx + m[7] * ly + m[8] * lz,
      ],
      h: [local[k + 3], local[k + 4], local[k + 5]],
      q: [qx, qy, qz, qw],
    });
  }
  stamped++;
}

for (const i of builders) emitPlacement(i);
console.log(`  decomposed ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local boxes ` +
            `(${noTris.toLocaleString()} assets with no triangles)`);
console.log(`  stamped   ${stamped.toLocaleString()} placements -> ${out.length.toLocaleString()} boxes (${bboxFallback.toLocaleString()} bbox fallbacks)`);

// ── Terrain clip ──────────────────────────────────────────────────────────
const kept = [];
let buried = 0;
for (const b of out) {
  const g = heightAtCet(terrain, b.c[0], b.c[1]);
  if (g !== null && b.c[2] + b.h[2] <= g - BELOW) { buried++; continue; }
  kept.push(b);
}
console.log(`  terrain   ${buried.toLocaleString()} buried boxes cut`);

// ── Proxies where uncovered (hash probe, as raw_hull) ─────────────────────
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

// ── World-space merge: contained boxes drop, runs fuse ────────────────────
// The count problem is kit redundancy, not detail: interpenetrating pieces
// stamp boxes inside other boxes, and a wall is twenty identical panels in a
// row, each carrying the same yaw. Boxes are bucketed by yaw, rotated into
// the shared frame (where they are axis-aligned by construction), then:
//   1. a box fully inside another is dropped;
//   2. boxes whose cross-sections match within EPS and that touch or overlap
//      along the remaining axis fuse into one.
// No grid exists at any point: fused faces sit exactly where the kit put
// them. Tilted boxes (non-yaw rotations) pass through untouched.
const MERGE_EPS = flag('mergeeps', 0.12);   // m: faces this close count as aligned
const MERGE_GAP = flag('mergegap', 0.05);   // m: panels this far apart still fuse
const MERGE_SWALLOW = flag('mergeswallow', 0.9);  // fraction inside a bigger box = redundant
const MERGE_ROUNDS = flag('mergerounds', 3);
const doMerge = !args.includes('--nomerge');
let droppedContained = 0, fusedRuns = 0;
if (doMerge) {
  const passthrough = [];
  const buckets = new Map();
  for (const b of kept) {
    if (Math.abs(b.q[0]) > 0.01 || Math.abs(b.q[1]) > 0.01) { passthrough.push(b); continue; }
    const yaw = Math.atan2(2 * (b.q[3] * b.q[2]), 1 - 2 * (b.q[2] * b.q[2]));
    const key = Math.round(yaw * 1800 / Math.PI);   // 0.1 degree buckets
    let l = buckets.get(key); if (!l) buckets.set(key, l = []);
    l.push(b);
  }

  const merged = [];
  for (const [key, list] of buckets) {
    const yaw = key * Math.PI / 1800;
    const ca = Math.cos(yaw), sa = Math.sin(yaw);
    // Into the frame: axis-aligned intervals.
    let items = list.map(b => {
      const fx = ca * b.c[0] + sa * b.c[1];
      const fy = -sa * b.c[0] + ca * b.c[1];
      return {
        x0: fx - b.h[0], x1: fx + b.h[0],
        y0: fy - b.h[1], y1: fy + b.h[1],
        z0: b.c[2] - b.h[2], z1: b.c[2] + b.h[2],
      };
    });

    // Containment: a box at least MERGE_SWALLOW inside a bigger one is
    // redundant mass. Slightly over-covering the difference is the trade
    // CDPR's own cloud makes everywhere. Interleaved with fusion below,
    // because fused boxes swallow more.
    const dropContained = () => {
      const H = 24, hh = new Map();
      items.forEach((b, i) => {
        for (let cx = Math.floor(b.x0 / H); cx <= Math.floor(b.x1 / H); cx++)
          for (let cy = Math.floor(b.y0 / H); cy <= Math.floor(b.y1 / H); cy++) {
            const k = `${cx},${cy}`;
            let l = hh.get(k); if (!l) hh.set(k, l = []);
            l.push(i);
          }
      });
      const dead = new Uint8Array(items.length);
      items.forEach((b, i) => {
        if (dead[i]) return;
        const vol = (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);
        if (!(vol > 0)) { dead[i] = 1; droppedContained++; return; }
        const k = `${Math.floor((b.x0 + b.x1) / 2 / H)},${Math.floor((b.y0 + b.y1) / 2 / H)}`;
        for (const j of hh.get(k) || []) {
          if (j === i || dead[j]) continue;
          const o = items[j];
          const oVol = (o.x1 - o.x0) * (o.y1 - o.y0) * (o.z1 - o.z0);
          if (oVol <= vol) continue;
          const ix = Math.min(b.x1, o.x1) - Math.max(b.x0, o.x0);
          const iy = Math.min(b.y1, o.y1) - Math.max(b.y0, o.y0);
          const iz = Math.min(b.z1, o.z1) - Math.max(b.z0, o.z0);
          if (ix > 0 && iy > 0 && iz > 0 && (ix * iy * iz) / vol >= MERGE_SWALLOW) {
            dead[i] = 1; droppedContained++; break;
          }
        }
      });
      items = items.filter((_, i) => !dead[i]);
    };

    // Run fusion, one axis at a time; fusing along x aligns cross-sections
    // for a later fuse along y, so rounds interleave with containment.
    const qk = v => Math.round(v / MERGE_EPS);
    dropContained();
    for (let round = 0; round < MERGE_ROUNDS; round++) {
      for (const axis of ['x', 'y', 'z']) {
        const [a0, a1, b0, b1, c0, c1] = axis === 'x' ? ['x0', 'x1', 'y0', 'y1', 'z0', 'z1']
          : axis === 'y' ? ['y0', 'y1', 'x0', 'x1', 'z0', 'z1'] : ['z0', 'z1', 'x0', 'x1', 'y0', 'y1'];
        const groups = new Map();
        for (const it of items) {
          const k = `${qk(it[b0])},${qk(it[b1])},${qk(it[c0])},${qk(it[c1])}`;
          let l = groups.get(k); if (!l) groups.set(k, l = []);
          l.push(it);
        }
        const next = [];
        for (const l of groups.values()) {
          l.sort((p, q) => p[a0] - q[a0]);
          let cur = l[0];
          for (let i = 1; i < l.length; i++) {
            const it = l[i];
            if (it[a0] <= cur[a1] + MERGE_GAP) {
              if (it[a1] > cur[a1]) cur[a1] = it[a1];
              fusedRuns++;
            } else { next.push(cur); cur = it; }
          }
          next.push(cur);
        }
        items = next;
      }
      dropContained();
    }

    // Back to world.
    const qz = Math.sin(yaw / 2), qw = Math.cos(yaw / 2);
    for (const it of items) {
      const fx = (it.x0 + it.x1) / 2, fy = (it.y0 + it.y1) / 2;
      merged.push({
        c: [ca * fx - sa * fy, sa * fx + ca * fy, (it.z0 + it.z1) / 2],
        h: [(it.x1 - it.x0) / 2, (it.y1 - it.y0) / 2, (it.z1 - it.z0) / 2],
        q: key === 0 ? [0, 0, 0, 1] : [0, 0, qz, qw],
      });
    }
  }
  for (const b of passthrough) merged.push(b);
  console.log(`  merge     ${kept.length.toLocaleString()} -> ${merged.length.toLocaleString()} boxes ` +
              `(${droppedContained.toLocaleString()} contained dropped, ${fusedRuns.toLocaleString()} run fusions)`);
  kept.length = 0;
  for (const b of merged) kept.push(b);
}

// ── Shape stats + write ───────────────────────────────────────────────────
{
  const dims = kept.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  console.log(`  shape     median largest dim ${med.toFixed(1)} m`);
}
console.log(`  BOXES     ${kept.length.toLocaleString()} after per-asset decomposition (0 axis + ${kept.length.toLocaleString()} oriented)`);

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
  district: name, bounds: meta.bounds, generator: 'assetboxes',
  res: RES, lod: LOD, gap: GAP, minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW,
  decomposed, noTris, stamped, bboxFallback, buried, proxyUsed, proxyCovered,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin`);
