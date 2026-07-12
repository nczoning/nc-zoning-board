#!/usr/bin/env node
/**
 * scripts/feel_cull.js
 * ─────────────────────────────────────────────────────────────────────────
 * Record the hand-cull as a durable, committed manifest.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Frames showing the world map, menus, loading screens or render glitches are
 * culled BY EYE from the full-size archive on E: (that's where they're browsed).
 * The cull must survive a re-extract — a world-map frame is a full-frame wall of
 * the exact cyan and red we measure, so letting one back in is not a small error.
 *
 * HOW IT FINDS THE CULL — and the bug that shaped this
 * ───────────────────────────────────────────────────
 * The first version diffed frames/ against the archive: "in frames/ but not in the
 * archive ⇒ culled". That only sees frames deleted from ONE store. Frames deleted
 * from BOTH (an earlier cull, or one already propagated) are invisible to it — and
 * a --force re-extract duly resurrected eight world-map frames into Kabuki's roof
 * pass, silently.
 *
 * So the cull is now derived from GAPS IN THE FRAME INDEX. ffmpeg numbers frames
 * 1..N contiguously; any index missing from the sequence was culled, no matter
 * which store it was deleted from. Indices, not filenames, because the index is
 * what ffmpeg hands us at re-extraction time.
 *
 * TAIL CULLS. A frame culled from the very END of a clip leaves no gap, just a
 * shorter tail — invisible to gap detection. (This is not hypothetical: Araska
 * Waterfront's 5 culls were all at the end of street2.) So N is taken as
 *
 *     N = max(highest index present, floor(clip duration x FPS))
 *
 * with the duration read from the video by ffprobe. Taking the max is deliberate:
 * ffmpeg's fps filter sometimes emits one frame more than floor(dur x fps), so
 * trusting ffprobe alone would clip a real frame. Over-estimating N is harmless —
 * an index that never existed simply never matches anything.
 *
 * Usage
 * ─────
 *   node scripts/feel_cull.js            # record the cull → manifest; prune frames/ + archive to match
 *   node scripts/feel_cull.js --check    # report only, change nothing (exit 1 on drift)
 *   node scripts/feel_cull.js --apply    # re-apply the manifest (after a re-extract / fresh clone)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '_lighting_demo', 'game_examples');
const ARCHIVE = process.env.ARCHIVE === 'off' ? null : (process.env.ARCHIVE || 'E:\\Cyberpunk Cityscapes');
const MANIFEST = path.join(__dirname, 'feel-culled-frames.json');
const FPS = 2;   // must match feel_extract.js

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const APPLY = args.includes('--apply');

const posix = (p) => p.split(path.sep).join('/');
const idxOf = (f) => Number(f.match(/_(\d+)\.(jpg|webp)$/)[1]);
const stemOf = (f) => f.split('__t')[0];
// The filename ffmpeg's output is renamed to — deterministic from the index.
const nameFor = (stem, idx) =>
  `${stem}__t${String(Math.round((idx - 1) / FPS)).padStart(4, '0')}_${String(idx).padStart(5, '0')}`;

// How many frames the clip SHOULD yield at FPS — from the video, not from what
// happens to be on disk. 0 if the source video is missing (nothing to infer).
function expectedFrames(subDir, stem) {
  for (const ext of ['mp4', 'mkv', 'mov', 'avi']) {
    const v = path.join(subDir, `${stem}.${ext}`);
    if (!fs.existsSync(v)) continue;
    try {
      const dur = Number(execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v,
      ]).toString().trim());
      return Number.isFinite(dur) ? Math.floor(dur * FPS) : 0;
    } catch { return 0; }
  }
  return 0;
}

function findFrameDirs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === 'frames') out.push(p);
    else if (e.name !== 'legacy_photos') findFrameDirs(p, out);
  }
  return out;
}

const loadManifest = () => (fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { culled: {} });

// ── --apply: manifest → delete the listed frames from frames/ and the archive ──
if (APPLY) {
  const man = loadManifest();
  let removed = 0;
  for (const [sub, clips] of Object.entries(man.culled)) {
    for (const [stem, indices] of Object.entries(clips)) {
      for (const idx of indices) {
        const name = nameFor(stem, idx);
        const j = path.join(ROOT, sub, 'frames', name + '.jpg');
        if (fs.existsSync(j)) { fs.unlinkSync(j); removed++; }
        if (ARCHIVE) {
          const w = path.join(ARCHIVE, sub, name + '.webp');
          if (fs.existsSync(w)) { fs.unlinkSync(w); removed++; }
        }
      }
    }
  }
  console.log(`[cull] applied manifest — removed ${removed} file(s).`);
  process.exit(0);
}

// ── record / check ────────────────────────────────────────────────────────────
const man = loadManifest();
const culled = {};
let totalPresent = 0, totalCulled = 0, prunedF = 0, prunedA = 0;

for (const fdir of findFrameDirs(ROOT)) {
  const sub = posix(path.relative(ROOT, path.dirname(fdir)));
  const adir = ARCHIVE ? path.join(ARCHIVE, sub) : null;
  const fFiles = fs.readdirSync(fdir).filter((f) => f.endsWith('.jpg'));
  const aFiles = adir && fs.existsSync(adir) ? fs.readdirSync(adir).filter((f) => f.endsWith('.webp')) : [];
  if (!fFiles.length) continue;

  const byStem = {};
  for (const f of fFiles) (byStem[stemOf(f)] ||= { frames: new Set(), arch: new Set() }).frames.add(idxOf(f));
  for (const f of aFiles) (byStem[stemOf(f)] ||= { frames: new Set(), arch: new Set() }).arch.add(idxOf(f));

  for (const [stem, s] of Object.entries(byStem)) {
    // N = max(highest index in either store, floor(clip duration x FPS)) — the
    // ffprobe term is what catches TAIL culls (see the header).
    const prior = man.culled?.[sub]?.[stem] || [];
    let maxIdx = Math.max(0, ...s.frames, ...s.arch, ...prior);
    const expected = expectedFrames(path.dirname(fdir), stem);
    if (expected > maxIdx) {
      console.log(`[cull] ${sub}/${stem}: video implies ${expected} frames, highest present is ${maxIdx} ⇒ ${expected - maxIdx} tail frame(s) culled`);
      maxIdx = expected;
    }
    if (!maxIdx) continue;

    const gaps = [];
    for (let i = 1; i <= maxIdx; i++) {
      if (!s.frames.has(i) || !s.arch.has(i)) gaps.push(i);   // missing from EITHER store ⇒ culled
    }
    // Union with what's already recorded — never lose an entry.
    const merged = [...new Set([...prior, ...gaps])].sort((a, b) => a - b);
    if (merged.length) ((culled[sub] ||= {})[stem] = merged);
    totalPresent += s.frames.size;
    totalCulled += merged.length;

    if (!CHECK) {
      // Propagate the cull to BOTH stores so they agree.
      for (const idx of merged) {
        const name = nameFor(stem, idx);
        const j = path.join(fdir, name + '.jpg');
        if (fs.existsSync(j)) { fs.unlinkSync(j); prunedF++; }
        if (adir) {
          const w = path.join(adir, name + '.webp');
          if (fs.existsSync(w)) { fs.unlinkSync(w); prunedA++; }
        }
      }
    }
  }
}

if (CHECK) {
  console.log(`[cull] ${totalPresent} frames present, ${totalCulled} culled across the set.`);
  process.exit(0);
}

const count = Object.values(culled).reduce((a, c) => a + Object.values(c).reduce((x, y) => x + y.length, 0), 0);
const out = {
  _note: 'Frames culled by hand from the night-feel reference capture (world map, menus, loading ' +
    'screens, render glitches). Stored as ffmpeg FRAME INDICES per clip — indices, not names, ' +
    'because the index is what a re-extract hands us, and gaps in the index catch frames deleted ' +
    'from either or both stores. Regenerate: node scripts/feel_cull.js. Re-apply after a ' +
    're-extract: node scripts/feel_cull.js --apply. See the header for the tail-cull limitation.',
  count,
  culled: Object.fromEntries(Object.entries(culled).sort()),
};
fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n');

console.log(`[cull] recorded ${count} culled frame(s) across ${Object.keys(culled).length} subdistrict(s)`);
console.log(`[cull] pruned ${prunedF} from frames/, ${prunedA} from the archive (both now agree)`);
console.log(`[cull] manifest → ${path.relative(process.cwd(), MANIFEST)}  (commit this)`);
