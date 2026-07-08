#!/usr/bin/env node
/**
 * scripts/tune_segment.js
 * ─────────────────────────────────────────────────────────────────────────
 * Building segmentation by HEIGHT DISCONTINUITY (the evidence-backed splitter —
 * see tune_probe_megablob: downtown is one solid footprint, but the height field
 * resolves individual buildings). Morphology-AGNOSTIC: segments by roof-height
 * plateaus separated by cliffs, so flat / round / horizontal / vertical
 * structures each come out as their own region — no "fat-bottom" assumption.
 *
 * Algorithm:
 *   1. Ground grid (cell = CELL). Per cell: roof = max box-top elevation.
 *   2. Region-grow: 8-adjacent occupied cells join one building iff |Δroof| < DH.
 *      A height cliff (|Δroof| ≥ DH) is a building boundary.
 *   3. Absorb tiny regions (< MIN_CELLS) into the adjacent region they share the
 *      most border with (kills roof-step slivers).
 *   4. Box → region by its centroid cell.
 *
 * Headless; renders colour-per-building PNGs. No shader change yet.
 * Output: cap/segment_<d>_dh<DH>.png + _lighting_demo/tune/SEGMENT.md
 * Run: node scripts/tune_segment.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const L = require('./tune_lib.js');

const OUT_DIR = path.join(L.ROOT, '_lighting_demo', 'tune');
const CAP_DIR = path.join(OUT_DIR, 'cap');
const TARGETS = ['city_center', 'watson'];
const CELL = 8;             // ground-grid cell (CET)
const DH_SWEEP = [10, 18, 30];  // roof-height cliff threshold (CET) — granularity knob
const RENDER_DH = 18;
const MIN_CELLS = 3;       // regions smaller than this get absorbed
const OUT_MAX_PX = 1100;

const P = {
  WINDOW_MIN_HEIGHT: L.NCZ.WINDOW_MIN_HEIGHT, WINDOW_HEIGHT_BAND: L.NCZ.WINDOW_HEIGHT_BAND,
  ARCH_VERTICALITY_LO: L.NCZ.ARCH_VERTICALITY_LO, ARCH_VERTICALITY_HI: L.NCZ.ARCH_VERTICALITY_HI,
  ARCH_FOOTPRINT_BIG: L.NCZ.ARCH_FOOTPRINT_BIG, ARCH_MIN_FOOTPRINT: L.NCZ.ARCH_MIN_FOOTPRINT,
  ARCH_PODIUM_HEIGHT_LO: L.NCZ.ARCH_PODIUM_HEIGHT_LO, ARCH_PODIUM_HEIGHT_HI: L.NCZ.ARCH_PODIUM_HEIGHT_HI,
  ARCH_MAX_ELONGATION: L.NCZ.ARCH_MAX_ELONGATION,
};

function buildGrid(decoded) {
  const { bcx, bcz, bhx, bhz, bcy, bhy, count } = decoded;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    if (bcx[i] - bhx[i] < minX) minX = bcx[i] - bhx[i];
    if (bcx[i] + bhx[i] > maxX) maxX = bcx[i] + bhx[i];
    if (bcz[i] - bhz[i] < minZ) minZ = bcz[i] - bhz[i];
    if (bcz[i] + bhz[i] > maxZ) maxZ = bcz[i] + bhz[i];
  }
  const col0 = Math.floor(minX / CELL), row0 = Math.floor(minZ / CELL);
  const cols = Math.floor(maxX / CELL) - col0 + 1, rows = Math.floor(maxZ / CELL) - row0 + 1;
  const roof = new Float32Array(cols * rows).fill(-Infinity);
  const occ = new Uint8Array(cols * rows);
  for (let i = 0; i < count; i++) {
    const c0 = Math.floor((bcx[i] - bhx[i]) / CELL) - col0, c1 = Math.min(Math.floor((bcx[i] + bhx[i]) / CELL) - col0, Math.floor((bcx[i] - bhx[i]) / CELL) - col0 + 12);
    const r0 = Math.floor((bcz[i] - bhz[i]) / CELL) - row0, r1 = Math.min(Math.floor((bcz[i] + bhz[i]) / CELL) - row0, Math.floor((bcz[i] - bhz[i]) / CELL) - row0 + 12);
    const t = bcy[i] + bhy[i];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * cols + c; occ[k] = 1; if (t > roof[k]) roof[k] = t;
    }
  }
  return { cols, rows, roof, occ, col0, row0 };
}

// Region-grow by roof-height similarity.
function segment(g, DH) {
  const { cols, rows, roof, occ } = g;
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes = [];
  const stack = [];
  let next = 0;
  for (let s = 0; s < occ.length; s++) {
    if (!occ[s] || label[s] !== -1) continue;
    const id = next++; label[s] = id; stack.length = 0; stack.push(s);
    let size = 0;
    while (stack.length) {
      const k = stack.pop(); size++;
      const r = (k / cols) | 0, c = k % cols, h = roof[k];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const nk = nr * cols + nc;
        if (occ[nk] && label[nk] === -1 && Math.abs(roof[nk] - h) < DH) { label[nk] = id; stack.push(nk); }
      }
    }
    sizes.push(size);
  }
  absorbTiny(g, label, sizes);
  return { label, sizes };
}

// Absorb sub-MIN_CELLS regions into the adjacent region they border most.
function absorbTiny(g, label, sizes) {
  const { cols, rows, occ } = g;
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < occ.length; k++) {
      if (!occ[k]) continue;
      const id = label[k];
      if (sizes[id] >= MIN_CELLS) continue;
      // find dominant neighbour label
      const r = (k / cols) | 0, c = k % cols;
      const tally = new Map();
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const nk = nr * cols + nc;
        if (occ[nk] && label[nk] !== id) tally.set(label[nk], (tally.get(label[nk]) || 0) + 1);
      }
      let best = -1, bestN = 0;
      for (const [lab, n] of tally) if (n > bestN) { best = lab; bestN = n; }
      if (best >= 0) { sizes[best]++; sizes[id]--; label[k] = best; changed = true; }
    }
  }
}

function aggregate(decoded, g, label) {
  const { bcx, bcy, bcz, bhx, bhy, bhz, count } = decoded;
  const { cols, col0, row0 } = g;
  const agg = new Map();
  for (let i = 0; i < count; i++) {
    const c = Math.floor(bcx[i] / CELL) - col0, r = Math.floor(bcz[i] / CELL) - row0;
    const lab = label[r * cols + c];
    if (lab === undefined || lab < 0) continue;
    let a = agg.get(lab);
    if (!a) { a = { size: 0, minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }; agg.set(lab, a); }
    a.size++;
    if (bcx[i]-bhx[i]<a.minX) a.minX=bcx[i]-bhx[i]; if (bcx[i]+bhx[i]>a.maxX) a.maxX=bcx[i]+bhx[i];
    if (bcy[i]-bhy[i]<a.minY) a.minY=bcy[i]-bhy[i]; if (bcy[i]+bhy[i]>a.maxY) a.maxY=bcy[i]+bhy[i];
    if (bcz[i]-bhz[i]<a.minZ) a.minZ=bcz[i]-bhz[i]; if (bcz[i]+bhz[i]>a.maxZ) a.maxZ=bcz[i]+bhz[i];
  }
  const buildings = [];
  for (const a of agg.values()) {
    const fx = (a.maxX - a.minX) * 0.5, fz = (a.maxZ - a.minZ) * 0.5;
    buildings.push({ size: a.size, h: (a.maxY - a.minY) * 0.5, fMax: Math.max(fx, fz), fMin: Math.min(fx, fz) });
  }
  return buildings;
}

function stats(buildings, boxCount) {
  const sizes = buildings.map((b) => b.size).sort((a, b) => b - a);
  const cc = {};
  for (const b of buildings) { const c = L.classifyBuilding(b.h, b.fMax, b.fMin, P).cls; cc[c] = (cc[c] || 0) + 1; }
  return { count: buildings.length, largestShare: (sizes[0] || 0) / Math.max(boxCount, 1), cc };
}

function hashColor(id) {
  const h = (id * 2654435761) >>> 0;
  return [70 + (h & 0x9f), 70 + ((h >> 8) & 0x9f), 70 + ((h >> 16) & 0x9f)];
}
async function renderSeg(g, label, sizes, file) {
  const { cols, rows, occ } = g;
  const buf = Buffer.alloc(cols * rows * 3);
  for (let k = 0; k < occ.length; k++) {
    if (!occ[k]) continue;
    const id = label[k];
    const [r, gg, b] = hashColor(id);
    buf[k * 3] = r; buf[k * 3 + 1] = gg; buf[k * 3 + 2] = b;
  }
  const scale = Math.max(1, Math.floor(OUT_MAX_PX / Math.max(cols, rows)));
  await sharp(buf, { raw: { width: cols, height: rows, channels: 3 } })
    .resize(cols * scale, rows * scale, { kernel: 'nearest' }).png().toFile(file);
}

async function main() {
  fs.mkdirSync(CAP_DIR, { recursive: true });
  const O = [];
  O.push('# Height-discontinuity segmentation — prototype\n');
  O.push(`_Generated by \`scripts/tune_segment.js\`. CELL=${CELL} CET, MIN_CELLS=${MIN_CELLS}. Renders in \`cap/\`._\n`);
  O.push('Region-grow over the roof-height field; a |Δroof| ≥ DH cliff is a building');
  O.push('boundary. Compare to union-find (one megablob, ~80% in the largest cluster).\n');
  O.push('| cloud | DH | buildings | largest% | short | thin | elong | podium | tower | block |');
  O.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const name of TARGETS) {
    const meta = L.DISTRICTS.find((m) => m.name === name);
    const d = L.decodeDistrict(meta);
    const g = buildGrid(d);
    for (const DH of DH_SWEEP) {
      const { label, sizes } = segment(g, DH);
      const b = aggregate(d, g, label);
      const s = stats(b, d.count);
      const c = s.cc;
      O.push(`| ${name} | ${DH} | **${s.count}** | ${(s.largestShare*100).toFixed(1)}% | ${c.short||0} | ${c.thin||0} | ${c.elongated||0} | ${c.podium||0} | ${c.tower||0} | ${c.block||0} |`);
      console.log(`${name.padEnd(13)} DH=${String(DH).padStart(2)} → ${String(s.count).padStart(5)} buildings, largest ${(s.largestShare*100).toFixed(1)}%`);
      if (DH === RENDER_DH) await renderSeg(g, label, sizes, path.join(CAP_DIR, `segment_${name}_dh${DH}.png`));
    }
  }
  O.push('');
  O.push(`Render: \`segment_<d>_dh${RENDER_DH}.png\` — each colour is one segmented building.\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'SEGMENT.md'), O.join('\n'));
  console.log(`\nDone. See _lighting_demo/tune/SEGMENT.md and cap/segment_*.png`);
}

main();
