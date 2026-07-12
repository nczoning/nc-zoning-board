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
const WIDTH = 640;        // working downscale; hue + area fractions are scale-invariant
const QUALITY = 3;        // ffmpeg -q:v (2 = best, 5 = meh). 3 keeps neon edges clean.
const VIDEO_RE = /\.(mp4|mkv|mov|avi)$/i;

// FULL-SIZE ARCHIVE. The working frames/ are 640 px (all the pixel pass needs, and
// the model is no better at 1280 — measured). The originals are worth keeping
// anyway: they're a reusable Night City reference library, and a candidate for a
// public gallery. WebP q88 at native 1440p is ~6x smaller than PNG with no visible
// loss on neon, and is directly web-servable.
// Set ARCHIVE=off to skip, or ARCHIVE=<path> to relocate.
const ARCHIVE = process.env.ARCHIVE === 'off' ? null
  : (process.env.ARCHIVE || 'E:\\Cyberpunk Cityscapes');
const ARCHIVE_QUALITY = 88;

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
// --archive-only: build the full-size archive for a clip whose working frames/
// already exist, WITHOUT re-extracting (and thereby resurrecting) frames that have
// already been culled by hand. The archive is then pruned to match frames/, so the
// two stay in step and the archive remains the cull's source of truth.
const ARCHIVE_ONLY = args.includes('--archive-only');
// --reset: with --force, deliberately DISCARD the existing hand-cull and start over
// from the raw video. Without it, --force preserves the cull (see below).
const RESET = args.includes('--reset');
const FILTER = args.find((a) => !a.startsWith('--'));

