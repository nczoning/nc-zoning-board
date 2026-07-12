#!/usr/bin/env node
/**
 * scripts/feel_profile.js
 * ─────────────────────────────────────────────────────────────────────────
 * Step 2 of the night-feel pipeline: extracted frames → per-subdistrict profile.
 *
 * Two passes over each subdistrict's frames/ folder:
 *
 *   PIXEL PASS (every frame, deterministic)   → hue, densities, warm/cool ratio
 *   MODEL PASS (1 frame per ~5 s, Ollama)     → billboards, vertical signs,
 *                                                holograms, mood
 *
 * The split is not an optimisation, it is a correctness requirement. A vision
 * model asked for `sign_density` on a Kabuki shot returned 1 (truth: 4) and
 * named the colours blue+red (truth: magenta/cyan/red). It is confidently wrong,
 * so the error survives averaging. Measure what is measurable; ask the model
 * only for meaning. See wiki/learnings/local-vlm-measures-nothing-pixels-do.
 *
 * HUE EXTRACTION IS SATURATION-LED, NOT BRIGHTNESS-LED — this is the subtle bit.
 * The obvious approach (take the BRIGHT pixels, they're the lights) measures the
 * wrong thing: bloom blows out the core of every sign to WHITE, so the brightest
 * pixels are the LEAST saturated. Raising the brightness threshold on real
 * footage drove the signage fraction from 49% to 3% and replaced Kabuki's neon
 * with the orange of its rooftop smog haze. Select on SATURATION with a modest
 * brightness floor and the true palette comes back (cyan 22 / red 21 / pink 20).
 *
 * Absolute brightness never transfers (post-tonemap, post-bloom): densities are
 * reported raw here and normalised ORDINALLY at the end, loudest district = 1.0.
 *
 * Run:  node scripts/feel_profile.js                 # all subdistricts
 *       node scripts/feel_profile.js kabuki          # one
 *       node scripts/feel_profile.js --no-model      # pixel pass only (fast)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '_lighting_demo', 'game_examples');
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';

// ── Pixel-pass thresholds ────────────────────────────────────────────────────
const V_LIGHT = 0.55;   // brightness: pixel is a light source (density metrics)
const S_WHITE = 0.25;   // below this saturation, a lit pixel is a WINDOW white
const V_HUE   = 0.40;   // hue extraction: modest brightness floor …
const S_HUE   = 0.65;   // … and a HIGH saturation gate (defeats bloom + haze)

const BINS = 12;
const HUE_NAMES = ['red', 'orange', 'amber', 'yellow-green', 'green', 'teal',
  'cyan', 'azure', 'blue', 'violet', 'magenta', 'hot-pink'];

const MOODS = ['dark', 'foggy', 'rainy', 'gaudy', 'neon-dense', 'clean', 'corpo',
  'industrial', 'residential', 'ruined', 'sparse', 'bright'];

const args = process.argv.slice(2);
const NO_MODEL = args.includes('--no-model');
const FILTER = args.find((a) => !a.startsWith('--'));

// ── Pixel pass ───────────────────────────────────────────────────────────────
async function measureFrame(file) {
  const { data, info } = await sharp(file).resize(480, null, { fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;
  const total = w * h;
  const hue = new Float64Array(BINS);
  let lit = 0, white = 0, warm = 0, cool = 0, coloured = 0;

  for (let i = 0; i < total; i++) {
    const r = data[i * c] / 255, g = data[i * c + 1] / 255, b = data[i * c + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const v = mx, s = mx ? d / mx : 0;

    if (v >= V_LIGHT) {
      lit++;
      if (s < S_WHITE) { white++; if (r > b) warm++; else cool++; }
    }
    // Hue: saturation-led. Deliberately NOT gated on the bright-core threshold.
    if (v >= V_HUE && s >= S_HUE && d > 0) {
      coloured++;
      let deg;
      if (mx === r) deg = 60 * (((g - b) / d) % 6);
      else if (mx === g) deg = 60 * ((b - r) / d + 2);
      else deg = 60 * ((r - g) / d + 4);
      if (deg < 0) deg += 360;
      hue[Math.floor(deg / (360 / BINS)) % BINS] += s;   // weight by saturation
    }
  }
  return { total, lit, white, warm, cool, coloured, hue: [...hue] };
}

// ── Model pass ───────────────────────────────────────────────────────────────
// ONE QUESTION PER CALL. This is not stylistic — a multi-field schema actively
// corrupts the answers. Measured on 14 Kabuki rooftop frames (same model, same
// images, temperature 0), asking for 6 fields at once vs 2:
//
//   6-field schema : big_billboards  1/14      <- WRONG, the frames are full of them
//   2-field schema : big_billboards 14/14      <- right
//   ...but vertical_signs moved the OTHER way (10/14 vs 6/14). The fields
//   interfere with each other. One question per call gets both right
//   (billboards 13/14, vertical signs 9/14).
//
// Cost is fine: ~4 calls x ~10 sampled frames x ~2.8 s per pass.
const QUESTIONS = {
  is_cityscape:   'Is this a view of buildings, streets or skyline? Answer false for menus, maps, loading screens or character close-ups.',
  big_billboards: 'Are there large illuminated advertising screens or billboard panels visible?',
  vertical_signs: 'Are there tall VERTICAL neon strips or blade signs running down building facades?',
  holograms:      'Are there floating or projected translucent HOLOGRAMS (not ordinary flat screens)?',
};
const SYSTEM = 'You answer one factual question about a Cyberpunk 2077 night screenshot. ' +
  'Describe only what is visible. Output only the JSON object.';

// Fail LOUDLY if the model isn't reachable or isn't there. The first version of
// this swallowed both into `semantic: null` and produced a clean-looking profile
// with the whole model pass silently missing — the failure mode to avoid.
async function preflight() {
  let tags;
  try {
    tags = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json());
  } catch {
    throw new Error(`Ollama unreachable at ${OLLAMA}. Start it (the desktop app, or\n` +
      `  OLLAMA_MODELS="D:\\LLM_Models" ollama serve\n` +
      `— note the model store is on D:, so a bare \`ollama serve\` sees NO models).`);
  }
  const have = (tags.models || []).map((m) => m.name);
  if (!have.includes(MODEL)) {
    throw new Error(`Ollama is up but has no "${MODEL}". Models present: ${have.join(', ') || '(none)'}\n` +
      `If that list is empty, the server was started without OLLAMA_MODELS=D:\\LLM_Models.`);
  }
  console.log(`[feel] model: ${MODEL} @ ${OLLAMA}`);
}

async function askOne(img, key, question, schemaProp) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,          // REQUIRED: Qwen defaults to a reasoning preamble that fights the grammar
      // Ollama takes the schema HERE, on the native endpoint. Its /v1 endpoint does
      // NOT accept OpenAI's response_format:json_schema — do not "modernise" this.
      format: { type: 'object', required: [key], properties: { [key]: schemaProp } },
      keep_alive: '10m',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question, images: [img] },
      ],
    }),
  }).then((r) => r.json());
  if (res.error) throw new Error(`Ollama: ${res.error}`);   // never swallow a server-side error
  try { return JSON.parse(res.message.content)[key]; }
  catch { return null; }                                     // a single unparseable answer is fine to drop
}

async function tagFrame(file) {
  const img = fs.readFileSync(file).toString('base64');
  const out = {};
  for (const [key, q] of Object.entries(QUESTIONS)) {
    out[key] = await askOne(img, key, q, { type: 'boolean' });
  }
  if (!out.is_cityscape) return out;   // a menu/map frame: don't bother asking about its mood
  out.mood = await askOne(img, 'mood',
    'Which of these best describe the mood of this scene? Choose up to 3.',
    { type: 'array', maxItems: 3, items: { type: 'string', enum: MOODS } }) || [];
  return out;
}

// ── Walk ─────────────────────────────────────────────────────────────────────
function findFrameDirs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === 'frames') out.push(p);
    else if (e.name !== 'legacy_photos') findFrameDirs(p, out);
  }
  return out;
}

(async () => {
  const dirs = findFrameDirs(ROOT).filter((d) => !FILTER || d.toLowerCase().includes(FILTER.toLowerCase()));
  if (!dirs.length) { console.log('[feel] no frames/ dirs — run feel_extract.js first.'); return; }
  if (!NO_MODEL) await preflight();

  const profiles = [];

  for (const framesDir of dirs) {
    const subDir = path.dirname(framesDir);
    const label = path.relative(ROOT, subDir).replace(/\\/g, '/');
    const files = fs.readdirSync(framesDir).filter((f) => /\.jpg$/i.test(f)).sort();
    if (!files.length) continue;

    // Group by pass (roof / street). Permissive on separators: `kabuki__roof`,
    // `kabuki_roof` and `kabuki-roof-2` all resolve. Anything with no recognisable
    // pass keyword lands in 'unknown' and still gets measured (just not used for
    // the street-vs-roof split).
    const passes = {};
    for (const f of files) {
      const stem = f.split('__t')[0].toLowerCase();
      const pass = /roof|sky|aerial/.test(stem) ? 'roof'
                 : /street|ground/.test(stem) ? 'street'
                 : 'unknown';
      (passes[pass] ||= []).push(f);
    }

    const rec = { label, passes: {} };
    for (const [pass, list] of Object.entries(passes)) {
      const agg = { total: 0, lit: 0, white: 0, warm: 0, cool: 0, coloured: 0, hue: new Array(BINS).fill(0) };
      for (const f of list) {
        const m = await measureFrame(path.join(framesDir, f));
        for (const k of ['total', 'lit', 'white', 'warm', 'cool', 'coloured']) agg[k] += m[k];
        for (let i = 0; i < BINS; i++) agg.hue[i] += m.hue[i];
      }
      const hueTot = agg.hue.reduce((a, b) => a + b, 0) || 1;
      const palette = agg.hue
        .map((v, i) => ({ name: HUE_NAMES[i], pct: +(100 * v / hueTot).toFixed(1) }))
        .sort((a, b) => b.pct - a.pct).filter((x) => x.pct >= 4);

      // Model pass: ~1 frame per 7.5 s of clip (frames are 2 fps ⇒ every 15th).
      // Sparser than the pixel pass because the semantic fields don't change
      // frame to frame, and each frame now costs 4-5 calls (one per question).
      let semantic = null;
      if (!NO_MODEL) {
        const sample = list.filter((_, i) => i % 15 === 0);
        const tags = [];
        for (const f of sample) {
          const t = await tagFrame(path.join(framesDir, f));
          if (t?.is_cityscape) tags.push(t);
        }
        if (tags.length) {
          const frac = (k) => tags.filter((t) => t[k]).length / tags.length;
          const band = (x) => (x >= 0.5 ? 'common' : x >= 0.2 ? 'occasional' : x > 0 ? 'rare' : 'none');
          const moodTally = {};
          for (const t of tags) for (const m of t.mood || []) moodTally[m] = (moodTally[m] || 0) + 1;
          semantic = {
            frames_tagged: tags.length,
            big_billboards: band(frac('big_billboards')),
            vertical_signs: band(frac('vertical_signs')),
            holograms: band(frac('holograms')),
            mood: Object.entries(moodTally).sort((a, b) => b[1] - a[1]).slice(0, 4).map((x) => x[0]),
          };
        }
      }

      rec.passes[pass] = {
        frames: list.length,
        lit_pct: +(100 * agg.lit / agg.total).toFixed(3),
        sign_pct: +(100 * agg.coloured / agg.total).toFixed(3),
        window_pct: +(100 * agg.white / agg.total).toFixed(3),
        warm_cool: [Math.round(100 * agg.warm / (agg.white || 1)), Math.round(100 * agg.cool / (agg.white || 1))],
        palette,
        semantic,
      };
      const p = rec.passes[pass];
      console.log(`[feel] ${label} (${pass}, ${list.length}f): sign ${p.sign_pct}%  window ${p.window_pct}%  ` +
        `warm/cool ${p.warm_cool.join('/')}  :: ${palette.map((x) => x.name + ' ' + x.pct).join('  ')}`);
    }
    profiles.push(rec);
    fs.writeFileSync(path.join(subDir, '_feel.json'), JSON.stringify(rec, null, 2));
  }

  // ── Ordinal normalisation: loudest street-pass sign density = 1.0 ──────────
  // Per the reference model, Kabuki is the loudest and everything scales DOWN.
  // Colour is taken from the STREET pass (signs seen directly); the ROOF pass is
  // haze-dominated at distance and its hue is not trustworthy — see the wiki.
  const streetSign = profiles.map((p) => p.passes.street?.sign_pct).filter((x) => x > 0);
  const loudest = Math.max(...streetSign, 0);
  if (loudest > 0) {
    console.log(`\n[feel] ordinal sign density (street pass, loudest = 1.0):`);
    for (const p of profiles) {
      const s = p.passes.street?.sign_pct;
      if (s == null) continue;
      console.log(`   ${p.label.padEnd(40)} ${(s / loudest).toFixed(2)}`);
    }
  }
  console.log(`\n[feel] wrote _feel.json for ${profiles.length} subdistrict(s).`);
})();
