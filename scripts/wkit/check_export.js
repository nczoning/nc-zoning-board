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

let since = 0;   // 0 ⇒ count every .glb on disk, and watch the TOTAL settle
const s = arg('--since', null);
if (s) {
  const [h, m] = s.split(':').map(Number);
  const d = new Date(); d.setHours(h, m || 0, 0, 0);
  since = d.getTime();
  // A --since in the FUTURE makes `written` stick at 0 forever. The settle rule then sees a
  // number that never changes, calls it quiet, and reports the export DEAD while it is running
  // flat out. That is not hypothetical — it happened on the first run of this script (--since
  // 23:05, passed at 22:5x), which declared `SHORT BY 2,242 — the export stopped early` while
  // the on-disk count was visibly climbing two columns to the left.
  //
  // A meter that cannot move is not a meter. Refuse, loudly, rather than measure nothing.
  if (since > Date.now()) {
    console.error(`\n--since ${s} is in the FUTURE. Nothing can be newer than it, so "written" would`);
    console.error('stay 0 and this script would report the export dead. Refusing.\n');
    process.exit(2);
  }
}

// WHICH METER IS HONEST DEPENDS ON THE EXPORT.
//   SKIP_EXISTING on  (the default) ⇒ every write is a NEW file ⇒ the TOTAL is a true meter.
//   SKIP_EXISTING off (a full re-export) ⇒ it OVERWRITES, the total barely moves, and only
//                                          --since can see the work. Use it, with a real time.

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
// RATE MUST BE MEASURED FROM PROGRESS, NOT FROM THE ABSOLUTE COUNT.
// Dividing the total on disk by the watcher's own uptime says "1,195/min, ETA 2 min" thirty
// seconds after starting — because most of that total was already there. It reads as good news
// and it is arithmetic about nothing. Baseline at the first sample and measure the delta.
let n0 = null;

console.log(`\nwatching ${RAW}`);
console.log(since ? `counting writes since ${new Date(since).toLocaleTimeString()}` : 'counting every .glb (no --since)');
console.log(EXPECT ? `expecting ${EXPECT.toLocaleString()}\n` : '');

const tick = () => {
  const { total, written, proxy } = scan();
  const n = since ? written : total;
  const mins = (Date.now() - t0) / 60000;

  if (n0 === null) n0 = n;                       // baseline: what was already on disk
  if (n !== last) { last = n; lastChange = Date.now(); }
  const quiet = (Date.now() - lastChange) / 1000;

  const rate = mins > 0 ? (n - n0) / mins : 0;   // progress since WE started, not the total
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
