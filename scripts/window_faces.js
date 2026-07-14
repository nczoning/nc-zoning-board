#!/usr/bin/env node
/**
 * scripts/window_faces.js
 * ─────────────────────────────────────────────────────────────────────────
 * PUT THE GAME'S REAL WINDOWS ON OUR BUILDING FACES — and decide how to encode them.
 *
 * The shader does not place a single window. It stamps a procedural 24 x 18 m grid across every
 * wall and lets a hash decide which cells glow (three-scene.js, `cellRnd`). Each drawn "window"
 * covers 291x the area of a real one. The only measured input is ONE BYTE per box.
 *
 * Meanwhile the game hands us 1,706,847 window rectangles, each with an exact CET position.
 *
 * HOW THEY GET DRAWN. Not as quads — that is a closed dead end (`?winmodel=panels`,
 * `?panelpush=`): our `.dds` boxes are a coarse decode, real facades sit INSIDE them, and window
 * quads get depth-culled. Instead we PAINT the real layout onto the box face in the fragment
 * shader — same pass, same geometry, no depth test, no new triangles. The box's inverse matrix is
 * already on the GPU (`faceInvBuffer`), so a fragment can find itself in the building's frame.
 *
 * THIS SCRIPT ANSWERS THE ONE QUESTION THAT DECIDES THE ENCODING:
 *
 *   A. Are the facades REGULAR LATTICES?  -> bake pitch/size/phase per face. ~8 bytes. Free to
 *                                            evaluate: one modulo in the shader.
 *   B. Are they irregular?                -> bake the rects. ~1.7M of them, and the fragment must
 *                                            loop over every window on its face.
 *
 * A is exact ONLY if the facades really are lattices. Night City's kit-built walls suggest they
 * are; the kits are literally repeated modules. But an earlier probe said 54% — and that probe ran
 * against the AABB faces, which point the wrong way and sit metres out, so its answer was
 * meaningless. MEASURE IT ON THE FACES WE ACTUALLY HAVE.
 *
 * THE BOXES ARE ORIENTED (see `fix(3d): the boxes are ROTATED`). Every test is done in the box's
 * own frame, where it is an honest AABB again.
 *
 * Usage:  node scripts/window_faces.js [--set fixed|vanilla] [--margin 4]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { BUILDING, PROXY } = require('./glass_lib');
const { makeDetailGrid, makeProxyFilter } = require('./proxy_dedup');
const { DISTRICT_META, decodeDistrict } = require('./tune_lib');

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const RAW = arg('--raw', 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw');
const SET = arg('--set', 'fixed');
const MARGIN = parseFloat(arg('--margin', '4'));

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

const qRot = (q, v) => {
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + (y * tz - z * ty), b + w * ty + (z * tx - x * tz), c + w * tz + (x * ty - y * tx)];
};
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

// ── the boxes we actually render — ORIENTED, in CET ─────────────────────────
const B = [];   // { c, h (true half-extents), q, dist }
for (const meta of DISTRICT_META) {
  const m = SET === 'vanilla' ? { ...meta, dataDdsFixed: null } : meta;
  if (!(m.dataDdsFixed || m.dataDds)) continue;
  let d;
  try { d = decodeDistrict(m); } catch (e) { console.warn(`  skip ${meta.name}: ${e.message}`); continue; }
  for (let i = 0; i < d.count; i++) {
    B.push({
      c: [d.bcx[i], -d.bcz[i], d.bcy[i]],                       // THREE -> CET
      h: [d.btx[i], d.btz[i], d.bty[i]],                        // TRUE half-extents, CET
      q: [d.bqx[i], -d.bqz[i], d.bqy[i], d.bqw[i]],             // orientation, CET
      r: Math.hypot(d.bhx[i], d.bhz[i], d.bhy[i]),              // AABB radius, for the hash only
      dist: meta.name,
    });
  }
}
console.log(`\nboxes (${SET}): ${B.length.toLocaleString()}  [ORIENTED]`);

const CELL = 32, key = (i, j) => i * 100000 + j;
const grid = new Map();
for (let b = 0; b < B.length; b++) {
  const r = B[b].r + MARGIN;
  const i0 = Math.floor((B[b].c[0] - r) / CELL), i1 = Math.floor((B[b].c[0] + r) / CELL);
  const j0 = Math.floor((B[b].c[1] - r) / CELL), j1 = Math.floor((B[b].c[1] + r) / CELL);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = key(i, j); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(b);
  }
}

const APP = {};
for (const r of readCsv('ncz_appearances.csv')) APP[r.id] = r.appearance;
// BUILDING, not ARCH. `architecture` is not in a proxy's path, and glass_lib exports BOTH regexes
// — ARCH (architecture|megabuilding) and BUILDING (…|proxy) — with a comment on BUILDING saying to
// use it. This file used ARCH.
//
// It cost the entire proxy export. 2,274 proxy meshes carrying 519,226 real window rects went into
// window-geom.json, and EVERY ONE of them was dropped here: no entry in `asset`, so `place()`
// returns on its first line and the placement contributes nothing. The bake came out at 885,291
// windows — barely different from the 902,155 it had BEFORE the proxies existed — and that
// "nothing much moved" is what a total loss looks like when the filter is silent.
//
// Arasaka Waterfront would still have had NINE towers.
const asset = {}, assetPath = {}, assetFoot = {}, assetTop = {};
for (const a of readCsv('ncz_assets.csv')) {
  if (!a.path || !BUILDING.test(a.path)) continue;
  assetPath[a.id] = a.path;
  assetFoot[a.id] = Math.max(+a.bbx1 - +a.bbx0, +a.bby1 - +a.bby0) || 0;
  assetTop[a.id] = (+a.bbz1) || 0;      // local top of the mesh bbox — the dedup's missing axis
  const g = GEOM[a.path.toLowerCase()];
  if (g) asset[a.id] = g;
}
// EMISSIVE chunks, not glass chunks. 43% of this city's glass area never lights up — doors,
// balustrades, shopfronts, the Corpo Plaza roundabout canopy. The material states which is which
// (`EmissiveEV`); window_geom.js records it per (appearance, chunk). --allglass to compare.
const ALL_GLASS = process.argv.includes('--allglass');
const glazed = (g, id) => {
  const n = APP[id];
  const rec = (n && g.apps[n]) || g.apps[Object.keys(g.apps)[0]] || { g: [], e: [] };
  // `l` = ON AFTER DARK (2^EV x (1 - turnOffAtNight) > 0), not merely emissive: the game bakes
  // switched-OFF windows as their own chunks, and lighting them lights windows it darkened.
  return ALL_GLASS ? (rec.g || []) : (rec.l || rec.e || []);
};

// ── land every real window on a box FACE ────────────────────────────────────
// A box face is named by its outward normal IN THE BOX'S OWN FRAME: axis 0/1/2, sign +/-.
// faceIdx = axis*2 + (sign>0 ? 0 : 1). In that frame the box is axis-aligned, so this is the
// simple test it always looked like — asked of the RIGHT wall.
const faces = new Map();          // "box:face" -> [{u, v, w, h}]  (face-local metres)
let W = 0, landed = 0, noBox = 0, failNormal = 0, failExtent = 0, failDepth = 0;
const depths = [];

// ── THE DEBUG CLOUD ─────────────────────────────────────────────────────────
// Every window, with WHY it did or did not land. 28% of the game's windows do not reach a face,
// and they are currently written off as "interior glass — courtyards, light wells". THAT IS AN
// ASSUMPTION, and an untested one: our boxes are a coarse `.dds` decode, not a tracing of the
// buildings, so a window we call "too deep" might be sitting on a real facade our box cloud
// simply MISSED.
//
// Those two cases look identical in a number and completely different on a map. So emit the
// positions and let the eye decide — a red cloud floating inside a building is interior glass; a
// red cloud hanging in the air on a flat wall face is a hole in the box cloud, and it is evidence
// for what a better box cloud would have to cover.
const REASON = { LANDED: 0, DEEP: 1, OFFSIDE: 2, NOBOX: 3, NONORMAL: 4 };
const dbgXYZ = [];      // world position (THREE space, so the renderer can use it directly)
const dbgWhy = [];

// WHERE DID THE WINDOWS COME FROM? Split every count by proxy vs detail.
// A total is not evidence: "windows went up 3%" is equally consistent with the proxies working
// and with the proxies contributing almost nothing while something else drifted. The pipeline has
// been fooled by an aggregate six times this week. Print the breakdown next to the total.
const SRC = { kitPlace: 0, kitWin: 0, pxPlace: 0, pxWin: 0 };

function place(assetId, px, py, pz, q, sx, sy, sz, appId) {
  const g = asset[assetId];
  if (!g) return;
  const isPx = PROXY.test(assetPath[assetId] || '');
  if (isPx) SRC.pxPlace++; else SRC.kitPlace++;
  const w0 = W;
  sx = sx || 1; sy = sy || 1; sz = sz || 1;

  for (const c of glazed(g, appId)) {
    const ch = g.chunks[c];
    if (!ch) continue;
    const n0 = qRot(q, ch.n);
    const nl = Math.hypot(n0[0], n0[1], n0[2]) || 1;
    const wn = [n0[0] / nl, n0[1] / nl, n0[2] / nl];

    for (const r of ch.rects) {
      W++;
      const rc = qRot(q, [r.c[0] * sx, r.c[1] * sy, r.c[2] * sz]);
      const p = [px + rc[0], py + rc[1], pz + rc[2]];
      // CET (x, y, z) -> THREE (x, z, -y), so the debug cloud drops straight into the scene.
      const emit = (why) => { dbgXYZ.push(p[0], p[2], -p[1]); dbgWhy.push(why); };

      const cand = grid.get(key(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)));
      if (!cand) { noBox++; emit(REASON.NOBOX); continue; }

      let bestB = -1, bestF = -1, bestD = Infinity;
      let anyN = false, anyE = false;
      for (const bi of cand) {
        const bb = B[bi];
        const inv = qConj(bb.q);
        const lp = qRot(inv, [p[0] - bb.c[0], p[1] - bb.c[1], p[2] - bb.c[2]]);
        const ln = qRot(inv, wn);
        for (let ax = 0; ax < 3; ax++) {
          for (const s of [1, -1]) {
            if (ln[ax] * s < 0.94) continue;             // this face points the wrong way
            anyN = true;
            let inside = true;
            for (let k = 0; k < 3; k++) {
              if (k === ax) continue;
              if (Math.abs(lp[k]) > bb.h[k] + MARGIN) { inside = false; break; }
            }
            if (!inside) continue;
            anyE = true;
            const d = Math.abs(lp[ax] - s * bb.h[ax]);
            if (d < bestD) { bestD = d; bestB = bi; bestF = ax * 2 + (s > 0 ? 0 : 1); }
          }
        }
      }
      if (!anyN) { failNormal++; emit(REASON.NONORMAL); continue; }
      if (!anyE) { failExtent++; emit(REASON.OFFSIDE); continue; }
      depths.push(bestD);
      if (bestD > MARGIN) { failDepth++; emit(REASON.DEEP); continue; }

      landed++;
      emit(REASON.LANDED);
      // PROJECT onto that face: the window's (u, v) in face-local metres, measured from the
      // face's lower-left corner. The depth is DISCARDED — that is the whole point of painting
      // rather than drawing. A window 3 m behind the facade still belongs on this wall.
      const bb = B[bestB];
      const inv = qConj(bb.q);
      const lp = qRot(inv, [p[0] - bb.c[0], p[1] - bb.c[1], p[2] - bb.c[2]]);
      const ax = bestF >> 1;
      const uax = ax === 0 ? 1 : 0;                       // the two in-plane axes
      const vax = ax === 2 ? 1 : 2;
      // the window's own size, rotated into the box's frame, then taken on the in-plane axes
      const ls = qRot(inv, qRot(q, [r.s[0] * sx, r.s[1] * sy, r.s[2] * sz])).map(Math.abs);
      const k2 = `${bestB}:${bestF}`;
      if (!faces.has(k2)) faces.set(k2, []);
      faces.get(k2).push({
        u: lp[uax] + bb.h[uax],                          // 0 .. 2*h[uax]
        v: lp[vax] + bb.h[vax],
        w: ls[uax],
        h: ls[vax],
      });
    }
  }
  if (isPx) SRC.pxWin += W - w0; else SRC.kitWin += W - w0;
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

// ── IS A FACE A REGULAR LATTICE? ────────────────────────────────────────────
// The decisive question. Project the face's windows onto each in-plane axis, take the DISTINCT
// coordinates, and ask whether their gaps are (near-)multiples of one pitch. A kit-built facade
// repeats one module, so it should be.
//
// Reported honestly: a face with 1-2 windows is trivially "regular" and tells us nothing, so the
// test only runs on faces with enough windows to be able to FAIL.
function lattice(vals, tol) {
  const u = [...new Set(vals.map((x) => +x.toFixed(2)))].sort((a, b) => a - b);
  if (u.length < 3) return { regular: true, pitch: 0, trivial: true };
  const gaps = [];
  for (let i = 1; i < u.length; i++) gaps.push(u[i] - u[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const pitch = sorted[Math.floor(sorted.length / 2)];        // median gap
  if (!(pitch > 0.05)) return { regular: false, pitch: 0 };
  let ok = 0;
  for (const g of gaps) {
    const m = g / pitch;
    if (Math.abs(m - Math.round(m)) < tol && Math.round(m) >= 1 && Math.round(m) <= 8) ok++;
  }
  return { regular: ok / gaps.length >= 0.85, pitch, frac: ok / gaps.length };
}

(async () => {
  // ── PASS 1: WHERE IS THERE A REAL BUILDING? ────────────────────────────────
  // Admitting proxies (above) is only half the job, and the other half is the half that BITES.
  // MOST BUILDINGS SHIP WITH BOTH a detailed version and a proxy, and the sector data contains
  // BOTH — `v38_005` is placed as 2,136 instanced meshes AND 72 proxy meshes. Counting them both
  // gives every glazed building in Night City its windows TWICE: a 2x overcount wearing the
  // costume of a fix.
  //
  // So use a proxy ONLY where no detailed geometry covers it, and decide that SPATIALLY — a
  // per-building proxy shares its prefab with the detail, but an AGGREGATE proxy (`*_mproxy`, one
  // mesh per block) does not, so a prefab test keeps it and drops it on top of a dozen real
  // buildings. window_boxes.js has done this since the proxies landed; this file never did.
  const detailGrid = makeDetailGrid();
  const seen = (f, C) => {
    const id = f[C.asset];
    if (!asset[id]) return;                       // not glazed — says nothing about coverage
    if (PROXY.test(assetPath[id] || '')) return;  // a proxy cannot vouch for itself
    // ...and HOW HIGH it reaches. A podium vetoing a tower is the bug this axis exists to stop.
    detailGrid.add(+f[C.x], +f[C.y], +f[C.z] + (assetTop[id] || 0) * (+f[C.sz] || 1));
  };
  await stream('ncz_instances.csv', seen);
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    seen(f, C);
  });
  const proxyFilter = makeProxyFilter(detailGrid, assetPath, assetFoot, assetTop);
  console.log(`\n  detail grid: ${detailGrid.size().toLocaleString()} cells of glazed architecture`);

  // ── PASS 2: the windows ────────────────────────────────────────────────────
  await stream('ncz_instances.csv', (f, C) => {
    if (!proxyFilter.keep(f[C.asset], +f[C.x], +f[C.y], +f[C.z], +f[C.sz])) return;
    place(f[C.asset], +f[C.x], +f[C.y], +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });
  await stream('ncz_nodes.csv', (f, C) => {
    if (Math.max(1, +f[C.inst] || 1) > 1) return;
    const x = +f[C.x], y = +f[C.y];
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return;
    if (!proxyFilter.keep(f[C.asset], x, y, +f[C.z], +f[C.sz])) return;
    place(f[C.asset], x, y, +f[C.z],
      [+f[C.qi], +f[C.qj], +f[C.qk], +f[C.qr]], +f[C.sx], +f[C.sy], +f[C.sz], f[C.app]);
  });
  proxyFilter.report();

  const pc = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
  const pct = (n) => `${((n / W) * 100).toFixed(1)}%`;

  console.log('\n=== 0. WHERE DID THE WINDOWS COME FROM?  (proxy vs detail)\n');
  const glazedProxyAssets = Object.keys(asset).filter((id) => PROXY.test(assetPath[id] || '')).length;
  console.log(`  GLAZED assets            ${Object.keys(asset).length.toLocaleString()}  (${glazedProxyAssets.toLocaleString()} of them proxies)`);
  console.log(`  detail placements USED   ${SRC.kitPlace.toLocaleString().padStart(11)}  ->  ${SRC.kitWin.toLocaleString().padStart(9)} windows`);
  console.log(`  PROXY placements USED    ${SRC.pxPlace.toLocaleString().padStart(11)}  ->  ${SRC.pxWin.toLocaleString().padStart(9)} windows`);
  console.log('     ^ if this is ~0, the proxies are not reaching the bake and the whole export was wasted.');

  console.log('\n=== 1. DO THE GAME\'S WINDOWS LAND ON OUR FACES?  (margin ' + MARGIN + ' m)\n');
  console.log(`  real windows              ${W.toLocaleString()}`);
  console.log(`  LANDED on a face          ${landed.toLocaleString()}  (${pct(landed)})`);
  console.log(`  no box near               ${noBox.toLocaleString()}  (${pct(noBox)})`);
  console.log(`  no face points that way   ${failNormal.toLocaleString()}  (${pct(failNormal)})   <- was 48.7% on the AABBs`);
  console.log(`  off the side of the face  ${failExtent.toLocaleString()}  (${pct(failExtent)})`);
  console.log(`  deeper than ${MARGIN} m inside  ${failDepth.toLocaleString()}  (${pct(failDepth)})   <- interior glass: courtyards, light wells`);
  console.log(`\n  depth to the face: p50 ${pc(depths, 0.5).toFixed(2)} m   p90 ${pc(depths, 0.9).toFixed(2)} m`);
  for (const m of [2, 4, 6, 8]) {
    console.log(`    margin ${m} m -> ${((depths.filter((x) => x <= m).length / W) * 100).toFixed(1)}% of ALL windows land`);
  }

  console.log('\n=== 2. HOW MUCH DATA?\n');
  const counts = [...faces.values()].map((a) => a.length);
  console.log(`  faces with >=1 window     ${faces.size.toLocaleString()}`);
  console.log(`  windows per face          p50 ${pc(counts, 0.5)}   p90 ${pc(counts, 0.9)}   p99 ${pc(counts, 0.99)}   max ${Math.max(...counts)}`);
  console.log(`  B. per-window rects       ${((landed * 8) / 1e6).toFixed(1)} MB  + ${((faces.size * 8) / 1e6).toFixed(1)} MB index`);
  console.log(`     ^ and the fragment must LOOP over its face's windows: p99 is ${pc(counts, 0.99)} iterations`);
  console.log(`  A. per-face lattice       ${((faces.size * 12) / 1e6).toFixed(2)} MB, ONE modulo in the shader`);

  console.log('\n=== 3. ARE THE FACADES REGULAR LATTICES?  (this decides A vs B)\n');
  let tested = 0, regU = 0, regV = 0, regBoth = 0;
  const pitchU = [], pitchV = [];
  for (const list of faces.values()) {
    if (list.length < 6) continue;                        // must be able to FAIL the test
    tested++;
    const a = lattice(list.map((r) => r.u), 0.12);
    const b = lattice(list.map((r) => r.v), 0.12);
    if (a.regular) { regU++; if (a.pitch) pitchU.push(a.pitch); }
    if (b.regular) { regV++; if (b.pitch) pitchV.push(b.pitch); }
    if (a.regular && b.regular) regBoth++;
  }
  const p = (n) => (tested ? `${((n / tested) * 100).toFixed(1)}%` : '—');
  console.log(`  faces tested (>=6 windows) ${tested.toLocaleString()}`);
  console.log(`  regular HORIZONTALLY       ${regU.toLocaleString()}  (${p(regU)})`);
  console.log(`  regular VERTICALLY         ${regV.toLocaleString()}  (${p(regV)})`);
  console.log(`  regular BOTH ways          ${regBoth.toLocaleString()}  (${p(regBoth)})   <- the number that decides it`);
  console.log(`\n  measured pitch: horizontal p50 ${pc(pitchU, 0.5).toFixed(2)} m,  vertical p50 ${pc(pitchV, 0.5).toFixed(2)} m`);
  console.log('  (the shader currently uses an INVENTED 24 x 18 m grid)');
  console.log('\n  HIGH => bake pitch/size/phase per face. Exact, tiny, and free to evaluate.');
  console.log('  LOW  => the facades are irregular; only the rect list is honest.\n');

  if (!process.argv.includes('--bake')) return;

  // ── BAKE ──────────────────────────────────────────────────────────────────
  // THE REAL WINDOWS, ADDRESSABLE FROM A FRAGMENT SHADER.
  //
  // Only 31% of facades are regular lattices, so a pitch/phase model would be a lie for two
  // thirds of the city. The rectangles have to be carried.
  //
  // But a fragment cannot loop over its face's windows: p99 is 222 of them and the worst face has
  // 3,254. So bucket them into TILES on the face. At the measured 2.33 x 4.00 m pitch an 8 m tile
  // holds ~6 windows, and a fragment loops over its own tile only — bounded, and independent of
  // how big the building is.
  //
  // CSR, three levels, because the address space is sparse: 263,780 boxes x 6 faces = 1.6M
  // possible faces, of which 69,533 carry glass. Paying 4 bytes for every possible face would
  // cost more than the windows do.
  //
  //   boxFace[NB]        -> where this box's 6 face records start (EMPTY if it has no glass)
  //   faceRec[nGlass*6]  -> {tileStart, tilesU | tilesV<<8, uSize, vSize} per face
  //   tileOff[nTiles+1]  -> CSR: this tile's rects are rect[tileOff[t] .. tileOff[t+1])
  //   rect[nRects*4]     -> u, v, w, h  in 1/64 m  (uint16: 0..1023 m, plenty for any face)
  //
  // NOTE the data goes in a TEXTURE, not a storage buffer: the night material already sits at
  // 7/8 storage buffers per fragment stage, and exceeding the cap fails pipeline creation for the
  // heaviest material only — the scene goes black while lighter debug views still work.
  // See wiki/learnings/webgpu-storage-buffer-limit-pack-vec4.
  const TILE = 8;                                   // metres
  const Q = 64;                                     // quantisation: 1/64 m
  const EMPTY = 0xffffffff;

  const boxFace = new Uint32Array(B.length).fill(EMPTY);
  const glassBoxes = [...new Set([...faces.keys()].map((k) => +k.split(':')[0]))].sort((a, b) => a - b);
  glassBoxes.forEach((b, i) => { boxFace[b] = i * 6; });

  const faceRec = new Uint32Array(glassBoxes.length * 6 * 4).fill(0);
  const tileOffs = [0];
  const rects = [];
  let nTiles = 0;

  for (let gi = 0; gi < glassBoxes.length; gi++) {
    const b = glassBoxes[gi];
    for (let f = 0; f < 6; f++) {
      const list = faces.get(`${b}:${f}`);
      const rec = (gi * 6 + f) * 4;
      if (!list || !list.length) { faceRec[rec] = EMPTY; continue; }
      const ax = f >> 1;
      const uax = ax === 0 ? 1 : 0;
      const vax = ax === 2 ? 1 : 2;
      const uSize = 2 * B[b].h[uax], vSize = 2 * B[b].h[vax];
      const tu = Math.max(1, Math.min(255, Math.ceil(uSize / TILE)));
      const tv = Math.max(1, Math.min(255, Math.ceil(vSize / TILE)));

      // bucket by tile. A window straddling a tile edge goes in EVERY tile it touches — a
      // fragment only ever reads one tile, so a window missing from a tile it overlaps would be
      // a hole in the middle of a pane.
      // CLAMP BOTH ENDS into the tile grid. A window may legitimately sit just OFF the edge of
      // its face — the join allows a margin — which puts its tile span at e.g. [0, -1]. Clamping
      // only the low end leaves lo > hi, the loop never runs, and the window is silently DROPPED.
      // That lost 183,063 windows, and the only reason it was caught is that the duplicate
      // counter (rects emitted minus windows landed) went NEGATIVE. Straddle duplicates cannot be
      // negative — an impossible number, printed next to the total, doing its job again.
      const clamp = (x, hi) => (x < 0 ? 0 : x > hi ? hi : x);
      const buckets = Array.from({ length: tu * tv }, () => []);
      for (const r of list) {
        const u0 = clamp(Math.floor(((r.u - r.w / 2) / uSize) * tu), tu - 1);
        const u1 = clamp(Math.floor(((r.u + r.w / 2) / uSize) * tu), tu - 1);
        const v0 = clamp(Math.floor(((r.v - r.h / 2) / vSize) * tv), tv - 1);
        const v1 = clamp(Math.floor(((r.v + r.h / 2) / vSize) * tv), tv - 1);
        for (let tv2 = v0; tv2 <= v1; tv2++) {
          for (let tu2 = u0; tu2 <= u1; tu2++) buckets[tv2 * tu + tu2].push(r);
        }
      }

      faceRec[rec] = tileOffs.length - 1;                       // tileStart
      faceRec[rec + 1] = tu | (tv << 8);
      faceRec[rec + 2] = Math.round(uSize * Q);
      faceRec[rec + 3] = Math.round(vSize * Q);

      for (const bk of buckets) {
        for (const r of bk) {
          rects.push(
            Math.max(0, Math.min(65535, Math.round(r.u * Q))),
            Math.max(0, Math.min(65535, Math.round(r.v * Q))),
            Math.max(0, Math.min(65535, Math.round(r.w * Q))),
            Math.max(0, Math.min(65535, Math.round(r.h * Q))),
          );
        }
        tileOffs.push(rects.length / 4);
        nTiles++;
      }
    }
  }

  const rectArr = Uint16Array.from(rects);
  const tileArr = Uint32Array.from(tileOffs);
  const dup = rectArr.length / 4 - landed;

  const OUT = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(OUT, `window-faces-${SET}.bin`), Buffer.concat([
    Buffer.from(boxFace.buffer), Buffer.from(faceRec.buffer),
    Buffer.from(tileArr.buffer), Buffer.from(rectArr.buffer),
  ]));
  const manifest = {
    set: SET, tile: TILE, quant: Q, margin: MARGIN,
    boxes: B.length, glassBoxes: glassBoxes.length, faces: faces.size,
    tiles: nTiles, rects: rectArr.length / 4, uniqueWindows: landed,
    bytes: { boxFace: boxFace.byteLength, faceRec: faceRec.byteLength, tileOff: tileArr.byteLength, rect: rectArr.byteLength },
  };
  fs.writeFileSync(path.join(OUT, `window-faces-${SET}.json`), JSON.stringify(manifest, null, 2));

  const MB = (n) => `${(n / 1e6).toFixed(2)} MB`;
  console.log('=== BAKED  data/window-faces-' + SET + '.bin\n');
  console.log(`  boxFace   ${String(B.length).padStart(9)} boxes        ${MB(boxFace.byteLength)}`);
  console.log(`  faceRec   ${String(glassBoxes.length * 6).padStart(9)} face slots   ${MB(faceRec.byteLength)}`);
  console.log(`  tileOff   ${String(nTiles).padStart(9)} tiles        ${MB(tileArr.byteLength)}`);
  console.log(`  rect      ${String(rectArr.length / 4).padStart(9)} entries      ${MB(rectArr.byteLength)}`);
  console.log(`            (${landed.toLocaleString()} windows + ${dup.toLocaleString()} tile-straddle duplicates)`);
  const total = boxFace.byteLength + faceRec.byteLength + tileArr.byteLength + rectArr.byteLength;
  console.log(`\n  TOTAL     ${MB(total)}   <- raw. This is what we look at before optimising anything.`);
  const perTile = (rectArr.length / 4) / nTiles;
  console.log(`\n  mean windows per tile ${perTile.toFixed(1)}   <- the fragment's inner loop (was 222 at p99, unbucketed)`);

  // ── the debug cloud: every window, and WHY ────────────────────────────────
  // Gitignored. This exists to answer a question a number cannot: is a rejected window really
  // interior glass, or is it a real facade our box cloud does not cover?
  fs.writeFileSync(path.join(OUT, `window-debug-${SET}.bin`), Buffer.concat([
    Buffer.from(Float32Array.from(dbgXYZ).buffer),
    Buffer.from(Uint8Array.from(dbgWhy).buffer),
  ]));
  const why = [0, 0, 0, 0, 0];
  for (const r of dbgWhy) why[r]++;
  fs.writeFileSync(path.join(OUT, `window-debug-${SET}.json`), JSON.stringify({
    set: SET, margin: MARGIN, count: dbgWhy.length,
    legend: {
      0: 'LANDED — painted on a box face (cyan)',
      1: 'TOO DEEP — >margin inside the box. Interior glass, OR a facade our boxes missed (RED)',
      2: 'OFF THE SIDE — the face points the right way but the window is past its edge (ORANGE)',
      3: 'NO BOX — no box anywhere near it (MAGENTA)',
      4: 'NO FACE that way — should be ~0 now the boxes are oriented (YELLOW)',
    },
    counts: { landed: why[0], deep: why[1], offside: why[2], nobox: why[3], nonormal: why[4] },
  }, null, 2));
  console.log(`\n=== DEBUG CLOUD  data/window-debug-${SET}.bin   ${MB(dbgWhy.length * 13)}  (?windebug)`);
  console.log(`  LANDED   ${String(why[0]).padStart(9)}  cyan`);
  console.log(`  TOO DEEP ${String(why[1]).padStart(9)}  RED      <- interior glass, or a hole in our box cloud?`);
  console.log(`  OFF SIDE ${String(why[2]).padStart(9)}  ORANGE`);
  console.log(`  NO BOX   ${String(why[3]).padStart(9)}  MAGENTA`);
  console.log(`  NO FACE  ${String(why[4]).padStart(9)}  YELLOW`);
  console.log();
})();
