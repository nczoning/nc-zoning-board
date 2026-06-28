# 3D Map — Lighting and Shadows

Reference for the sun/shadow/lighting system in the Three.js schematic view.

> **Renderer:** this scene runs on `WebGPURenderer` (three r184) with TSL node
> materials. There is **no `onBeforeCompile` / GLSL-chunk injection** and no
> `MeshLambertMaterial` — every material is a `*NodeMaterial`. Shadow state lives on
> the **light** (`light.shadow.*`), not on `renderer.shadowMap` (which under WebGPU
> only carries `{ enabled, transmitted, type }`).

---

## Sun and Ambient Light

Lighting is calibrated to the in-game 3D map's environment file
(`base/weather/24h_basic/3dmap.envparam`), which lights the world map with a fixed
low sun + a 6-direction ambient cube through an ACES tonemap. We reproduce that with
**one `DirectionalLight` (sun) + one `HemisphereLight` (ambient)**, both at fixed,
calibrated colour and intensity — the in-game map has no time-of-day variation.

```javascript
// Sun — warm white, fixed intensity (envparam LightAreaSettings.sunColor)
_dirLight = new THREE.DirectionalLight(0xffffff, NCZ.SUN_INTENSITY); // 3.00
_dirLight.color.setRGB(...NCZ.SUN_COLOR_RGB, THREE.LinearSRGBColorSpace); // [0.975, 0.869, 0.774]

// Ambient — the envparam ambient cube collapses to a hemisphere:
// 5 bright cool-white faces (sky+sides) over 1 dim blue face (ground)
_hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, NCZ.AMBIENT_INTENSITY); // 0.405
_hemiLight.color.setRGB(...NCZ.AMBIENT_SKY_RGB, THREE.LinearSRGBColorSpace);    // [0.796, 0.895, 1.0]
_hemiLight.groundColor.setRGB(...NCZ.AMBIENT_GROUND_RGB, THREE.LinearSRGBColorSpace); // [0.566, 0.766, 1.0]
```

Sun : ambient ≈ 7.4 : 1 (envelope-fit). Cast shadows are layered on top as an
intentional artistic choice — the in-game map has them disabled.

### Updating sun position

`NCZ.ThreeScene.setSunPosition(azimuthRad, altitudeRad)` moves **only the sun's
direction** — colour and intensity are fixed at construction. The slider/showcase
sweep the direction so shadows move and faces relight; the look stays calibrated.

It:

- Stores the requested az/el in `_sunAz` / `_sunEl` **before** the lights-exist guard
  (so an early call before `init()` still propagates to the UI-sync poll — see
  PR #733, the cold-load sun-init race)
- Recomputes `_sunDir` and re-places the light `SUN_DIST` up the sun ray from the
  shadow camera's target (orthographic ⇒ only direction matters for shading)
- **Floors the sun direction's Y at ~6° elevation** (`Math.max(0.1, sin(el))`) so the
  shadow camera's `lookAt` never goes degenerate-horizontal. The visible sun *sphere*
  (showcase only) uses the unclamped elevation so it still sets at the horizon.
- Calls `flagShadowUpdate()` (sun moved ⇒ re-render the depth map next frame)

The showcase flyover drives `setSunPosition()` automatically during its animation.

---

## Shadow Map Setup

**Shadows are enabled by default.** The UI checkbox controls the state via
`setLayerVisibility('shadows', true/false)` → `setShadowsEnabled()`.

```javascript
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

_dirLight.castShadow         = true;
_dirLight.shadow.mapSize.set(NCZ.SHADOW_MAP_SIZE, NCZ.SHADOW_MAP_SIZE); // 4096²
_dirLight.shadow.camera.near = NCZ.SHADOW_CAM_NEAR;  //     1
_dirLight.shadow.camera.far  = NCZ.SHADOW_CAM_FAR;   // 40000
_dirLight.shadow.bias        = NCZ.SHADOW_BIAS;      //     0
// normalBias is set per-frame by updateShadowCamera (scaled with the footprint)
```

`SHADOW_BIAS` is **0**: the native `depth32float` shadow map + reverse-Z buffer have
ample depth precision, so the old WebGL RGBA8-packed-depth cushion (`-0.0005`) is no
longer needed. The geometric self-shadow (a shadow texel covering a depth range) is
handled entirely by the **normal bias** instead.

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
in `updateShadowCamera(renderCam = camera)` to concentrate the 4096² map on exactly the
visible-ground footprint — far sharper shadows when zoomed in. Two fit paths, because the
camera shapes differ too much to share one:

- **Schema cam** (interactive top-down perspective): **rect-fit** — ray-cast the view's
  NDC corners to the `Y=0` ground plane, take the bbox. Tight and sharp; always succeeds
  because `controls` constrain tilt below horizontal.
- **Showcase fly cam** (cinematic, often near-horizontal): **fixed-size box** centred
  where the camera's forward ray meets the ground, with `tHit` capped. Constant size →
  no per-frame "shadow box pop" as the cinematic camera crosses the horizon.

```javascript
function updateShadowCamera(renderCam = camera) {
  // half = min(0.5 * hypot(W, D), SHADOW_MAX_DISTANCE) + SHADOW_GROUND_MARGIN  (schema)
  //      = SHADOW_MAX_DISTANCE + SHADOW_GROUND_MARGIN                          (fly cam)
  // center is clamped to world bounds (the scene is finite; a centre past the
  // edge would waste half the map on empty void)
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
| `SHADOW_MAP_SIZE` | 4096 | Shadow map resolution (4096² texels) |
| `SHADOW_MAX_DISTANCE` | 8600 | Cap on the footprint half-side (≈ world half-diagonal; nothing renders past the world bounds) |
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
