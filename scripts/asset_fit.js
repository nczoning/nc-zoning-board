#!/usr/bin/env node
/**
 * asset_fit.js: stage 2 by ONE question, asked recursively.
 *
 * The sibling to asset_carve.js, and an answer to what went wrong with it.
 * The carve decides where to split from the mesh's dominant PLANES, and that
 * stage needed a new tuned constant for every asset family it met: plane
 * support, plane count, cell caps, solid votes, skin tests, component merge
 * fractions. Twenty-four flags, seventeen of which change geometry.
 *
 * Everything that actually worked converged on one question: DOES THIS BOX
 * DESCRIBE THE GEOMETRY INSIDE IT? Coverage of the box's largest face says
 * whether the shape is there; the count of normal clusters says whether the
 * surface is flat-faced or turning. Split when the answer is no, merge back
 * when one box says what two did, and stop.
 *
 * So this generator is that question and nothing else. No planes, no BSP, no
 * cells, no solid vote. A component's oriented bounding box is the starting
 * guess, exactly as CDPR's own vault decomposes into a few long tilted ribs;
 * it is kept when it describes the mesh and subdivided when it does not.
 *
 * Three shape parameters instead of seventeen: --fillmin, --minbox, --depth.
 *
 * Usage: node scripts/asset_fit.js <district> [--asset <substring>]
 * Then:  node scripts/cull_hidden.js <district>
 *        node scripts/encode_hull_dds.js <district> --outdir fit
 * View:  ?assets=fit&only=<district>
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

// ── The three shape parameters ────────────────────────────────────────────
const FILL_MIN = flag('fillmin', 0.85);   // share of the box's largest face that must have geometry over it
const MIN_BOX  = flag('minbox', 0.1);     // metres: a box thinner than this in any axis is not worth drawing
const MAX_DEPTH = flag('depth', 8);       // subdivisions allowed before a box is accepted as it is
const VOL_GAIN = flag('volgain', 0.1);    // share of a box's volume a split must remove to be worth taking
const SPLIT_TRIES = flag('splittries', 8); // candidate cut positions tried per axis

// ── Pipeline parameters, identical in meaning to the carve's ──────────────
const LOD       = flag('lod', 2);
const MIN_SIZE  = flag('minsize', 0.3);
const MAX_SIZE  = flag('maxsize', 1000);
const PROXY_MAX = flag('proxymax', 450);
const PROXY_COVER = flag('proxycover', 0.25);
const BELOW     = flag('below', 16);
const BBOX_SMALL = flag('bboxsmall', 4);
const NTOL      = flag('ntol', 8);        // degrees: the cone that decides whether two normals are the same facet
const MAX_FACETS = flag('maxfacets', 4);  // facets a box may hold before the surface counts as turning

if (!name) { console.error('usage: node scripts/asset_fit.js <district> [--asset <substring>]'); process.exit(1); }

const COS_NTOL = Math.cos(NTOL * Math.PI / 180);
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

// Eigenvectors of a symmetric 3x3 by cyclic Jacobi, largest spread first.
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

// ── The decomposition: one question, asked recursively ────────────────────
const stats = { components: 0, boxes: 0, deepest: 0, capped: 0, merged: 0 };

function fitMesh(tris, sx, sy, sz, verbose) {
  const T = tris.length / 9;
  if (!T) return null;

  const tv = new Float64Array(T * 9), tn = new Float64Array(T * 3);
  const ta = new Float64Array(T), tc = new Float64Array(T * 3);
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
  }

  // Connected components: a mesh is not necessarily one object, and a box
  // spanning two of them describes neither.
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

  const boxes = [];
  for (const idx of components) {
    if (verbose && components.length <= 6) {
      const F = frameOf(idx);
      const fit = fitBox(idx, F);
      const sil = [0, 1, 2].map(k => silhouette(idx, F, fit.centre, fit.half, k).toFixed(2)).join(' / ');
      console.log(`  component ${idx.length} tris  size ${fit.half.map(h => (h * 2).toFixed(1)).join(' x ')}  silhouettes ${sil}  facets ${facets(idx)}`);
    }
    boxes.push(...describe(idx, 0));
  }
  const out = mergeBack(boxes);
  if (verbose) {
    console.log(`${boxes.length} boxes -> ${out.length} after merge, ${out.filter(b => b.oriented).length} oriented`);
  }
  if (!out.length) return null;

  const arr = new Float32Array(out.length * 10);
  out.forEach((b, i) => {
    const o = i * 10;
    arr[o] = b.centre[0]; arr[o + 1] = b.centre[1]; arr[o + 2] = b.centre[2];
    arr[o + 3] = b.half[0]; arr[o + 4] = b.half[1]; arr[o + 5] = b.half[2];
    arr[o + 6] = b.quat[0]; arr[o + 7] = b.quat[1]; arr[o + 8] = b.quat[2]; arr[o + 9] = b.quat[3];
  });
  return arr;

  // The frame of the geometry itself. A wall's principal axes ARE the world
  // axes, so it snaps back to an identity quat; an arc's are along its chord.
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

  function fitBox(list, F) {
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
    const half = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
    const mid = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
    return {
      half,
      centre: [
        F[0][0] * mid[0] + F[1][0] * mid[1] + F[2][0] * mid[2],
        F[0][1] * mid[0] + F[1][1] * mid[1] + F[2][1] * mid[2],
        F[0][2] * mid[0] + F[1][2] * mid[1] + F[2][2] * mid[2],
      ],
    };
  }

  // Coverage of every silhouette, not area, and the WORST of the three is the
  // answer. Coverage marks cells rather than summing area, so a wall's two
  // shells read 1.0 and a triangle reads 0.5 whatever its shells do. Asking
  // only about the largest face is not enough: a beam lattice fills its own
  // silhouette exactly as a solid does, so a 56 x 108 x 31 m skylight frame
  // was accepted as ONE box. Side-on it is mostly holes, and that is the view
  // that catches it.
  function faceFill(list, F, centre, half) {
    let worst = 1;
    for (let k = 0; k < 3; k++) {
      const f = silhouette(list, F, centre, half, k);
      if (f < worst) worst = f;
    }
    return worst;
  }

  function silhouette(list, F, centre, half, k) {
    const a = (k + 1) % 3, b = (k + 2) % 3;
    if (half[a] < 1e-6 || half[b] < 1e-6) return 1;
    const G = 12;
    const grid = new Uint8Array(G * G);
    for (const t of list) {
      const o9 = t * 9;
      const p = [];
      for (let v = 0; v < 9; v += 3) {
        const d = [tv[o9 + v] - centre[0], tv[o9 + v + 1] - centre[1], tv[o9 + v + 2] - centre[2]];
        p.push([(dot3(d, F[a]) / half[a] + 1) / 2 * G, (dot3(d, F[b]) / half[b] + 1) / 2 * G]);
      }
      const gx0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0])));
      const gx1 = Math.min(G - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
      const gy0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1])));
      const gy1 = Math.min(G - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
      const d1x = p[1][0] - p[0][0], d1y = p[1][1] - p[0][1];
      const d2x = p[2][0] - p[0][0], d2y = p[2][1] - p[0][1];
      const den = d1x * d2y - d2x * d1y;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        if (grid[gy * G + gx]) continue;
        if (Math.abs(den) < 1e-12) { grid[gy * G + gx] = 1; continue; }
        const qx = gx + 0.5 - p[0][0], qy = gy + 0.5 - p[0][1];
        const w1 = (qx * d2y - d2x * qy) / den;
        const w2 = (d1x * qy - qx * d1y) / den;
        if (w1 >= -0.02 && w2 >= -0.02 && w1 + w2 <= 1.02) grid[gy * G + gx] = 1;
      }
    }
    let hit = 0;
    for (let i = 0; i < grid.length; i++) hit += grid[i];
    return hit / (G * G);
  }

  // Flat-faced or turning? A solid has a handful of normal clusters however
  // large it is; a curve has one per facet.
  function facets(list) {
    let area = 0;
    for (const t of list) area += ta[t];
    if (!(area > 0)) return 0;
    const groups = [];
    for (const t of list) {
      const n = [tn[t * 3], tn[t * 3 + 1], tn[t * 3 + 2]];
      let g = null;
      for (const q of groups) {
        if (Math.abs(q.n[0] * n[0] + q.n[1] * n[1] + q.n[2] * n[2]) >= COS_NTOL) { g = q; break; }
      }
      if (g) g.a += ta[t]; else groups.push({ n, a: ta[t] });
    }
    return groups.filter(g => g.a >= area * 0.05).length;
  }

  function describes(list, F, centre, half) {
    return faceFill(list, F, centre, half) >= FILL_MIN && facets(list) <= MAX_FACETS;
  }

  function makeBox(list, F, fit) {
    return {
      centre: fit.centre, half: fit.half,
      quat: F === IDENT ? [0, 0, 0, 1] : matToQuat(F[0], F[1], F[2]),
      oriented: F !== IDENT, tris: list,
    };
  }

  // The whole algorithm. One box is proposed, and kept if it describes what is
  // inside it. Otherwise it is halved along its longest axis and each half is
  // asked the same question, with its own frame, so a split can follow a curve
  // rather than step around it in world axes. A split that does not improve
  // the answer is refused, which is what stops a round cable or an organic
  // debris pile from being shattered into a thousand boxes that are each just
  // as wrong as the one they replaced.
  function describe(list, depth) {
    const F = frameOf(list);
    const fit = fitBox(list, F);
    if (fit.half.some(h => h * 2 < MIN_BOX)) return [];
    if (depth > stats.deepest) stats.deepest = depth;
    const box = makeBox(list, F, fit);
    if (describes(list, F, fit.centre, fit.half)) { stats.boxes++; return [box]; }
    if (depth >= MAX_DEPTH) { stats.capped++; stats.boxes++; return [box]; }

    // WHERE to cut matters as much as whether to. A midpoint cut through a
    // beam lattice gives two halves with the same cross-section and no gain,
    // so a 56 x 108 x 31 m skylight frame comes back as one solid block. A
    // lattice only comes apart between its members, and the members say where
    // that is. So search: every axis, several candidate positions drawn from
    // where the geometry actually sits, and take whichever removes the most
    // empty volume. This is the plane carve's real insight kept and its
    // mistake dropped, because a cut here bounds one box instead of slicing
    // the whole mesh from edge to edge.
    let best = null;
    for (let ax = 0; ax < 3; ax++) {
      const coord = list.map(t => dot3([tc[t * 3], tc[t * 3 + 1], tc[t * 3 + 2]], F[ax])).sort((a, b) => a - b);
      const cuts = new Set();
      for (let q = 1; q < SPLIT_TRIES; q++) cuts.add(coord[Math.floor(coord.length * q / SPLIT_TRIES)]);
      cuts.add(dot3(fit.centre, F[ax]));
      for (const cut of cuts) {
        const lo = [], hi = [];
        for (const t of list) {
          (dot3([tc[t * 3], tc[t * 3 + 1], tc[t * 3 + 2]], F[ax]) < cut ? lo : hi).push(t);
        }
        if (!lo.length || !hi.length) continue;
        let vol = 0, ok = true;
        for (const part of [lo, hi]) {
          const pf = frameOf(part);
          const pfit = fitBox(part, pf);
          if (pfit.half.some(h => h * 2 < MIN_BOX)) { ok = false; break; }
          vol += 8 * pfit.half[0] * pfit.half[1] * pfit.half[2];
        }
        if (!ok) continue;
        if (!best || vol < best.vol) best = { vol, lo, hi };
      }
    }
    if (!best) { stats.boxes++; return [box]; }
    const { lo, hi } = best;

    // Does the split remove empty space? That is the only question worth
    // asking here, and it is not the same as improving the silhouette.
    // Halving a beam lattice barely changes how filled it looks from any one
    // direction, so a fill-gain gate stops instantly and hands back a solid
    // block for a 56 x 108 x 31 m frame; but the two halves' boxes together
    // enclose far less air than the parent did, which is the real gain. A
    // solid gains nothing, because its halves tile the same volume. A straight
    // cable gains nothing either, so it stops; a curved one does, so it
    // follows the curve.
    // A split is worth taking when it removes empty space, and not otherwise.
    // Low fill is the wrong trigger on its own: almost nothing reaches 0.85 on
    // all three silhouettes (a plain wall reads 0.91 / 0.83 / 0.99), so every
    // asset splits to the depth cap and a 30 m cable becomes 844 boxes.
    const parentVol = 8 * fit.half[0] * fit.half[1] * fit.half[2];
    if (best.vol > parentVol * (1 - VOL_GAIN)) { stats.boxes++; return [box]; }

    return describe(lo, depth + 1).concat(describe(hi, depth + 1));
  }

  // The same question, inverted. Two boxes collapse into one when the union
  // still describes its geometry, which undoes a split the recursion made for
  // a distinction too small to see: a ceiling tilted 5 degrees across its
  // quadrants, a rail whose channel faces each earned their own box.
  function mergeBack(list) {
    if (list.length < 2 || list.length > 400) return list;
    const radius = (b) => Math.hypot(b.half[0], b.half[1], b.half[2]);
    let changed = true;
    while (changed && list.length > 1) {
      changed = false;
      for (let i = 0; i < list.length && !changed; i++) {
        for (let j = i + 1; j < list.length && !changed; j++) {
          const a = list[i], b = list[j];
          const gap = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2])
                    - radius(a) - radius(b);
          if (gap > 0.5) continue;
          const both = a.tris.concat(b.tris);
          const F = frameOf(both);
          const fit = fitBox(both, F);
          if (!describes(both, F, fit.centre, fit.half)) continue;
          list[i] = makeBox(both, F, fit);
          list.splice(j, 1);
          stats.merged++;
          changed = true;
        }
      }
    }
    return list;
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
  const local = fitMesh(tris, sx, sy, sz, false);
  cache.set(key, local);
  decomposed++;
  if (!local) noBoxes++; else totalAssetBoxes += local.length / 10;
  if (decomposed % 250 === 0) {
    console.log(`    fitted ${decomposed.toLocaleString()} (asset, scale) pairs, ${Math.round(totalAssetBoxes).toLocaleString()} local boxes, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
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
  const local = fitMesh(tris, found.sx, found.sy, found.sz, true);
  const scaled = [];
  for (let t = 0; t < tris.length; t += 3) {
    scaled.push(tris[t] * found.sx, tris[t + 1] * found.sy, tris[t + 2] * found.sz);
  }
  fs.writeFileSync(path.join(dataDir, 'debug-asset.json'), JSON.stringify({
    path: found.path, scale: [found.sx, found.sy, found.sz],
    tris: scaled, slabs: local ? Array.from(local) : [],
  }));
  console.log(`${(local ? local.length : 0) / 10} boxes total, deepest split ${stats.deepest}, ${stats.capped} hit the depth cap`);
  process.exit(0);
}

// ── Classify placements (identical policy to asset_boxes.js) ──────────────
console.log(`district ${name} (recursive fit)`);
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
console.log(`  fitted    ${decomposed.toLocaleString()} (asset, scale) pairs -> ${Math.round(totalAssetBoxes).toLocaleString()} local boxes ` +
            `(${noTris.toLocaleString()} with no triangles, ${noBoxes.toLocaleString()} with nothing to draw)`);
console.log(`  shape     ${stats.components.toLocaleString()} components, ${stats.merged.toLocaleString()} merges, deepest split ${stats.deepest}, ${stats.capped.toLocaleString()} boxes hit the depth cap`);
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
console.log(`  BOXES     ${kept.length.toLocaleString()} after the recursive fit, ${((Date.now() - t0) / 1000).toFixed(0)} s`);

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
  district: name, bounds: meta.bounds, generator: 'assetfit',
  fillMin: FILL_MIN, minBox: MIN_BOX, maxDepth: MAX_DEPTH, maxFacets: MAX_FACETS, ntol: NTOL,
  lod: LOD, minSize: MIN_SIZE, maxSize: MAX_SIZE, below: BELOW,
  decomposed, noTris, noBoxes, stamped, bboxFallback, droppedBig, buried, proxyUsed, proxyCovered,
  components: stats.components, merges: stats.merged, deepest: stats.deepest, depthCapped: stats.capped,
  boxes: kept.length,
  stride: 10, layout: 'centre xyz, halfExtent xyz, quat xyzw (float32)',
  generated: new Date().toISOString(),
}, null, 2));
console.log(`\n  wrote data/district-hull-${name}.bin (generator assetfit; cull with cull_hidden.js, encode with --outdir fit)`);
