/**
 * NC Zoning Board — CP2077 3D-map colour pipeline (ACES tonemap + grade + LUT)
 *
 * Reproduces the in-game 3D world map's full colour pipeline, decoded from
 * `base/weather/24h_basic/3dmap.envparam` (see wiki/sources/
 * 3dmap-envparam-lighting). The map renders:
 *
 *     HDR scene  →  ACES tonemap  →  colour grade  →  braindance LUT  →  display
 *
 * Registered as a custom WebGPU tone-mapping function (replacing the interim
 * `THREE.NeutralToneMapping`). The grade + LUT are gated by `_gradeEnabled`:
 * on for the Game / Preem "replicate a real map" themes, off for the five
 * stylised themes, which keep their own colour identity. The ACES tonemap is
 * always on — it is the theme-agnostic HDR→display curve.
 *
 * ── 1. ACES tonemap ─────────────────────────────────────────────────────────
 * The ACES **SSTS** (Single-Stage Tone Scale) — the parametric ACES Output
 * Transform tone curve — ported verbatim from the ACES 1.3 reference
 * `ACESlib.SSTS.ctl` (ampas/aces-dev), driven by the decoded
 * `STonemappingACESParams`: minStops -7, maxStops 9, midGrayScale 1,
 * dimSurround 1, surroundGamma 1, desaturate 0, toneCurveSaturation 1,
 * tonemapLuminance 0. `tonemapLuminance: 0` ⇒ per-channel; `desaturate: 0` ⇒
 * no ACES desaturation — so it is the SSTS tone scale per RGB channel, no RRT
 * sweeteners. The SSTS `TsParams` depend only on the params, so they are built
 * once here in JS and baked into the TSL graph; the GPU evaluates a 4-knot
 * log-space quadratic B-spline per channel.
 *
 * Documented assumption: REDengine specifies the range in **stops**; the ACES
 * reference takes display luminances. We place the Min/Max ACES points
 * directly at `0.18·midGrayScale·2^stops` with the reference SDR anchors
 * (MIN_LUM 0.02, MID_LUM 4.8, MAX_LUM 48). Everything downstream is reference.
 *
 * ── 2. Colour grade ─────────────────────────────────────────────────────────
 * The envparam `ColorGradingAreaSettings` (verbatim): contrast 1.1 about pivot
 * 0.435, gain (R 1.0, G 1.3, B 1.3), luminance gamma 0.96. The 0.435 pivot is
 * a *display-referred* mid value, so the grade runs in sRGB/display space
 * (the tonemap output is encoded to sRGB first). brightness/lift/offsets/hue
 * are all identity in the decoded data and omitted. The combination order
 * (contrast → gain → gamma → saturation) is the standard primary-correction
 * order — the *params* are exact, the formula is the conventional one.
 *
 * ── 3. Braindance LUT ───────────────────────────────────────────────────────
 * The envparam `ldrLut` → `cube_cp_braindance_v001.xbm`, a 32³ RGBA-float 3D
 * colour cube (`inputMapping: sRGB`, `outputMapping: Linear`). Extracted to
 * `assets/data/braindance-lut.bin` by `scripts/build_lut.js`; loaded here into
 * a `Data3DTexture` and sampled trilinearly. `applyAfterLUT: 0` on the tonemap
 * confirms tonemap precedes the LUT.
 *
 * Wiring: `registerCP2077ToneMapping(renderer)` → set `renderer.toneMapping`
 * to the returned constant; `loadBraindanceLUT(url)` to populate the cube;
 * `setSceneGradeEnabled(bool)` per theme (driven from the `--scene-grade` CSS
 * custom property in updateMaterials()).
 */

import {
  Data3DTexture, RGBAFormat, FloatType, LinearFilter,
  ClampToEdgeWrapping, NoColorSpace,
} from 'three';
import {
  Fn, float, vec3, select, log2, exp2, pow, max, clamp, floor, texture3D, uniform,
} from 'three/tsl';

