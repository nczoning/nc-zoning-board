#!/usr/bin/env node
/**
 * scripts/window_panels.js
 * ─────────────────────────────────────────────────────────────────────────
 * ROUTE A — THE REAL FACADE PANELS, AT THEIR REAL TRANSFORMS.
 *
 * Every previous model painted windows onto OUR box cloud and then argued about the
 * denominator. The boxes are an approximation of the city; the panels are the city.
 *
 *   A window is not an object. `window_parallax_interior` is a MATERIAL with roomWidth /
 *   roomHeight (3 x 4 m) that tiles a fake interior across whatever surface carries it.
 *   There is no per-window XYZ to extract, and the mesh's "chunks" are LOD levels, not
 *   spatial parts (lodMask 1/2/4) — so there is no glass chunk to pull out either.
 *
 *   What DOES exist, exactly, is the PANEL: `cct_cpz_building_a_f_12m` is a 12 x 8 x 0.24 m
 *   facade slab, and we know its world position, rotation and scale to the centimetre.
 *
 * So: emit one quad per placed glass-bearing panel, in world space, and let the window grid
 * tile across the panel itself. No box join, no facade-area denominator, no classification.
 * The thing that was darkening Corpo Plaza — normalising real glass against the fictional
 * surface area of 1,374 interpenetrating slabs — cannot happen, because no box is involved.
 *
 * HONEST LIMIT (this is the A/B): a mesh is called glass if `window_parallax_interior` is in
 * its material library. On a multilayer facade (ml_*_masksset) the glass is a MASKED LAYER,
 * so part of the panel is wall and we will light all of it. Route B — decoding the mask
 * textures — is what fixes that, and is only worth doing if A's placement looks right.
 *
 * Output (data/window-panels-<set>.bin): 9 floats per panel, in THREE space —
 *     px py pz   qx qy qz qw   sw sh
 * i.e. a unit quad (PlaneGeometry(1,1), +Z normal) scaled to the panel and placed on it.
 *
 * Usage: node scripts/window_panels.js [--margin ...] [--roof] [--bake]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RAW = process.argv.includes('--raw')
  ? process.argv[process.argv.indexOf('--raw') + 1]
  : 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw';
// Roof glass is REAL (16.7% of glass area) but `onWall` has always discarded it, and the
// window A/B must not be confounded by suddenly adding it. Opt in with --roof.
const WANT_ROOF = process.argv.includes('--roof');

// ONE definition of glass, shared (scripts/glass_lib.js). It now includes glass.mt and
// glass_onesided.mt — 145 material definitions the old regex ignored outright.
const { ARCH, makeGlassTest } = require('./glass_lib');

function readCsv(file) {
  const lines = fs.readFileSync(path.join(RAW, file), 'utf8').split(/\r?\n/);
  const head = lines[0].split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const L = lines[i]; if (!L) continue;
    const f = []; let cur = '', q = false;
    for (const ch of L) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { f.push(cur); cur = ''; }
      else cur += ch;
    }
    f.push(cur);
    const o = {}; head.forEach((h, k) => { o[h] = f[k]; });
    out.push(o);
  }
  return out;
}

// CET quaternion rotate (i,j,k,r == x,y,z,w; Z up)
function qRot(q, v) {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
}
// CET (Z up) → THREE (Y up):  x, z, -y
const toThree = (v) => [v[0], v[2], -v[1]];

// Rotation matrix (columns = basis vectors) → quaternion. Standard Shepperd's method.
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

// ── ASSETS: local bbox + is-it-glass-bearing ────────────────────────────────
const isGlass = makeGlassTest(readCsv('ncz_materials.csv'));
const asset = {};
for (const a of readCsv('ncz_assets.csv')) {
  if (!ARCH.test(a.path)) continue;
  const lo = [+a.bbx0, +a.bby0, +a.bbz0], hi = [+a.bbx1, +a.bby1, +a.bbz1];
  if (![...lo, ...hi].every(Number.isFinite)) continue;
  const d = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (!d.every((v) => v > 0)) continue;
  const glass = isGlass((a.mat_names || '').split('|'), (a.mat_paths || '').split('|'));
  if (!glass) continue;
  // The bbox is NOT centred on the mesh origin — cct_cpz_building_a_f_12m runs X[-12,0],
  // Z[0,8]. Carry the centre, or every panel lands offset by half its own size.
  asset[a.id] = { dims: d, ctr: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
}
console.log(`glass-bearing arch meshes: ${Object.keys(asset).length.toLocaleString()}`);

const out = [];   // 9 floats per panel
let total = 0, roofSkipped = 0;

function panel(id, x, y, z, q, sx, sy, sz) {
  const A = asset[id];
  if (!A) return;
  const s = [sx || 1, sy || 1, sz || 1];
  const d = [A.dims[0] * s[0], A.dims[1] * s[1], A.dims[2] * s[2]];

  // The panel's own axes: THIN is the normal, the two LARGE ones span its face.
  const order = [0, 1, 2].sort((i, j) => d[i] - d[j]);
  const nAx = order[0], vAx = order[1], uAx = order[2];   // normal, short, long

  const axis = (k) => { const a = [0, 0, 0]; a[k] = 1; return a; };
  const uW = qRot(q, axis(uAx));      // local axis → world (CET)
  const vW = qRot(q, axis(vAx));
  const nW = qRot(q, axis(nAx));

  // Roof glass: killed today by `onWall`, kept out of the A/B unless asked for.
  if (!WANT_ROOF && Math.abs(nW[2]) > 0.940) { roofSkipped++; return; }

  // The panel's CENTRE in the world: the node's position plus its own bbox centre,
  // scaled and rotated into place.
  const c = qRot(q, [A.ctr[0] * s[0], A.ctr[1] * s[1], A.ctr[2] * s[2]]);
  const cw = [x + c[0], y + c[1], z + c[2]];

  // Build the quad's frame in THREE space. A PlaneGeometry(1,1) has +X right, +Y up,
  // +Z normal — so map long→X, short→Y, thin→Z, and keep it right-handed.
  const U = toThree(uW), V = toThree(vW), N = toThree(nW);
  // Right-handedness: if U x V points against N, flip V (a mirrored basis makes matToQuat
  // return garbage and the panel renders inside-out).
  const cx = U[1] * V[2] - U[2] * V[1], cy = U[2] * V[0] - U[0] * V[2], cz = U[0] * V[1] - U[1] * V[0];
  if (cx * N[0] + cy * N[1] + cz * N[2] < 0) { V[0] = -V[0]; V[1] = -V[1]; V[2] = -V[2]; }

  const [qx, qy, qz, qw] = matToQuat(U, V, N);
  const P = toThree(cw);
  out.push(P[0], P[1], P[2], qx, qy, qz, qw, d[uAx], d[vAx]);
  total++;
}

async function stream(file, onRow) {
  const COL = {}; let first = true;
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(RAW, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (first) { line.split(',').forEach((h, i) => { COL[h] = i; }); first = false; continue; }
    onRow(line.split(','), COL);
  }
}

(async () => {
  // Instanced copies — one row per placed copy, each with its own transform.
  await stream('ncz_instances.csv', (f, C) => {
    panel(f[C.asset], +f[C.x], +f[C.y], +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz]);
  });
  // ...and the ones that were never instanced. Both, or 11% of the city's glass vanishes.
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    const x = +f[C.x], y = +f[C.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
    panel(f[C.asset], x, y, +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz]);
  });

  console.log(`\nPLACED PANELS: ${total.toLocaleString()}   (roof panels skipped: ${roofSkipped.toLocaleString()})`);
  const sizes = [];
  for (let i = 0; i < out.length; i += 9) sizes.push(out[i + 7] * out[i + 8]);
  sizes.sort((a, b) => a - b);
  const q = (p) => sizes[Math.floor(sizes.length * p)];
  console.log(`panel area m2: p10 ${q(0.1).toFixed(1)}  median ${q(0.5).toFixed(1)}  p90 ${q(0.9).toFixed(1)}  max ${sizes[sizes.length - 1].toFixed(0)}`);
  console.log(`total glass-bearing facade: ${(sizes.reduce((a, b) => a + b, 0) / 1e3).toFixed(0)}k m2`);

  if (process.argv.includes('--bake')) {
    const buf = Buffer.from(new Float32Array(out).buffer);
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'window-panels.bin'), buf);
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'window-panels.json'), JSON.stringify({
      count: total, stride: 9, layout: 'px,py,pz,qx,qy,qz,qw,sw,sh', space: 'three', roof: WANT_ROOF,
    }, null, 2));
    console.log(`\n=== BAKED data/window-panels.bin — ${total.toLocaleString()} panels, ${(buf.length / 1048576).toFixed(1)} MB`);
  }
})();
