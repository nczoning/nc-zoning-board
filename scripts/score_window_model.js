#!/usr/bin/env node
/**
 * scripts/score_window_model.js
 * ─────────────────────────────────────────────────────────────────────────
 * SCORE A WINDOW MODEL AGAINST THE GAME'S REAL WINDOWS.
 *
 * Every window model this project has shipped was tuned BY EYE. That is how we got a 24 x 18 m
 * grid (each "window" 291x the area of a real one) and a hash deciding which cells glow. Nobody
 * was being careless — there was nothing to check against.
 *
 * There is now. `data/window-faces-{set}.bin` holds 768,736 REAL windows, each already landed on
 * the face of one of our boxes, in that face's own (u, v) metres. So a model can be asked the only
 * question that matters:
 *
 *     Of the real windows, what fraction does the model put a window ON?
 *
 * "On" = a model window centre within TOL metres of the real window centre. Reported at several
 * tolerances because one number hides the shape of the failure.
 *
 * ─── WHY BOTH NUMBERS ────────────────────────────────────────────────────────
 * RECALL alone is gameable: a grid with a 10 cm pitch scores ~100% recall and is a solid wall of
 * light. So we also report PRECISION — of the windows the model DRAWS, what fraction is near a
 * real one. A model that lights the right city has to win both.
 *
 * ─── THE MODELS ──────────────────────────────────────────────────────────────
 *   shipping   24.00 x 18.00 m, phase 0   what three-scene.js draws TODAY (WINDOW_CELL_W/H)
 *   measured    2.33 x  4.00 m, phase 0   the real median pitch. The KICKOFF's proposal.
 *   measured+   2.33 x  4.00 m, BEST phase per face   the kickoff, given a free gift
 *   oracle      BEST pitch AND phase per face, fitted from that face's OWN real windows
 *
 * `oracle` is the one that decides it. It is not shippable — it needs per-face params fitted from
 * the very windows we are trying to predict, which is more data than just carrying the rectangles.
 * It is the CEILING on any lattice model whatsoever. If the ceiling is low, no procedural grid can
 * be rescued by better constants, and window_faces.js's call ("only 31% of facades are regular
 * lattices, so a pitch/phase model would be a lie for two thirds of the city") is confirmed with a
 * number rather than an assertion.
 *
 * Usage:  node scripts/score_window_model.js [--set fixed] [--sample 20000]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const SET = arg('--set', 'fixed');
const SAMPLE = parseInt(arg('--sample', '0'), 10);   // 0 = every face
const TOLS = [0.25, 0.50, 1.00];                     // metres

const DATA = path.join(__dirname, '..', 'data');
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, `window-faces-${SET}.json`), 'utf8'));
const buf = fs.readFileSync(path.join(DATA, `window-faces-${SET}.bin`));

const EMPTY = 0xffffffff;
const Q = manifest.quant;

// The four arrays, laid out back to back exactly as window_faces.js concatenated them.
let o = 0;
const boxFace = new Uint32Array(buf.buffer, buf.byteOffset + o, manifest.bytes.boxFace / 4); o += manifest.bytes.boxFace;
const faceRec = new Uint32Array(buf.buffer, buf.byteOffset + o, manifest.bytes.faceRec / 4); o += manifest.bytes.faceRec;
const tileOff = new Uint32Array(buf.buffer, buf.byteOffset + o, manifest.bytes.tileOff / 4); o += manifest.bytes.tileOff;
const rect    = new Uint16Array(buf.buffer, buf.byteOffset + o, manifest.bytes.rect / 2);

console.log(`\ndata/window-faces-${SET}.bin`);
console.log(`  ${manifest.boxes.toLocaleString()} boxes, ${manifest.glassBoxes.toLocaleString()} with glass`);
console.log(`  ${manifest.faces.toLocaleString()} faces carrying ${manifest.uniqueWindows.toLocaleString()} real windows\n`);

// ── pull one face's UNIQUE windows ──────────────────────────────────────────
// A window straddling a tile edge was written into every tile it touches, so the rect list has
// 1,075,215 entries for 768,736 windows. Dedupe or the duplicates get scored twice — and they are
// not uniformly distributed (a big window straddles more tiles), so they would silently weight the
// score toward large panes.
function faceWindows(rec) {
  const tileStart = faceRec[rec];
  if (tileStart === EMPTY) return null;
  const packed = faceRec[rec + 1];
  const tu = packed & 0xff, tv = (packed >> 8) & 0xff;
  const uSize = faceRec[rec + 2] / Q, vSize = faceRec[rec + 3] / Q;

  const seen = new Set();
  const w = [];
  for (let t = 0; t < tu * tv; t++) {
    const a = tileOff[tileStart + t], b = tileOff[tileStart + t + 1];
    for (let i = a; i < b; i++) {
      const k = rect[i * 4] * 4294967296 + rect[i * 4 + 1] * 65536 + rect[i * 4 + 2];  // u,v,w
      if (seen.has(k)) continue;
      seen.add(k);
      w.push({ u: rect[i * 4] / Q, v: rect[i * 4 + 1] / Q });
    }
  }
  return { u: w, uSize, vSize, win: w };
}

// ── fit a 1-D lattice to a face's real window coordinates ───────────────────
// Median gap between DISTINCT coordinates = the pitch (same estimator window_faces.js used, so
// `oracle` and the 31%-regular figure are measuring the same thing). Phase = the offset that
// minimises the mean distance from each real coordinate to the nearest lattice line.
function fitAxis(vals) {
  const u = [...new Set(vals.map((x) => +x.toFixed(2)))].sort((a, b) => a - b);
  if (u.length < 2) return { pitch: 0, phase: u[0] ?? 0 };
  const gaps = [];
  for (let i = 1; i < u.length; i++) gaps.push(u[i] - u[i - 1]);
  gaps.sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)];
  if (!(pitch > 0.05)) return { pitch: 0, phase: u[0] };
  return { pitch, phase: bestPhase(vals, pitch) };
}

// Best phase for a KNOWN pitch: sweep it. Closed-form (circular mean) is the textbook answer and
// it is wrong here — the residuals are not von Mises, they are multi-modal (a facade often has two
// window columns offset by half a pitch), and the circular mean lands between them, fitting neither.
function bestPhase(vals, pitch) {
  let best = 0, bestErr = Infinity;
  for (let s = 0; s < 32; s++) {
    const ph = (s / 32) * pitch;
    let err = 0;
    for (const x of vals) {
      const d = Math.abs(((x - ph) / pitch) % 1);
      err += Math.min(d, 1 - d) * pitch;
    }
    if (err < bestErr) { bestErr = err; best = ph; }
  }
  return best;
}

// Distance from a coordinate to the nearest lattice line at (pitch, phase).
const toLattice = (x, pitch, phase) => {
  if (!(pitch > 0)) return Math.abs(x - phase);
  const d = Math.abs(((x - phase) / pitch) % 1);
  return Math.min(d, 1 - d) * pitch;
};

// ── the models ──────────────────────────────────────────────────────────────
// Each returns {pu, pv, phu, phv} for a face. A model window sits at every lattice intersection.
const MODELS = {
  shipping:   (f) => ({ pu: 24.0, pv: 18.0, phu: 12.0, phv: 9.0 }),      // cell CENTRES: floor(x/24)+0.5
  measured:   (f) => ({ pu: 2.33, pv: 4.00, phu: 1.165, phv: 2.0 }),
  'measured+':(f) => ({ pu: 2.33, pv: 4.00,
                        phu: bestPhase(f.win.map((w) => w.u), 2.33),
                        phv: bestPhase(f.win.map((w) => w.v), 4.00) }),
  oracle:     (f) => ({ ...bestLattice(f.win.map((w) => w.u)), ...bestLattice(f.win.map((w) => w.v), true) }),
};

// A TRUE per-face ceiling. The median-gap estimator in fitAxis() is an ESTIMATOR, not an
// optimiser — it was written to answer "is this face regular?", and on an irregular face it
// happily returns a pitch that fits nothing. Used as a ceiling it is not even an upper bound:
// it scored WORSE than the fixed 2.33 m grid at ±1 m, which is impossible for a real optimum.
//
// So search. Every pitch from 1.0 to 8.0 m, every phase within it, keep whichever lattice lands
// nearest to the most of this face's own windows. That is the best any grid could POSSIBLY do
// here — fitted to the very data it is scored against, per face, which is already more per-face
// state than a procedural model is allowed. Nothing shippable can beat it.
function bestLattice(vals, isV) {
  let best = { pitch: 2.33, phase: 0 }, bestHit = -1;
  for (let p = 1.0; p <= 8.001; p += 0.05) {
    const ph = bestPhase(vals, p);
    let n = 0;
    for (const x of vals) if (toLattice(x, p, ph) <= 0.25) n++;
    if (n > bestHit) { bestHit = n; best = { pitch: p, phase: ph }; }
  }
  return isV ? { pv: best.pitch, phv: best.phase } : { pu: best.pitch, phu: best.phase };
}

// ── score ───────────────────────────────────────────────────────────────────
// RECALL    : real windows the model lands on.
// PRECISION : model windows that land on a real one. Estimated from the model's window COUNT on
//             the face (pu x pv lattice over the face) vs how many of them are near a real window.
//             A grid draws a window at every intersection, including over blank wall.
const names = Object.keys(MODELS);
const hit = {}, drawn = {}, hitDrawn = {};
for (const n of names) { hit[n] = TOLS.map(() => 0); drawn[n] = 0; hitDrawn[n] = TOLS.map(() => 0); }
let totalReal = 0, facesScored = 0;

const glassBoxes = manifest.glassBoxes;
const step = SAMPLE > 0 ? Math.max(1, Math.floor((glassBoxes * 6) / SAMPLE)) : 1;

for (let gi = 0; gi < glassBoxes; gi++) {
  for (let f = 0; f < 6; f++) {
    const slot = gi * 6 + f;
    if (slot % step !== 0) continue;
    const face = faceWindows(slot * 4);
    if (!face || face.win.length === 0) continue;
    facesScored++;
    totalReal += face.win.length;

    for (const n of names) {
      const m = MODELS[n](face);
      if (!(m.pu > 0) || !(m.pv > 0)) continue;

      // RECALL — every real window, how far to the nearest lattice intersection.
      for (const w of face.win) {
        const du = toLattice(w.u, m.pu, m.phu);
        const dv = toLattice(w.v, m.pv, m.phv);
        const d = Math.hypot(du, dv);
        for (let t = 0; t < TOLS.length; t++) if (d <= TOLS[t]) hit[n][t]++;
      }

      // PRECISION — walk the lattice over the face; how many drawn windows sit near a real one?
      const nu = Math.floor(face.uSize / m.pu) + 1;
      const nv = Math.floor(face.vSize / m.pv) + 1;
      if (nu * nv > 200000) continue;                     // a degenerate sub-cm pitch; skip, don't hang
      for (let i = 0; i < nu; i++) {
        const cu = m.phu + i * m.pu;
        if (cu > face.uSize) continue;
        for (let j = 0; j < nv; j++) {
          const cv = m.phv + j * m.pv;
          if (cv > face.vSize) continue;
          drawn[n]++;
          let best = Infinity;
          for (const w of face.win) {
            const d = Math.hypot(w.u - cu, w.v - cv);
            if (d < best) best = d;
          }
          for (let t = 0; t < TOLS.length; t++) if (best <= TOLS[t]) hitDrawn[n][t]++;
        }
      }
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
console.log(`scored ${facesScored.toLocaleString()} faces / ${totalReal.toLocaleString()} real windows`
  + (step > 1 ? `   (1-in-${step} face sample)` : '   (every face)') + '\n');

console.log('RECALL — of the game\'s real windows, how many does the model put a window on?\n');
console.log('  model        ' + TOLS.map((t) => `±${t.toFixed(2)}m`.padStart(9)).join('') + '     grid');
console.log('  ' + '─'.repeat(56));
for (const n of names) {
  const g = n === 'oracle' ? 'per-face fit' : n === 'measured+' ? '2.33x4.00 +phase' : n === 'measured' ? '2.33 x 4.00' : '24.0 x 18.0';
  console.log(`  ${n.padEnd(12)}` + TOLS.map((_, t) => pct(hit[n][t], totalReal).padStart(9)).join('') + `     ${g}`);
}

console.log('\nPRECISION — of the windows the model DRAWS, how many are on a real one?\n');
console.log('  model        ' + TOLS.map((t) => `±${t.toFixed(2)}m`.padStart(9)).join('') + '     drawn');
console.log('  ' + '─'.repeat(56));
for (const n of names) {
  console.log(`  ${n.padEnd(12)}` + TOLS.map((_, t) => pct(hitDrawn[n][t], drawn[n]).padStart(9)).join('')
    + `     ${drawn[n].toLocaleString()}`);
}

console.log('\n  A model has to win BOTH. High recall with low precision is a wall of light;');
console.log('  high precision with low recall is a dark city with a few right windows.\n');
console.log('  `oracle` is the CEILING for any lattice model — pitch AND phase fitted per face from');
console.log('  the very windows it is being scored against. Nothing procedural can beat it. If it is');
console.log('  low, the facades are not lattices and the rectangles have to be carried.\n');