/**
 * Custom tone-mapping enum value. Three.js built-ins occupy 0..7; any unused
 * integer works as a NodeLibrary key.
 */
export const CP2077_ACES_TONE_MAPPING = 2077;

// ── Decoded STonemappingACESParams (3dmap.envparam) ─────────────────────────
const MIN_STOPS      = -7;
const MAX_STOPS      = 9;
const MID_GRAY_SCALE = 1;
const SURROUND_GAMMA = 1;   // multiplies the dim-surround gamma; 1 ⇒ unchanged
const DIM_SURROUND   = 1;   // enabled

// ── Decoded ColorGradingAreaSettings (3dmap.envparam) ───────────────────────
const GRADE_CONTRAST       = 1.10000002;
const GRADE_CONTRAST_PIVOT = 0.435000002;
const GRADE_GAIN           = [1.0, 1.29999995, 1.29999995]; // R, G, B
const GRADE_GAMMA_LUM      = 0.959999979;                   // luminance gamma
const GRADE_SATURATION     = 1.10000002;                    // saturation about luma

// ── ACES SSTS reference constants (ACESlib.SSTS.ctl, ACES 1.3) ──────────────
const MIN_LUM_SDR = 0.02;   // SDR display black, cd/m²
const MID_LUM     = 4.8;    // SSTS mid-grey output luminance
const MAX_LUM_SDR = 48.0;   // SDR display white, cd/m²
const MID_SLOPE   = 1.55;   // SSTS mid-point slope (fixed by the reference)
const DIM_SURROUND_GAMMA = 0.9811; // ACES ODT darkSurround_to_dimSurround exponent

// Rec.709 luma weights (luminance for the grade's luminance-gamma step).
const REC709 = [0.2126, 0.7152, 0.0722];

// Textbook monomial-to-basis matrix M1 (ACESlib.SSTS.ctl), used as cf·M1.
const M1 = [
  [ 0.5, -1.0, 0.5 ],
  [-1.0,  1.0, 0.5 ],
  [ 0.5,  0.0, 0.0 ],
];

const LUT_SIZE = 32; // braindance LUT edge length (32³ cube)

const log10  = (x) => Math.log10(x);
const log2js = (x) => Math.log2(x);

// ── The braindance LUT (Data3DTexture) ──────────────────────────────────────
// Created empty; loadBraindanceLUT() fills it from assets/data/braindance-lut.bin.
// Referenced by the tone-mapping graph as a texture binding — the binding is to
// this stable object, so a later data fill + needsUpdate uploads transparently.
const _lutTexture = new Data3DTexture(
  new Float32Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4), LUT_SIZE, LUT_SIZE, LUT_SIZE);
_lutTexture.format     = RGBAFormat;
_lutTexture.type       = FloatType;
_lutTexture.minFilter  = LinearFilter;
_lutTexture.magFilter  = LinearFilter;
_lutTexture.wrapS      = ClampToEdgeWrapping;
_lutTexture.wrapT      = ClampToEdgeWrapping;
_lutTexture.wrapR      = ClampToEdgeWrapping;
_lutTexture.colorSpace = NoColorSpace; // LUT data is sampled raw — no decode
_lutTexture.name       = 'braindance-lut';
_lutTexture.needsUpdate = true;

// Grade + LUT gate — 0 for the stylised themes (ACES tonemap only), 1 for the
// Game / Preem themes. A uniform, so theme switches need no pipeline rebuild.
const _gradeEnabled = uniform(0);

/**
 * Load the braindance LUT into the 3D texture.
 * @param {string} url - path to braindance-lut.bin (32³ RGBA float32)
 * @returns {Promise<void>}
 */
