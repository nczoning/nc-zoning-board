#!/usr/bin/env node
/**
 * scripts/feel_extract.js
 * ─────────────────────────────────────────────────────────────────────────
 * Step 1 of the night-feel pipeline: capture videos → extracted frames.
 *
 *   _lighting_demo/game_examples/<District>/<Sub>/<id>__<pass>.mp4
 *        │
 *        └─ffmpeg 2 fps─► <District>/<Sub>/frames/<id>__<pass>__t0037.jpg
 *
 * The frames are KEPT on disk (not a temp dir) so they can be reviewed and
 * culled by hand before measurement. The timestamp in each filename is the
 * point in the clip it came from, so a bad stretch (e.g. the world map being
 * open at t=37s) is easy to find and delete:
 *
 *     rm frames/*__t003[6-9].jpg
 *
 * Anything deleted from frames/ simply never reaches the pixel or model pass.
 * That hand-cull is deliberate: an automatic UI detector was tried and it
 * false-positived on clean cool-toned cityscapes (headlight streams read as
 * map-screen cyan). Eyes beat a heuristic here.
 *
 * Idempotent: a clip whose frames/ output already exists is skipped unless
 * --force. Existing legacy screenshots live in <Sub>/legacy_photos/ and are
 * untouched by this script.
 *
 * Run:  node scripts/feel_extract.js            # all new videos
 *       node scripts/feel_extract.js --force    # re-extract everything
 *       node scripts/feel_extract.js kabuki     # only clips matching a substring
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '_lighting_demo', 'game_examples');
const FPS = 2;            // frames per second of clip — the pixel pass wants density, it is cheap
const WIDTH = 640;        // downscale; hue + area fractions are scale-invariant
const QUALITY = 3;        // ffmpeg -q:v (2 = best, 5 = meh). 3 keeps neon edges clean.
const VIDEO_RE = /\.(mp4|mkv|mov|avi)$/i;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const FILTER = args.find((a) => !a.startsWith('--'));

function findVideos(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'frames' || e.name === 'legacy_photos') continue;
      findVideos(p, out);
    } else if (VIDEO_RE.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

if (!fs.existsSync(ROOT)) {
  console.error(`[feel] no ${path.relative(process.cwd(), ROOT)} — nothing to do.`);
  process.exit(1);
}

const videos = findVideos(ROOT).filter((v) => !FILTER || v.toLowerCase().includes(FILTER.toLowerCase()));
if (!videos.length) {
  console.log('[feel] no videos found.' + (FILTER ? ` (filter: "${FILTER}")` : ''));
  process.exit(0);
}

let totalFrames = 0;
for (const video of videos) {
  const dir = path.dirname(video);
  const stem = path.basename(video).replace(VIDEO_RE, '');   // e.g. kabuki__roof
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const existing = fs.readdirSync(framesDir).filter((f) => f.startsWith(stem + '__t'));
  if (existing.length && !FORCE) {
    console.log(`[feel] skip ${stem} — ${existing.length} frames already extracted (--force to redo)`);
    totalFrames += existing.length;
    continue;
  }
  for (const f of existing) fs.unlinkSync(path.join(framesDir, f));

  // %04d counts extracted frames, not seconds — so at FPS=2, frame N is at
  // t = (N-1)/FPS. We rename to the real timestamp below so the filename means
  // something when culling by eye.
  const tmp = path.join(framesDir, `.tmp_${stem}_%05d.jpg`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-i', video,
    '-vf', `fps=${FPS},scale=${WIDTH}:-1`,
    '-q:v', String(QUALITY),
    tmp,
  ], { stdio: 'inherit' });

  const tmps = fs.readdirSync(framesDir).filter((f) => f.startsWith(`.tmp_${stem}_`)).sort();
  let n = 0;
  for (const f of tmps) {
    const idx = Number(f.match(/_(\d+)\.jpg$/)[1]);          // 1-based
    const secs = (idx - 1) / FPS;
    const name = `${stem}__t${String(Math.round(secs)).padStart(4, '0')}_${String(idx).padStart(5, '0')}.jpg`;
    fs.renameSync(path.join(framesDir, f), path.join(framesDir, name));
    n++;
  }
  totalFrames += n;
  console.log(`[feel] ${stem}: ${n} frames → ${path.relative(process.cwd(), framesDir)}`);
}

console.log(`\n[feel] ${videos.length} clip(s), ${totalFrames} frames.`);
console.log('[feel] Now CULL BY EYE: delete any frame showing the world map, a menu, or a');
console.log('       loading screen. The timestamp is in the filename (…__t0037_00075.jpg).');
console.log('[feel] Then: node scripts/feel_profile.js');
