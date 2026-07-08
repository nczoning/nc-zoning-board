# 3D Map — Lighting and Shadows

Reference for the sun/shadow/lighting system in the Three.js schematic view.

> **Renderer:** this scene runs on `WebGPURenderer` (three r184) with TSL node
> materials. There is **no `onBeforeCompile` / GLSL-chunk injection** and no
> `MeshLambertMaterial` — every material is a `*NodeMaterial`. Shadow state lives on
> the **light** (`light.shadow.*`), not on `renderer.shadowMap` (which under WebGPU
> only carries `{ enabled, transmitted, type }`).

---

## Day–night lighting model

The daytime base is calibrated to the in-game 3D map's environment file
(`base/weather/24h_basic/3dmap.envparam`) — a low sun + a 6-direction ambient cube
through an ACES tonemap. Layered on top is a full **day–night cycle** driven by one
control, `nightFactor` (a `smoothstep` over the sun's elevation: 0 by day, 1 at
night; `NCZ.nightFactorForSunElevation`). At `nightFactor == 0` the scene is
byte-identical to the original calibrated daytime.

**Three lights — two celestial, one ambient:**

```javascript
// SUN — warm, casts shadows. Intensity fades out with nightFactor.
_dirLight  = new THREE.DirectionalLight(0xffffff, NCZ.SUN_INTENSITY);   // 3.00 by day → 0 at night
_dirLight.color.setRGB(...NCZ.SUN_COLOR_RGB, THREE.LinearSRGBColorSpace);  // [0.975, 0.869, 0.774]

// MOON — cool, casts NO shadows (castShadow stays false, set once). Real lunar arc.
_moonLight = new THREE.DirectionalLight(0xffffff, 0);                    // → MOON_INTENSITY × phase × altitude × nightFactor
_moonLight.color.setRGB(...NCZ.MOON_COLOR_RGB, THREE.LinearSRGBColorSpace); // [0.62, 0.74, 1.0]

// AMBIENT — hemisphere; day cube ⇄ night skyglow cube by nightFactor.
_hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, NCZ.AMBIENT_INTENSITY); // 0.405 day
```

Both bodies are positioned from **real ephemeris** (SunCalc, at the Morro Bay anchor
on the June solstice): the sun via `getPosition`, the moon via `getMoonPosition`. The
moon's brightness uses a tunable phase constant (`NCZ.MOON_PHASE`, default ~full) so a
new-moon date can't leave the night dark. As `nightFactor`→1 the warm sun crossfades
out and the cool moon (gated by its own altitude) crossfades in; the ambient lerps to a
cool night skyglow, boosted toward `AMBIENT_INTENSITY_NIGHT_MOONLESS` as the moon sets
so a moonless deep night stays legible. See `docs/3d-map-lighting.md` for the full
colour/exposure model.

> **Shadows belong to the sun.** Only `_dirLight` casts; the moon never does
> (moonlight shadows are physically imperceptible, and a moon caster would re-introduce
> the shadow-box artifact at night). Shadow *strength* also fades with the sun's
> elevation (`SUN_SHADOW_FADE_*`), so dusk softens shadows out and night has none.

### Updating sun / moon position

