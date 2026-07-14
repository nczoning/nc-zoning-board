#!/usr/bin/env node
/**
 * scripts/window_faces.js
 * ─────────────────────────────────────────────────────────────────────────
 * MATCH THE GAME'S REAL WINDOWS TO OUR BUILDING FACES.
 *
 * The renderer does not place a single window. It stamps a procedural 24 x 18 m grid on every
 * wall and lets a hash decide which cells light up (three-scene.js, `cellRnd`). The only
 * measured input is ONE BYTE per box — the glass-area ratio. The grid, the spacing, and which
 * windows are on are all invented, and a drawn "window" covers 291x the area of a real one.
 *
 * Meanwhile the game hands us 1,706,847 window rectangles, every one with an exact CET
 * position. This script asks the only question that matters before we build on them:
 *
 *     CAN A REAL WINDOW BE PUT ON ONE OF OUR BOX FACES, AND HOW MANY OF THEM LAND?
 *
 * Because our boxes are a coarse `.dds` decode, not a tracing of the buildings. Real facades sit
 * INSIDE them. Drawing the windows as QUADS is a closed dead end — they get depth-culled
 * (`?winmodel=panels`, `?panelpush=`). This is the other move: keep shading the box faces, and
 * replace the hash with the REAL LAYOUT, projected onto the face. Same pass, same depth, no new
 * geometry. But it only works if the windows actually land on the faces, and that is measured
 * here rather than assumed.
 *
 * THE ANSWER IS THE ASSIGNMENT RATE. If it is high, the layout is reachable and we can throw the
 * hash away. If it is low, our boxes are not where the walls are, and no amount of shader work
 * fixes that.
 *
 * Usage:  node scripts/window_faces.js [--set fixed|vanilla] [--margin 2]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { ARCH } = require('./glass_lib');
const { DISTRICT_META, decodeDistrict } = require('./tune_lib');

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const RAW = arg('--raw', 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw');
const SET = arg('--set', 'fixed');
const MARGIN = parseFloat(arg('--margin', '2'));

const GEOM_FILE = path.join(__dirname, '..', 'data', 'window-geom.json');
if (!fs.existsSync(GEOM_FILE)) {
  console.error('\nMISSING data/window-geom.json — run: node scripts/window_geom.js\n');
  process.exit(1);
}
const GEOM = JSON.parse(fs.readFileSync(GEOM_FILE, 'utf8'));

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

function qRot(q, v) {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
}

// ── the boxes we actually render (verbatim decode, THREE -> CET) ─────────────
const bx = [], by = [], bz = [], bhx = [], bhy = [], bhz = [], bDist = [];
for (const meta of DISTRICT_META) {
  const m = SET === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
  if (!(m.dataDdsFixed || m.dataDds)) continue;
  let d;
  try { d = decodeDistrict(m); } catch (e) { console.warn(`  skip ${meta.name}: ${e.message}`); continue; }
  for (let i = 0; i < d.count; i++) {
    bx.push(d.bcx[i]); by.push(-d.bcz[i]); bz.push(d.bcy[i]);
    bhx.push(d.bhx[i]); bhy.push(d.bhz[i]); bhz.push(d.bhy[i]);
    bDist.push(meta.name);
  }
}
const NB = bx.length;
console.log(`\nboxes (${SET}): ${NB.toLocaleString()}`);

const CELL = 32;
const key = (i, j) => i * 100000 + j;
const grid = new Map();
for (let b = 0; b < NB; b++) {
  const i0 = Math.floor((bx[b] - bhx[b] - MARGIN) / CELL), i1 = Math.floor((bx[b] + bhx[b] + MARGIN) / CELL);
  const j0 = Math.floor((by[b] - bhy[b] - MARGIN) / CELL), j1 = Math.floor((by[b] + bhy[b] + MARGIN) / CELL);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(b);
    }
  }
}

// ── assets + appearances ────────────────────────────────────────────────────
const APP = {};
for (const r of readCsv('ncz_appearances.csv')) APP[r.id] = r.appearance;
const asset = {};
for (const a of readCsv('ncz_assets.csv')) {
  if (!a.path || !ARCH.test(a.path)) continue;
  const g = GEOM[a.path.toLowerCase()];
  if (g) asset[a.id] = g;
}
const glazed = (g, id) => {
  const n = APP[id];
  return (n && g.apps[n]) ? g.apps[n] : (g.apps[Object.keys(g.apps)[0]] || []);
};

// ── THE SIX FACES OF A BOX ──────────────────────────────────────────────────
// Boxes are axis-aligned, so a face is named by its outward normal. `onWall` already throws the
// roof away in the shader, but count it here — a big roof share means the normals are wrong
// (that is how a Y-up/Z-up basis error was caught earlier today).
const FACES = [
  { n: [1, 0, 0], ax: 0, s: +1 }, { n: [-1, 0, 0], ax: 0, s: -1 },
  { n: [0, 1, 0], ax: 1, s: +1 }, { n: [0, -1, 0], ax: 1, s: -1 },
  { n: [0, 0, 1], ax: 2, s: +1 }, { n: [0, 0, -1], ax: 2, s: -1 },
];

const perFace = new Map();          // "box:face" -> count
let windows = 0, landed = 0, orphan = 0, noBox = 0;
const faceHits = [0, 0, 0, 0, 0, 0];
const offsets = [];                 // how far OUTSIDE the box face does the real window sit?
const uvs = new Map();              // "box:face" -> [{u,v,w,h}]  (for the regularity test)

function place(assetId, px, py, pz, q, sx, sy, sz, appId) {
  const g = asset[assetId];
  if (!g) return;
  sx = sx || 1; sy = sy || 1; sz = sz || 1;

  for (const c of glazed(g, assetId ? appId : appId)) {
    const ch = g.chunks[c];
    if (!ch) continue;
    const wn = qRot(q, ch.n);
    const wnl = Math.hypot(wn[0], wn[1], wn[2]) || 1;
    const nx = wn[0] / wnl, ny = wn[1] / wnl, nz = wn[2] / wnl;

    for (const r of ch.rects) {
      windows++;
      // pane centre -> world
      const lc = [r.c[0] * sx, r.c[1] * sy, r.c[2] * sz];
      const rc = qRot(q, lc);
      const wx = px + rc[0], wy = py + rc[1], wz = pz + rc[2];

      const cand = grid.get(key(Math.floor(wx / CELL), Math.floor(wy / CELL)));
      if (!cand) { noBox++; continue; }

      // Which BOX FACE is this window mounted on? The face's outward normal must AGREE with the
      // window's own normal (a window on the far wall does not belong to this face), and the
      // window must sit near that face's plane and within its extent.
      let best = -1, bestFace = -1, bestD = Infinity;
      for (const b of cand) {
        const bc = [bx[b], by[b], bz[b]], bh = [bhx[b], bhy[b], bhz[b]];
        for (let fi = 0; fi < 6; fi++) {
          const F = FACES[fi];
          const dot = F.n[0] * nx + F.n[1] * ny + F.n[2] * nz;
          if (dot < 0.94) continue;                         // face points the wrong way
          const p = [wx, wy, wz];
          // distance to the face plane
          const plane = bc[F.ax] + F.s * bh[F.ax];
          const d = Math.abs(p[F.ax] - plane);
          if (d > MARGIN) continue;
          // and inside the face's other two extents
          let inside = true;
          for (let k = 0; k < 3; k++) {
            if (k === F.ax) continue;
            if (p[k] < bc[k] - bh[k] - MARGIN || p[k] > bc[k] + bh[k] + MARGIN) { inside = false; break; }
          }
          if (!inside) continue;
          if (d < bestD) { bestD = d; best = b; bestFace = fi; }
        }
      }
      if (best < 0) { orphan++; continue; }

      landed++;
      faceHits[bestFace]++;
      offsets.push(bestD);
      const fk = `${best}:${bestFace}`;
      perFace.set(fk, (perFace.get(fk) || 0) + 1);

      // face-local (u, v) — u along the face's first non-normal axis, v = world Z (up) when the
      // face is a wall. Stored for the regularity test only.
      const F = FACES[bestFace];
      const axes = [0, 1, 2].filter((k) => k !== F.ax);
      const bc = [bx[best], by[best], bz[best]], bh = [bhx[best], bhy[best], bhz[best]];
      const u = ([wx, wy, wz][axes[0]] - (bc[axes[0]] - bh[axes[0]]));
      const v = ([wx, wy, wz][axes[1]] - (bc[axes[1]] - bh[axes[1]]));
      const sw = [r.s[0] * sx, r.s[1] * sy, r.s[2] * sz];
      if (!uvs.has(fk)) uvs.set(fk, []);
      if (uvs.get(fk).length < 400) uvs.get(fk).push({ u, v, w: sw[axes[0]], h: sw[axes[1]] });
    }
  }
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
  await stream('ncz_instances.csv', (f, C) => {
    place(f[C.asset], +f[C.x], +f[C.y], +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    const x = +f[C.x], y = +f[C.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
    place(f[C.asset], x, y, +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });

  const pctOf = (n) => `${((n / windows) * 100).toFixed(1)}%`;
  const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * q)] ?? 0; };

  console.log('\n=== CAN THE GAME\'S WINDOWS BE PUT ON OUR FACES?\n');
  console.log(`  real windows              ${windows.toLocaleString()}`);
  console.log(`  LANDED on a box face      ${landed.toLocaleString()}  (${pctOf(landed)})   <- margin ${MARGIN} m`);
  console.log(`  no box anywhere near      ${noBox.toLocaleString()}  (${pctOf(noBox)})`);
  console.log(`  box there, no face fits   ${orphan.toLocaleString()}  (${pctOf(orphan)})`);

  console.log('\n=== WHICH FACE (sanity — a big roof share means the normals are wrong)\n');
  const fn = ['+X', '-X', '+Y', '-Y', '+Z (roof)', '-Z (floor)'];
  for (let i = 0; i < 6; i++) console.log(`  ${fn[i].padEnd(10)} ${faceHits[i].toLocaleString().padStart(10)}  ${((faceHits[i] / landed) * 100).toFixed(1)}%`);

  console.log('\n=== HOW FAR OUTSIDE THE FACE DOES A REAL WINDOW SIT?\n');
  console.log(`  p50 ${p(offsets, 0.5).toFixed(2)} m   p90 ${p(offsets, 0.9).toFixed(2)} m   max ${p(offsets, 1).toFixed(2)} m`);
  console.log('  (the box/facade mismatch, measured. This is what killed drawing quads.)');

  console.log('\n=== HOW MUCH DATA IS THIS?\n');
  const faces = perFace.size;
  const counts = [...perFace.values()];
  console.log(`  faces with >=1 window     ${faces.toLocaleString()}`);
  console.log(`  windows per face          p50 ${p(counts, 0.5)}   p90 ${p(counts, 0.9)}   max ${p(counts, 1)}`);
  console.log(`  as packed rects (u,v,w,h @ 16-bit) = ${((landed * 8) / 1e6).toFixed(1)} MB + ${((faces * 8) / 1e6).toFixed(1)} MB index`);

  // ── ARE THE FACADES REGULAR GRIDS? ────────────────────────────────────────
  // If they are, the layout compresses to a per-face pitch/size/phase (~8 bytes) instead of a
  // list of rects (~8 bytes EACH). That is a 30x saving, and it is only honest if the facades
  // really are lattices. So measure it — do not assume it because the code comment says so.
  let tested = 0, regular = 0;
  for (const [, list] of uvs) {
    if (list.length < 6) continue;
    tested++;
    const us = [...new Set(list.map((r) => +r.u.toFixed(2)))].sort((a, b) => a - b);
    if (us.length < 3) { regular++; continue; }
    const gaps = [];
    for (let i = 1; i < us.length; i++) gaps.push(us[i] - us[i - 1]);
    const med = p(gaps, 0.5);
    if (med <= 0) continue;
    // regular if 80% of gaps are within 15% of the median gap (or are a clean multiple of it)
    const ok = gaps.filter((gp) => {
      const m = gp / med;
      return Math.abs(m - Math.round(m)) < 0.15 && Math.round(m) >= 1 && Math.round(m) <= 6;
    }).length;
    if (ok / gaps.length >= 0.8) regular++;
  }
  console.log('\n=== ARE THE FACADES REGULAR GRIDS? (decides whether we can compress)\n');
  console.log(`  faces tested (>=6 windows) ${tested.toLocaleString()}`);
  console.log(`  a regular lattice          ${regular.toLocaleString()}  (${tested ? ((regular / tested) * 100).toFixed(1) : 0}%)`);
  console.log('\n  HIGH  => bake a per-face pitch/size/phase; exact AND tiny.');
  console.log('  LOW   => the facades are irregular; only the full rect list is honest.\n');
})();
