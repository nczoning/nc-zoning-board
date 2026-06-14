# 3D Map — Lighting & Colour Pipeline

How the Three.js 3D schematic map reproduces Cyberpunk 2077's in-game 3D
world-map look. Everything here is decoded from game files; the few values that
can't be is called out under [Calibration](#calibration).

## Source of truth

The in-game 3D world map is a render-to-texture scene. Its environment was
decoded from WolvenKit exports:

| File | What it gave us |
| --- | --- |
| `base/entities/cameras/3dmap/3dmap_view.ent` | the render-to-texture camera; its `env` field points to ↓ |
| `base/weather/24h_basic/3dmap.envparam` | sun, ambient, exposure, tonemap, colour-grading settings |
| `base/weather/24h_basic/luts/cube_cp_braindance_v001.xbm` | the colour-grading LUT |
| `base/materials/3d_map_*.mt` + per-asset `*.Material.json` | material albedo (`BaseColorScale`) |

Full decode notes: `wiki/sources/3dmap-envparam-lighting.md`.

## The pipeline

```
HDR scene   →   ACES tonemap   →   colour grade   →   braindance LUT   →   sRGB output
(sun + ambient)     (SSTS)         (contrast/             (32³ 3D
                                    gain/gamma)            texture)
```

The in-game map is deferred-rendered and genuinely lit (its building gbuffer
writes a normal). We reproduce the same chain.

## Colour space

- Working space is **linear**: `THREE.ColorManagement.enabled = true`,
  `renderer.outputColorSpace = SRGBColorSpace`.
- Theme `--scene-*` albedo is authored as sRGB hex, read into a linear `THREE.Color`.
- The tone-mapping function returns **linear** display values; Three.js applies
  the sRGB OETF at output — so the function must not sRGB-encode its result.
- The braindance LUT is `sRGB`-indexed, `Linear`-output (per the envparam
  `ColorGradingLutParams`): the grade pass encodes to sRGB before the lookup,
  and the sampled result is linear.

## Lighting — `three-scene.js`

Decoded from `3dmap.envparam`:

- **Sun** — `DirectionalLight`, colour `(0.975, 0.869, 0.774)` (warm white,
  linear), a fixed low south-west direction (azimuth 107°, elevation 7°). The
  time-of-day slider moves only the *direction*; the colour is fixed — the
  in-game map has no time-of-day variation.
- **Ambient** — `HemisphereLight`: sky `(0.796, 0.895, 1.0)`, ground
  `(0.566, 0.766, 1.0)` — the decoded 6-direction ambient cube collapsed to a
  hemisphere (bright cool dome, dim blue floor).
- Cast shadows are an intentional artistic layer; the in-game map's own
  shadows are subtle.

## Tonemap — `aces-tonemap.js`

The game tonemaps with `TonemappingModeACES`. `aces-tonemap.js` implements the
**ACES SSTS** (Single-Stage Tone Scale) — the parametric ACES Output Transform
tone curve — ported verbatim from the ACES 1.3 reference (`ACESlib.SSTS.ctl`),
parametrised by the decoded `STonemappingACESParams` (`minStops -7`,
`maxStops 9`, `midGrayScale 1`, `desaturate 0`, …).

It is registered as a custom WebGPU tone-mapping function via
`renderer.library.addToneMapping(fn, CP2077_ACES_TONE_MAPPING)` and selected
with `renderer.toneMapping`. (Three.js r184 has no `renderer.toneMappingNode`;
`addToneMapping` is the supported extension point — every built-in tonemap is
registered the same way. Three's built-in `ACESFilmicToneMapping` is the
Narkowicz *approximation* and is **not** used.)

## Colour grade + LUT — `aces-tonemap.js`, gated by `--scene-grade`

From the envparam `ColorGradingAreaSettings`:

- contrast 1.1 about pivot 0.435, gain (R 1.0, G/B 1.3), luminance gamma 0.96 —
  applied in display (sRGB) space (the 0.435 pivot is display-referred)
- the **braindance LUT** — `cube_cp_braindance_v001`, a 32×32×32 RGBA-float cube

`scripts/build_lut.js` extracts the LUT from a WolvenKit **`.cube`** export →
`assets/data/braindance-lut.bin`; the app loads it into a `THREE.Data3DTexture`
and samples it trilinearly. **Do not** use WolvenKit's *DDS* export of this
texture — for a 3D float volume it re-lays-out the slices incorrectly (its
texel 0 differs from the raw `.xbm` bytes; the `.cube` export is faithful).

The grade + LUT are the game's *specific creative grade*. They are gated by the
`--scene-grade` CSS custom property: **on for the Game theme**, off for the five
stylised themes — which keep their own colour identity and get only the
(theme-agnostic) ACES tonemap.

## Theme colours