export async function loadBraindanceLUT(url) {
  const buf  = await (await fetch(url)).arrayBuffer();
  const data = new Float32Array(buf);
  const expected = LUT_SIZE * LUT_SIZE * LUT_SIZE * 4;
  if (data.length !== expected) {
    throw new Error(`braindance LUT: expected ${expected} floats, got ${data.length}`);
  }
  _lutTexture.image.data = data;
  _lutTexture.needsUpdate = true;
}

/** Enable/disable the grade + LUT (Game / Preem themes on, others off). */
export function setSceneGradeEnabled(enabled) {
  _gradeEnabled.value = enabled ? 1 : 0;
}

// ── CPU: build the SSTS TsParams from the decoded params ────────────────────

/** ACES `interpolate1D` — clamped linear interpolation on a sorted 2-point table. */
function interp1D([[x0, y0], [x1, y1]], x) {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
}

/** Port of `init_coefsLow` — the 6 low-segment spline coefficients (log10 space). */
function initCoefsLow(low, mid) {
  const knotInc = (log10(mid.x) - log10(low.x)) / 3;
  const c = [];
  c[0] = low.slope * (log10(low.x) - 0.5 * knotInc) + (log10(low.y) - low.slope * log10(low.x));
  c[1] = low.slope * (log10(low.x) + 0.5 * knotInc) + (log10(low.y) - low.slope * log10(low.x));
  c[3] = mid.slope * (log10(mid.x) - 0.5 * knotInc) + (log10(mid.y) - mid.slope * log10(mid.x));
  c[4] = mid.slope * (log10(mid.x) + 0.5 * knotInc) + (log10(mid.y) - mid.slope * log10(mid.x));
  const pctLow = interp1D([[-15, 0.18], [-6.5, 0.35]], log2js(low.x / 0.18));
  c[2] = log10(low.y) + pctLow * (log10(mid.y) - log10(low.y));
  return [c[0], c[1], c[2], c[3], c[4], c[4]]; // last duplicated, per init_TsParams
}

/** Port of `init_coefsHigh` — the 6 high-segment spline coefficients (log10 space). */
function initCoefsHigh(mid, max) {
  const knotInc = (log10(max.x) - log10(mid.x)) / 3;
  const c = [];
  c[0] = mid.slope * (log10(mid.x) - 0.5 * knotInc) + (log10(mid.y) - mid.slope * log10(mid.x));
  c[1] = mid.slope * (log10(mid.x) + 0.5 * knotInc) + (log10(mid.y) - mid.slope * log10(mid.x));
  c[3] = max.slope * (log10(max.x) - 0.5 * knotInc) + (log10(max.y) - max.slope * log10(max.x));
  c[4] = max.slope * (log10(max.x) + 0.5 * knotInc) + (log10(max.y) - max.slope * log10(max.x));
  const pctHigh = interp1D([[6.5, 0.89], [18, 0.90]], log2js(max.x / 0.18));
  c[2] = log10(mid.y) + pctHigh * (log10(max.y) - log10(mid.y));
  return [c[0], c[1], c[2], c[3], c[4], c[4]];
}

/** Build the SSTS TsParams (Min/Mid/Max points + spline coefficients). */
function buildTsParams() {
  const midX = 0.18 * MID_GRAY_SCALE;
  const min = { x: midX * Math.pow(2, MIN_STOPS), y: MIN_LUM_SDR, slope: 0 };
  const mid = { x: midX,                          y: MID_LUM,     slope: MID_SLOPE };
  const max = { x: midX * Math.pow(2, MAX_STOPS), y: MAX_LUM_SDR, slope: 0 };
  return {
    min, mid, max,
    coefsLow:  initCoefsLow(min, mid),
    coefsHigh: initCoefsHigh(mid, max),
  };
}

