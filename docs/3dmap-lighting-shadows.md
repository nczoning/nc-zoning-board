# 3D Map — Lighting and Shadows

Reference for the sun/shadow/lighting system in the Three.js schematic view.

---

## Sun and Ambient Light

The scene uses a single `DirectionalLight` (sun) and an `AmbientLight`.

```javascript
_dirLight = new THREE.DirectionalLight(0xffffff, 1.0 - NCZ.AMBIENT_INTENSITY);
_ambLight = new THREE.AmbientLight(0xffffff, NCZ.AMBIENT_INTENSITY);
```

### Updating sun position

`NCZ.ThreeScene.setSunPosition(azimuthRad, altitudeRad)` repositions the light and updates:

- Light position and intensity (dims near horizon, full above ~30°)
- Light colour (warm orange at horizon → neutral white above ~20°)
- `_dirLight.castShadow` (disabled below 5° elevation to avoid degenerate shadow projections)
- Current azimuth/altitude stored in `_sunAz` / `_sunEl` for `getCameraState()`

The showcase flyover drives `setSunPosition()` automatically during its animation.

---

## Shadow Map Setup

**Shadows are enabled by default.** The UI checkbox reflects and controls the state via `setLayerVisibility('shadows', true/false)`.

```javascript
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

_dirLight.shadow.mapSize.set(NCZ.SHADOW_MAP_SIZE, NCZ.SHADOW_MAP_SIZE); // 4096²
_dirLight.shadow.camera.near  = NCZ.SHADOW_CAM_NEAR;  //    10
_dirLight.shadow.camera.far   = NCZ.SHADOW_CAM_FAR;   // 25000
_dirLight.shadow.bias         = NCZ.SHADOW_BIAS;       // -0.0005
_dirLight.shadow.normalBias   = NCZ.SHADOW_NORMAL_BIAS; // 0.01
```

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
no `castShadow`/`enabled` teardown → no `depthTexture` crash). See the wiki learning
*renderer.shadowMap flags inert under WebGPU* and decision *render-on-demand shadows on the
light* for the full rationale and trigger audit.

### Dynamic shadow frustum

The shadow frustum is not fixed — it resizes every time the camera changes to concentrate the shadow map on the visible area. This gives dramatically sharper shadows when zoomed in.

```javascript
function updateShadowFrustum() {
  // Scale to visible area + tilt margin
  const visibleHalf = Math.max(camera.right, camera.top) / camera.zoom;
  const tilt = controls.getPolarAngle();
  const tiltFactor = Math.max(1, 1 / Math.max(0.2, Math.cos(tilt)));
  const frustum = Math.max(NCZ.SHADOW_FRUSTUM_MIN, visibleHalf * 3.0 * tiltFactor);

  // Update shadow camera frustum
  _dirLight.shadow.camera.[left/right/top/bottom] = ±frustum;
  _dirLight.shadow.camera.updateProjectionMatrix();

  // Track camera pan target (moves light + target together to preserve sun direction)
  const delta = controls.target - _dirLight.target.position;
  _dirLight.position += delta;
  _dirLight.target.position.copy(controls.target);

  // Scale bias with frustum to reduce peter panning at high zoom
  const biasScale = min(1, frustum / NCZ.SHADOW_FRUSTUM);
  _dirLight.shadow.bias       = NCZ.SHADOW_BIAS       * biasScale;
  _dirLight.shadow.normalBias = NCZ.SHADOW_NORMAL_BIAS * biasScale;
}
```

Key constants:

| Constant | Value | Purpose |
| --- | --- | --- |
| `SHADOW_MAP_SIZE` | 4096 | Shadow map resolution (4096² texels) |
| `SHADOW_FRUSTUM` | 7000 | Max frustum radius at full zoom-out |
| `SHADOW_FRUSTUM_MIN` | 400 | Minimum frustum radius (prevents over-concentration) |
| `SHADOW_BIAS` | -0.0005 | Base depth bias (scales down at high zoom) |
| `SHADOW_NORMAL_BIAS` | 0.01 | Normal-direction bias (scales down at high zoom) |

### Which objects cast and receive shadows

| Object | castShadow | receiveShadow | Material | Notes |
| --- | --- | --- | --- | --- |
| Terrain | ✓ | ✓ | `MeshLambertMaterial` + flatShading | `frustumCulled=false` |
| Water | — | ✓ | `MeshLambertMaterial` | Receives terrain shadows |
| Cliffs | ✓ | ✓ | `MeshLambertMaterial` + flatShading | `frustumCulled=false` |
| Landmarks | ✓ | ✓ | `MeshLambertMaterial` + flatShading | Dogtown structures etc. |
| Buildings | ✓ | ✓ | `MeshLambertMaterial` + `onBeforeCompile` | Instanced; stencil=1 |
| Roads | — | — | `MeshBasicMaterial` | Overlay layer; no shadow |
| Metro | — | — | `MeshBasicMaterial` | Overlay layer; no shadow |

**Note on `frustumCulled=false`:** Terrain and cliffs have `frustumCulled=false` to ensure they are always included in the shadow pass regardless of the dynamic shadow camera position.

**Note on GLB normals:** Terrain, cliffs, water, and landmarks retain the `NORMAL` vertex attribute after stripping (all other attributes removed). Normals are required for Three.js's `shadow.normalBias` computation. Roads/metro use `MeshBasicMaterial` and don't need normals.

---

## Building Lighting and Shadows

Buildings use `MeshLambertMaterial` with `onBeforeCompile` patches. Standard Three.js handles shadow casting (`castShadow = true`) and receiving (`receiveShadow = true`) automatically via the default `MeshDepthMaterial` — no `customDepthMaterial` needed.

The `onBeforeCompile` patches add:

1. **World-space planar UV** — computed from `instanceMatrix * vertex` world position in the `project_vertex` chunk, sent as `vMUv` to the fragment shader
2. **`_m.dds` surface modulation** — `diffuseColor.rgb *= 0.3 + mVal * 0.7` in `color_fragment`, applied before Lambert lighting
3. **Edge highlight** — injected via `outgoingLight` string replacement (before `#include <opaque_fragment>`) using `vLocalUv` (BoxGeometry face UV) and `uEdgeColor / uEdgeThickness / uEdgeSharpness / uEdgeIntensity` uniforms

Building materials also **write stencil=1** (`AlwaysStencilFunc, ReplaceStencilOp`) so the SeeThrough road pass can test against them.

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

## Historical: Gen 2 RawShaderMaterial (replaced)

The previous GPU instancing approach used `RawShaderMaterial` with `gl_InstanceID` + `texelFetch()`. It required `customDepthMaterial`, identity matrices for bounding sphere, `frustumCulled=false`, and exact `packDepthToRGBA` matching Three.js's `modf`-based implementation. All eliminated by the DDS + CPU matrix + `MeshLambertMaterial` pipeline.
