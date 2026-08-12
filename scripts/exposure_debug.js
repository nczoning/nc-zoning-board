#!/usr/bin/env node
/**
 * exposure_debug.js: pack the visibility verdict into something the browser
 * can draw, so the claim gets checked by eye instead of trusted.
 *
 * exposure.js says 44.5% of placed geometry cannot be reached by any camera
 * the map allows. That is a large claim resting on a ray test, and the way to
 * falsify it is direct: draw the hidden placements in red. Every red pixel
 * visible on screen is a placement the test called unreachable while the
 * camera reaches it, which is a bug. An empty screen is the verdict holding.
 *
 * Output is per district, and deliberately not the stage-1 bin: that is 60 to
 * 128 MB of placement records at 20 floats each, most of it fields the debug
 * view never reads. This writes the ten floats a box needs plus the verdict.
 *
 * Usage:
 *   node scripts/exposure_debug.js                 # every district with exposure data
 *   node scripts/exposure_debug.js watson --minsize 2
 *
 * Output: data/exposure-boxes-<district>.bin
 *           float32 x10 per placement: centre xyz, half-extent xyz, quat xyzw
 *           followed by one uint8 verdict per placement, in the same order
 *         data/exposure-boxes-<district>.json  counts and the byte layout
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i > 0 ? Number(args[i + 1]) : d; };
const MIN_SIZE = flag('minsize', 0.5);

const dataDir = path.join(__dirname, '..', 'data');
let districts = args.filter(a => !a.startsWith('--') && !/^[\d.]+$/.test(a));
if (!districts.length) {
  districts = fs.readdirSync(dataDir)
    .map(f => f.match(/^exposure-([^.]+)\.bin$/))
    .filter(Boolean).map(m => m[1]);
}
if (!districts.length) {
  console.error('no data/exposure-<district>.bin found; run scripts/exposure.js first');
  process.exit(1);
}

for (const name of districts) {
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, `district-boxes-${name}.json`), 'utf8'));
  const raw = fs.readFileSync(path.join(dataDir, `district-boxes-${name}.bin`));
  const box = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const verdict = new Uint8Array(fs.readFileSync(path.join(dataDir, `exposure-${name}.bin`)));
  const S = meta.stride, nBox = meta.boxes;

  // Two passes: count first, so the output is exactly sized rather than
  // grown. A 1.2M-placement district otherwise reallocates its way through
  // several hundred megabytes.
  let n = 0;
  for (let i = 0; i < nBox && i < verdict.length; i++) {
    const v = verdict[i];
    if (v !== 1 && v !== 2) continue;                       // untested or no geometry
    const o = i * S;
    if (Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2 < MIN_SIZE) continue;
    n++;
  }

  const geo = new Float32Array(n * 10);
  const ver = new Uint8Array(n);
  let k = 0, visible = 0, hidden = 0;
  for (let i = 0; i < nBox && i < verdict.length; i++) {
    const v = verdict[i];
    if (v !== 1 && v !== 2) continue;
    const o = i * S;
    if (Math.max(box[o + 3], box[o + 4], box[o + 5]) * 2 < MIN_SIZE) continue;
    const g = k * 10;
    geo[g] = box[o]; geo[g + 1] = box[o + 1]; geo[g + 2] = box[o + 2];
    geo[g + 3] = box[o + 3]; geo[g + 4] = box[o + 4]; geo[g + 5] = box[o + 5];
    geo[g + 6] = box[o + 6]; geo[g + 7] = box[o + 7]; geo[g + 8] = box[o + 8]; geo[g + 9] = box[o + 9];
    ver[k] = v;
    if (v === 1) visible++; else hidden++;
    k++;
  }

  const out = Buffer.concat([Buffer.from(geo.buffer, 0, n * 40), Buffer.from(ver.buffer, 0, n)]);
  fs.writeFileSync(path.join(dataDir, `exposure-boxes-${name}.bin`), out);
  fs.writeFileSync(path.join(dataDir, `exposure-boxes-${name}.json`), JSON.stringify({
    district: name, count: n, visible, hidden, minSize: MIN_SIZE,
    layout: 'float32[count*10] centre xyz + halfExtent xyz + quat xyzw, then uint8[count] verdict',
    verdictLegend: { 1: 'visible from the camera cone', 2: 'never visible' },
    bytes: out.length, generated: new Date().toISOString(),
  }, null, 2));

  console.log(`${name}: ${n.toLocaleString()} boxes (${visible.toLocaleString()} visible, ${hidden.toLocaleString()} hidden) ` +
              `-> data/exposure-boxes-${name}.bin  ${(out.length / 1e6).toFixed(1)} MB`);
}
