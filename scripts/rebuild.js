#!/usr/bin/env node
/**
 * rebuild.js: the whole per-district pipeline as ONE command, with the
 * previous-run comparison built into the output.
 *
 * For each district: district_hull -> score_hull -> encode_hull_dds, metrics
 * parsed from their stdout, appended to data/run-log.jsonl, and DIFFED against
 * the district's previous run. Two controls this session kept paying for are
 * automatic here:
 *
 *   - identical metrics after a change that should move them means the change
 *     did not fire; the diff says IDENTICAL loudly instead of leaving it to
 *     be noticed;
 *   - a fix is only live where it was re-encoded, so the default district set
 *     is EVERY district with stage-1 data on disk, not the one being poked.
 *
 * Usage:
 *   node scripts/rebuild.js                        # all districts with boxes on disk
 *   node scripts/rebuild.js city_center            # one district
 *   node scripts/rebuild.js watson -- --airmax 0.1 # extra hull flags after --
 *   node scripts/rebuild.js --verbose              # stream child output too
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, '..');
const dataDir = path.join(repo, 'data');
const logFile = path.join(dataDir, 'run-log.jsonl');

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const extraHull = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
const own = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
const verbose = own.includes('--verbose');
let districts = own.filter(a => !a.startsWith('--'));
if (!districts.length) {
  districts = fs.readdirSync(dataDir)
    .map(f => f.match(/^district-boxes-(.+)\.bin$/))
    .filter(Boolean).map(m => m[1]);
}

const rev = (() => {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  return (r.stdout || '?').trim() + (dirty.stdout && dirty.stdout.trim() ? '+dirty' : '');
})();

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (verbose) { process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); }
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r.stdout || '';
}

const num = (s, re) => { const m = s.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };

/**
 * Stage 1 is part of the pipeline, so it reruns when its script is newer than
 * the bin it produced. Without this the box layout can change (a new slot, a
 * new field) and every district except the one rebuilt by hand keeps feeding
 * the old layout to stage 2, which reads the stride from the meta and carries
 * on quietly with the new code disabled. That is the stale-DDS failure again
 * one stage earlier: the run looks clean and the change is simply not in it.
 */
function stage1IfStale(district) {
  const bin = path.join(dataDir, `district-boxes-${district}.bin`);
  const src = path.join(repo, 'scripts', 'district_boxes.js');
  if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return false;
  console.log('  stage 1   rerunning district_boxes.js (bin older than the script)');
  run('node', ['scripts/district_boxes.js', district]);
  return true;
}

function metricsFor(district) {
  stage1IfStale(district);
  const hull = run('node', ['--max-old-space-size=12288', 'scripts/district_hull.js', district, '--voxel', '2', ...extraHull]);
  const score = run('node', ['scripts/score_hull.js', district, '--cloud', 'hull']);
  const enc = run('node', ['scripts/encode_hull_dds.js', district]);
  return {
    boxes: num(hull, /BOXES\s+([\d,]+) after greedy merge/),
    axis: num(hull, /\(([\d,]+) axis/),
    oriented: num(hull, /axis \+ ([\d,]+) oriented/),
    rotatedPlacements: num(hull, /rotated\s+([\d,]+) placements/),
    cells: num(hull, /voxelised ([\d,]+) cells/),
    neverGeometry: num(hull, /([\d,]+) never-geometry/),
    within05: num(score, /within {2}0\.5 m\s+([\d.]+)%/),
    within1: num(score, /within {4}1 m\s+([\d.]+)%/),
    within2: num(score, /within {4}2 m\s+([\d.]+)%/),
    swallowedPct: num(score, /= ([\d.]+)% of every window/),
    depthP50: num(score, /depth p50 ([\d.]+) m/),
    slots: num(enc, /([\d,]+) slots/),
    ddsMB: num(enc, /([\d.]+) MB/),
  };
}

function lastEntry(district) {
  if (!fs.existsSync(logFile)) return null;
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    if (e.district === district) return e;
  }
  return null;
}

for (const district of districts) {
  const t0 = Date.now();
  console.log(`\n=== ${district} (${rev}${extraHull.length ? ' ' + extraHull.join(' ') : ''}) ===`);
  const m = metricsFor(district);
  const prev = lastEntry(district);
  const entry = { ts: new Date().toISOString(), district, rev, extraHull, minutes: +((Date.now() - t0) / 60000).toFixed(1), metrics: m };
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

  const rows = [
    ['boxes', 'boxes'], ['oriented', 'oriented'], ['within 0.5 m %', 'within05'],
    ['within 1 m %', 'within1'], ['swallowed %', 'swallowedPct'], ['depth p50 m', 'depthP50'],
    ['dds MB', 'ddsMB'],
  ];
  let allSame = prev !== null;
  for (const [label, key] of rows) {
    const now = m[key], was = prev ? prev.metrics[key] : null;
    if (was !== null && was !== undefined && now !== was) allSame = false;
    const delta = (was === null || was === undefined || now === null) ? ''
      : (now === was ? '  (=)' : `  (${now > was ? '+' : ''}${+(now - was).toFixed(2)})`);
    console.log(`  ${label.padEnd(16)} ${String(now).padStart(10)}${delta}`);
  }
  if (prev && allSame) {
    console.log('  *** IDENTICAL to the previous run. If this run carried a change, the change DID NOT FIRE.');
  }
  console.log(`  ${entry.minutes} min; log: data/run-log.jsonl`);
}
