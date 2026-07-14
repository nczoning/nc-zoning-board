#!/usr/bin/env node
/**
 * scripts/wkit/check_export.js
 * ─────────────────────────────────────────────────────────────────────────
 * VERIFY A WOLVENKIT GLB EXPORT — FROM OUTSIDE, AND ONLY ONCE IT HAS STOPPED MOVING.
 *
 * `wkit.ExportFiles()` is ASYNCHRONOUS. It returns immediately and writes on a background
 * thread. A wscript cannot sleep, so it cannot check its own work — and when it tried, it
 * reported `ONLY 798/2257 .glb FILES EXIST — 1459 MISSING` 0.9 seconds in. Nothing was wrong.
 * It did the same thing again on 2026-07-14 (2257/5429). Both were false alarms.
 *
 * A count is only evidence once it has stopped changing. That is what this does.
 *
 * ─── AND IT WATCHES WRITES, NOT THE TOTAL ────────────────────────────────────
 * The obvious meter — "has the .glb count stopped rising?" — is WRONG, and wrong in the
 * dangerous direction. The export OVERWRITES meshes already on disk, and an overwrite does not
 * move the total. A long run of overwrites is indistinguishable from a finished export, so the
 * obvious meter reports SUCCESS in the middle of the run.
 *
 * Count files written INSIDE this run instead. That sees overwrites, and it cannot mistake
 * "busy re-exporting" for "done".
 *
 * Usage:
 *   node scripts/wkit/check_export.js                 # watch until settled
 *   node scripts/wkit/check_export.js --expect 4509   # ...and fail loudly if it settles short
 *   node scripts/wkit/check_export.js --since "22:24" # writes counted from this clock time today
 */
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (f, d) => (process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : d);
const RAW = arg('--raw', 'd:/Modding/CP2077 Mods/MyMods/map_data_export/source/raw');
const EXPECT = parseInt(arg('--expect', '0'), 10);
const QUIET_MS = parseInt(arg('--quiet', '150'), 10) * 1000;   // no new writes for this long ⇒ settled
const POLL_MS = 20_000;

let since = Date.now();
const s = arg('--since', null);
if (s) {
  const [h, m] = s.split(':').map(Number);
  const d = new Date(); d.setHours(h, m || 0, 0, 0);
  since = d.getTime();
} else {
  since = 0;   // no --since ⇒ count every .glb on disk, and watch the TOTAL settle
}

function scan() {
  let total = 0, written = 0, proxy = 0;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.glb')) {
        total++;
        if (p.includes(`${path.sep}proxy${path.sep}`)) proxy++;
        let mt = 0;
        try { mt = fs.statSync(p).mtimeMs; } catch { /* mid-write */ }
        if (mt >= since) written++;
      }
    }
  };
  walk(RAW);
  return { total, written, proxy };
}

const t0 = Date.now();
let last = -1, lastChange = Date.now();

console.log(`\nwatching ${RAW}`);
console.log(since ? `counting writes since ${new Date(since).toLocaleTimeString()}` : 'counting every .glb (no --since)');
console.log(EXPECT ? `expecting ${EXPECT.toLocaleString()}\n` : '');

const tick = () => {
  const { total, written, proxy } = scan();
  const n = since ? written : total;
  const mins = (Date.now() - t0) / 60000;

  if (n !== last) { last = n; lastChange = Date.now(); }
  const quiet = (Date.now() - lastChange) / 1000;

  const rate = mins > 0 ? n / mins : 0;
  const eta = EXPECT && rate > 0 ? (EXPECT - n) / rate : 0;
  console.log(
    `[${mins.toFixed(1).padStart(5)} min] ${since ? 'written' : 'total'} ${String(n).padStart(5)}`
    + (EXPECT ? `/${EXPECT}` : '')
    + `  on disk ${String(total).padStart(5)}  proxy ${String(proxy).padStart(5)}`
    + `  ${rate.toFixed(0).padStart(4)}/min`
    + (EXPECT && eta > 0 ? `  ETA ${eta.toFixed(0).padStart(4)} min` : '')
    + `  quiet ${quiet.toFixed(0)}s`,
  );

  if (Date.now() - lastChange >= QUIET_MS) {
    console.log(`\n=== SETTLED — no new writes for ${(QUIET_MS / 1000).toFixed(0)}s ===`);
    console.log(`  .glb on disk   ${total.toLocaleString()}`);
    console.log(`  under \\proxy\\  ${proxy.toLocaleString()}`);
    if (since) console.log(`  written this run ${written.toLocaleString()}`);
    if (EXPECT && total < EXPECT) {
      console.log(`\n  *** SHORT BY ${(EXPECT - total).toLocaleString()}. The export stopped early.`);
      console.log('  *** Do NOT rebuild — you would bake against a partial library.\n');
      process.exit(1);
    }
    console.log('\n  next: node scripts/rebuild_night_data.js\n');
    process.exit(0);
  }
  setTimeout(tick, POLL_MS);
};
tick();
