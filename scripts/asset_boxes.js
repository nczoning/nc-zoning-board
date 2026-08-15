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
const OBB_TIGHT = flag('obbtight', 2.75); // accept an oriented component when obb volume <= this x cell volume
const OBB_MIN  = flag('obbmin', 8);   // cells: components smaller than this stay on the grid
const OBB_GAIN = flag('obbgain', 0.7); // obb volume must also be <= this x the component's own aabb volume:
                                       // flat slabs have DEGENERATE eigenvalue pairs, so PCA's in-plane axes
                                       // are noise (one stray corner cell = 42 deg) and pass the tightness
                                       // gate at ~2x; a rotation only ships when it beats the aabb outright

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

// Eigenvectors of a symmetric 3x3 (cyclic Jacobi). Returns three orthonormal
// column vectors; the covariance of a solid box is diagonal in the box's own
// frame, so these are the component's natural axes.
function jacobiEigen(a00, a01, a02, a11, a12, a22) {
  const A = [a00, a01, a02, a01, a11, a12, a02, a12, a22];
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-12) continue;
      const app = A[p * 3 + p], aqq = A[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p], akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq;
        A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k], aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk;
        A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq;
        V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return [
    [V[0], V[3], V[6]],
    [V[1], V[4], V[7]],
    [V[2], V[5], V[8]],
  ];
}

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
let obbFitted = 0, obbLoose = 0, obbAxis = 0;

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
  let res = RES;
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

  // Oriented-at-source: angled shapes INSIDE one mesh (vault ribs, beams,
  // ramps) step on this axis-aligned grid. Label connected solid components;
  // PCA over each component's cell centres proposes a frame, and when the
  // oriented bounding box is TIGHT the whole component becomes ONE rotated
  // box and releases its cells. Loose, small or axis-aligned components fall
  // through to the grid merge unchanged.
  const boxes = [];   // stride 10: c3, h3, q4 (identity quat for grid boxes)
  {
    const cellVol = res * res * res;
    let comp = new Int32Array(1 << 12);
    let stack = new Int32Array(1 << 12);
    let sp = 0;
    const push3 = k => {
      if (lg[k] !== 1) return;
      lg[k] = 3;
      if (sp === stack.length) { const b = new Int32Array(stack.length * 2); b.set(stack); stack = b; }
      stack[sp++] = k;
    };
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (lg[li(x, y, z)] !== 1) continue;
      let cn = 0;
      sp = 0; push3(li(x, y, z));
      while (sp > 0) {
        const k = stack[--sp];
        if (cn === comp.length) { const b = new Int32Array(comp.length * 2); b.set(comp); comp = b; }
        comp[cn++] = k;
        const cx = k % nx, cy = ((k / nx) | 0) % ny, cz = (k / (nx * ny)) | 0;
        if (cx > 0) push3(k - 1);
        if (cx < nx - 1) push3(k + 1);
        if (cy > 0) push3(k - nx);
        if (cy < ny - 1) push3(k + nx);
        if (cz > 0) push3(k - nx * ny);
        if (cz < nz - 1) push3(k + nx * ny);
      }
      if (cn < OBB_MIN) continue;
      // PCA over cell centres (cell units: uniform scale, same eigenvectors),
      // plus the component's own axis-aligned bounds for the gain gate.
      let sx1 = 0, sy1 = 0, sz1 = 0;
      let ax0 = Infinity, ax1 = -Infinity, ay0 = Infinity, ay1 = -Infinity, az0 = Infinity, az1 = -Infinity;
      for (let i = 0; i < cn; i++) {
        const k = comp[i];
        const px = k % nx, py = ((k / nx) | 0) % ny, pz = (k / (nx * ny)) | 0;
        sx1 += px; sy1 += py; sz1 += pz;
        if (px < ax0) ax0 = px; if (px > ax1) ax1 = px;
        if (py < ay0) ay0 = py; if (py > ay1) ay1 = py;
        if (pz < az0) az0 = pz; if (pz > az1) az1 = pz;
      }
      const aabbVol = (ax1 - ax0 + 1) * (ay1 - ay0 + 1) * (az1 - az0 + 1) * cellVol;
      const mx = sx1 / cn, my = sy1 / cn, mz = sz1 / cn;
      let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
      for (let i = 0; i < cn; i++) {
        const k = comp[i];
        const dx = (k % nx) - mx, dy = (((k / nx) | 0) % ny) - my, dz = ((k / (nx * ny)) | 0) - mz;
        c00 += dx * dx; c01 += dx * dy; c02 += dx * dz;
        c11 += dy * dy; c12 += dy * dz; c22 += dz * dz;
      }
      const [u, v, n2] = jacobiEigen(c00 / cn, c01 / cn, c02 / cn, c11 / cn, c12 / cn, c22 / cn);
      // Near-axis-aligned frames stay on the grid: the exact merge is already
      // exact there, and a noise rotation of a straight wall reads as jitter.
      if (Math.max(Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])) > 0.999 &&
          Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) > 0.999 &&
          Math.max(Math.abs(n2[0]), Math.abs(n2[1]), Math.abs(n2[2])) > 0.999) { obbAxis++; continue; }
      // Right-handed basis (a mirrored frame makes matToQuat return garbage).
      const wx = u[1] * v[2] - u[2] * v[1], wy = u[2] * v[0] - u[0] * v[2], wz = u[0] * v[1] - u[1] * v[0];
      if (wx * n2[0] + wy * n2[1] + wz * n2[2] < 0) { n2[0] = -n2[0]; n2[1] = -n2[1]; n2[2] = -n2[2]; }
      // Project cell centres (local metres) onto the axes; pad each extent by
      // that axis' support of an axis-aligned cell cube (exact for corners).
      let l0 = Infinity, h0 = -Infinity, l1 = Infinity, h1 = -Infinity, l2 = Infinity, h2 = -Infinity;
      for (let i = 0; i < cn; i++) {
        const k = comp[i];
        const px = gx0 + ((k % nx) + 0.5) * res;
        const py = gy0 + ((((k / nx) | 0) % ny) + 0.5) * res;
        const pz = gz0 + (((k / (nx * ny)) | 0) + 0.5) * res;
        const t0 = u[0] * px + u[1] * py + u[2] * pz;
        const t1 = v[0] * px + v[1] * py + v[2] * pz;
        const t2 = n2[0] * px + n2[1] * py + n2[2] * pz;
        if (t0 < l0) l0 = t0; if (t0 > h0) h0 = t0;
        if (t1 < l1) l1 = t1; if (t1 > h1) h1 = t1;
        if (t2 < l2) l2 = t2; if (t2 > h2) h2 = t2;
      }
      const pad0 = 0.5 * res * (Math.abs(u[0]) + Math.abs(u[1]) + Math.abs(u[2]));
      const pad1 = 0.5 * res * (Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]));
      const pad2 = 0.5 * res * (Math.abs(n2[0]) + Math.abs(n2[1]) + Math.abs(n2[2]));
      const e0 = (h0 - l0) / 2 + pad0, e1 = (h1 - l1) / 2 + pad1, e2 = (h2 - l2) / 2 + pad2;
      const volObb = 8 * e0 * e1 * e2;
      if (volObb > OBB_TIGHT * cn * cellVol || volObb > OBB_GAIN * aabbVol) { obbLoose++; continue; }
      const f0 = (l0 + h0) / 2, f1 = (l1 + h1) / 2, f2 = (l2 + h2) / 2;
      const q = matToQuat(u, v, n2);
      boxes.push(
        u[0] * f0 + v[0] * f1 + n2[0] * f2,
        u[1] * f0 + v[1] * f1 + n2[1] * f2,
        u[2] * f0 + v[2] * f1 + n2[2] * f2,
        e0, e1, e2, q[0], q[1], q[2], q[3],
      );
      obbFitted++;
      for (let i = 0; i < cn; i++) lg[comp[i]] = 0;
    }
    // Components that stayed on the grid go back to 1 for the merge.
    for (let k = 0, ln = nx * ny * nz; k < ln; k++) if (lg[k] === 3) lg[k] = 1;
  }

  // Greedy merge (exact cover), same growth rules as the hull's mergeGrid.
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
        0, 0, 0, 1,
      );
    }
  }
  const out = boxes.length ? Float32Array.from(boxes) : null;
  cache.set(key, out);
  decomposed++;
  totalAssetBoxes += boxes.length / 10;
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
  const pq = [qx, qy, qz, qw];
  const px = box[o + 13], py = box[o + 14], pz = box[o + 15];
  for (let k = 0; k < local.length; k += 10) {
    const lx = local[k], ly = local[k + 1], lz = local[k + 2];
    // Oriented local boxes compose their frame with the placement's
    // (placement applied last); identity local quats keep the fast path.
    const q = (local[k + 6] === 0 && local[k + 7] === 0 && local[k + 8] === 0)
      ? pq
      : quatMul(pq, [local[k + 6], local[k + 7], local[k + 8], local[k + 9]]);
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
console.log(`  decomposed ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local boxes ` +
            `(${noTris.toLocaleString()} assets with no triangles)`);
console.log(`  oriented  ${obbFitted.toLocaleString()} components fitted at source ` +
            `(${obbLoose.toLocaleString()} loose, ${obbAxis.toLocaleString()} axis-aligned stayed on grid)`);
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
  obbTight: OBB_TIGHT, obbMin: OBB_MIN, obbGain: OBB_GAIN, obbFitted, obbLoose, obbAxis,
  decomposed, noTris, stamped, bboxFallback, buried, proxyUsed, proxyCovered,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin`);