/** Three consecutive coefficients → the (a,b,c) of `logy = a·t² + b·t + c`. */
function quadraticABC([c0, c1, c2]) {
  const m0 = c0 * M1[0][0] + c1 * M1[1][0] + c2 * M1[2][0];
  const m1 = c0 * M1[0][1] + c1 * M1[1][1] + c2 * M1[2][1];
  const m2 = c0 * M1[0][2] + c1 * M1[1][2] + c2 * M1[2][2];
  return { a: m0, b: m1, c: m2 };
}

// ── Build the TSL tone-mapping function ─────────────────────────────────────

function makeToneMappingFn() {
  const P = buildTsParams();

  const logMinX = log10(P.min.x), logMidX = log10(P.mid.x), logMaxX = log10(P.max.x);
  const logMinY = log10(P.min.y), logMaxY = log10(P.max.y);

  // Per-segment quadratic coefficients (knot j ∈ {0,1,2}) — compile-time
  // constants; only `t` and the j-select run on the GPU.
  const lo = [
    quadraticABC([P.coefsLow[0],  P.coefsLow[1],  P.coefsLow[2]]),
    quadraticABC([P.coefsLow[1],  P.coefsLow[2],  P.coefsLow[3]]),
    quadraticABC([P.coefsLow[2],  P.coefsLow[3],  P.coefsLow[4]]),
  ];
  const hi = [
    quadraticABC([P.coefsHigh[0], P.coefsHigh[1], P.coefsHigh[2]]),
    quadraticABC([P.coefsHigh[1], P.coefsHigh[2], P.coefsHigh[3]]),
    quadraticABC([P.coefsHigh[2], P.coefsHigh[3], P.coefsHigh[4]]),
  ];

  const INV_LOG2_10 = 1 / Math.log2(10); // log10(x) = log2(x) · INV_LOG2_10
  const LOG2_10     = Math.log2(10);     // pow10(y) = exp2(y · LOG2_10)

  const pick3 = (j, v0, v1, v2) =>
    select(j.lessThan(0.5), float(v0), select(j.lessThan(1.5), float(v1), float(v2)));

  /** Evaluate one 4-knot SSTS segment — a log-space quadratic B-spline. */
  const segment = (logx, logA, logB, seg) => {
    const knot = logx.sub(logA).div(logB - logA).mul(3); // N_KNOTS-1 = 3
    const j = clamp(floor(knot), float(0), float(2));
    const t = knot.sub(j);
    const a = pick3(j, seg[0].a, seg[1].a, seg[2].a);
    const b = pick3(j, seg[0].b, seg[1].b, seg[2].b);
    const c = pick3(j, seg[0].c, seg[1].c, seg[2].c);
    return a.mul(t).mul(t).add(b.mul(t)).add(c); // logy
  };

  /** ACES `ssts()` on one channel — scene-linear x → display luminance. */
  const sstsChannel = (x) => {
    const logx = log2(max(x, float(1e-10))).mul(INV_LOG2_10);
    const logyLow  = segment(logx, logMinX, logMidX, lo);
    const logyHigh = segment(logx, logMidX, logMaxX, hi);
    const logy = select(
      logx.lessThanEqual(logMinX), float(logMinY),
      select(logx.lessThan(logMidX), logyLow,
        select(logx.lessThan(logMaxX), logyHigh, float(logMaxY))));
    return exp2(logy.mul(LOG2_10)); // pow10
  };

  /** Per-channel linear → sRGB OETF (the grade + LUT run in display space). */
  const linearToSRGB = (c) =>
    select(c.lessThanEqual(0.0031308),
      c.mul(12.92),
      pow(max(c, float(0)), float(1 / 2.4)).mul(1.055).sub(0.055));

  /**
   * The envparam colour grade, in sRGB/display space (the 0.435 contrast pivot
   * is display-referred). contrast about pivot → gain → luminance gamma.
   */
  const applyGrade = (c) => {
    // Contrast about the pivot.
    let g = c.sub(GRADE_CONTRAST_PIVOT).mul(GRADE_CONTRAST).add(GRADE_CONTRAST_PIVOT);
    // Per-channel gain — the map's cool cast (G/B +30%).
    g = g.mul(vec3(GRADE_GAIN[0], GRADE_GAIN[1], GRADE_GAIN[2]));
    // Luminance gamma — applied to luma so chroma is preserved.
    const luma  = g.r.mul(REC709[0]).add(g.g.mul(REC709[1])).add(g.b.mul(REC709[2]));
    const lumaC = max(luma, float(1e-5));
    const scale = pow(lumaC, float(1 / GRADE_GAMMA_LUM)).div(lumaC);
    const gamma = max(g.mul(scale), float(0));
    // Saturation about luma — `desat + (colour − desat)·saturation`, written
    // out (not the TSL `.mix()` method, which mis-orders operands).
    const sLuma = vec3(gamma.r.mul(REC709[0]).add(gamma.g.mul(REC709[1])).add(gamma.b.mul(REC709[2])));
    return max(sLuma.add(gamma.sub(sLuma).mul(float(GRADE_SATURATION))), float(0));
  };

  /** Sample the braindance 3D LUT. Input is sRGB-encoded; output is linear. */
  const sampleLUT = (cSRGB) => {
    const uvw = clamp(cSRGB, float(0), float(1))
      .mul((LUT_SIZE - 1) / LUT_SIZE)
      .add(0.5 / LUT_SIZE); // texel-centre addressing for the 32³ cube
    return texture3D(_lutTexture, uvw).rgb;
  };

  // Registered tone-mapping function: (linear color, exposure) → linear display.
  return Fn(([color, exposure]) => {
    const x = color.mul(exposure);

    // ── ACES SSTS tone scale, per channel (tonemapLuminance: 0) ──
    const Y = vec3(sstsChannel(x.r), sstsChannel(x.g), sstsChannel(x.b));

    // SSTS display luminance [MIN_LUM, MAX_LUM] → [0,1] linear code value.
    let cv = clamp(
      Y.sub(float(MIN_LUM_SDR)).div(float(MAX_LUM_SDR - MIN_LUM_SDR)),
      float(0), float(1));

    // Dim-surround compensation (envparam dimSurround: 1) — ACES ODT viewing-
    // environment gamma on luminance, chroma preserved.
    if (DIM_SURROUND) {
      const g = DIM_SURROUND_GAMMA * SURROUND_GAMMA;
      const luma = cv.r.mul(REC709[0]).add(cv.g.mul(REC709[1])).add(cv.b.mul(REC709[2]));
      cv = cv.mul(pow(max(luma, float(1e-5)), float(g - 1)));
    }
    cv = clamp(cv, float(0), float(1));

    // ── Grade + braindance LUT (Game / Preem themes) ──
    // The grade runs in sRGB/display space; the LUT takes sRGB in, linear out.
    const cvSRGB  = clamp(linearToSRGB(cv), float(0), float(1));
    const graded  = clamp(applyGrade(cvSRGB), float(0), float(1));
    const lutOut  = sampleLUT(graded); // linear (LUT outputMapping: Linear)

    // Gate: stylised themes get the ACES result; Game/Preem get grade + LUT.
    const out = select(_gradeEnabled.greaterThan(0.5), lutOut, cv);

    // Return linear display values — the renderer applies the sRGB OETF after.
    return clamp(out, float(0), float(1));
  });
}

/**
 * Register the CP2077 ACES tone-mapping function on a WebGPU renderer.
 * After calling this, set `renderer.toneMapping = CP2077_ACES_TONE_MAPPING`.
 *
 * @param {THREE.WebGPURenderer} renderer
 * @returns {number} the constant to assign to `renderer.toneMapping`
 */
export function registerCP2077ToneMapping(renderer) {
  renderer.library.addToneMapping(makeToneMappingFn(), CP2077_ACES_TONE_MAPPING);
  return CP2077_ACES_TONE_MAPPING;
}