The Game theme's `--scene-*` are the **exact extracted material
`BaseColorScale`** values — buildings `#c97e87`, terrain/cliffs `#566c88`,
landmarks `#f2919c`, edge `#ff99a5`, grid `#6d8ab0`. Water shares the terrain
albedo `#566c88` with a 0.7 brightness multiply on the water material
(`3dmap_water.mi`'s `Brightness` override).

No eyedropping, no inverse-calibration: exact game albedo goes in, and the
decoded pipeline (envparam lighting → ACES → grade → LUT) produces the in-game
look out.

## Calibration

Three values *cannot* be read from the game files, because they are
engine-specific:

| Constant (`constants.js`) | Why it can't be decoded |
| --- | --- |
| `SUN_INTENSITY` | the envparam's sun `Alpha` is a REDengine HDR unit, no 1:1 Three.js mapping |
| `AMBIENT_INTENSITY` | likewise — the ambient cube's `Alpha 2000` is a REDengine HDR unit |
| `SCENE_TONEMAP_EXPOSURE` | the game's exposure is runtime auto-metered (`ExposureAreaSettings`) — no fixed value exists in any file |

`SUN_INTENSITY` and `AMBIENT_INTENSITY` are **calibrated** against the usage
envelope (default load, whole-city, zoomed-out, tilted-close) — not a single
frame. Current values: sun `3.0`, ambient `0.405` (sun:ambient ≈ 7.4:1).
Exposure is no longer a single constant — see below.

This is the only tuning in the pipeline: every colour, the tone curve, the
grade and the LUT are exact decoded game data; only the brightness scalars are
fit.

## Time-of-day exposure curve

The in-game map's exposure is runtime auto-metered (`ExposureAreaSettings`) and
its sun is a fixed artistic choice. Ours is **real SunCalc sun data**, so scene
illuminance swings >10× from sunrise to noon — no single `toneMappingExposure`
keeps the map usable across that range (too dark at dawn/dusk, or too bright at
noon). We substitute a deterministic **`exposure(time)` curve**
(`NCZ.SCENE_EXPOSURE_CURVE`, applied in `applySunTime`): exposure rises at low
sun and falls at high sun, holding the map in a usable brightness band all day.

The curve was **solved, not eyeballed**, by the metering harness (below): it
holds the default whole-city view at a fixed target brightness (anchored to
exposure `1.0` at the 08:00 default load) and reads off the exposure each sun
time needs. The solved values recover the physical inverse-illuminance law
(`exposure × sin(elevation) ≈ 0.40` for mid-to-high sun), plateauing near the
horizon where hemisphere ambient dominates. Regenerate with
`node scripts/measure_lighting.js --solve`.

`SCENE_EXPOSURE` survives as the init fallback and the fixed `?gamelight`
reference exposure (held constant so the colour-fidelity reference frame can't
drift).

## Metering harness — `scripts/measure_lighting.js`

Automated brightness QA. Drives an installed Chrome (puppeteer-core, WebGPU)
across the envelope in `scripts/lighting-envelope.json` — 8 approved camera
poses × 7 sun times × the 2 calibrated themes — screenshots the 3D canvas, and
computes per-frame luminance stats (median / p5 / p95 / black% / clip%) with
sharp. Flags frames outside the calibrated `bounds`; exits non-zero so it can
gate lighting changes. `--solve` fits the exposure curve; `--quick` runs a
smoke subset. Emits `report.json` + labelled contact sheets.

The `bounds.medianMin` floor is `0.035`: deep-shadow dense-tower canyons
legitimately sit at median ~0.04 (dim but legible, 0% crushed) — accepted as
correct rather than brightened, since exposure is one global lever per time and
brightening them would push the whole-city view past its 1.0 anchor.

## Not (yet) replicated

- **Bloom** — the envparam has `BloomAreaSettings`. The in-game buildings'
  "glow" (and the visible structure of their decoded edge highlight at
  zoomed-out scale) comes from it. Not implemented — tracked as a follow-up.

## Key files

| File | Role |
| --- | --- |
| `assets/js/aces-tonemap.js` | ACES SSTS tonemap + colour grade + braindance LUT |
| `scripts/build_lut.js` | `.cube` → `assets/data/braindance-lut.bin` |
| `assets/js/three-scene.js` | sun/ambient setup, tonemap registration, LUT load, `setSceneExposure` |
| `assets/js/app.js` | `applySunTime` — sun direction + `exposureForMinutes` curve lookup |
| `assets/js/constants.js` | `SUN_*`, `AMBIENT_*`, `SCENE_EXPOSURE`, `SCENE_EXPOSURE_CURVE` |
| `assets/css/theme.css` | per-theme `--scene-*` albedo + the `--scene-grade` gate |
| `scripts/measure_lighting.js` | metering harness — sweep, `--solve`, contact sheets |
| `scripts/lighting-envelope.json` | approved poses, sun sweep, calibrated bounds |