// The committed cull manifest (scripts/feel-culled-frames.json). Authoritative
// record of every frame culled by hand — see scripts/feel_cull.js.
const MANIFEST_PATH = path.join(__dirname, 'feel-culled-frames.json');
const MANIFEST = fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  : { culled: {} };
const posix = (p) => p.split(path.sep).join('/');

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
  const stem = path.basename(video).replace(VIDEO_RE, '');   // e.g. kabuki_roof
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const existing = fs.readdirSync(framesDir).filter((f) => f.startsWith(stem + '__t'));
  if (existing.length && !FORCE && !ARCHIVE_ONLY) {
    console.log(`[feel] skip ${stem} — ${existing.length} frames already extracted (--force to redo)`);
    totalFrames += existing.length;
    continue;
  }

  // PRESERVE THE HAND-CULL ACROSS A RE-EXTRACT.
  // Frames showing the world map / menus / glitches are culled by eye. A naive
  // re-extract resurrects every one of them, in BOTH outputs, silently — and a map
  // screen is a full-frame wall of the exact cyan and red we measure.
  //
  // Two sources, checked in order:
  //   1. scripts/feel-culled-frames.json — the COMMITTED manifest, keyed by clip
  //      stem and holding ffmpeg FRAME INDICES. Authoritative, and the only source
  //      that survives an archive rebuild or a fresh clone.
  //   2. whatever the archive currently holds — the fallback when a clip has been
  //      culled but not yet recorded (run `node scripts/feel_cull.js`).
  // --reset deliberately discards the cull and starts over from the raw video.
  let dropIdx = null;     // Set of frame INDICES to delete after extraction
  let keepIdx = null;     // Set of frame INDICES to keep (archive-derived fallback)
  if (!RESET) {
    const listed = MANIFEST.culled?.[posix(path.relative(ROOT, dir))]?.[stem];
    if (listed?.length) {
      dropIdx = new Set(listed);
      console.log(`[feel] ${stem}: honouring the cull manifest (${listed.length} frames will be dropped)`);
    } else if (FORCE && ARCHIVE) {
      const archDir = path.join(ARCHIVE, path.relative(ROOT, dir));
      if (fs.existsSync(archDir)) {
        const have = fs.readdirSync(archDir)
          .filter((f) => f.startsWith(stem + '__t') && f.endsWith('.webp'))
          .map((f) => Number(f.match(/_(\d+)\.webp$/)[1]));
        if (have.length) {
          keepIdx = new Set(have);
          console.log(`[feel] ${stem}: --force preserving the archive's cull (${have.length} kept; run feel_cull.js to record it properly)`);
        }
      }
    }
  }
  // Unified predicate, by frame index — the index is what ffmpeg hands us, and it
  // is stable across the timestamp-rounding in the filename.
  const isCulled = (idx) => (dropIdx ? dropIdx.has(idx) : keepIdx ? !keepIdx.has(idx) : false);

  let n = existing.length;
  if (!ARCHIVE_ONLY) {
    for (const f of existing) fs.unlinkSync(path.join(framesDir, f));

    // ffmpeg's %05d counts extracted frames, not seconds — at FPS=2, frame N is at
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
    n = 0;
    for (const f of tmps) {
      const idx = Number(f.match(/_(\d+)\.jpg$/)[1]);          // 1-based
      const secs = (idx - 1) / FPS;
      const name = `${stem}__t${String(Math.round(secs)).padStart(4, '0')}_${String(idx).padStart(5, '0')}.jpg`;
      if (isCulled(idx)) {   // previously hand-culled — don't resurrect
        fs.unlinkSync(path.join(framesDir, f));
        continue;
      }
      fs.renameSync(path.join(framesDir, f), path.join(framesDir, name));
      n++;
    }
  }

  // Full-size archive, mirroring the district/subdistrict tree. Same filenames as
  // the working frames (minus the extension), so a culled working frame can always
  // be traced back to its original.
  if (ARCHIVE) {
    const rel = path.relative(ROOT, dir);
    const archDir = path.join(ARCHIVE, rel);
    fs.mkdirSync(archDir, { recursive: true });
    execFileSync('ffmpeg', [
      '-v', 'error', '-i', video,
      '-vf', `fps=${FPS}`,                       // native resolution — no scale filter
      '-c:v', 'libwebp', '-quality', String(ARCHIVE_QUALITY), '-compression_level', '5',
      path.join(archDir, `.tmp_${stem}_%05d.webp`),
    ], { stdio: 'inherit' });

    const atmps = fs.readdirSync(archDir).filter((f) => f.startsWith(`.tmp_${stem}_`)).sort();
    // Never resurrect a hand-culled frame in the archive either. With --archive-only
    // the working frames/ already carries the cull, so mirror that; otherwise use the
    // same manifest/archive predicate the working extraction used.
    const onlyKeep = ARCHIVE_ONLY
      ? new Set(fs.readdirSync(framesDir).filter((f) => f.startsWith(stem + '__t')).map((f) => f.replace(/\.jpg$/, '')))
      : null;
    let bytes = 0, kept = 0, pruned = 0;
    for (const f of atmps) {
      const idx = Number(f.match(/_(\d+)\.webp$/)[1]);
      const secs = (idx - 1) / FPS;
      const out = `${stem}__t${String(Math.round(secs)).padStart(4, '0')}_${String(idx).padStart(5, '0')}.webp`;
      const drop = onlyKeep ? !onlyKeep.has(out.replace(/\.webp$/, '')) : isCulled(idx);
      if (drop) {
        fs.unlinkSync(path.join(archDir, f)); pruned++; continue;
      }
      fs.renameSync(path.join(archDir, f), path.join(archDir, out));
      bytes += fs.statSync(path.join(archDir, out)).size;
      kept++;
    }
    console.log(`[feel] ${stem}: ${n} frames → frames/ (${WIDTH}px)  +  ${kept} full-size → ${archDir} (${(bytes / 1e6).toFixed(0)} MB)` +
      (pruned ? `  [${pruned} pruned to match the existing cull]` : ''));
  } else {
    console.log(`[feel] ${stem}: ${n} frames → ${path.relative(process.cwd(), framesDir)}`);
  }
  totalFrames += n;
}

console.log(`\n[feel] ${videos.length} clip(s), ${totalFrames} frames.`);
console.log('[feel] Now CULL BY EYE: delete any frame showing the world map, a menu, or a');
console.log('       loading screen. The timestamp is in the filename (…__t0037_00075.jpg).');
console.log('[feel] Then: node scripts/feel_profile.js');