`NCZ.ThreeScene.setSunPosition(az, alt)` and `setMoonPosition(az, alt)` store the
body's az/el (`_sunAz/_sunEl`, `_moonAz/_moonEl`), move that body's visible disc, then
call the shared **`updateDayNightLighting()`** which recomputes everything from
`nightFactor`: both light directions/colours/intensities, the ambient lerp, and the
sun-shadow fade. `setSunPosition` stores its az/el **before** the lights-exist guard
(so an early pre-`init()` call still propagates to the UI-sync poll — PR #733).

- The **sun** drives the shadow camera. `_sunDir`'s Y is floored at
  `NCZ.KEY_LIGHT_MIN_DIR_Y` (~5.7°) so the shadow camera's `lookAt` can't go
  degenerate near the horizon.
- The **visible discs** use the *unclamped* elevation (`positionSkyBody`) so they
  trace their true arcs — they're not gated on/off; terrain depth-occludes them at the
  horizon (they crest ridgelines naturally). Over open sea, with no terrain, a low disc
  simply hovers (accepted — no horizon to set behind).
- `flagShadowUpdate()` fires only when the sun actually casts (`_sunShadowFade > 0`).

The showcase flyover drives **both** `setSunPosition()` and `setMoonPosition()` each
frame from the same SunCalc data — so the map and showcase share one path.

---

## Shadow Map Setup

**Shadows are enabled by default.** The UI checkbox controls the state via
`setLayerVisibility('shadows', true/false)` → `setShadowsEnabled()`.

```javascript
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

_dirLight.castShadow         = true;
_dirLight.shadow.mapSize.set(NCZ.SHADOW_MAP_SIZE, NCZ.SHADOW_MAP_SIZE); // 8192²
_dirLight.shadow.camera.near = NCZ.SHADOW_CAM_NEAR;  //     1
_dirLight.shadow.camera.far  = NCZ.SHADOW_CAM_FAR;   // 40000
_dirLight.shadow.bias        = NCZ.SHADOW_BIAS;      //     0
// normalBias is set per-frame by updateShadowCamera (scaled with the footprint)
```

`SHADOW_BIAS` is **0**: the native `depth32float` shadow map + reverse-Z buffer have
ample depth precision, so the old WebGL RGBA8-packed-depth cushion (`-0.0005`) is no
longer needed. The geometric self-shadow (a shadow texel covering a depth range) is
handled entirely by the **normal bias** instead.

### Shadow strength fades with the sun (night has no cast shadows)

`updateDayNightLighting()` sets the live shadow strength as
`_shadowsOn ? _shadowIntensity × _sunShadowFade : 0`, where `_sunShadowFade` is a
`smoothstep` over the sun's elevation: full at/above `SUN_SHADOW_FADE_FULL_DEG` (12°),
0 at/below `SUN_SHADOW_FADE_OFF_DEG` (3°). So crisp shadows in daylight, fading through
dusk, **none at night** — and with the moon casting nothing, night has no caster at
all. This is what removes the night/dusk "shadow box" by construction: no caster ⇒
nothing to clip against the coverage cap.

### Shadow render-on-demand (WebGPU) — the gate is on the *light*

> ⚠️ Under `WebGPURenderer`, `renderer.shadowMap` only carries `{ enabled, transmitted,
> type }`. **`renderer.shadowMap.autoUpdate` and `.needsUpdate` are inert** (silent no-ops).
> The per-light shadow pass is gated inside `ShadowNode.updateBefore()` by
> `light.shadow.needsUpdate || light.shadow.autoUpdate`.

So shadow render-on-demand is driven on the light:

```javascript
_dirLight.shadow.autoUpdate = false;            // permanent — the real WebGPU gate

function flagShadowUpdate() {                    // single chokepoint
  if (_shadowsOn && _dirLight) _dirLight.shadow.needsUpdate = true;
}
```

`flagShadowUpdate()` is called only when the shadow silhouette actually changes —
`setSunPosition()` (sun moved), `updateShadowCamera()` (camera/resize/terrain/flyover/
re-enable), and **the async caster loads** (`loadBuildings`, `loadLandmarks` — they finish
after the post-terrain refit, so nothing else flags them). It is **not** called on
theme/colour transitions (shadow depth is geometry-only). The result: the 4096² depth pass
re-renders only on shadow-relevant frames, and the **Shadows toggle off** simply stops
flagging → `updateBefore()` early-returns → the pass is skipped (depth texture left intact,
no `castShadow`/`enabled` teardown → no `depthTexture` crash; see `setShadowsEnabled()`).
Off also sets `shadow.intensity = 0` and poisons the cull's shadow frustum so off-screen
casters stop being drawn into the main pass. (PR #751.)

### Dynamic shadow camera

The single shadow camera (an `OrthographicCamera`) is **re-fitted every camera change**
in `updateShadowCamera(renderCam = camera)` to concentrate the 8192² map on the visible
ground — far sharper shadows when zoomed in. The fit switches by *regime*, not by camera:

- **Zoomed in** (visible-ground sphere radius ≤ `SHADOW_MAX_DISTANCE`): **camera-fit** —
  bounding-sphere of the view's NDC corners ray-cast to `Y=0`. Tight, sharp, tracks
  what you see.
- **Zoomed out** (radius > the cap) **and the showcase fly cam**: **world-locked box** —
  centred on the world, half = cap. The box already spans the whole ~12 km world, so
  following the camera buys no sharpness and only causes the **"moving shadow box"**
  (a capped, camera-tracking slice whose centre clamps to a world edge, leaving the far
  side unshadowed). World-locking gives full coverage from a static centre. This
  subsumes the fly cam's old forward-ray + `tHit`-cap fit (now removed).

```javascript
function updateShadowCamera(renderCam = camera) {
  // Zoomed in : half = groundSphereRadius + SHADOW_GROUND_MARGIN, centre = footprint
  // Zoomed out / fly cam : half = SHADOW_MAX_DISTANCE + SHADOW_GROUND_MARGIN, centre = WORLD centre
  // (world half-diagonal ≈ the cap, so a world-centred cap-sized box covers every corner)
  shadowCam.left = -half; shadowCam.right = half;
  shadowCam.top  =  half; shadowCam.bottom = -half;
  shadowCam.near = NCZ.SHADOW_CAM_NEAR;
  shadowCam.far  = NCZ.SHADOW_CAM_FAR;
  shadowCam.updateProjectionMatrix();

  // normalBias in WORLD units = N texels × (2·half / mapSize) — constant texel
  // offset at every zoom (a constant world bias is too small zoomed out → acne,
  // too large zoomed in → shadows detach)
  _dirLight.shadow.normalBias = NCZ.SHADOW_NORMAL_BIAS_TEXELS * (2 * half / NCZ.SHADOW_MAP_SIZE);

  // Keep the sun light + target SUN_DIST up the sun ray from the footprint centre
  _dirLight.target.position.copy(center);
  _dirLight.position.copy(center).addScaledVector(_sunDir, NCZ.SUN_DIST);

  updateShadowFrustumUniforms(); // refresh the planes the building union-cull reads
  flagShadowUpdate();            // footprint moved ⇒ re-render next frame (no-op while off)
}
```

Key constants:

| Constant | Value | Purpose |
| --- | --- | --- |
| `SHADOW_MAP_SIZE` | 8192 | Shadow map resolution (8192² texels). Always-on (not resized per-mode): the fine texels keep the showcase's fast sun from shimmering; runtime resize is unreliable on r184 (three.js #30766, fixed r185). Interactive cost is bounded by render-on-demand (re-renders only on camera moves). |
| `SUN_SHADOW_FADE_OFF_DEG` / `…_FULL_DEG` | 3 / 12 | Sun elevation over which cast-shadow strength ramps 0→full. Below 3° (dusk/night) shadows fade out — no caster ⇒ no shadow box. |
| `KEY_LIGHT_MIN_DIR_Y` | 0.10 | Floor on the sun direction's Y (~5.7°) so the shadow camera's `lookAt` can't degenerate near the horizon. |
| `SHADOW_MAX_DISTANCE` | 8600 | Cap on the footprint half-side (≈ world half-diagonal; nothing renders past the world bounds). Past the cap the box world-locks. |
| `SHADOW_GROUND_MARGIN` | 600 | Footprint extends this far past the visible ground (building heights + a sliver of off-screen casters) |
| `SHADOW_CAM_NEAR` | 1 | Shadow camera near clip |
| `SHADOW_CAM_FAR` | 40000 | Far clip — the camera sits `SUN_DIST` up the sun ray, so this must reach the far edge even at a low sun (orthographic ⇒ wide range is free) |
| `SHADOW_BIAS` | 0 | Depth bias — native `depth32float` + reverse-Z need none |
| `SHADOW_NORMAL_BIAS_TEXELS` | 2.5 | Receiver-sample offset along the surface normal, in shadow-texel widths (→ world units per-frame) |
| `SUN_DIST` | 22000 | How far up the sun ray the light + shadow camera sit from the footprint centre |

### Which objects cast and receive shadows

| Object | castShadow | receiveShadow | Material | Notes |
| --- | --- | --- | --- | --- |
| Terrain | — | ✓ | `MeshLambertNodeMaterial` + `flatShading` | `frustumCulled=false`; faceted look is intentional (community vote — see PR #748) |
| Water | — | ✓ | `MeshLambertNodeMaterial` (terrain material, brightness 0.7) | Receives terrain shadows |
| Cliffs | ✓ | ✓ | `MeshLambertNodeMaterial` + `flatShading` | `frustumCulled=false` |
| Landmarks | ✓ | ✓ | `MeshLambertNodeMaterial` | Dogtown structures etc. |
| Buildings | ✓ | ✓ | `MeshLambertNodeMaterial` + TSL nodes | Instanced; stencil=1 |
| Roads | — | — | `MeshBasicNodeMaterial` (additive) | Overlay layer; no shadow |
| Metro | — | — | `MeshBasicNodeMaterial` (additive) | Overlay layer; no shadow |
| Sun disc | — | — | `MeshBasicNodeMaterial` | Visible orb; traces the solar arc, terrain-occluded |
| Moon disc | — | — | `MeshBasicNodeMaterial` | Visible orb; traces the lunar arc (incl. daytime) |

**Note on `frustumCulled=false`:** terrain and cliffs are always included in the shadow
pass regardless of the dynamic shadow camera position.

**Note on GLB normals:** terrain, cliffs, water, and landmarks retain the `NORMAL` vertex
attribute after stripping (all other attributes removed). Normals are required for the
`shadow.normalBias` receiver offset. Roads/metro use `MeshBasicNodeMaterial` and don't
need them.

---

## Building Lighting and Shadows

Buildings use `MeshLambertNodeMaterial` driven by **TSL nodes** (no `onBeforeCompile`).
Standard Three.js handles shadow casting/receiving (`castShadow`/`receiveShadow = true`)
via the engine's depth pass — no `customDepthMaterial` needed. Per-district values that
the WebGL build passed as `onBeforeCompile` uniforms are now plain TSL `uniform()` nodes.

The material wires three nodes:

1. **`normalNode`** — per-instance view-space normals. The instance matrix is applied to
   the local normal (inverse-transpose form, for non-uniform building scale) → world, then
   `transformNormalToView()` → view. `NodeMaterial.setupNormal()` consumes `normalNode`
   *directly* for lighting, so it must already be in view space.
2. **`colorNode`** — `_m.dds` surface modulation (`0.4 + 0.5·m`, the decoded
   `3d_map_cubes.mt` value) applied to the albedo, plus the procedural **edge highlight**
   (`saturate(pow(max(|1-2u|,|1-2v|), EdgeSharpnessPower))` over a synthesised per-face UV,
   `lerp`'d onto albedo pre-lighting) with `fwidth` anti-aliasing.
3. **`emissiveNode`** (optional) — when **edge glow** is on, the edge term is also written
   to emissive so it stays self-lit regardless of sun/shadow. Binary on/off at
   `NCZ.EDGE_GLOW_INTENSITY`; per-theme default from `--scene-edge-glow`, overridable in
   Settings.

Per-district uniforms: `uTransMin`/`uTransMax`/`uOffset` (instance-texel decode + multi-
district composition), `uEdgeColor`, `uEdgeSharpness`, `uEdgeCamCoeff`, `uEdgeGlow`.
`uEdgeColor` + `uEdgeGlow` are mutated at runtime (theme rewire / flyover tweens) via
`mat.userData.tslUniforms`.

Building materials also **write stencil=1** so the SeeThrough road pass can test against
them.

---

## Camera State API

```javascript
// Capture camera position + sun state (copy to clipboard)
copy(JSON.stringify(NCZ.ThreeScene.getCameraState()));
// → { target, position, zoom, polar, azimuth, sunAz, sunEl }

// Restore
NCZ.ThreeScene.setCameraState(JSON.parse('...'));
```

---

## Historical: WebGL → WebGPU material migration

Two generations preceded the current pipeline:

- **Gen 2 — `RawShaderMaterial`** (`gl_InstanceID` + `texelFetch()`): required
  `customDepthMaterial`, identity matrices for the bounding sphere, `frustumCulled=false`,
  and exact `packDepthToRGBA` matching Three.js's `modf`-based implementation. Replaced by
  the DDS + CPU-matrix instancing pipeline.
- **Gen 3 (WebGL/r170) — `MeshLambertMaterial` + `onBeforeCompile`**: the planar UV,
  `_m` modulation and edge highlight were injected as GLSL chunk replacements
  (`project_vertex`, `color_fragment`, `outgoingLight`). The WebGPU migration ported all
  of these to TSL `colorNode`/`normalNode`/`emissiveNode` on `MeshLambertNodeMaterial`;
  the GLSL injection is gone.
