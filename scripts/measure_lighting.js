/**
 * Lighting metering harness — measures scene brightness across the envelope
 * defined in scripts/lighting-envelope.json (poses × sun times × themes).
 *
 * Drives a real installed Chrome via puppeteer-core (WebGPU needs it; no
 * bundled Chromium download), screenshots the 3D canvas element only, and
 * computes display-referred luminance stats per frame with sharp.
 *
 * Usage:
 *   node scripts/measure_lighting.js                 # full sweep, all themes
 *   node scripts/measure_lighting.js --quick         # quickSunSweep × first theme
 *   node scripts/measure_lighting.js --theme game    # single theme
 *   node scripts/measure_lighting.js --headless      # hide the Chrome window
 *   node scripts/measure_lighting.js --out <dir>     # report dir (default .claude/tmp/lighting-report)
 *
 * Output: <out>/report.json, <out>/sheet-<theme>.png (labelled contact sheet
 * with per-frame stats), and a console table flagging provisional-bound
 * violations. Frames: <out>/frames/<theme>/<pose>@<sun>.png
 *
 * Gotchas handled:
 *   - Compute culling lags camera teleports (buildings missing at the new
 *     pose). setPose() does the confirmed zoom-out/in nudge + settle waits.
 *   - Theme must be PINNED, not inherited — localStorage is seeded before the
 *     app boots (a stray stored preference silently flips every measurement).
 *   - Pins/districts overlays are disabled before measuring (calibration
 *     rule: overlays off); shadows stay ON — usability mode measures the real
 *     default viewing condition.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const sharp = require('sharp');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'lighting-envelope.json'), 'utf8'));

const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const optOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const QUICK = hasFlag('quick');
const OUT_DIR = path.resolve(ROOT, optOf('out', path.join('.claude', 'tmp', 'lighting-report')));
const THEMES = optOf('theme', null) ? [optOf('theme', null)] : (QUICK ? SPEC.themes.slice(0, 1) : SPEC.themes);
const SUNS = QUICK ? SPEC.quickSunSweep : SPEC.sunSweepSliderMinutes;
const PORT = Number(optOf('port', 3614));
const VIEW = { width: 1600, height: 940 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Static file server (no deps — the page just needs same-origin fetch) ──
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.dds': 'application/octet-stream',
  '.bin': 'application/octet-stream', '.ico': 'image/x-icon',
};
function startServer(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// ── Page helpers ──────────────────────────────────────────────────────────
async function waitForScene(page) {
  await page.waitForFunction(() => {
    const st = window.NCZ?.ThreeScene?.getCameraState?.();
    const loadingEl = document.querySelector('.scene-loading');
    const loading = loadingEl && loadingEl.offsetParent !== null;
    return !!st && !loading;
  }, { timeout: 120_000, polling: 500 });
}

// Teleport with the cull-nudge workaround: compute culling can lag a camera
// jump and leave buildings missing — zoom out ~3% and back in, with settles.
async function setPose(page, pose) {
  const apply = (position) => page.evaluate((t, p) => {
    window.NCZ.ThreeScene.setCameraState({ target: t, position: p });
  }, pose.target, position);
  const nudged = pose.position.map((v, i) => pose.target[i] + (v - pose.target[i]) * 1.03);
  await apply(pose.position);
  await sleep(150);
  await apply(nudged);
  await sleep(150);
  await apply(pose.position);
  await sleep(450); // cull compute + shadow refit + render settle
}

async function setSun(page, minutes) {
  await page.evaluate((m) => {
    const s = document.getElementById('scene-sun-slider');
    s.value = m;
    s.dispatchEvent(new Event('input'));
  }, minutes);
  await sleep(350); // shadow map re-render
}

// ── Metrics: display-referred relative luminance stats from raw pixels ────
async function frameStats(pngBuffer) {
  const { data, info } = await sharp(pngBuffer).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const hist = new Uint32Array(256);
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += ch) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    hist[Math.min(255, Math.round(y))]++;
    sum += y;
    n++;
  }
  const pct = (k) => { // luminance value at the k-th percentile
    const target = (k / 100) * n;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v / 255; }
    return 1;
  };
  let black = 0, clip = 0;
  for (let v = 0; v <= Math.round(0.02 * 255); v++) black += hist[v];
  for (let v = Math.round(0.97 * 255); v < 256; v++) clip += hist[v];
  return {
    mean: +(sum / n / 255).toFixed(4),
    median: +pct(50).toFixed(4),
    p5: +pct(5).toFixed(4),
    p95: +pct(95).toFixed(4),
    blackPct: +(100 * black / n).toFixed(2),
    clipPct: +(100 * clip / n).toFixed(2),
  };
}

function boundFlags(s) {
  const b = SPEC.provisionalBounds;
  const flags = [];
  if (s.median < b.medianMin) flags.push('DARK');
  if (s.median > b.medianMax) flags.push('BRIGHT');
  if (s.clipPct > b.clipMaxPct) flags.push('CLIP');
  if (s.blackPct > b.blackMaxPct) flags.push('CRUSH');
  return flags;
}

// ── Contact sheet ─────────────────────────────────────────────────────────
async function buildSheet(theme, frames, outFile) {
  const W = 560, H = 330, LABEL = 44;
  const cols = SUNS.length, rows = SPEC.poses.length;
  const thumbs = [];
  for (const f of frames) {
    const img = await sharp(f.file).resize(W, H, { fit: 'cover' }).toBuffer();
    const flagTxt = f.flags.length ? '  ⚠ ' + f.flags.join(',') : '';
    const label = Buffer.from(
      `<svg width="${W}" height="${LABEL}"><rect width="100%" height="100%" fill="black" opacity="0.8"/>` +
      `<text x="6" y="17" font-size="14" font-family="monospace" fill="#00f0ff">${f.pose} @ ${f.sunLabel}</text>` +
      `<text x="6" y="36" font-size="13" font-family="monospace" fill="${f.flags.length ? '#ff6159' : '#9fba8c'}">med ${f.stats.median} p5 ${f.stats.p5} p95 ${f.stats.p95} blk ${f.stats.blackPct}% clp ${f.stats.clipPct}%${flagTxt}</text></svg>`
    );
    thumbs.push(await sharp({ create: { width: W, height: H + LABEL, channels: 3, background: '#101018' } })
      .composite([{ input: img, top: LABEL, left: 0 }, { input: label, top: 0, left: 0 }]).png().toBuffer());
  }
  const sheet = sharp({ create: { width: cols * (W + 8), height: rows * (H + LABEL + 8), channels: 3, background: '#06060a' } });
  await sheet.composite(thumbs.map((t, i) => ({
    input: t,
    left: (i % cols) * (W + 8),
    top: Math.floor(i / cols) * (H + LABEL + 8),
  }))).png().toFile(outFile);
}

// ── Main ──────────────────────────────────────────────────────────────────
(async () => {
  fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });
  const server = await startServer(PORT);
  const browser = await puppeteer.launch({
    channel: 'chrome',
    headless: hasFlag('headless') ? 'new' : false,
    args: ['--enable-unsafe-webgpu', '--hide-scrollbars', `--window-size=${VIEW.width + 20},${VIEW.height + 120}`],
    defaultViewport: { ...VIEW, deviceScaleFactor: 1 },
  });

  const report = { startedAt: new Date().toISOString(), themes: {}, spec: { suns: SUNS, bounds: SPEC.provisionalBounds } };
  const sunLabel = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  try {
    for (const theme of THEMES) {
      console.log(`\n━━ theme: ${theme} ━━`);
      const page = await browser.newPage();
      // Pin the theme BEFORE the app boots — a stray stored preference
      // otherwise flips every measurement (observed in the wild). Same for the
      // first-visit welcome modal: a fresh profile shows it over the canvas
      // and it contaminates every frame until dismissed.
      await page.evaluateOnNewDocument((t) => {
        localStorage.setItem('nc_theme_id', t);
        sessionStorage.setItem('nc_zoning_board_visited', 'true');
      }, theme);
      await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await waitForScene(page);
      // Calibration rule: overlays off. Shadows ON = real default condition.
      // Also hide the UI panels that float over the canvas (legend + sun bar):
      // element screenshots capture overlaying DOM, and those pixels would
      // count toward the luminance stats. visibility:hidden keeps the sun
      // slider responsive to programmatic input events.
      await page.evaluate(() => {
        NCZ.ThreeScene.setLayerVisibility('districts', false);
        NCZ.ThreeScene.setLayerVisibility('pins', false);
        NCZ.ThreeScene.setShadowsEnabled(true);
        const style = document.createElement('style');
        style.textContent = '#overlay-controls, #scene-controls, #sidebar, #sidebar-open { visibility: hidden !important; }';
        document.head.appendChild(style);
      });
      const canvas = await page.$('#map-3d canvas');
      if (!canvas) throw new Error('3D canvas not found — is the SCHEMA view active?');

      const frames = [];
      const themeDir = path.join(OUT_DIR, 'frames', theme);
      fs.mkdirSync(themeDir, { recursive: true });

      for (const pose of SPEC.poses) {
        for (const sun of SUNS) {
          await setSun(page, sun);
          await setPose(page, pose);
          const file = path.join(themeDir, `${pose.id}@${sunLabel(sun).replace(':', '')}.png`);
          const buf = await canvas.screenshot();
          fs.writeFileSync(file, buf);
          const stats = await frameStats(buf);
          const flags = boundFlags(stats);
          frames.push({ pose: pose.id, sun, sunLabel: sunLabel(sun), file, stats, flags });
          console.log(
            `${pose.id.padEnd(20)} ${sunLabel(sun)}  med ${String(stats.median).padEnd(7)} ` +
            `p5 ${String(stats.p5).padEnd(7)} p95 ${String(stats.p95).padEnd(7)} ` +
            `blk ${String(stats.blackPct + '%').padEnd(7)} clp ${String(stats.clipPct + '%').padEnd(7)} ${flags.join(',')}`
          );
        }
      }

      await buildSheet(theme, frames, path.join(OUT_DIR, `sheet-${theme}.png`));
      report.themes[theme] = frames.map(({ file, ...rest }) => ({ ...rest, file: path.relative(OUT_DIR, file) }));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  const all = Object.values(report.themes).flat();
  const bad = all.filter((f) => f.flags.length);
  console.log(`\n${all.length} frames measured, ${bad.length} outside provisional bounds.`);
  console.log(`Report: ${path.join(OUT_DIR, 'report.json')}`);
  for (const t of Object.keys(report.themes)) console.log(`Sheet:  ${path.join(OUT_DIR, `sheet-${t}.png`)}`);
  process.exitCode = bad.length ? 2 : 0; // regression-gate friendly
})().catch((err) => { console.error(err); process.exit(1); });
