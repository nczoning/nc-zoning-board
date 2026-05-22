/**
 * build_lut.js — extract the in-game 3D-map colour-grading LUT to a runtime asset.
 *
 * The CP2077 world map render-to-texture scene applies a colour grade whose
 * LDR LUT is `base/weather/24h_basic/luts/cube_cp_braindance_v001.xbm`
 * (decoded from `3dmap.envparam` — see wiki/sources/3dmap-envparam-lighting).
 * That `.xbm` is a 32×32×32 RGBA-float 3D colour cube.
 *
 * Source format — a `.cube` (Adobe Cube LUT): export the `.xbm` from WolvenKit
 * as `.cube` and place it in assets/lut-source/. NOTE: do *not* use WolvenKit's
 * DDS export of this texture — for a 3D float volume it re-lays-out the slices
 * incorrectly (verified: its texel 0 differs from the raw `.xbm` bytes). The
 * `.cube` export is byte-faithful to the engine data.
 *
 * This parses the `.cube` and writes the raw 32³ RGBA float data, which the app
 * loads straight into a THREE.Data3DTexture (RGBAFormat + FloatType) and
 * samples in the Game theme's colour-grade pass.
 *
 * Source `.cube` lives in assets/lut-source/ (gitignored — needs WolvenKit +
 * the game files to produce); the committed runtime asset is assets/data/.
 * Mirrors the glb-source/ → glb-meshopt/ pattern.
 *
 *   node scripts/build_lut.js     (or: npm run build-lut)
 */

const fs = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '..', 'assets', 'lut-source', 'cube_cp_braindance_v001.cube');
const OUT  = path.join(__dirname, '..', 'assets', 'data', 'braindance-lut.bin');
const SIZE = 32; // expected LUT edge length (32³ cube)

function fail(msg) {
  console.error(`build_lut: ${msg}`);
  process.exit(1);
}

function build() {
  if (!fs.existsSync(SRC)) {
    fail(`source .cube not found at ${SRC}\n` +
         `  Export base/weather/24h_basic/luts/cube_cp_braindance_v001.xbm from\n` +
         `  WolvenKit as a .cube file and place it in assets/lut-source/.`);
  }

  const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

  // ── parse the .cube ─────────────────────────────────────────────────────
  let size = null;
  const rgb = []; // flat [r,g,b, r,g,b, …] in R-fastest order
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;          // blank / comment
    if (line.startsWith('TITLE') || line.startsWith('DOMAIN_')) continue; // metadata
    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)/);
    if (sizeMatch) { size = parseInt(sizeMatch[1], 10); continue; }
    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) {
      fail(`unparseable .cube line: "${raw}"`);
    }
    rgb.push(parts[0], parts[1], parts[2]);
  }

  // ── validate ────────────────────────────────────────────────────────────
  if (size !== SIZE)  fail(`expected LUT_3D_SIZE ${SIZE}, got ${size}`);
  const texels = SIZE * SIZE * SIZE;
  if (rgb.length !== texels * 3) {
    fail(`expected ${texels} entries, got ${rgb.length / 3}`);
  }

  // ── emit ────────────────────────────────────────────────────────────────
  // .cube data is R-fastest, then G, then B — identical ordering to
  // THREE.Data3DTexture (x-fastest, x = R). Expand RGB → RGBA (opaque) float32.
  const out = new Float32Array(texels * 4);
  for (let i = 0; i < texels; i++) {
    out[i * 4 + 0] = rgb[i * 3 + 0];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 1.0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(out.buffer));

  console.log(`build_lut: wrote ${path.relative(path.join(__dirname, '..'), OUT)} — ` +
              `${SIZE}³ RGBA32F, ${out.byteLength.toLocaleString()} bytes.`);
}

build();
