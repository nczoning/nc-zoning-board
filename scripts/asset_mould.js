#!/usr/bin/env node
/**
 * asset_mould.js: stage 2 by taking a cast of the mesh.
 *
 * Every earlier generator guessed at one missing fact: which part of a box is
 * SOLID. asset_boxes.js voted per cell, asset_carve.js voted by triangle
 * facing and then tested how much of a cell's skin was real mesh,
 * asset_fit.js measured silhouette coverage, and CoACD's own preprocessing
 * tried to make open shells watertight (34 s for a 14-triangle wall, and a
 * worse answer for it). All four are proxies for the same fact.
 *
 * A mould answers it instead of approximating it. Fill the box with voxels,
 * flood the air in from the outside, invert: what the air could not reach is
 * solid. A hollow shell becomes the solid it stands for, so a wall is one
 * block; a lattice stays genuinely hollow between its beams, so its members
 * come out as members. No vote, no skin test, no silhouette, no threshold on
 * any of them.
 *
 * Boxes are grown greedily through the solid, in the COMPONENT'S OWN frame
 * rather than the world's, so a slanted beam casts one slanted box instead of
 * a staircase: the mould supplies solidity, the geometry still supplies
 * orientation.
 *
 * Two shape parameters: --budget (voxels per component) and --minbox.
 *
 * Usage: node scripts/asset_mould.js <district> [--asset <substring>]
 * Then:  node scripts/cull_hidden.js <district>
 *        node scripts/encode_hull_dds.js <district> --outdir mould
 * View:  ?assets=mould&only=<district>
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

const ASSET = strFlag('asset');

// ── The two shape parameters ──────────────────────────────────────────────
const BUDGET  = flag('budget', 120000); // voxels a component's mould may use
// metres: a box thinner than this is not drawn. It must not exceed MIN_VOXEL,
// or a mesh thinner than one voxel loses every box it has: a 0.10 m wall casts
// 0.10 m boxes, and a 0.15 m floor deletes the wall entirely.
const MIN_BOX = flag('minbox', 0.1);

// ── Pipeline parameters, identical in meaning to the siblings' ────────────
const LOD       = flag('lod', 2);
const MIN_SIZE  = flag('minsize', 0.3);
const MAX_SIZE  = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW     = flag('below', 16);
const BBOX_SMALL = flag('bboxsmall', 4);
const MIN_VOXEL = flag('minvoxel', 0.1);  // metres: floor on voxel size, so a big mesh stays affordable

if (!name) { console.error('usage: node scripts/asset_mould.js <district> [--asset <substring>]'); process.exit(1); }

const dataDir = path.join(__dirname, '..', 'data');
const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
const S = meta.stride, TYPE = meta.types || {}, PATHS = meta.assetPaths || {};

// ── Vector and quaternion helpers ─────────────────────────────────────────
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
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
const quatMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
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

function eigen3(m) {
  const a = [m[0].slice(), m[1].slice(), m[2].slice()];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i][j] * a[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[y][y] - a[x][x]);
  return order.map(k => norm3([v[0][k], v[1][k], v[2][k]]));
}

// ── The mould ─────────────────────────────────────────────────────────────
const stats = { components: 0, voxels: 0, solid: 0, boxes: 0, floors: 0 };

function mouldMesh(tris, sx, sy, sz, verbose) {
  const T = tris.length / 9;
  if (!T) return null;

  const tv = new Float64Array(T * 9);
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    for (let v = 0; v < 9; v += 3) {
      tv[o9 + v] = tris[o9 + v] * sx;
      tv[o9 + v + 1] = tris[o9 + v + 1] * sy;
      tv[o9 + v + 2] = tris[o9 + v + 2] * sz;
    }
  }

  // Connected components: separate objects get separate moulds, so a plane
  // through one never reaches another.
  const vkey = new Map();
  const parent = new Int32Array(T);
  for (let t = 0; t < T; t++) parent[t] = t;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < T; t++) {
    const o9 = t * 9;
    for (let v = 0; v < 9; v += 3) {
      const k = `${Math.round(tv[o9 + v] * 1000)},${Math.round(tv[o9 + v + 1] * 1000)},${Math.round(tv[o9 + v + 2] * 1000)}`;
      const prev = vkey.get(k);
      if (prev === undefined) vkey.set(k, t);
      else { const a = find(prev), b = find(t); if (a !== b) parent[b] = a; }
    }
  }
  const compOf = new Map();
  for (let t = 0; t < T; t++) {
    const r = find(t);
    let list = compOf.get(r);
    if (!list) compOf.set(r, list = []);
    list.push(t);
  }
  const components = [...compOf.values()];
  stats.components += components.length;
  if (verbose) console.log(`${T} triangles, ${components.length} connected component(s)`);

  const out = [];
  for (const idx of components) out.push(...castOne(idx, verbose && components.length <= 6));
  if (!out.length) return null;

  const arr = new Float32Array(out.length * 10);
  out.forEach((b, i) => {
    const o = i * 10;
    arr[o] = b.centre[0]; arr[o + 1] = b.centre[1]; arr[o + 2] = b.centre[2];
    arr[o + 3] = b.half[0]; arr[o + 4] = b.half[1]; arr[o + 5] = b.half[2];
    arr[o + 6] = b.quat[0]; arr[o + 7] = b.quat[1]; arr[o + 8] = b.quat[2]; arr[o + 9] = b.quat[3];
  });
  return arr;

  // The component's own axes. The mould supplies solidity; orientation still
  // comes from the geometry, so a slanted beam casts one slanted box instead
  // of the staircase a world-aligned grid would give it.
  function frameOf(list) {
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const t of list) {
      const o9 = t * 9;
      for (let v = 0; v < 9; v += 3) { cx += tv[o9 + v]; cy += tv[o9 + v + 1]; cz += tv[o9 + v + 2]; n++; }
    }
    if (n < 3) return IDENT;
    cx /= n; cy /= n; cz /= n;
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const t of list) {
      const o9 = t * 9;
      for (let v = 0; v < 9; v += 3) {
        const d = [tv[o9 + v] - cx, tv[o9 + v + 1] - cy, tv[o9 + v + 2] - cz];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j];
      }
    }
    const e = eigen3(m);
    if (!e.every(v => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]))) return IDENT;
    const f = [snapAxis(e[0]), snapAxis(norm3(cross3(e[2], e[0]))), snapAxis(e[2])];
    return f.every(isUnitAxis) ? IDENT : f;
  }

  function castOne(list, verbose) {
    const F = frameOf(list);
    // Extent in the component's frame.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of list) {
      const o9 = t * 9;
      for (let v = 0; v < 9; v += 3) {
        const p = [tv[o9 + v], tv[o9 + v + 1], tv[o9 + v + 2]];
        for (let k = 0; k < 3; k++) {
          const s = dot3(p, F[k]);
          if (s < lo[k]) lo[k] = s;
          if (s > hi[k]) hi[k] = s;
        }
      }
    }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (span.some(s => !(s > 0))) return [];

    // Voxel size from a BUDGET, not a fixed metre value: a 1 m prop and a
    // 100 m frame both get a mould they can afford, and neither decides the
    // resolution by hand.
    let vox = Math.cbrt(span[0] * span[1] * span[2] / BUDGET);
    if (!(vox > 0)) vox = MIN_VOXEL;
    vox = Math.max(vox, MIN_VOXEL, Math.max(...span) / 256);
    const nx = Math.max(1, Math.ceil(span[0] / vox)) + 2;
    const ny = Math.max(1, Math.ceil(span[1] / vox)) + 2;
    const nz = Math.max(1, Math.ceil(span[2] / vox)) + 2;
    const total = nx * ny * nz;
    if (total > BUDGET * 8) return [];      // pathological, leave to the fallback
    stats.voxels += total;

    // One voxel of padding all round, so the flood always has an outside to
    // start from even when the mesh touches its own bounds.
    const org = [lo[0] - vox, lo[1] - vox, lo[2] - vox];
    const at = (x, y, z) => (z * ny + y) * nx + x;
    const grid = new Uint8Array(total);       // 1 = surface

    // Rasterise: sample each triangle finely enough that no voxel is skipped.
    for (const t of list) {
      const o9 = t * 9;
      const a = [tv[o9], tv[o9 + 1], tv[o9 + 2]];
      const b = [tv[o9 + 3], tv[o9 + 4], tv[o9 + 5]];
      const c = [tv[o9 + 6], tv[o9 + 7], tv[o9 + 8]];
      const la = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const lb = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const n = Math.min(512, Math.max(2, Math.ceil(Math.max(la, lb) / (vox * 0.5))));
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        const p = [
          a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
          a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
          a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
        ];
        const gx = Math.floor((dot3(p, F[0]) - org[0]) / vox);
        const gy = Math.floor((dot3(p, F[1]) - org[1]) / vox);
        const gz = Math.floor((dot3(p, F[2]) - org[2]) / vox);
        if (gx < 0 || gy < 0 || gz < 0 || gx >= nx || gy >= ny || gz >= nz) continue;
        grid[at(gx, gy, gz)] = 1;
      }
    }

    // Flood the air in from the outside. Anything it cannot reach is solid,
    // whether the mesh states it or not, so solidity needs no vote, no skin
    // test and no silhouette measure.
    const outside = new Uint8Array(total);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const cur = stack.pop();
      const z = (cur / (nx * ny)) | 0;
      const y = ((cur - z * nx * ny) / nx) | 0;
      const x = cur - z * nx * ny - y * nx;
      for (let d = 0; d < 6; d++) {
        const dx = d === 0 ? -1 : d === 1 ? 1 : 0;
        const dy = d === 2 ? -1 : d === 3 ? 1 : 0;
        const dz = d === 4 ? -1 : d === 5 ? 1 : 0;
        const ax = x + dx, ay = y + dy, az = z + dz;
        if (ax < 0 || ay < 0 || az < 0 || ax >= nx || ay >= ny || az >= nz) continue;
        const k = at(ax, ay, az);
        if (outside[k] || grid[k]) continue;
        outside[k] = 1;
        stack.push(k);
      }
    }

    const solid = new Uint8Array(total);
    let solidCount = 0;
    for (let k = 0; k < total; k++) {
      if (!outside[k]) { solid[k] = 1; solidCount++; }
    }
    stats.solid += solidCount;
    if (verbose) {
      console.log(`  component ${list.length} tris  span ${span.map(s => s.toFixed(1)).join(' x ')}  ` +
                  `voxel ${vox.toFixed(2)} m  grid ${nx}x${ny}x${nz}  solid ${solidCount}`);
    }
    if (!solidCount) return [];

    // Grow boxes greedily through the solid. Each box expands a face at a
    // time while the whole new layer is solid and unclaimed, which keeps a
    // slab a slab instead of a field of cubes.
    const boxes = [];
    const claimed = new Uint8Array(total);
    for (let z0 = 0; z0 < nz; z0++) for (let y0 = 0; y0 < ny; y0++) for (let x0 = 0; x0 < nx; x0++) {
      const k0 = at(x0, y0, z0);
      if (!solid[k0] || claimed[k0]) continue;
      let x1 = x0, y1 = y0, z1 = z0;
      const free = (ax0, ax1, ay0, ay1, az0, az1) => {
        for (let z = az0; z <= az1; z++) for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
          const k = at(x, y, z);
          if (!solid[k] || claimed[k]) return false;
        }
        return true;
      };
      let grew = true;
      while (grew) {
        grew = false;
        if (x1 + 1 < nx && free(x1 + 1, x1 + 1, y0, y1, z0, z1)) { x1++; grew = true; }
        if (y1 + 1 < ny && free(x0, x1, y1 + 1, y1 + 1, z0, z1)) { y1++; grew = true; }
        if (z1 + 1 < nz && free(x0, x1, y0, y1, z1 + 1, z1 + 1)) { z1++; grew = true; }
        if (x0 - 1 >= 0 && free(x0 - 1, x0 - 1, y0, y1, z0, z1)) { x0--; grew = true; }
        if (y0 - 1 >= 0 && free(x0, x1, y0 - 1, y0 - 1, z0, z1)) { y0--; grew = true; }
        if (z0 - 1 >= 0 && free(x0, x1, y0, y1, z0 - 1, z0 - 1)) { z0--; grew = true; }
      }
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) claimed[at(x, y, z)] = 1;

      const half = [(x1 - x0 + 1) * vox / 2, (y1 - y0 + 1) * vox / 2, (z1 - z0 + 1) * vox / 2];
      if (half.some(h => h * 2 < MIN_BOX)) continue;
      const mid = [
        org[0] + (x0 + (x1 - x0 + 1) / 2) * vox,
        org[1] + (y0 + (y1 - y0 + 1) / 2) * vox,
        org[2] + (z0 + (z1 - z0 + 1) / 2) * vox,
      ];
      boxes.push({
        centre: [
          F[0][0] * mid[0] + F[1][0] * mid[1] + F[2][0] * mid[2],
          F[0][1] * mid[0] + F[1][1] * mid[1] + F[2][1] * mid[2],
          F[0][2] * mid[0] + F[1][2] * mid[1] + F[2][2] * mid[2],
        ],
        half,
        quat: F === IDENT ? [0, 0, 0, 1] : matToQuat(F[0], F[1], F[2]),
        oriented: F !== IDENT,
      });
    }
    stats.boxes += boxes.length;
    if (verbose) console.log(`  -> ${boxes.length} boxes`);
    return boxes;
  }
}

// ── Per-asset, cached by (asset, scale) ───────────────────────────────────
const cache = new Map();
let decomposed = 0, noTris = 0, totalAssetBoxes = 0, noBoxes = 0;
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
  const local = mouldMesh(tris, sx, sy, sz, false);
  cache.set(key, local);
  decomposed++;
  if (!local) noBoxes++; else totalAssetBoxes += local.length / 10;
  if (decomposed % 250 === 0) {
    console.log(`    moulded ${decomposed.toLocaleString()} (asset, scale) pairs, ${Math.round(totalAssetBoxes).toLocaleString()} local boxes, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  return local;
}

// ── --asset: one asset in, report + JSON out, exit ────────────────────────
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
  const local = mouldMesh(tris, found.sx, found.sy, found.sz, true);
  const scaled = [];
  for (let t = 0; t < tris.length; t += 3) {
    scaled.push(tris[t] * found.sx, tris[t + 1] * found.sy, tris[t + 2] * found.sz);
  }
  fs.writeFileSync(path.join(dataDir, 'debug-asset.json'), JSON.stringify({
    path: found.path, scale: [found.sx, found.sy, found.sz],
    tris: scaled, slabs: local ? Array.from(local) : [],
  }));
  console.log(`${(local ? local.length : 0) / 10} boxes total`);
  process.exit(0);
}

// ── Classify placements ───────────────────────────────────────────────────
console.log(`district ${name} (mould)`);
const terrain = indexTris(loadTerrain());
const builders = [];
const proxies = [];
let skippedSmall = 0, skippedHuge = 0, skippedNever = 0, skippedProxy = 0;
for (let i = 0; i < meta.boxes; i++) {
  const o = i * S;
  const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
  if (largest < MIN_SIZE) { skippedSmall++; continue; }
  const assetPath = PATHS[box[o + 10]] || '';
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

// ── Stamp placements ──────────────────────────────────────────────────────
const out = [];
let stamped = 0, bboxFallback = 0, droppedBig = 0;

function emitPlacement(i) {
  const o = i * S;
  const local = decompose(box[o + 10], box[o + 16], box[o + 17], box[o + 18]);
  const qx = box[o + 6], qy = box[o + 7], qz = box[o + 8], qw = box[o + 9];
  if (!local) {
    const largest = Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2;
    if (largest >= BBOX_SMALL) { droppedBig++; return; }
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
console.log(`  moulded   ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local boxes ` +
            `(${noTris.toLocaleString()} with no triangles, ${noBoxes.toLocaleString()} with nothing to draw)`);
console.log(`  mould     ${stats.components.toLocaleString()} components, ${Math.round(stats.voxels / 1e6)}M voxels cast, ${Math.round(100 * stats.solid / Math.max(1, stats.voxels))}% solid`);
console.log(`  stamped   ${stamped.toLocaleString()} placements -> ${out.length.toLocaleString()} boxes (${bboxFallback.toLocaleString()} bbox fallbacks under ${BBOX_SMALL} m, ${droppedBig.toLocaleString()} larger dropped)`);

// ── Terrain clip ──────────────────────────────────────────────────────────
const kept = [];
let buried = 0;
for (const b of out) {
  const g = heightAtCet(terrain, b.c[0], b.c[1]);
  if (g !== null && b.c[2] + b.h[2] <= g - BELOW) { buried++; continue; }
  kept.push(b);
}
console.log(`  terrain   ${buried.toLocaleString()} buried boxes cut`);

// ── Proxies where uncovered ───────────────────────────────────────────────
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

// ── Write ─────────────────────────────────────────────────────────────────
{
  const dims = kept.map(b => Math.max(b.h[0], b.h[1], b.h[2]) * 2).sort((a, b) => a - b);
  const med = dims.length ? dims[dims.length >> 1] : 0;
  const oriented = kept.filter(b => b.q[3] !== 1 || b.q[0] !== 0 || b.q[1] !== 0 || b.q[2] !== 0).length;
  console.log(`  shape     median largest dim ${med.toFixed(1)} m, ${oriented.toLocaleString()} oriented`);
}
console.log(`  BOXES     ${kept.length.toLocaleString()} after the mould, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

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
  district: name, bounds: meta.bounds, generator: 'assetmould',
  budget: BUDGET, minBox: MIN_BOX, minVoxel: MIN_VOXEL,
  lod: LOD, minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW,
  decomposed, noTris, noBoxes, stamped, bboxFallback, droppedBig, buried, proxyUsed, proxyCovered,
  components: stats.components, voxels: stats.voxels, solidVoxels: stats.solid,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin (generator assetmould; cull with cull_hidden.js, encode with --outdir mould)`);
