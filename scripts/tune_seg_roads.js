#!/usr/bin/env node
/**
 * scripts/tune_seg_roads.js
 * ─────────────────────────────────────────────────────────────────────────
 * ROAD-AWARE segmentation lab. The building `_data.dds` has NO street gaps —
 * dense districts percolate into one footprint component, so the height
 * segmenter over-merges flat same-height areas (Watson core etc.). But the ROAD
 * network exists separately (3dmap_roads.glb). This rasterises the roads into a
 * GLOBAL grid ONCE, then per district carves the street grid out of the building
 * footprint as a BARRIER — so region-grow can't cross a street → buildings
 * separate by CITY BLOCK. HEIGHT-AWARE: a road cell is only a barrier where the
 * building roof above it is street-level (< ROAD_CLEARANCE); where a tall building
 * BRIDGES the road (roof >> road), it stays connected (buildings go over roads).
 *
 * Runs EVERY district. Headless A/B (current vs road-carved): building count,
 * largest-share, + colour-per-building PNGs. Lab only — no renderer change until
 * it validates, then the carve ports into segmentBuildings.
 *
 * Road GLB → world: renderer rotates the road scene 180° about Y, so
 * worldX = -rawX, worldZ = -rawZ, worldY = rawY (matches building bcx/bcz/bcy).
 *
 * Run: node scripts/tune_seg_roads.js [--only=watson] [--clear=40] [--dilate=1]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const L = require('./tune_lib.js');

const args = process.argv.slice(2);
const val = (k, d) => { const a = args.find((s) => s.startsWith(`--${k}=`)); return a ? parseFloat(a.split('=')[1]) : d; };
const CELL = val('cell', 8);
const DH = val('dh', 18);
const MIN_CELLS = 3;
const ROAD_DILATE = val('dilate', 1);     // widen road barrier by N cells (roads are thin)
const ROAD_CLEARANCE = val('clear', 40);  // CET roof-above-road; below = street-level (carve), above = bridge (keep)
const TRI_SPAN_CAP = val('tricap', 4000); // skip only truly degenerate full-map triangles; highways INCLUDED
const OUT_DIR = path.join(L.ROOT, '_lighting_demo', 'seg');
const ONLY = (args.find((s) => s.startsWith('--only=')) || '').split('=')[1];
const OUT_MAX_PX = 1100;

// ── GLOBAL road raster (build ONCE) ──────────────────────────────────────────
// worldX = -rawX, worldZ = -rawZ, worldY = rawY.
function loadRoadTris(absPath) {
  const buf = fs.readFileSync(absPath);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const tris = [];
  const rp = (acc, i) => { const bv = json.bufferViews[acc.bufferView]; const st = bv.byteStride || 12; const o = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0) + i * st; return [-buf.readFloatLE(o), buf.readFloatLE(o + 4), -buf.readFloatLE(o + 8)]; };
  const ri = (acc, i) => { const bv = json.bufferViews[acc.bufferView]; const o = binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0); return acc.componentType === 5123 ? buf.readUInt16LE(o + i * 2) : acc.componentType === 5125 ? buf.readUInt32LE(o + i * 4) : buf.readUInt8(o + i); };
  for (const m of json.meshes) for (const pr of m.primitives) {
    const pos = json.accessors[pr.attributes.POSITION];
    if (pr.indices != null) { const idx = json.accessors[pr.indices]; for (let i = 0; i < idx.count; i += 3) tris.push([rp(pos, ri(idx, i)), rp(pos, ri(idx, i + 1)), rp(pos, ri(idx, i + 2))]); }
    else for (let i = 0; i < pos.count; i += 3) tris.push([rp(pos, i), rp(pos, i + 1), rp(pos, i + 2)]);
  }
  return tris;
}

// Global grid spanning the road extent. Returns lookup of road coverage + min
// road elevation by world (x, z).
function buildGlobalRoadGrid(tris) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const t of tris) for (const v of t) { if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0]; if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2]; }
  const col0 = Math.floor(minX / CELL) - 2, row0 = Math.floor(minZ / CELL) - 2;
  const cols = Math.floor(maxX / CELL) - col0 + 3, rows = Math.floor(maxZ / CELL) - row0 + 3;
  const road = new Uint8Array(cols * rows);
  const roadY = new Float32Array(cols * rows).fill(Infinity);
  let skipped = 0;
  for (const t of tris) {
    const xs = [t[0][0], t[1][0], t[2][0]], zs = [t[0][2], t[1][2], t[2][2]];
    if (Math.max(...xs) - Math.min(...xs) > TRI_SPAN_CAP || Math.max(...zs) - Math.min(...zs) > TRI_SPAN_CAP) { skipped++; continue; }
    const c0 = Math.floor(Math.min(...xs) / CELL) - col0, c1 = Math.floor(Math.max(...xs) / CELL) - col0;
    const r0 = Math.floor(Math.min(...zs) / CELL) - row0, r1 = Math.floor(Math.max(...zs) / CELL) - row0;
    const ax = t[0][0], az = t[0][2], bx = t[1][0], bz = t[1][2], cx = t[2][0], cz = t[2][2];
    const ay = t[0][1], by = t[1][1], cy = t[2][1];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const px = (c + col0 + 0.5) * CELL, pz = (r + row0 + 0.5) * CELL;
      const wa = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d;
      const wb = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d;
      const wc = 1 - wa - wb;
      if (wa >= -0.01 && wb >= -0.01 && wc >= -0.01) { const k = r * cols + c; road[k] = 1; const y = wa * ay + wb * by + wc * cy; if (y < roadY[k]) roadY[k] = y; }
    }
  }
  for (let d = 0; d < ROAD_DILATE; d++) {
    const nr = road.slice(), ny = roadY.slice();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (road[r * cols + c]) continue; let best = Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const a = r + dr, b = c + dc; if (a >= 0 && b >= 0 && a < rows && b < cols && road[a * cols + b]) best = Math.min(best, roadY[a * cols + b]); }
      if (best < Infinity) { nr[r * cols + c] = 1; ny[r * cols + c] = best; }
    }
    road.set(nr); roadY.set(ny);
  }
  console.log(`global road grid ${cols}x${rows}, ${road.reduce((a, b) => a + b, 0)} road cells (skipped ${skipped} huge tris)`);
  return {
    covered: (wx, wz) => { const c = Math.floor(wx / CELL) - col0, r = Math.floor(wz / CELL) - row0; return (r >= 0 && c >= 0 && r < rows && c < cols) ? road[r * cols + c] : 0; },
    elev: (wx, wz) => { const c = Math.floor(wx / CELL) - col0, r = Math.floor(wz / CELL) - row0; return (r >= 0 && c >= 0 && r < rows && c < cols) ? roadY[r * cols + c] : Infinity; },
  };
}

// ── district grid (same as the renderer's segmentBuildings) ──────────────────
function buildGrid(d) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < d.count; i++) { if (d.bcx[i] - d.bhx[i] < minX) minX = d.bcx[i] - d.bhx[i]; if (d.bcx[i] + d.bhx[i] > maxX) maxX = d.bcx[i] + d.bhx[i]; if (d.bcz[i] - d.bhz[i] < minZ) minZ = d.bcz[i] - d.bhz[i]; if (d.bcz[i] + d.bhz[i] > maxZ) maxZ = d.bcz[i] + d.bhz[i]; }
  const col0 = Math.floor(minX / CELL), row0 = Math.floor(minZ / CELL);
  const cols = Math.floor(maxX / CELL) - col0 + 1, rows = Math.floor(maxZ / CELL) - row0 + 1;
  const roof = new Float32Array(cols * rows).fill(-Infinity);
  const floor = new Float32Array(cols * rows).fill(Infinity);
  const occ = new Uint8Array(cols * rows);
  for (let i = 0; i < d.count; i++) {
    const c0 = Math.floor((d.bcx[i] - d.bhx[i]) / CELL) - col0, c1 = Math.min(Math.floor((d.bcx[i] + d.bhx[i]) / CELL) - col0, Math.floor((d.bcx[i] - d.bhx[i]) / CELL) - col0 + 12);
    const r0 = Math.floor((d.bcz[i] - d.bhz[i]) / CELL) - row0, r1 = Math.min(Math.floor((d.bcz[i] + d.bhz[i]) / CELL) - row0, Math.floor((d.bcz[i] - d.bhz[i]) / CELL) - row0 + 12);
    const t = d.bcy[i] + d.bhy[i], b = d.bcy[i] - d.bhy[i];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; occ[k] = 1; if (t > roof[k]) roof[k] = t; if (b < floor[k]) floor[k] = b; }
  }
  return { cols, rows, roof, floor, occ, col0, row0 };
}

// Road barrier for this district's grid, gated by STRUCTURE THICKNESS so it's
// robust to 3D: a road cell carves the footprint ONLY where it's open street OR
// the building stuff there is THIN (roof-floor < ROAD_CLEARANCE) — a surface
// street / podium deck / skywalk. Where a real (thick) building sits, the cell is
// kept connected, which correctly handles a building OVER a tunnel AND a building
// UNDER an elevated highway (both: thick structure → not carved).
function roadBarrier(g, roads) {
  const { cols, rows, col0, row0, occ, roof, floor } = g;
  const barrier = new Uint8Array(cols * rows);
  let nb = 0, bridge = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const wx = (c + col0 + 0.5) * CELL, wz = (r + row0 + 0.5) * CELL;
    if (!roads.covered(wx, wz)) continue;
    const k = r * cols + c;
    if (!occ[k]) { barrier[k] = 1; nb++; continue; }       // open street
    if (roof[k] - floor[k] < ROAD_CLEARANCE) { barrier[k] = 1; nb++; } // thin connector → carve
    else bridge++;                                          // thick building (over tunnel / under highway) → keep
  }
  return { barrier, nb, bridge };
}

function segment(g, barrier) {
  const { cols, rows, roof, occ } = g;
  const blocked = (k) => !occ[k] || (barrier && barrier[k]);
  const label = new Int32Array(cols * rows).fill(-1); const sizes = []; const stack = []; let next = 0;
  for (let s = 0; s < occ.length; s++) {
    if (blocked(s) || label[s] !== -1) continue;
    const id = next++; label[s] = id; stack.length = 0; stack.push(s); let size = 0;
    while (stack.length) { const k = stack.pop(); size++; const r = (k / cols) | 0, c = k % cols, h = roof[k];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const nr = r + dr, nc = c + dc; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue; const nk = nr * cols + nc; if (!blocked(nk) && label[nk] === -1 && Math.abs(roof[nk] - h) < DH) { label[nk] = id; stack.push(nk); } } }
    sizes.push(size);
  }
  let changed = true, passes = 0;
  while (changed && passes++ < 12) { changed = false;
    for (let k = 0; k < occ.length; k++) { if (blocked(k) || sizes[label[k]] >= MIN_CELLS) continue; const id = label[k], r = (k / cols) | 0, c = k % cols, tally = new Map();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const nr = r + dr, nc = c + dc; if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue; const nk = nr * cols + nc; if (!blocked(nk) && label[nk] !== id) tally.set(label[nk], (tally.get(label[nk]) || 0) + 1); }
      let best = -1, bestN = 0; for (const [lab, n] of tally) if (n > bestN) { best = lab; bestN = n; } if (best >= 0) { sizes[best]++; sizes[id]--; label[k] = best; changed = true; } }
  }
  return { label, count: next };
}

function stats(g, label) {
  const sz = new Map();
  for (let k = 0; k < g.occ.length; k++) if (g.occ[k] && label[k] >= 0) sz.set(label[k], (sz.get(label[k]) || 0) + 1);
  const sizes = [...sz.values()].sort((a, b) => b - a);
  const cells = sizes.reduce((a, b) => a + b, 0);
  return { count: sz.size, largest: (sizes[0] || 0) / Math.max(cells, 1), median: sizes[Math.floor(sizes.length / 2)] || 0 };
}

function hashColor(id) { const h = (id * 2654435761) >>> 0; return [60 + (h & 0x9f), 60 + ((h >> 8) & 0x9f), 60 + ((h >> 16) & 0x9f)]; }
async function render(g, label, barrier, file) {
  const { cols, rows, occ } = g; const b = Buffer.alloc(cols * rows * 3);
  for (let k = 0; k < occ.length; k++) { if (barrier && barrier[k]) { b[k * 3] = 20; b[k * 3 + 1] = 20; b[k * 3 + 2] = 30; continue; } if (!occ[k]) continue; const [r, gg, bl] = hashColor(label[k]); b[k * 3] = r; b[k * 3 + 1] = gg; b[k * 3 + 2] = bl; }
  const scale = Math.max(1, Math.floor(OUT_MAX_PX / Math.max(cols, rows)));
  await sharp(b, { raw: { width: cols, height: rows, channels: 3 } }).resize(cols * scale, rows * scale, { kernel: 'nearest' }).png().toFile(file);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`road-aware segmentation lab — CELL=${CELL} DH=${DH} clearance=${ROAD_CLEARANCE} dilate=${ROAD_DILATE}\n`);
  const roads = buildGlobalRoadGrid(loadRoadTris(path.join(L.ROOT, 'assets/glb-source/3dmap_roads.glb')));
  const targets = ONLY ? L.DISTRICTS.filter((m) => m.name === ONLY) : L.DISTRICTS;
  console.log('\ndistrict          curr_bld  +roads  curr_largest  +roads_largest  bridgeKept');
  for (const meta of targets) {
    let d; try { d = L.decodeDistrict(meta); } catch (e) { continue; }
    if (!d.count) continue;
    console.time(`  ${meta.name} grid`); const g = buildGrid(d); console.timeEnd(`  ${meta.name} grid`);
    console.time(`  ${meta.name} barrier`); const { barrier, bridge } = roadBarrier(g, roads); console.timeEnd(`  ${meta.name} barrier`);
    console.time(`  ${meta.name} seg`); const base = segment(g, null), wr = segment(g, barrier); console.timeEnd(`  ${meta.name} seg`);
    const sb = stats(g, base.label), sr = stats(g, wr.label);
    console.log(`${meta.name.padEnd(16)} ${String(sb.count).padStart(6)} ${String(sr.count).padStart(7)} ${(sb.largest * 100).toFixed(1).padStart(11)}% ${(sr.largest * 100).toFixed(1).padStart(13)}% ${String(bridge).padStart(10)}`);
    await render(g, base.label, null, path.join(OUT_DIR, `seg_${meta.name}_current.png`));
    await render(g, wr.label, barrier, path.join(OUT_DIR, `seg_${meta.name}_roads.png`));
  }
  console.log(`\nrenders → _lighting_demo/seg/seg_<district>_{current,roads}.png`);
}

main();
