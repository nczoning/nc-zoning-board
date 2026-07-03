/**
 * NC Zoning Board — Three.js Scene
 * Namespace: NCZ.ThreeScene
 *
 * Manages the WebGPU renderer, perspective schema camera (FOV 25°, TweakDB-
 * aligned to the game's TopDown view), OrbitControls, GLB loading (tiered),
 * lighting, and render loop for the schematic 3D view.
 *
 * Camera/coordinate notes (derived from render_terrain_3d.html):
 *   GLB space: X = CET_X, Y = height, Z = -CET_Y
 *   Camera sits high on Y, looks down, up vector = (0, 0, -1) so north faces up.
 *   Cliffs GLB requires a position offset: (-2255, 0, 3050).
 */

import * as THREE from 'three';
import {
  attribute, uniform, texture, positionWorld, positionLocal, normalLocal,
  transformNormal, transformNormalToView, uv, vec2, vec4, float, mix, smoothstep, materialColor,
  instancedArray, instanceIndex,
  // Phase 2B compute culling
  Fn, If, storage, struct, atomicStore, atomicAdd, uint,
  // Terrain grid shader
  dFdx, dFdy,
  // Building edge highlight
  cameraPosition,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// WebGPU fat-line addons live under lines/webgpu/. The legacy WebGL versions
// at lines/Line2.js + lines/LineMaterial.js import THREE.ShaderLib (a
// WebGL-only registry) which the three.webgpu build does not expose, so
// loading them at module-init time throws a SyntaxError before our code ever
// runs. The webgpu wrapper extends LineSegments2 and pairs with the bundled
// Line2NodeMaterial — same Line2 API, TSL-based shader, viewport size pulled
// from the renderer automatically (no `resolution` field to keep in sync).
import { Line2 } from 'three/addons/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import Stats from 'three/addons/libs/stats.module.js';
// The exact in-game 3D-map colour pipeline (decoded from 3dmap.envparam):
// ACES tonemap + colour grade + braindance LUT — see assets/js/aces-tonemap.js.
import { registerCP2077ToneMapping, loadBraindanceLUT, setSceneGradeEnabled } from './aces-tonemap.js';

window.NCZ = window.NCZ || {};

// Default sun direction (unit, points from the ground toward the sun) until the
// real SunCalc-driven position arrives via setSunPosition.
const SUN_DIR = new THREE.Vector3(-1, 1.5, -1).normalize();

const ThreeScene = (() => {
  let renderer, camera, scene, controls;
  let initialized = false;
  // True only when the renderer ended up on a real WebGPU backend. The webgpu
  // build reports renderer.isWebGPURenderer === true even on its WebGL2
  // fallback, so that flag can't be trusted — renderer.backend.isWebGPUBackend
  // (set by r184's WebGPUBackend, absent on WebGLBackend) is the real signal.
  let _webgpuActive = false;
  let loadingEl      = null;
  let loadingFillEl  = null;
  let loadStepsTotal = 0;
  let loadStepsDone  = 0;
  let _dirLight      = null; // the sun (DirectionalLight + single fitted shadow camera)
  let _hemiLight     = null; // sky/ground fill (replaces a flat AmbientLight)
  let _sunDir        = SUN_DIR.clone(); // unit, ground→sun; updated by setSunPosition, consumed by updateShadowCamera
  let _shadowScratchV = new THREE.Vector3();     // reused by updateShadowCamera so it doesn't allocate per camera move
  // Light-space basis + up vector for the shadow texel-snap (see updateShadowCamera).
  // _SHADOW_UP matches Three's default OrthographicCamera up, so the basis we build
  // here is the same one DirectionalLightShadow uses when it aims the depth camera.
  const _SHADOW_UP = new THREE.Vector3(0, 1, 0);
  const _snapX = new THREE.Vector3();
  const _snapY = new THREE.Vector3();
  const _snapZ = new THREE.Vector3();
  // Last computed shadow fit (half + center) captured by updateShadowCamera —
  // exposed via getShadowSnapshot() for the `__shadowTrace` debug logger.
  // `fallback` true means rect was degenerate and we used the world-centered
  // safety net; `lastUpdateMs` lets us detect frames where updateShadowCamera
  // didn't run.
  let _lastShadowFit = { half: 0, cx: 0, cz: 0, fallback: false, lastUpdateMs: 0 };
  // Reusable scratch state for visible-ground-rect ray casts (perspective camera)
  const _groundRectCorner = new THREE.Vector3();
  const _groundRectMin    = new THREE.Vector3();
  const _groundRectMax    = new THREE.Vector3();
  const _GROUND_RECT_NDC  = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  // Cast rays from the camera through the four NDC corners and intersect with
  // the ground plane (Y=0). The XZ AABB of those four hits is the bounding rect
  // of what the camera sees on the ground — used by pan bounds, scale bar, and
  // the shadow camera footprint. Works for any camera type (orthographic via
  // unproject's projection-matrix inversion, perspective likewise).
  // Mutates and returns _groundRectMin / _groundRectMax.
  function _computeVisibleGroundRect(cam) {
    _groundRectMin.set( Infinity, 0,  Infinity);
    _groundRectMax.set(-Infinity, 0, -Infinity);
    for (const [nx, ny] of _GROUND_RECT_NDC) {
      _groundRectCorner.set(nx, ny, 0.5).unproject(cam);
      const dx = _groundRectCorner.x - cam.position.x;
      const dy = _groundRectCorner.y - cam.position.y;
      const dz = _groundRectCorner.z - cam.position.z;
      if (Math.abs(dy) < 1e-6) continue;           // ray parallel to ground
      const t = -cam.position.y / dy;
      if (t <= 0) continue;                         // ground is behind camera
      const gx = cam.position.x + t * dx;
      const gz = cam.position.z + t * dz;
      if (gx < _groundRectMin.x) _groundRectMin.x = gx;
      if (gx > _groundRectMax.x) _groundRectMax.x = gx;
      if (gz < _groundRectMin.z) _groundRectMin.z = gz;
      if (gz > _groundRectMax.z) _groundRectMax.z = gz;
    }
  }

  // Bounding sphere (centroid + enclosing radius) of the visible-ground footprint.
  // Same four corner ray-casts as _computeVisibleGroundRect, but the sphere — unlike
  // the AABB — is invariant under camera azimuth: rotating the view yields a congruent
  // ground footprint, so its corners' pairwise distances (hence the radius) don't
  // change and the centroid only translates. updateShadowCamera fits the sun's ortho
  // box to this so the shadow texel size stays constant as you pan/rotate, which is the
  // precondition for the texel snap to actually hold. Mutates the _groundSphere* state.
  const _groundSphereCenter = new THREE.Vector3();
  const _groundSphereCorners = [
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ];
  let _groundSphereRadius = 0;
  let _groundSphereValid  = false;
  function _computeVisibleGroundSphere(cam) {
    let n = 0;
    _groundSphereCenter.set(0, 0, 0);
    for (const [nx, ny] of _GROUND_RECT_NDC) {
      _groundRectCorner.set(nx, ny, 0.5).unproject(cam);
      const dy = _groundRectCorner.y - cam.position.y;
      if (Math.abs(dy) < 1e-6) continue;           // ray parallel to ground
      const t = -cam.position.y / dy;
      if (t <= 0) continue;                         // ground is behind camera
      const c = _groundSphereCorners[n++];
      c.set(
        cam.position.x + t * (_groundRectCorner.x - cam.position.x),
        0,
        cam.position.z + t * (_groundRectCorner.z - cam.position.z),
      );
      _groundSphereCenter.add(c);
    }
    _groundSphereValid = n > 0;
    if (!_groundSphereValid) return;
    _groundSphereCenter.multiplyScalar(1 / n);
    let r2 = 0;
    for (let i = 0; i < n; i++) {
      const d2 = _groundSphereCenter.distanceToSquared(_groundSphereCorners[i]);
      if (d2 > r2) r2 = d2;
    }
    _groundSphereRadius = Math.sqrt(r2);
  }
  let _shadowsOn     = true;  // shadows on by default; checkbox reflects this via poll
  // Stored shadow strength — independent of the on/off toggle. Initialised from
  // the constant; the Shadows overlay multiplies by this when enabled, by 0 when
  // off (so the tuned strength survives a Shadows toggle).
  let _shadowIntensity = NCZ.SHADOW_INTENSITY;
  let _sunSphere     = null; // visible sun disc — shown during showcase only
  let _sunAz = Math.PI * 0.25, _sunEl = Math.PI * 0.35; // last *requested* setSunPosition args — placeholders only until the first call (the slider init in app.js), which may land before the lights exist
  let _terrainBox = null;     // THREE.Box3 of the terrain GLB; gates pan-bound clamp
                              // because the bound shouldn't activate before terrain loads
  let _introTween   = null;   // E5 intro fly-in tween, or null when idle
  let _introLastTime = 0;     // performance.now() of the previous intro frame

  // Material refs — stored so updateMaterials() can re-apply theme colors live
  let terrainMat = null;
  let waterMat   = null;
  let cliffsMat  = null;
  let roadsMat        = null;  // SeeThrough pass (water stencil)
  let bordersMat      = null;  // SeeThrough pass (water stencil)
  let normalRoadsMat  = null;  // Normal depth-tested pass
  let normalBordersMat= null;  // Normal depth-tested pass
  let metroMat        = null;
  let metroDistanceUniform = null; // TSL uniform() — schema camera-to-target distance; drives metro LOD tier discard (mutex)
  // Captured at WebGPURenderer construction so dumpDebugInfo can introspect
  // the antialias flag — WebGPURenderer has no getContextAttributes() to read it
  // back from, unlike WebGLRenderer.
  let _rendererInitParams = null;

  // ── Phase 2B compute culling state ─────────────────────────────────────
  // TWO 6-plane frustum sets shared by every district's cull compute:
  //   • _frustumPlaneUniforms       — the camera frustum (what the user sees)
  //   • _shadowFrustumPlaneUniforms — the sun's shadow camera frustum (what
  //                                   the shadow map covers)
  // An instance is visible to the cull if it passes EITHER frustum — so an
  // off-screen building still in the shadow ortho box gets into the indirect
  // buffer and casts its shadow into the visible area. (Phase 2B originally
  // tested only the camera frustum, which made shadows pop in at screen
  // edges on pan and vanish on small rotations at high zoom.) See
  // [[webgpu-migration-execution]] risk register row for the rationale of
  // Approach A (12-plane test) over sun-direction dilation or AABB union.
  //
  // Each plane is a vec4 packing `(normal.xyz, constant)`; the visibility
  // test against the bounding sphere is
  //   `dot(plane.xyz, center) + plane.w >= -radius`.
  // We recompute both sets on every `controls.change` (CPU-side, via Three's
  // existing `THREE.Frustum.setFromProjectionMatrix`) and push to the same
  // uniform nodes — much cheaper than passing matrices and re-deriving
  // planes per-thread on the GPU.
  const _frustumPlaneUniforms = [
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
  ];
  const _shadowFrustumPlaneUniforms = [
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
  ];
  const _frustumScratch       = new THREE.Frustum();
  const _frustumScratchMat    = new THREE.Matrix4();
  const _shadowFrustumScratch    = new THREE.Frustum();
  const _shadowFrustumScratchMat = new THREE.Matrix4();
  // Per-district compute nodes (reset + cull) registered during loadBuildings.
  // Dispatched in pairs from the animation-loop `frame()` before `renderer.render`.
  const _cullComputes = [];

  function updateFrustumUniforms(renderCam = camera) {
    if (!renderCam) return;
    // `renderCam` defaults to the schema ortho camera; pass the perspective
    // `flyCamera` during showcase so the cull tests against what's actually
    // being rendered. `Frustum.setFromProjectionMatrix` handles both
    // ortho + perspective projections — the algebra is the same.
    _frustumScratchMat.multiplyMatrices(renderCam.projectionMatrix, renderCam.matrixWorldInverse);
    // Critical: pass WebGPUCoordinateSystem so the near/far plane extraction
    // uses the WebGPU clip-space convention (depth range [0, 1]). The default
    // is WebGL (depth range [-1, 1]), which extracts a wrong near plane for
    // a WebGPU projection matrix and over-aggressively culls instances at
    // intermediate depths. The lateral planes (left/right/top/bottom) are
    // identical between conventions; only near/far differ.
    _frustumScratch.setFromProjectionMatrix(_frustumScratchMat, THREE.WebGPUCoordinateSystem);
    for (let i = 0; i < 6; i++) {
      const p = _frustumScratch.planes[i];
      _frustumPlaneUniforms[i].value.set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }
  }

  // Refresh the 6 sun-shadow-camera frustum planes from the current light
  // pose. Mirrors what `DirectionalLightShadow.updateMatrices()` does
  // internally before the shadow pass — position the shadow camera at the
  // light, aim it at the light target, refresh its world+inverse matrices —
  // so the planes we extract match the box the shadow renderer will use.
  // Called from `updateShadowCamera()` after the ortho box + light pose
  // have been re-fitted, so all existing `updateShadowCamera()` call sites
  // (controls.change, onResize, post-terrain, renderFrame fly cam,
  // startRenderLoop) automatically refresh the union-cull's second frustum.
  function updateShadowFrustumUniforms() {
    if (!_dirLight) return;
    if (!_shadowsOn) {
      // Shadows off → no off-screen caster needs to survive the cull for shadow
      // reasons. Poison the shadow frustum with a degenerate plane: `dot(plane.xyz,
      // center) + plane.w` = -1e30, so the cull's `dist >= -radius` test fails for
      // every instance → `shadowVisible` is always false and only camera-visible
      // instances draw. Pure uniform write; the compiled cullFn is untouched.
      _shadowFrustumPlaneUniforms[0].value.set(0, 0, 0, -1e30);
      return;
    }
    const shadowCam = _dirLight.shadow.camera;
    shadowCam.position.copy(_dirLight.position);
    shadowCam.lookAt(_dirLight.target.position);
    // Camera.updateMatrixWorld() also refreshes matrixWorldInverse — needed
    // for the projection × view multiply below.
    shadowCam.updateMatrixWorld(true);
    _shadowFrustumScratchMat.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
    _shadowFrustumScratch.setFromProjectionMatrix(_shadowFrustumScratchMat, THREE.WebGPUCoordinateSystem);
    for (let i = 0; i < 6; i++) {
      const p = _shadowFrustumScratch.planes[i];
      _shadowFrustumPlaneUniforms[i].value.set(p.normal.x, p.normal.y, p.normal.z, p.constant);
    }
  }
  let buildingMeshes     = [];    // one InstancedMesh per district
  let buildingMaterials  = [];    // parallel ShaderMaterial array for theme updates
  let landmarkMat        = null;  // shared MeshLambertMaterial for all landmark GLBs

  // District metadata — sourced directly from 3dmap_triangle_soup.Material.json.
  // dataDds: _data.dds (DXGI_FORMAT_R16G16B16A16_UNORM — raw 16-bit RGBA instance data)
  // dataDdsFixed: optional alignment-fixed _data from malgalad's "3D World Map
  //   Fixed" mod (Nexus #26500). Same dimensions/transforms as the vanilla
  //   dataDds (texel placement corrected), so it's a straight texture swap when
  //   the Fixed asset set is selected. ep1_spaceport has no fixed version → it
  //   stays on dataDds in both sets. See docs/3dmap-fixed-assets.md.
  // mDds:    _m.dds   (DXGI_FORMAT_R8_UNORM — 8-bit greyscale surface detail, 10 mips)
  // transMin/transMax: district-local CET XYZ bounds (before district offset)
  // offset: world XY offset applied to decoded positions (no Z offset)
  // cubeSize: half-extent multiplier (from CubeSize shader parameter)
  // edgeThickness / edgeSharpness: EdgeThickness / EdgeSharpnessPower from
  //   3d_map_cubes.mt — drive the building edge highlight. edgeSharpness sets
  //   the visible band width; edgeThickness only feeds the sub-pixel
  //   camera-distance term.
  const DISTRICT_META = [
    { name: 'westbrook',     dataDds: 'assets/dds/westbrook_data.dds',    dataDdsFixed: 'assets/dds/fixed/westbrook_data.dds',    mDds: 'assets/dds/westbrook_m.dds',    cubeSize: 197.0,        transMin: [-1078.94739, -1148.69434, -18.4205875],  transMax: [1155.12,      1562.87903,  507.894714],  offset: [  -97.209,    590.849], edgeThickness: 0.0001, edgeSharpness: 30 },
    { name: 'city_center',   dataDds: 'assets/dds/city_center_data.dds',  dataDdsFixed: 'assets/dds/fixed/city_center_data.dds',  mDds: 'assets/dds/city_center_m.dds',  cubeSize: 168.289993,   transMin: [ -770.609192, -530.549133, -40.6581497],  transMax: [1316.82483,    649.75531,  642.893127],  offset: [-2116.637,    106.508], edgeThickness: 0.0001, edgeSharpness: 30 },
    { name: 'heywood',       dataDds: 'assets/dds/heywood_data.dds',      dataDdsFixed: 'assets/dds/fixed/heywood_data.dds',      mDds: 'assets/dds/heywood_m.dds',      cubeSize: 197.236832,   transMin: [-1080.35107,  -418.153046, -38.4002304],  transMax: [1136.94556,   1372.15979,  374.181305],  offset: [-1576.732,  -1002.811], edgeThickness: 0.0005, edgeSharpness: 50 },
    { name: 'pacifica',      dataDds: 'assets/dds/pacifica_data.dds',     dataDdsFixed: 'assets/dds/fixed/pacifica_data.dds',     mDds: 'assets/dds/pacifica_m.dds',     cubeSize: 305.600006,   transMin: [-4008.396,   -4575.14941, -51.9539986],  transMax: [8258.31641,   7254.10059,  264.306946],  offset: [-2422.441,  -2368.156], edgeThickness: 0.0005, edgeSharpness: 50 },
    { name: 'santo_domingo', dataDds: 'assets/dds/santo_domingo_data.dds',dataDdsFixed: 'assets/dds/fixed/santo_domingo_data.dds',mDds: 'assets/dds/santo_domingo_m.dds',cubeSize: 139.342102,   transMin: [-1328.95288, -1880.02502, -37.5960007],  transMax: [1555.26318,   1369.01294,  332.348328],  offset: [  -15.944,  -1610.080], edgeThickness: 0.0001, edgeSharpness: 30 },
    { name: 'watson',        dataDds: 'assets/dds/watson_data.dds',       dataDdsFixed: 'assets/dds/fixed/watson_data.dds',       mDds: 'assets/dds/watson_m.dds',       cubeSize: 237.175003,   transMin: [-1254.46997, -1258.68469, -24.7028503],  transMax: [1988.5448,    2032.52405,  475.268005],  offset: [-1979.372,   1873.951], edgeThickness: 0.0005, edgeSharpness: 50 },
    { name: 'ep1_dogtown',   dataDds: 'assets/dds/dogtown_data.dds',      dataDdsFixed: 'assets/dds/fixed/dogtown_data.dds',      mDds: 'assets/dds/dogtown_m.dds',      cubeSize: 198.020691,   transMin: [-2650.0,     -3126.6084,   -0.750015974], transMax: [-1025.51855, -1803.58118,  493.576111],  offset: [    0.0,        0.0  ], edgeThickness: 0.0005, edgeSharpness: 50 },
    { name: 'ep1_spaceport', dataDds: 'assets/dds/spaceport_data.dds',    mDds: 'assets/dds/spaceport_m.dds',    cubeSize: 115.298218,   transMin: [-1168.5874,   -765.104614, -41.4592323],  transMax: [1219.45483,   1018.70129,  296.498138],  offset: [-4200.000,    200.000], edgeThickness: 0.0005, edgeSharpness: 50 },
    // Fixed-only "corrections overlay" — malgalad's combined my_district cloud
    // (world-space, offset 0). The per-district fixed textures remove the game's
    // broken blocks but don't replace them; my_district fills those gaps (e.g.
    // the Corpo Plaza building cluster). Only loaded with the Fixed asset set;
    // reuses the game's Pacifica surface (pacifica_m) that malgalad's material
    // points at — c_pacifica_m is byte-identical. See
    // docs/3dmap-fixed-assets.md.
    { name: 'my_district',   dataDds: 'assets/dds/fixed/my_district_data.dds', mDds: 'assets/dds/pacifica_m.dds', cubeSize: 200, transMin: [-2766, -5399, -50], transMax: [2960, 4254, 650], offset: [-828, -531], edgeThickness: 0.0005, edgeSharpness: 50, fixedOnly: true },
    // Fixed-only "ugly building" add-on (malgalad's optional download that returns
    // the building to Watson). Tiny standalone cloud; offset is its entity's
    // world position (FixedPoint-decoded). Same Pacifica surface as my_district.
    { name: 'ugly_building',  dataDds: 'assets/dds/fixed/ugly_building_data.dds', mDds: 'assets/dds/pacifica_m.dds', cubeSize: 200, transMin: [-578, -849, -50], transMax: [578, 849, 650], offset: [-1630, 1404], edgeThickness: 0.0005, edgeSharpness: 50, fixedOnly: true },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────

  function readThemeColor(varName, fallback) {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    // CSS custom properties return their literal stored value — CSS functions like
    // color-mix() are NOT resolved by getPropertyValue. Fall back if unparseable.
    try { return new THREE.Color(raw || fallback); }
    catch { return new THREE.Color(fallback); }
  }

  // Whether the active theme wants the in-game colour grade + braindance LUT.
  // Driven by the `--scene-grade` CSS custom property: the Game (and later
  // Preem) themes set it to 1; the five stylised themes leave it unset (0), so
  // they keep their own colour identity and get only the ACES tonemap.
  function themeGradeEnabled() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--scene-grade').trim();
    return parseFloat(raw) > 0;
  }

  // Read a numeric theme custom property (e.g. an opt-in intensity gate),
  // falling back when unset/unparseable. Same idea as themeGradeEnabled but
  // returns the value, not a boolean.
  function readThemeNumber(varName, fallback) {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  // Effective colour-grade state. Each theme has a default (--scene-grade);
  // the Settings "LUT" toggle can override it for the session. A theme switch
  // resets the override back to the new theme's default (see updateMaterials).
  let _gradeOn = false;
  function applyGrade(on) { _gradeOn = !!on; setSceneGradeEnabled(_gradeOn); requestRender(); }
  function setGradeEnabled(on) { applyGrade(on); }       // manual override (Settings toggle)
  function getGradeEnabled() { return _gradeOn; }

  // Edge-glow on/off, same pattern as the grade. Binary: on → the building
  // edge emissive uses the fixed NCZ.EDGE_GLOW_INTENSITY, off → 0. Each theme
  // has a default (--scene-edge-glow > 0); the Settings toggle overrides it for
  // the session; a theme switch resets to the new theme's default.
  let _edgeGlowOn = false;
  function applyEdgeGlow(on) {
    _edgeGlowOn = !!on;
    const v = _edgeGlowOn ? NCZ.EDGE_GLOW_INTENSITY : 0;
    for (const mat of buildingMaterials) {
      const u = mat.userData.tslUniforms;
      if (u?.uEdgeGlow) u.uEdgeGlow.value = v;
    }
    requestRender();
  }
  function setEdgeGlowEnabled(on) { applyEdgeGlow(on); }
  function getEdgeGlowEnabled() { return _edgeGlowOn; }
  function themeEdgeGlowDefault() { return readThemeNumber('--scene-edge-glow', 0) > 0; }

  // Derive edge highlight colour from the building base colour.

  // ── Terrain "graph-paper" grid ─────────────────────────────────────────────
  // Decoded from the game's 3d_map_terrain pixel shader (PIX DXIL capture).
  // In-game, terrain, water AND cliffs all use that one material template, so
  // every hillshade material below carries the grid.

  // Continuous anti-aliased grid-line coverage. The game's original formula
  // (round() + min(frac()·N,1), integrated over the pixel footprint) has hard
  // step discontinuities — coverage JUMPS as the camera moves, and the game
  // hides the resulting shimmer with TAA, which our scene does not have. This
  // replacement is continuous so it antialiases itself, no TAA needed:
  //   • triangle-wave distance to the nearest line centre — no jumps,
  //   • smoothstep ramp across the pixel footprint,
  //   • minification compensation — once a line is thinner than a pixel it is
  //     drawn at footprint width and dimmed proportionally, so it fades out
  //     smoothly instead of aliasing.
  // N is the line-width factor — a line spans ≈ cell/N. The +0.5 places the
  // lines where the game's formula put them (same grid, no flicker).
  const gridCoverage = Fn(([c, N]) => {
    const w         = dFdx(c).abs().max(dFdy(c).abs());                  // pixel footprint per axis
    const halfWidth = float(0.5).div(N);                                 // line half-width (cell fraction)
    const dist      = float(0.5).sub(c.add(0.5).fract().sub(0.5).abs()); // 0 on a line, 0.5 mid-cell
    const eff       = w.max(halfWidth);                                  // never thinner than a pixel
    const cov       = float(1).sub(smoothstep(eff.sub(w), eff.add(w), dist))
                              .mul(halfWidth.div(eff));                  // dim sub-pixel lines → fade
    return cov.x.max(cov.y).clamp(0, 1);   // a line in X or Y
  });

  // Three nested grids on world XZ (cells 80 / 8 / 400 wu) combined into one
  // line factor: main grid, minus the fine grid, with major lines boosted.
  function terrainGridFactor() {
    const P = positionWorld.xz;
    const [cellA, cellB, cellC] = NCZ.TERRAIN_GRID_CELLS;
    const [nA, nB, nC]          = NCZ.TERRAIN_GRID_LINE_N;
    const a = gridCoverage(P.div(cellA), nA);
    const b = gridCoverage(P.div(cellB).add(NCZ.TERRAIN_GRID_FINE_OFFSET), nB);
    const c = gridCoverage(P.div(cellC), nC);
    return a.mul(NCZ.TERRAIN_GRID_MAIN_WEIGHT).sub(b)
            .mul(c.mul(NCZ.TERRAIN_GRID_MAJOR_BOOST).add(1))
            .clamp(0, 1);
  }

  // ── Building edge highlight ────────────────────────────────────────────────
  // Decoded from the game's 3d_map_cubes.mt gbuffer pixel shader (PIX capture).
  // The game computes
  //   X    = max(|1-2u|, |1-2v|) + camDist·0.002·EdgeThickness / faceSize
  //   edge = saturate(pow(X, EdgeSharpnessPower))
  // `pow(X, power)` is NOT a step — it is a GRADIENT: ~0 across the inner face,
  // curving up to the bright rim. `edge` then lerps albedo → EdgeColor, so each
  // face shades dark-centre → light-edge (the in-game look). An earlier port
  // mistook the steep curve for a near-step and rendered a flat smoothstep
  // band, which dropped the gradient — this restores it.
  // No TAA here, so the steep rim is box-filtered over X's pixel footprint:
  // the analytic mean of X^p over [lo,hi] is
  //   (hi^(p+1) − lo^(p+1)) / ((hi − lo)(p+1))
  // → X^p as the footprint → 0, and self-flattens (toward 1/(p+1)) when the
  // whole gradient goes sub-pixel under minification, instead of shimmering.
  const buildingEdgeCoverage = Fn(([faceUv, sharpness, camTerm]) => {
    // X = max(|1−2u|, |1−2v|) + camTerm — 0 at the face centre, 1 at the edge.
    const X = faceUv.x.mul(2).sub(1).abs()
          .max( faceUv.y.mul(2).sub(1).abs() )
          .add(camTerm);
    const hw = dFdx(X).abs().max(dFdy(X).abs()).mul(0.5);  // half pixel-footprint of X
    const lo = X.sub(hw).clamp(0, 1);
    const hi = X.add(hw).clamp(0, 1);
    const p1 = sharpness.add(1);
    return hi.pow(p1).sub(lo.pow(p1))
             .div( hi.sub(lo).max(0.0001).mul(p1) )
             .clamp(0, 1);
  });

  // Hillshade material for terrain / water / cliffs. `colorNode` lerps the
  // theme base colour → theme grid colour by the procedural grid factor, so
  // each surface keeps its existing per-theme colour and the grid rides on
  // top. Where there's no grid line the factor is 0 and the colorNode is
  // exactly `materialColor` — the fill is identical to the plain material.
  //
  // Use the `mix()` FUNCTION, never the `.mix()` node method here: the
  // method does not evaluate as `mix(receiver, b, t)` — `materialColor.mix(
  // uGrid, 0)` rendered the grid colour, not the base colour, washing the
  // whole surface even at factor 0. The `mix(a, b, t)` function is correct
  // (verified: `mix(materialColor, uGrid, 0) === materialColor`).
  //
  // Base colour stays in `material.color` (read via `materialColor`); only
  // the grid line colour is a `uniform()` on userData.tslUniforms.
  function makeHillshadeMaterial(colorVar, fallback, extra = {}, brightness = 1) {
    const mat = new THREE.MeshLambertNodeMaterial({
      color: readThemeColor(colorVar, fallback),
      // INTENTIONAL faceted look — do NOT "fix" this. `flatShading` discards
      // the GLBs' (present) smooth vertex normals for per-face ones, so the
      // directional sun (#694) renders the terrain/cliffs as crisp triangle
      // facets. PR #741 removed this for "correct" smooth hillshading; a 12–3
      // community vote (2–2 among the core team) preferred the faceted version,
      // so it was restored as the deliberate style. Smooth shading is the
      // one-line opposite (drop this flag) if the call is ever revisited.
      flatShading: true,
      side: THREE.DoubleSide,
      ...extra,
    });
    const uGrid = uniform(readThemeColor('--scene-grid', '#6d8ab0'));
    mat.userData.tslUniforms = { uGrid };
    // Base colour + procedural grid. `brightness` is the material's decoded
    // Brightness param — water is 0.7 (3dmap_water.mi overrides it on the
    // shared terrain material); terrain and cliffs are 1.
    const shaded = mix(materialColor, uGrid, terrainGridFactor());
    mat.colorNode = brightness === 1 ? shaded : shaded.mul(brightness);
    return mat;
  }


  function applyMaterial(root, material) {
    root.traverse(child => {
      if (child.isMesh) child.material = material;
    });
  }

  // Give every descendant of `root` a prefixed, type-tagged name so the Needle
  // Inspector hierarchy reads as English instead of "mesh_0". WolvenKit/Blender
  // bakes generic names like "mesh_0", "Object_3", "Cube.001" — those are
  // overwritten. Any descriptive name (e.g. "Crystal_Palace_Tower") is kept.
  const NAME_GENERIC = /^(mesh|object|node|cube|sphere|group|geometry|line|primitive)[\s._\d]*$/i;
  function nameSubtree(root, prefix) {
    let i = 0;
    root.traverse(obj => {
      if (obj === root) return;
      if (obj.name && !NAME_GENERIC.test(obj.name)) return;
      obj.name = `${prefix}-${obj.type.toLowerCase()}-${i++}`;
    });
  }

  // Freeze world matrices on a fully-positioned static subtree so Three.js
  // skips the per-frame matrix-update traversal beneath it. Computes once,
  // then disables the auto-update flag the parent uses to recurse in.
  function freezeStatic(obj) {
    obj.updateMatrixWorld(true);
    obj.matrixWorldAutoUpdate = false;
  }

  // Hoisted singleton: MeshoptDecoder is attached so GLBs encoded with
  // EXT_meshopt_compression decode transparently. The decoder is a no-op for
  // uncompressed GLBs (the extension is only triggered when present). The
  // decoder ships with three.js examples — no extra dependency.
  const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

  function loadGLB(file) {
    const path = `${NCZ.GLB_DIR}/${file}`;
    return new Promise((resolve, reject) => {
      gltfLoader.load(path, gltf => resolve(gltf.scene), undefined, reject);
    });
  }

  // ── DDS loaders ─────────────────────────────────────────────────────────
  // DDS files exported by WolvenKit use DX10 extended headers (FourCC='DX10').
  // Standard header = 128 bytes, DX10 extension = 20 bytes → pixel data at offset 148.
  // _data.dds: DXGI_FORMAT_R16G16B16A16_UNORM — raw 16-bit RGBA, 1 mip, no compression.
  // _m.dds:    DXGI_FORMAT_R8_UNORM            — 8-bit greyscale, 10 mips, no compression.

  // Load _data.dds → Uint16Array of raw 16-bit RGBA pixel values.
  // Width and height are read from the DDS header (offsets 16 and 12).
  async function loadDataDds(path) {
    const buf    = await fetch(path).then(r => r.arrayBuffer());
    const header = new Uint32Array(buf, 0, 32);
    const width  = header[4];   // DDS header offset 16 = uint32 index 4
    const height = header[3];   // DDS header offset 12 = uint32 index 3
    const pixels = new Uint16Array(buf, NCZ.DDS_PIXEL_OFFSET);
    return { pixels, width, height };
  }

  // Load _m.dds → DataTexture (mip 0 only, WebGL generates the rest).
  // R8_UNORM: each pixel is one uint8 byte, normalised to [0,1] on GPU.
  async function loadMDds(path) {
    const buf    = await fetch(path).then(r => r.arrayBuffer());
    const header = new Uint32Array(buf, 0, 32);
    const width  = header[4];
    const height = header[3];
    const mip0   = new Uint8Array(buf, NCZ.DDS_PIXEL_OFFSET, width * height);
    const tex    = new THREE.DataTexture(mip0, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    tex.flipY = true;  // WolvenKit corrects VFlip on export; flipY matches TextureLoader convention
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Anisotropic filtering — fixes shimmer on surfaces viewed at oblique angles
    // (terrain/buildings tilted toward the camera). Mips alone aren't enough because
    // mip selection picks based on the smaller of the screen-space derivatives —
    // an elongated texture footprint still aliases along the long axis. AF samples
    // multiple texels along that axis. Free-ish on modern GPUs (fixed-function path).
    // WebGPU exposes the limit via `renderer.backend.device.limits.maxSamplerAnisotropy`
    // (post-init); WebGL2 fallback uses the legacy `renderer.capabilities.getMaxAnisotropy()`.
    // Cap at 16 — the hardware ceiling on every consumer GPU since ~2009.
    const maxAniso = renderer.backend?.device?.limits?.maxSamplerAnisotropy
                  ?? renderer.capabilities?.getMaxAnisotropy?.()
                  ?? 16;
    tex.anisotropy = Math.min(16, maxAniso);
    tex.needsUpdate = true;
    return tex;
  }

  function setLoadingText(text) {
    const el = loadingEl?.querySelector('.scene-loading__text');
    if (el) el.textContent = text;
  }
  function registerLoadStep(n = 1) { loadStepsTotal += n; }
  function stepProgress() {
    loadStepsDone++;
    if (loadingFillEl && loadStepsTotal > 0)
      loadingFillEl.style.width = `${(loadStepsDone / loadStepsTotal) * 100}%`;
  }
  function hideLoading() {
    if (loadingEl) loadingEl.style.display = 'none';
  }

  // Public: did the renderer end up on a real WebGPU backend? app.js calls
  // this after init() resolves to decide whether to start the 3D render loop
  // or fall the user back to the 2D Leaflet map.
  function isWebGPUActive() { return _webgpuActive; }

  // ── Scene init ─────────────────────────────────────────────────────────

  async function init(containerId) {
    if (initialized) return;
    initialized = true;

    // Diagnostic gate (?webgpuprobe). Captures the *real* WebGPU
    // adapter/device negotiation BEFORE Three.js swallows it into a single
    // "WebGPU is not available" log line. Separate from ?debug so it doesn't
    // pull in the stats.js panels. Belt-and-suspenders try/catch: the probe
    // also self-guards, but init() must never throw because of it.
    const PROBE = new URLSearchParams(window.location.search).has('webgpuprobe');
    if (PROBE) { try { await runWebGPUProbe(); } catch (_) { /* never blocks init */ } }

    const container = document.getElementById(containerId);
    loadingEl     = container.querySelector('.scene-loading');
    loadingFillEl = container.querySelector('.scene-loading__fill');

    // Renderer — WebGPU build with WebGL2 auto-fallback. The canvas is kept at
    // width/height:100% via the `#map-3d > canvas` rule in style.css so it
    // always fills #map-3d without pushing surrounding layout elements (and
    // without falling back to its intrinsic drawingBuffer size, which would
    // misalign with the CSS2D pin overlay on any DPR > 1.0).
    //
    // reversedDepthBuffer: stores depth as 1=near→0=far instead of 0=near→1=far,
    // and uses depthCompare:'greater' instead of 'less'. Combined with WebGPU's
    // native float depth, this redistributes precision so far-frustum surfaces
    // keep enough resolution to avoid Z-fighting at our 3-15km zoom range.
    // Strictly better than the old `logarithmicDepthBuffer` workaround — log-depth
    // writes frag_depth from the fragment shader, killing the GPU's early-Z
    // optimization. Reverse-Z achieves precision purely through projection-matrix
    // tricks; early-Z stays on. Available on `WebGPURenderer` since Three.js r183
    // (PR #32967, Feb 2026). Camera.reversedDepth is auto-corrected per PR #31410.
    //
    // (No `powerPreference` here — Chrome confirmed it's currently ignored on
    // Windows for navigator.gpu.requestAdapter() per https://crbug.com/369219127.
    // Hybrid-graphics laptops fall back to OS adapter selection. Watch list
    // item: revisit if dGPU isn't getting selected.)
    // requiredLimits: buildings read an `instancedArray` storage buffer from
    // the vertex shader. Under Three.js's `featureLevel:'compatibility'`
    // adapter request the vertex-stage storage-buffer limit defaults to 0, so
    // Chrome needs `maxStorageBuffersInVertexStage:1` opted in explicitly or
    // the first draw throws a binding-visibility error.
    //
    // But that per-stage limit is a newer split of the older unified
    // `maxStorageBuffersPerShaderStage`. Firefox 150 doesn't implement the new
    // name at all, and WebGPU rejects the ENTIRE device request if
    // `requiredLimits` names a limit the adapter doesn't expose
    // ("OperationError: Limit 'maxStorageBuffersInVertexStage' not
    // recognized") — which is exactly why the 3D scene silently fell back to
    // WebGL2 on Firefox. So probe the adapter first and only ask for the limit
    // on adapters that actually have it; Firefox's core mode allows the
    // vertex-stage read under its `maxStorageBuffersPerShaderStage` budget
    // without the opt-in. (Confirmed via the ?webgpuprobe diagnostic, PR #665.)
    const requiredLimits = {};
    try {
      const probeAdapter = await navigator.gpu?.requestAdapter();
      if (typeof probeAdapter?.limits?.maxStorageBuffersInVertexStage === 'number') {
        requiredLimits.maxStorageBuffersInVertexStage = 1;
      }
    } catch (_) {
      // No navigator.gpu / adapter — WebGPURenderer falls back to WebGL2 on
      // its own; nothing to require here.
    }
    _rendererInitParams = {
      antialias: true,
      stencil: true,
      reversedDepthBuffer: true,
      requiredLimits,
    };
    // TEMP — verification only, remove before dev→main. ?forcewebgl forces
    // the WebGL2 backend so the WebGPU-unavailable → 2D-Leaflet fallback can
    // be exercised on any browser (no about:config / exotic browser needed).
    if (new URLSearchParams(window.location.search).has('forcewebgl')) {
      _rendererInitParams.forceWebGL = true;
      console.warn('[NCZ] ?forcewebgl — forcing WebGL2 backend (test gate).');
    }
    renderer = new THREE.WebGPURenderer(_rendererInitParams);
    try {
      await renderer.init();   // WebGPURenderer requires async init before any use
    } catch (err) {
      // Neither WebGPU nor the WebGL2 fallback could initialise — bail to 2D.
      console.warn('[NCZ] Renderer init failed — falling back to the 2D map.', err);
      _webgpuActive = false;
      hideLoading();
      return;
    }
    // The 3D scene's buildings hard-depend on WebGPU compute (storage buffers,
    // indirect draw, atomics — no WebGL2 equivalent). On the WebGL2 fallback
    // they throw and the scene is broken-looking, so we don't render a
    // degraded 3D view at all: abort init here and let app.js fall the user
    // back to the fully-functional 2D Leaflet map (see forceSatFallback).
    _webgpuActive = !!renderer.backend?.isWebGPUBackend;
    if (!_webgpuActive) {
      console.warn('[NCZ] WebGPU unavailable — renderer on WebGL2 backend. ' +
                   'Aborting 3D init; using the 2D map instead.');
      hideLoading();
      return;
    }
    // r185's #33700 "fixed" render-list sorting under reversedDepthBuffer with
    // a wholesale list.reverse() AFTER the painter sort. The sort key is
    // groupOrder → renderOrder → z → id, so the reverse fixes the z direction
    // but also INVERTS renderOrder semantics — our transparent chain
    // (water 0 → SeeThrough roads 1 → metro 2) drew backwards: metro first
    // (then hidden under water's depthWrite) and SeeThrough roads before water
    // had written stencil=STENCIL_WATER (tunnel roads gone). Compensate by
    // handing the sorter comparators that are the exact NEGATION of the order
    // we want — the engine's trailing .reverse() then lands the desired order:
    // renderOrder ascending (the documented contract), z direction correct for
    // reversed-depth projected z (larger z = nearer). The id tiebreaker makes
    // the order total, so reverse(sort(-D)) == sort(D) exactly — no stability
    // caveats. Remove when upstream replaces the wholesale reverse with a
    // z-only fix: https://github.com/mrdoob/three.js/pull/33700
    if (renderer.reversedDepthBuffer === true) {
      const desiredOpaque = (a, b) =>       // front-to-back: z DESC (reversed z, near is larger)
        a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder :
        a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder :
        a.z !== b.z ? b.z - a.z :
        a.id - b.id;
      const desiredTransparent = (a, b) =>  // back-to-front: z ASC (reversed z, far is smaller)
        a.groupOrder !== b.groupOrder ? a.groupOrder - b.groupOrder :
        a.renderOrder !== b.renderOrder ? a.renderOrder - b.renderOrder :
        a.z !== b.z ? a.z - b.z :
        a.id - b.id;
      renderer.setOpaqueSort((a, b) => -desiredOpaque(a, b));
      renderer.setTransparentSort((a, b) => -desiredTransparent(a, b));
    }
    // Make the sRGB-correct colour pipeline explicit. These match Three.js r170
    // defaults (since r152 / r155 respectively) but stating them here protects
    // the scene's appearance against future Three.js default changes — both flags
    // have shifted in past major versions.
    THREE.ColorManagement.enabled = true;
    renderer.outputColorSpace     = THREE.SRGBColorSpace;
    // Tonemap — the exact in-game 3D-map ACES Output Transform. The map renders
    // through `TonemappingModeACES` (decoded from 3dmap.envparam); aces-tonemap.js
    // ports the ACES SSTS tone scale parametrised by the decoded
    // STonemappingACESParams and registers it as a custom WebGPU tone-mapping
    // function. This supersedes the interim NeutralToneMapping; Three's built-in
    // ACESFilmicToneMapping (the Narkowicz approximation — desaturates) is not used.
    // Exposure (NCZ.SCENE_EXPOSURE) — a normalised gauge. The in-game map's
    // physical camera decodes to exposure 0.000108, but that value can't be
    // used literally: it's a global multiplier and would crush the unlit
    // [0,1]-colour overlays (roads/metro/district lines) to black. So exposure
    // stays in the overlay-friendly range and the lights are scaled to match.
    // See the lighting block in constants.js.
    renderer.toneMapping         = registerCP2077ToneMapping(renderer);
    renderer.toneMappingExposure = NCZ.SCENE_EXPOSURE;
    // Load the braindance grading LUT — fire-and-forget; the texture binding is
    // stable so the data fill uploads transparently once the fetch lands. The
    // grade + LUT are gated per theme via the --scene-grade CSS var (Game/Preem
    // set it to 1; the five stylised themes leave it 0). Seed it from the
    // active theme; updateMaterials() re-reads it on every theme switch.
    loadBraindanceLUT('assets/data/braindance-lut.bin')
      .catch(err => console.warn('[NCZ] braindance LUT load failed:', err));
    applyGrade(themeGradeEnabled());
    // Cap effective DPR — see NCZ.MAX_DEVICE_PIXEL_RATIO. The debug-dump
    // "Renderer DPR" line shows the capped value; "Display ... DPR" still shows
    // the raw window.devicePixelRatio, so the two diverge for capped users.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, NCZ.MAX_DEVICE_PIXEL_RATIO));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    // Shadow render-on-demand is driven on the LIGHT, not here. Under
    // WebGPURenderer the shadow pass is gated by
    // `light.shadow.needsUpdate || light.shadow.autoUpdate`, and
    // renderer.shadowMap.autoUpdate/needsUpdate are inert (the WebGPU
    // renderer.shadowMap object only carries { enabled, transmitted, type }).
    // We hold _dirLight.shadow.autoUpdate = false (set just after the light is
    // created) and flag re-renders via flagShadowUpdate(), so the 4096² depth
    // pass only re-renders when a caster or the sun/shadow-camera actually moves —
    // theme tweens, pin hovers and other non-geometric frames skip it.
    // Take the canvas out of document flow so its pixel-buffer dimensions
    // can never push or displace surrounding layout elements.
    // inset:0 stretches it to fill #map-3d on all four sides — no explicit
    // width/height needed (and adding them alongside inset:0 can cause squishing).
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset    = '0';
    container.appendChild(renderer.domElement);

    initStats(container);

    // Scene background matches theme primary color
    scene = new THREE.Scene();
    scene.name = 'main-scene';
    scene.background = readThemeColor('--primary', '#0a192f');

    // Perspective camera matching the game's TopDown view — FOV 25°, distance in
    // CET / world units (see SCHEMA_CAMERA_* in constants.js; values mirror
    // WorldMap.TopDownCameraSettingsDefault in TweakDB). Z = -WORLD_CY because
    // GLB_Z = -CET_Y.
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(
      NCZ.SCHEMA_CAMERA_FOV, aspect, NCZ.SCHEMA_CAMERA_NEAR, NCZ.SCHEMA_CAMERA_FAR,
    );
    camera.name = 'schema-camera';
    // Open at the E5 intro's far pose; playIntro() flies it down to the rest
    // pose once the scene has finished loading.
    const _introStart = introCameraPose(NCZ.SCHEMA_INTRO_START_DISTANCE, NCZ.SCHEMA_INTRO_START_TILT);
    camera.position.copy(_introStart.position);
    camera.lookAt(_introStart.target);
    camera.up.set(0, 1, 0);
    camera.updateProjectionMatrix();

    // ── Lighting: calibrated to the in-game 3D map (3dmap.envparam) ──
    // The game lights the world map with a fixed low sun + a 6-direction ambient
    // cube, through an ACES tonemap (decoded from base/weather/24h_basic/
    // 3dmap.envparam). We reproduce that: a DirectionalLight with the decoded
    // warm sun colour + a HemisphereLight with the decoded sky/ground colours,
    // both at fixed (calibrated) intensity — the game's map has no time-of-day
    // variation. The sun slider still moves the sun's *direction* (shadows sweep,
    // faces relight); colour + intensity stay put. Cast shadows are layered on
    // top as an intentional artistic choice (the in-game map has them disabled).
    //
    // One shadow map, an OrthographicCamera fitted each move to the visible-ground
    // footprint (updateShadowCamera). castShadow stays on permanently; the
    // "shadows" layer toggle flips shadow *intensity* (toggling castShadow on a
    // live light tears its depth texture down mid-frame and crashes WebGPURenderer).
    _dirLight = new THREE.DirectionalLight(0xffffff, NCZ.SUN_INTENSITY);
    _dirLight.color.setRGB(...NCZ.SUN_COLOR_RGB, THREE.LinearSRGBColorSpace);
    _dirLight.name = 'sun';
    _dirLight.castShadow         = true;
    _dirLight.shadow.mapSize.set(NCZ.SHADOW_MAP_SIZE, NCZ.SHADOW_MAP_SIZE);
    _dirLight.shadow.camera.near = NCZ.SHADOW_CAM_NEAR;
    _dirLight.shadow.camera.far  = NCZ.SHADOW_CAM_FAR; // orthographic ⇒ a wide range costs no precision
    _dirLight.shadow.camera.name = 'sun-shadow-cam';
    _dirLight.shadow.bias        = NCZ.SHADOW_BIAS;        // 0 — native depth32float + reverse-Z need no depth cushion
    // The real WebGPU shadow-pass gate: hold autoUpdate off and re-render only when
    // flagShadowUpdate() raises needsUpdate (caster/sun/shadow-cam moved). While the
    // Shadows overlay is off, flagShadowUpdate() no-ops → the depth pass never runs.
    _dirLight.shadow.autoUpdate  = false;
    // normalBias is set per-frame by updateShadowCamera (scaled with the footprint).
    _dirLight.shadow.intensity   = _shadowsOn ? _shadowIntensity : 0;
    _dirLight.target.name = 'sun-target';
    // Position the light + target are set by updateShadowCamera (it centres the
    // shadow on the visible ground); seed them at the world centre so the first
    // frame before that runs isn't degenerate.
    _dirLight.target.position.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    _dirLight.position.copy(_dirLight.target.position).addScaledVector(_sunDir, NCZ.SUN_DIST);
    scene.add(_dirLight);
    scene.add(_dirLight.target);

    // Hemisphere ambient — the decoded envparam ambient cube collapses to a
    // hemisphere: 5 bright cool-white faces (sky + sides) over 1 dim blue face
    // (ground). Fixed colour + intensity, matching the game's fixed environment.
    _hemiLight = new THREE.HemisphereLight(0xffffff, 0xffffff, NCZ.AMBIENT_INTENSITY);
    _hemiLight.color.setRGB(...NCZ.AMBIENT_SKY_RGB, THREE.LinearSRGBColorSpace);
    _hemiLight.groundColor.setRGB(...NCZ.AMBIENT_GROUND_RGB, THREE.LinearSRGBColorSpace);
    _hemiLight.name = 'sky-fill';
    scene.add(_hemiLight);
    // Sun position is applied by app.js via the slider once terrain has loaded.

    // Visible sun sphere — hidden by default, shown during showcase only.
    // Radius NCZ.SUN_SPHERE_RADIUS units at NCZ.SUN_SPHERE_DIST distance ≈ 1.7° apparent diameter (≈3× real sun).
    _sunSphere = new THREE.Mesh(
      new THREE.SphereGeometry(NCZ.SUN_SPHERE_RADIUS, 16, 16),
      new THREE.MeshBasicNodeMaterial({ color: 0xffcc44 })
    );
    _sunSphere.name = 'sun-sphere';
    _sunSphere.visible = false;
    scene.add(_sunSphere);

    // OrbitControls — left=pan, right=tilt, middle=zoom.
    //
    // Attached to `container` (#map-3d), not `renderer.domElement` (the
    // canvas), so pointer events bubbling up from the CSS2D pin/cluster
    // overlay reach the controls — mirroring Leaflet's pattern where the
    // map's drag handler lives on the container element above the marker
    // layer. Combined with the pointer-capture defeat below, this lets
    // OrbitControls see drag/zoom gestures that start on a pin while the
    // pin's own `click` event still fires naturally on mouseup. (A prior
    // synthetic-event approach failed because pointer capture redirected
    // pointerup off the pin.)
    const _orbitDom = renderer.domElement.parentElement;
    controls = new OrbitControls(camera, _orbitDom);
    // Defeat OrbitControls' setPointerCapture — Leaflet doesn't use pointer
    // capture for its map drag, and that's exactly the property that
    // preserves click event dispatch on child markers. Without this
    // override, `pointerup` would retarget to the container and the
    // browser would fire `click` on the lowest common ancestor (the
    // container) instead of on the pin. No-op'ing both methods is a
    // single-line patch; the only behavioural trade-off is that a drag
    // pointer leaving the container during a gesture goes silent — the
    // container fills the viewport so this is a near-impossible case.
    _orbitDom.setPointerCapture     = () => {};
    _orbitDom.releasePointerCapture = () => {};
    // Scene-control UI (#scene-controls — Reset/Showcase buttons, sun slider,
    // tilt readout) lives *inside* #map-3d, so its gestures bubble up to the
    // OrbitControls listeners on _orbitDom and pan/zoom/tilt the camera while
    // you're operating a control (dragging the sun slider moved the map).
    // This is the inverse of the pin/cluster case above: pins *want* the
    // gesture to reach the camera (drag-to-pan, click still fires); controls
    // do NOT. Mirror Leaflet's L.DomEvent.disableClickPropagation /
    // disableScrollPropagation — stop the gesture-initiating events at the
    // control container so OrbitControls (the ancestor listener) never sees
    // them. stopPropagation only (no preventDefault / stopImmediatePropagation)
    // leaves the controls' own behaviour and click handlers fully intact.
    const _sceneControls = document.getElementById('scene-controls');
    if (_sceneControls) {
      for (const evt of ['pointerdown', 'wheel', 'contextmenu']) {
        _sceneControls.addEventListener(evt, (e) => e.stopPropagation());
      }
    }
    // District hover-brighten: cursor over a district's area fades its outline
    // up. Listener on the container so moves over the CSS2D pin overlay still
    // reach it (events bubble; pointer capture is no-op'd above). passive — we
    // never preventDefault, so the camera drag path is untouched.
    _orbitDom.addEventListener('mousemove', onSceneMouseMove, { passive: true });
    _orbitDom.addEventListener('mouseleave', () => { setHoveredDistrict(null); NCZ.DistrictInfo?.hide?.(); }, { passive: true });
    controls.mouseButtons = {
      LEFT:   THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT:  THREE.MOUSE.ROTATE,
    };
    controls.minPolarAngle  = NCZ.CAMERA_MIN_TILT;
    controls.maxPolarAngle  = NCZ.CAMERA_MAX_TILT;
    controls.dampingFactor  = NCZ.CAMERA_DAMPING;
    controls.minDistance    = NCZ.SCHEMA_CAMERA_MIN_DISTANCE;
    controls.maxDistance    = NCZ.SCHEMA_CAMERA_MAX_DISTANCE;
    controls.zoomSpeed      = NCZ.CAMERA_ZOOM_SPEED;
    controls.panSpeed       = NCZ.CAMERA_PAN_SPEED;
    controls.rotateSpeed    = NCZ.CAMERA_ROTATE_SPEED;
    controls.enableDamping  = true;
    // Ground-plane panning, not screen-space. Under perspective, screen-space
    // panning (the OrbitControls default) has a world-Y component whenever
    // the camera is tilted — left-drag at high tilt lifts controls.target off
    // the ground, the orbit pivot moves up, and subsequent rotates/zooms
    // behave around a lifted point so the camera itself appears to climb as
    // you pan. With screenSpacePanning=false, panning is constrained to the
    // plane orthogonal to the camera up vector (world XZ), so target stays
    // at Y=0 implicitly and vertical drag at high tilt moves the target
    // forward/back along the camera look direction at the same rate as
    // horizontal drag moves it left/right. Ortho hid the drift; perspective
    // surfaces it. See controls 'change' handler — no y-clamp needed.
    controls.screenSpacePanning = false;
    // Target the same point the camera is posed over (the E5 intro start —
    // see camera.position above). A mismatch here would make controls.update()
    // derive a bogus azimuth from the off-axis offset, rotating the pre-intro
    // loading view ~180° (it looked upside-down before this).
    controls.target.copy(_introStart.target);
    controls.update();
    updateFrustumUniforms();   // seed frustum planes for the first cull dispatch
    updateShadowCamera();      // seed the shadow camera from the initial pose
    controls.addEventListener('change', () => {
      updateDistrictZoom();
      if (metroDistanceUniform) metroDistanceUniform.value = camera.position.distanceTo(controls.target);
      updateShadowCamera();
      updateFrustumUniforms();   // Phase 2B: refresh the 6 cull-frustum planes
      updateScaleBar();
      requestRender();
    });

    // Cancel the E5 intro fly-in the moment the user grabs the controls, and
    // release the render-loop hold the tween took (paired setContinuousRender).
    controls.addEventListener('start', () => {
      if (_introTween) { _introTween = null; setContinuousRender(false); }
    });

    // Pan bounds — clamp controls.target so the camera can't drift
    // arbitrarily far from the visible terrain. OrbitControls has no built-in
    // min/maxPan, so we listen for 'change' and snap target back if it leaves
    // bounds, also moving camera.position by the same delta so the spherical
    // offset stays consistent.
    //
    // Bounds use the *terrain GLB extent* (the visible square ~[-8000, 8000]
    // in both Three X and Three Z) rather than the playable CET world extent
    // (which is asymmetric — playable area sits in the northern half of the
    // Y range). This gives the same "perfect square" feel Leaflet has on the
    // SAT view, where the user can pan equally far past every edge.
    //
    // panEdgeFraction = 0.5 collapses to zero offset → target clamps at the
    // terrain edge → at max pan, terrain edge sits at viewport center, half
    // terrain visible / half empty (matches Leaflet exactly at zero tilt).
    //
    // Tilt note: at high tilts the visible ground extent grows by 1/cos(polar)
    // in the tilt direction, so the "half-screen-past-terrain" feel stretches
    // out — you can technically pan more terrain off-screen at high tilt
    // before hitting the bound. An earlier tilt-correction attempt produced
    // catastrophic camera jumps when bounds inverted at extreme zoom-out +
    // tilt; that was reverted in favour of this stable simpler bound. A
    // proper tilt-aware fix is a future improvement (see E5/E6 discussion).
    controls.addEventListener('change', () => {
      const t = controls.target;
      const f = NCZ.PIN_3D_PAN_EDGE_FRACTION;
      // Pan envelope = TweakDB WorldMap.DefaultSettings.cursorBoundary (the
      // game's own pan limits — tighter than the terrain GLB extent because
      // the playable area sits in the northern half of the world). Allow the
      // target to drift toward an edge by (f - 0.5) × visible-rect-size so
      // edge content can still be centred.
      _computeVisibleGroundRect(camera);
      const Vx = _groundRectMax.x - _groundRectMin.x;
      const Vz = _groundRectMax.z - _groundRectMin.z;
      const offsetX = (f - 0.5) * Vx;
      const offsetZ = (f - 0.5) * Vz;
      const xMin = NCZ.PAN_BOUND_MIN_X - offsetX;
      const xMax = NCZ.PAN_BOUND_MAX_X + offsetX;
      const zMin = NCZ.PAN_BOUND_MIN_Z - offsetZ;
      const zMax = NCZ.PAN_BOUND_MAX_Z + offsetZ;
      let dx = 0, dz = 0;
      if (t.x < xMin) dx = xMin - t.x;
      else if (t.x > xMax) dx = xMax - t.x;
      if (t.z < zMin) dz = zMin - t.z;
      else if (t.z > zMax) dz = zMax - t.z;
      if (dx === 0 && dz === 0) return;
      t.x += dx;
      t.z += dz;
      camera.position.x += dx;
      camera.position.z += dz;
      requestRender();
    });

    window.addEventListener('resize', onResize);

    // Attach the marker layer (CSS2DRenderer overlay + pin group) before assets load,
    // so app.js can call NCZ.ThreeMarkers.setMods() as soon as mod data is fetched
    // even if GLBs haven't finished loading yet. controls is passed so the marker
    // layer can drive camera fly-to-pin tweens on focusMod().
    NCZ.ThreeMarkers?.attach?.(scene, camera, container, controls);

    // Initial scale bar — controls 'change' won't fire until the user
    // interacts, so paint the bar once at startup using the initial camera state.
    updateScaleBar();

    loadTerrain();
  }

  // Suppresses ONLY renderer.setSize during the showcase (issue #771). r185's
  // WebGPURenderer keeps a stale binding to the internal HDR render-context
  // target after setSize destroys/recreates it — a setSize during the
  // flyover's continuous loop then makes every subsequent frame submit a
  // destroyed texture ("Destroyed texture ... used in a submit"). The
  // showcase's fullscreen enter fires a resize; holding the drawing buffer at
  // its pre-showcase size keeps the cached binding valid, and CSS stretches
  // the canvas to fullscreen. Geometrically safe: flyover.js keeps
  // flyCamera.aspect synced to the *client* aspect, and the NDC→client
  // mapping is identical whether the buffer resizes or CSS stretches.
  //
  // Everything else in onResize MUST still run — in particular
  // ThreeMarkers.onResize (the CSS2DRenderer maps NDC to its own stored
  // size; leaving it stale while the client size changes offsets every pin,
  // cluster and district label from its world anchor — issue #769, the
  // "floating pins" bug the original full-early-return version caused).
  // See scripts/r185_resize_spike.html for the repro seed; the real fix is
  // upstream (bind-group cache must re-key on target recreation).
  let _resizeSuppressed = false;
  function setResizeSuppressed(on) { _resizeSuppressed = !!on; }
  let _lastBufferW = 0, _lastBufferH = 0; // last size the drawing buffer was set to

  function onResize() {
    if (!renderer) return;
    const container = renderer.domElement.parentElement;
    if (!container || container.style.display === 'none') return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const bufferResized = !_resizeSuppressed && (w !== _lastBufferW || h !== _lastBufferH);
    if (bufferResized) {
      renderer.setSize(w, h, false); // updateStyle:false — CSS width/height stay at 100%
      _lastBufferW = w; _lastBufferH = h;
    }
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateShadowCamera();   // shadow camera follows the schema camera's aspect
    // flyCamera resize is handled in flyover.js
    // Line2NodeMaterial pulls viewport size from a TSL screen node at
    // shader-execution time, so the legacy resolution-set loop is no longer
    // needed here. What IS needed on r185: dispose the district line
    // materials after setSize so the backend drops their cached render state.
    // The Line2 render path retains GPU state referencing the renderer's
    // canvas-size RGBA16Float framebuffer target; setSize destroys and
    // recreates that target but the cached state is never re-keyed, so every
    // later submit that includes a district line binds the destroyed texture
    // and the whole frame's submit is discarded — canvas wedges black until
    // reload (#771; bisect 2026-07-03: base scene, buildings, shadows, roads
    // and metro all resize clean — district Line2 alone carries the wedge;
    // material.needsUpdate is NOT sufficient to flush it, dispose() is).
    // Three rebuilds the disposed materials transparently on their next
    // render. Gated on an actual buffer resize so resize-event storms during
    // a window drag don't recompile the line pipelines redundantly.
    if (bufferResized) {
      for (const m of districtLineMaterials) m.dispose();
    }
    NCZ.ThreeMarkers?.onResize?.(w, h);
    updateScaleBar();
    requestRender();
  }

  // ── Layer registry ─────────────────────────────────────────────────────
  // Named scene groups — toggled by setLayerVisibility()

  const layers = {
    terrain:   null,
    water:     null,
    cliffs:    null,
    roads:     null,
    metro:     null,
    districts: null,  // parent group — toggled as a unit
    buildings: null,
  };

  // Sub-groups inside layers.districts (parent group controls overall visibility):
  let _districtOuter  = null; // districts with subs — visible at the districts zoom band (d ≥ 11000)
  let _districtSub    = null; // canonical subdistricts — visible at the subs band (7000 ≤ d < 11000)
  let _districtAlways = null; // no-sub districts (Dogtown / Morro Rock) + non-canonical subs (Casino) — visible whenever EITHER outline tier is

  // Name labels: { css: CSS2DObject, group } — `group` is the outline tier the
  // label belongs to, so the label is shown exactly when that tier is.
  const _districtLabels = [];

  // Gate each label per-leaf (CSS2D `visible` doesn't cascade from a parent
  // group). A label shows when the Districts overlay is on AND its outline
  // tier's group is currently visible — so district names appear at the
  // district zoom band, subdistrict names at the subdistrict band.
  function updateDistrictLabelVisibility() {
    if (!_districtLabels.length) return;
    const districtsOn = layers.districts ? layers.districts.visible : true;
    // Showcase mode: names are a user option independent of the outline tier
    // (the tier groups stay visible to carry the pinned outlines — see
    // forceDistrictBand — so the label gate needs its own switch).
    const namesOn = _showcaseDistricts ? _showcaseDistricts.names : true;
    for (const { css, group } of _districtLabels) css.visible = districtsOn && group.visible && namesOn;
  }

  function setLayerVisibility(name, visible) {
    if (name === 'districts') {
      if (layers.districts) layers.districts.visible = visible;
      if (visible) updateDistrictZoom();
      updateDistrictLabelVisibility();
      requestRender();
      return;
    }
    if (name === 'shadows') { setShadowsEnabled(visible); return; }
    // The marker overlay isn't a scene layer — it's a separate CSS2DRenderer
    // pass owned by ThreeMarkers, gated by the schema camera's Three.js
    // Object3D.layers mask. Routing it through here keeps the overlay-controls
    // panel's [data-overlay] handler uniform across every toggle.
    if (name === 'pins') { NCZ.ThreeMarkers?.setOverlayVisible?.(visible); requestRender(); return; }
    if (name === 'buildings' && layers.landmarks) layers.landmarks.visible = visible;
    if (layers[name]) layers[name].visible = visible;
    requestRender();
  }

  // Pins the district-outline tier independent of the schema camera's zoom
  // band. The showcase flyover renders through its own camera while the
  // schema camera (which drives updateDistrictZoom) is frozen — starting a
  // showcase zoomed in below SUBDISTRICT_DISTANCE_3D froze ALL outline tiers
  // hidden for the whole flight, so "Show district outlines" silently did
  // nothing. 'district' pins the main-district tier (the cinematic look the
  // waypoint script was written for); null restores zoom-band control.
  //
  // opts { names, outlines } split the showcase district feature: names gate
  // the CSS2D labels (see updateDistrictLabelVisibility), outlines gate the
  // Line2 rings per-line (the tier groups stay visible either way so labels
  // can show without outlines). Outlines render at the HOVERED opacity for
  // the whole flight — the 5% base is illegible from cinematic distances.
  let _districtBandForced = null; // 'district' | null
  let _showcaseDistricts  = null; // { names, outlines } | null
  function forceDistrictBand(band, opts = null) {
    _districtBandForced = band;
    _showcaseDistricts  = band === 'district'
      ? { names: !!(opts?.names ?? true), outlines: !!(opts?.outlines ?? true) }
      : null;
    if (band === 'district') {
      if (_districtOuter)  _districtOuter.visible  = true;
      if (_districtSub)    _districtSub.visible    = false;
      if (_districtAlways) _districtAlways.visible = true;
      for (const e of _districtHover) {
        if (e.line) e.line.visible = _showcaseDistricts.outlines;
        e.target = NCZ.DISTRICT_LINE_OPACITY_HOVER;
        if (e.material) e.material.opacity = NCZ.DISTRICT_LINE_OPACITY_HOVER;
      }
    } else {
      for (const e of _districtHover) {
        if (e.line) e.line.visible = true;
        e.target = NCZ.DISTRICT_LINE_OPACITY;
        if (e.material) e.material.opacity = NCZ.DISTRICT_LINE_OPACITY;
      }
      updateDistrictZoom();
    }
    updateDistrictLabelVisibility();
    requestRender();
  }

  function updateDistrictZoom() {
    if (_districtBandForced) return; // showcase owns the band — see forceDistrictBand
    if (!_districtOuter || !_districtSub || !controls) return;
    // Three-state visibility, matching WorldMap.ZoomLevel* records:
    //   d ≥ 11000: main district outlines (ZoomLevelDistricts.showDistricts = 1)
    //   7000 ≤ d < 11000: subdistrict outlines (ZoomLevelSubDistricts.showSubDistricts = 1)
    //   d < 7000: neither (every closer zoom-level record has both flags false)
    // The game hides outlines entirely at close zoom — only mappins remain.
    // alwaysGroup (no-sub districts + non-canonical subs) follows the same
    // outline-tier-visible rule: shown whenever EITHER district or subdistrict
    // tier would render, hidden together with them below 7000.
    // Distance from camera to target = distance-to-ground (target sits on Y=0).
    const distance = camera.position.distanceTo(controls.target);
    _districtOuter.visible = distance >= NCZ.DISTRICT_DISTANCE_3D;
    _districtSub.visible   = distance >= NCZ.SUBDISTRICT_DISTANCE_3D && distance < NCZ.DISTRICT_DISTANCE_3D;
    if (_districtAlways) _districtAlways.visible = distance >= NCZ.SUBDISTRICT_DISTANCE_3D;
    updateDistrictLabelVisibility();
  }

  // ── District hover-brighten ─────────────────────────────────────────────
  // In-game parity: outlines sit at NCZ.DISTRICT_LINE_OPACITY (5%) and brighten
  // to ~full over 250 ms when the cursor enters the district's area. No pick
  // geometry — the rings are flat on Y=0, so we intersect the cursor ray with
  // the ground plane and run a CPU point-in-polygon over the in-memory rings.
  // One registry entry per outline; `group` is its visibility tier so we only
  // test (and brighten) outlines that are actually drawn at the current zoom.
  const _districtHover = []; // { ring, line, material, group, area, target }
  let _hoveredEntry = null;
  // Draw the hovered outline last so it paints on top of any coincident faint
  // neighbour. Outlines have depthTest:false (depth ignored), so the only thing
  // that decides which of two coplanar coincident lines wins a pixel is paint
  // order — and the transparent back-to-front sort is unstable for equal-
  // distance lines. District outlines sit at tier 7 of the explicit transparent
  // chain (water 0 → roads depth/colour 1/2 → borders depth/colour 3/4 →
  // SeeThrough 5 → metro 6 → districts 7) so they always draw after water — a
  // shared tier would fall back to camera-angle-dependent centroid-z ties.
  // A higher renderOrder forces the hovered line last so it reads above its
  // siblings. Reset to the base tier on exit.
  const DISTRICT_LINE_RENDER_ORDER  = 7;
  const DISTRICT_HOVER_RENDER_ORDER = 10;
  let _hoverFading  = false; // true while any material.opacity != its target
  let _hoverLastT   = 0;
  const _hoverRay    = new THREE.Raycaster();
  const _hoverPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y = 0
  const _hoverNdc    = new THREE.Vector2();
  const _hoverWorld  = new THREE.Vector3();

  // Shoelace area (absolute) — used to prefer the smallest matching ring when a
  // point sits inside nested outlines (e.g. the casino sub inside Westbrook).
  function polygonArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(a) / 2;
  }

  // line may be null for a label-only hover region (Badlands has no outline but
  // still wants its name to emphasise when the cursor is over its area).
  function registerDistrictHover(ring, line, group, labelEl, districtId, subId) {
    if (!ring || ring.length < 3) return;
    _districtHover.push({
      ring,
      line: line || null,
      material: line?.material || null,
      group,
      labelEl: labelEl || null, // matched name label, emphasised in sync on hover
      districtId: districtId || null, // for the info panel
      subId: subId || null,
      area: polygonArea(ring),
      target: NCZ.DISTRICT_LINE_OPACITY,
    });
  }

  // Intersect the cursor ray with the Y=0 ground plane → CET [x, y], or null.
  function groundPointAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    _hoverNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1)
    );
    _hoverRay.setFromCamera(_hoverNdc, camera);
    // Near-horizontal rays barely graze Y=0 — bail rather than pick a point
    // kilometres off (cf. ray-to-ground-thit-explodes-near-horizontal). Outlines
    // only show when zoomed out/steep, so this never costs a real hover.
    if (Math.abs(_hoverRay.ray.direction.y) < 1e-3) return null;
    if (!_hoverRay.ray.intersectPlane(_hoverPlane, _hoverWorld)) return null;
    return [_hoverWorld.x, -_hoverWorld.z]; // world (x,z) → ring (cetX, cetY)
  }

  // The visible outline under a CET ground point (or null) — only outlines whose
  // tier group is currently drawn, smallest-area first. Drives the brighten;
  // the info panel resolves the subdistrict separately (all tiers).
  function pickDistrictAt(gp) {
    if (!gp || !_districtHover.length || !layers.districts?.visible) return null;
    let best = null;
    for (const e of _districtHover) {
      if (!e.group.visible) continue;
      if (NCZ.pointInPolygon(gp, e.ring) && (!best || e.area < best.area)) best = e;
    }
    return best;
  }

  function setHoveredDistrict(entry) {
    if (entry === _hoveredEntry) return;
    if (_hoveredEntry) {
      _hoveredEntry.target = NCZ.DISTRICT_LINE_OPACITY;
      if (_hoveredEntry.line) _hoveredEntry.line.renderOrder = DISTRICT_LINE_RENDER_ORDER;
      _hoveredEntry.labelEl?.classList.remove('district-label-hover');
    }
    if (entry) {
      entry.target = NCZ.DISTRICT_LINE_OPACITY_HOVER;
      // line is null for label-only entries (Badlands has no outline).
      if (entry.line) entry.line.renderOrder = DISTRICT_HOVER_RENDER_ORDER;
      // Emphasise the matching name label in sync with the outline brighten.
      entry.labelEl?.classList.add('district-label-hover');
    }
    _hoveredEntry = entry;
    if (!_hoverFading) { _hoverFading = true; _hoverLastT = performance.now(); setContinuousRender(true); }
  }

  function onSceneMouseMove(e) {
    // Showcase mode pins every outline at the hovered opacity — the pointer
    // must not re-target materials mid-flight (and the pick raycast uses the
    // schema camera, which is wrong under the fly camera anyway).
    if (_showcaseDistricts) return;
    const gp = groundPointAt(e.clientX, e.clientY);
    setHoveredDistrict(pickDistrictAt(gp)); // outline/label brighten (tier-gated)
    // Info panel resolves the subdistrict under the cursor at any tier; stats
    // reflect the whole district at the district tier, the sub below it.
    if (gp && layers.districts?.visible) {
      const distance = camera.position.distanceTo(controls.target);
      const statsLevel = distance >= NCZ.DISTRICT_DISTANCE_3D ? 'district' : 'sub';
      NCZ.DistrictInfo?.showAt?.(gp[0], gp[1], statsLevel);
    } else NCZ.DistrictInfo?.hide?.();
  }

  // Advance every outline material toward its target opacity. Linear over
  // NCZ.DISTRICT_HOVER_FADE_MS for the full 0.05↔1.0 range; releases the
  // continuous-render hold once all materials have settled.
  function stepDistrictHoverFade(now) {
    if (!_hoverFading) return;
    const dt = Math.max(0, now - _hoverLastT);
    _hoverLastT = now;
    const range = NCZ.DISTRICT_LINE_OPACITY_HOVER - NCZ.DISTRICT_LINE_OPACITY;
    const maxStep = range * (dt / NCZ.DISTRICT_HOVER_FADE_MS);
    let active = false;
    for (const e of _districtHover) {
      if (!e.material) continue; // label-only entry (Badlands) — no outline to tween
      const diff = e.target - e.material.opacity;
      if (Math.abs(diff) <= maxStep || maxStep === 0) {
        if (e.material.opacity !== e.target) e.material.opacity = e.target;
      } else {
        e.material.opacity += Math.sign(diff) * maxStep;
        active = true;
      }
    }
    if (!active) { _hoverFading = false; setContinuousRender(false); }
  }

  // ── Scale bar ───────────────────────────────────────────────────────
  // Mirrors Leaflet's L.control.scale: pick a "nice" round length (1, 2, or
  // 5 × 10ⁿ metres) closest to PIN_3D_SCALE_TARGET_PX wide on screen, render
  // a horizontal bar of that pixel width, label it. CET unit ≈ metre, so no
  // unit conversion needed beyond CET_UNITS_PER_METER (default 1).
  //
  // Perspective worldPerPixel along screen-X at the *centre of screen* (where
  // the OrbitControls target sits on Y=0): visible width = 2 × distance ×
  // tan(FOV/2) × aspect; worldPerPixel = that / canvasWidth. Screen-X is
  // parallel to the ground regardless of tilt, so the bar still reads true
  // when tilted (camera right vector stays in the world XZ plane).
  function updateScaleBar() {
    if (!camera || !renderer || !controls) return;
    const el = document.querySelector('#scene-scale .leaflet-control-scale-line');
    if (!el) return;
    const canvasWidth = renderer.domElement.clientWidth;
    if (!canvasWidth) return;
    const distance = camera.position.distanceTo(controls.target);
    const halfFovY = (camera.fov * Math.PI) / 360;
    const visibleWidth = 2 * distance * Math.tan(halfFovY) * camera.aspect;
    const worldPerPixel = visibleWidth / canvasWidth;
    const metresPerPixel = worldPerPixel / NCZ.CET_UNITS_PER_METER;
    const idealMetres = NCZ.PIN_3D_SCALE_TARGET_PX * metresPerPixel;
    if (!isFinite(idealMetres) || idealMetres <= 0) return;
    // Snap to 1 / 2 / 5 × 10ⁿ
    const pow10 = Math.pow(10, Math.floor(Math.log10(idealMetres)));
    const ratio = idealMetres / pow10;
    const mantissa = ratio < 2 ? 1 : ratio < 5 ? 2 : 5;
    const niceMetres = mantissa * pow10;
    const barPx = Math.round(niceMetres / metresPerPixel);
    const label = niceMetres < 1000
      ? `${niceMetres} m`
      : `${(niceMetres / 1000).toFixed(niceMetres % 1000 === 0 ? 0 : 1)} km`;
    el.style.width = `${barPx}px`;
    el.textContent = label;
  }

  // ── GLB loading (tiered) ───────────────────────────────────────────────

  async function loadTerrain() {
    registerLoadStep(); // terrain
    setLoadingText('Loading terrain...');
    try {
      // Tier 1: terrain + water + cliffs in parallel
      const [terrainScene, waterScene, cliffsScene] = await Promise.all([
        loadGLB('3dmap_terrain.glb'),
        loadGLB('3dmap_water.glb'),
        loadGLB('3dmap_cliffs.glb'),
      ]);

      // SeeThrough-roads stencil chain (Pacifica tunnel — a road visible *through* the open bay).
      //   • Water writes stencil=STENCIL_WATER where it's the visible surface. The water GLB is a
      //     flat sea-level sheet (world Y ≈ -1) the whole terrain (Y -99..+879) pokes through, so
      //     for stencilZPass to land only on "pixels where you see water" (the open bay = where the
      //     terrain dips below sea level), water must be depth-tested against the FULLY-rendered
      //     opaque scene. `transparent: true` (opacity = WATER_OPACITY, 1.0 by default — still
      //     visually opaque) moves water out of the opaque list into the transparent pass, which is
      //     unconditionally drawn after every opaque object — so its depth test sees terrain/cliffs/
      //     buildings already in the depth buffer and fails over all of them, confining
      //     stencil=STENCIL_WATER to the bay. (Plain renderOrder doesn't push water past the terrain
      //     in the opaque sort under WebGPURenderer — cause unclear; the transparent pass sidesteps
      //     the sort entirely.) renderOrder stays 0, so water still draws before the SeeThrough roads.
      //   • Terrain, cliffs and buildings over-stamp stencil=STENCIL_OCCLUDER where THEY are the
      //     visible surface (depth-tested, ZPass:Replace) — so SeeThrough roads don't draw through
      //     them. Safe vs the tunnel because water (transparent pass) re-writes stencil=STENCIL_WATER
      //     over the bay AFTER the terrain seabed wrote stencil=STENCIL_OCCLUDER there in the opaque pass.
      const stencilOverstamp = { stencilWrite: true, stencilRef: NCZ.STENCIL_OCCLUDER, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp };
      terrainMat = makeHillshadeMaterial('--scene-terrain', '#566c88', stencilOverstamp);
      waterMat   = makeHillshadeMaterial('--scene-water',   '#566c88', {
        transparent: true, opacity: NCZ.WATER_OPACITY,
        stencilWrite: true, stencilRef: NCZ.STENCIL_WATER,
        stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      }, 0.7); // 0.7 = Brightness override in 3dmap_water.mi (shared terrain material)
      cliffsMat  = makeHillshadeMaterial('--scene-cliffs',  '#566c88', stencilOverstamp);
      applyMaterial(terrainScene, terrainMat);
      applyMaterial(waterScene,   waterMat);
      applyMaterial(cliffsScene,  cliffsMat);

      // Shadow flags — terrain RECEIVES only (no longer casts). Road/metro
      // decals sit near-coplanar with terrain and use shadow() to receive
      // building shadows; if terrain also casts, the decal's shadow sample
      // reads as occluded by the terrain right under it → black-stripe acne
      // along the road. Cliffs still cast (they're elevated and the user
      // wants long cliff-base shadows). Water receives only (flat ocean).
      // Side-benefit: terrain self-shadow "the wave" (grazing-sun acne) goes
      // away as a consequence — Phase 3's footprint-scaled normalBias was
      // there to mask exactly that.
      terrainScene.traverse(c => { if (c.isMesh) { c.receiveShadow = true; c.frustumCulled = false; } });
      waterScene.traverse(c =>   { if (c.isMesh) { c.receiveShadow = true; c.frustumCulled = false; } });
      cliffsScene.traverse(c =>  { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.frustumCulled = false; } });



      // Cliffs GLB entity localTransform offset (resolved from WolvenKit export):
      // CET pos (-2255, -3050) → GLB offset X=-2255, Z=+3050
      cliffsScene.position.set(-2255, 0, 3050);

      terrainScene.name = 'terrain';
      waterScene.name   = 'water';
      cliffsScene.name  = 'cliffs';
      nameSubtree(terrainScene, 'terrain');
      nameSubtree(waterScene,   'water');
      nameSubtree(cliffsScene,  'cliffs');

      layers.terrain = terrainScene;
      layers.water   = waterScene;
      layers.cliffs  = cliffsScene;
      scene.add(terrainScene, waterScene, cliffsScene);
      freezeStatic(terrainScene);
      freezeStatic(waterScene);
      freezeStatic(cliffsScene);
      requestRender();

      // Fit camera frustum to the terrain bounding box. Stored at module
      // scope so the pan-bound listener can clamp against terrain extent
      // (the visible square) instead of the playable-CET-world extent
      // (which is asymmetric north-south).
      const box = new THREE.Box3().setFromObject(terrainScene);
      _terrainBox = box;   // retained for the pan-bound clamp; the opening
                           // camera framing is the E5 intro fly-in (playIntro).

      stepProgress(); // terrain done
      updateShadowCamera(); // re-fit the shadow camera now the schema camera is sized to terrain
      setLoadingText('Loading roads & buildings...');

      // Trigger the sun slider so app.js applies the correct initial sun position.
      // Done here (post-terrain) because ThreeScene.setSunPosition now exists and
      // the directional light is in the scene — the slider fires too early otherwise.
      document.getElementById('scene-sun-slider')?.dispatchEvent(new Event('input'));

      // Tier 2+3: start all concurrent tasks, hide loading only when all complete.
      // Add future loaders (loadLandmarks etc.) to this array.
      Promise.all([loadRoadsMetro(), loadDistricts(), loadBuildings(), loadLandmarks()])
        .then(() => {
          // Buildings now exist — apply the active theme's edge-glow default to
          // their uniforms (updateMaterials' early applyEdgeGlow ran before the
          // materials were built; the grade has no such dependency).
          applyEdgeGlow(themeEdgeGlowDefault());
          hideLoading();
          playIntro();
        });

    } catch (err) {
      console.error('[NCZ] Terrain GLB load failed:', err);
      setLoadingText('Failed to load terrain. Check console for details.');
    }
  }

  async function loadRoadsMetro() {
    registerLoadStep(); // roads + metro
    try {
      const [roadsScene, metroScene, bordersScene] = await Promise.all([
        loadGLB('3dmap_roads.glb'),
        loadGLB('3dmap_metro.glb'),
        loadGLB('3dmap_roads_borders.glb'),
      ]);

      // All road GLBs have inverted X axis — rotate 180° around Y to correct
      roadsScene.rotation.y   = Math.PI;
      metroScene.rotation.y   = Math.PI;
      bordersScene.rotation.y = Math.PI;

      roadsScene.name   = 'roads-loaded';
      metroScene.name   = 'metro-loaded';
      bordersScene.name = 'road-borders-loaded';
      nameSubtree(roadsScene,   'road');
      nameSubtree(metroScene,   'metro');
      nameSubtree(bordersScene, 'road-border');

      const roadColor   = readThemeColor('--overlay-road-color',        '#504b41');
      const borderColor = readThemeColor('--overlay-road-border-color', '#1ec3c8');
      const metroColor  = readThemeColor('--overlay-metro-color',       '#dcaa28');

      // Normal depth-tested pass — surface roads/borders sit correctly in scene.
      // Flat unlit Basic so the infographic colour stays uniform across the
      // whole road network. (Tried receiving sun shadows in this PR — both via
      // a manual `materialColor × shadow()` multiply on Basic and via Lambert +
      // receiveShadow — and both looked wrong: the multiply gave black-stripe
      // acne on the coplanar road geometry, and Lambert sun-direction-tinted
      // the network into something that read as 3D rather than infographic.
      // Scrapped — buildings/terrain still receive shadows, decals don't.)
      // Blend + opacity here are decoded constants, not tuning. 3d_map_solid.mt
      // has a fixed One/One additive PSO; the per-material AdditiveAlphaBlend flag
      // decides whether the additive contribution is pre-scaled by Color.Alpha.
      // Roads = AdditiveAlphaBlend 0 / alpha 255, borders = AdditiveAlphaBlend 1 /
      // alpha 255 → both full-strength additive. (Roads were Normal-blend opacity
      // 0.8 — an eyeballed guess that also let the road colour drift with whatever
      // sat under it; additive is the game-faithful blend.)
      // Surface roads/borders over-stamp stencil=STENCIL_OCCLUDER where they
      // are the visible surface — the same pattern terrain/cliffs/buildings
      // use in the opaque pass. This makes the surface and SeeThrough copies
      // mutually exclusive per pixel: where the surface copy draws (passes
      // depth), the stencil is no longer STENCIL_WATER, so the SeeThrough
      // copy skips it. Without this, the below-sea-level tunnel-entrance
      // cutting drew BOTH copies (water stamps 2 → surface ramp draws → the
      // SeeThrough copy draws again on top = bright double-drawn band).
      const roadOverstamp = {
        stencilWrite: true, stencilRef: NCZ.STENCIL_OCCLUDER,
        stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      };
      // Depth pre-pass + Equal colour pass — additive layers can't occlude
      // themselves (every overlapping fragment adds), so overlapping road
      // decks / crossing borders drew twice (bright hot spots at any angle:
      // draw order within a tier is buffer order, not per-fragment depth).
      // Each layer first lays down its nearest-surface depth (colorWrite off,
      // transparent:true keeps it in the transparent pass AFTER water — an
      // opaque prepass would depth-block water under bridges and shift the
      // additive base colour), then the colour pass draws with
      // depthFunc:Equal so exactly one surface per pixel receives colour.
      // The vertex path is identical between the two passes, so rasterized
      // depth matches exactly.
      const depthPrepassMat = new THREE.MeshBasicNodeMaterial({ transparent: true, colorWrite: false });
      // r185 routes material.depthFunc through ReversedDepthFuncs under
      // reversedDepthBuffer and wrongly inverts EqualDepth → NotEqualDepth
      // (equality is direction-independent; the upstream map blanket-inverts
      // every comparator). Hand it NotEqual so the broken inversion lands on
      // the Equal we actually want — the same pre-compensation pattern as the
      // render-list sort comparators above. Symptom if this regresses: roads
      // invisible over terrain/water but visible through buildings.
      // Remove together with the sort compensation when upstream fixes.
      const equalDepth = renderer.reversedDepthBuffer === true ? THREE.NotEqualDepth : THREE.EqualDepth;
      normalRoadsMat   = new THREE.MeshBasicNodeMaterial({ color: roadColor,   transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthFunc: equalDepth, depthWrite: false, ...roadOverstamp });
      normalBordersMat = new THREE.MeshBasicNodeMaterial({ color: borderColor, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthFunc: equalDepth, depthWrite: false, ...roadOverstamp });

      applyMaterial(roadsScene,   normalRoadsMat);
      applyMaterial(bordersScene, normalBordersMat);

      // Explicit transparent-pass tiers — the whole water/roads/metro chain is
      // order-dependent, and any two overlays sharing a renderOrder fall back
      // to per-object centroid-z ties that flip with camera angle (the cause
      // of the old "road borders vanish over water at some angles" bug):
      //   water 0 → roads depth 1 → roads colour 2 → borders depth 3
      //   → borders colour 4 → SeeThrough copies 5 → metro 6
      //   → district outlines 7 → hover DISTRICT_HOVER_RENDER_ORDER.
      // Borders draw AFTER the roads passes: a border under an overlapping
      // road deck must depth-fail against that deck. Each layer's own
      // depth-prepass → Equal-colour pair collapses self-overlap (deck over
      // street, crossing borders) to a single additive contribution.
      roadsScene.traverse(o   => { if (o.isMesh) o.renderOrder = 2; });
      bordersScene.traverse(o => { if (o.isMesh) o.renderOrder = 4; });

      // Metro: normal depth-tested, renderOrder=6 — after water (0) so it
      // shows over the bay, after the road passes so it layers above both.
      //
      // LOD discard: COLOR_0 vertex attribute carries the LOD tier as one
      // mutually-exclusive channel per vertex (per the building/metro extraction
      // pipeline — see `[[phase3-building-rendering]]` and the metro LOD-channel
      // mapping note in CLAUDE.md). Discard rules:
      //   B=wide solid:  show only at far zoom    (zoom <= LOD_MED)
      //   G=thin solid:  show only at medium zoom (LOD_MED <= zoom <= LOD_NEAR)
      //   R=dotted:      show only at close zoom  (zoom >= LOD_NEAR)
      //
      // TSL port (was `onBeforeCompile` GLSL injection on r170):
      //   - vertex color attribute pulled via `attribute('color')`
      //   - per-frame zoom uniform via `uniform()` node — mutate `.value` from
      //     the controls 'change' handler (lookup at top of init())
      //   - boolean expression composed with TSL methods (.greaterThan/.and/.or)
      //   - `material.maskNode` is a KEEP mask (true=keep, false=discard);
      //     we compose the discard condition for clarity then `.not()` it
      metroMat = new THREE.MeshBasicNodeMaterial({
        color: metroColor,
        transparent: true,
        opacity: 0.235,  // 3dmap_metro Color.Alpha 60/255 — AdditiveAlphaBlend=1
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      // Metro LOD — decoded from 3d_map_metro.mt's pixel shader (PIX capture).
      // The metro mesh carries three
      // tiers in COLOR_0 (R dotted / G thin / B wide), one channel per vertex.
      // Each tier is fully on below its distance threshold and crossfades out
      // over METRO_LOD_TRANSITION — the game dissolves tiers, it doesn't snap.
      // Driven by one CPU uniform: schema camera-to-target distance, seeded
      // from the LIVE camera here — a constant seed showed the wrong tier on
      // the first frame until the first camera move (the load-flicker bug).
      metroDistanceUniform = uniform(camera.position.distanceTo(controls.target));
      const uMetroNear = uniform(NCZ.METRO_LOD_DISTANCE_NEAR);
      const uMetroMed  = uniform(NCZ.METRO_LOD_DISTANCE_MED);
      const uMetroFar  = uniform(NCZ.METRO_LOD_DISTANCE_FAR);
      const uMetroW    = uniform(NCZ.METRO_LOD_TRANSITION);
      const lodColor   = attribute('color');
      // Per-tier ramp: 1 below `threshold`, ramps to 0 by `threshold + W`.
      const tierRamp = (threshold) =>
        threshold.add(uMetroW).sub(metroDistanceUniform).div(uMetroW).clamp(0, 1);
      const fNear = tierRamp(uMetroNear);
      const fMed  = tierRamp(uMetroMed);
      const fFar  = tierRamp(uMetroFar);
      // Mutually-exclusive tier weights — the game's min(ramp, 1 - prevRamp)
      // chain, so adjacent tiers crossfade and never both reach full.
      const nearW = fNear;
      const midW  = fMed.min(float(1).sub(fNear));
      const farW  = fFar.min(float(1).sub(fMed));
      // Each vertex carries exactly one tier in COLOR_0; `max` selects its
      // weight. The result drives alpha — tiers fade in/out under additive blend.
      const metroLOD = nearW.mul(lodColor.r)
        .max(midW.mul(lodColor.g))
        .max(farW.mul(lodColor.b));
      metroMat.opacityNode = metroLOD.mul(0.235);          // decoded base opacity (3dmap_metro Color.Alpha 60/255)
      metroMat.maskNode    = metroLOD.greaterThan(0.001);  // drop fully-faded fragments

      function makeSeeThrough(source, mat) {
        const group = new THREE.Group();
        group.rotation.y = Math.PI;
        source.traverse(child => {
          if (!child.isMesh) return;
          const m = new THREE.Mesh(child.geometry, mat);
          m.position.copy(child.position);
          m.rotation.copy(child.rotation);
          m.scale.copy(child.scale);
          group.add(m);
        });
        return group;
      }

      // SeeThrough pass: depthTest:false + stencil=EQUAL(STENCIL_WATER) → only renders where water
      // is the visible surface at this pixel — i.e. the open bay (see the stencil-chain comment in
      // loadTerrain). Pacifica tunnel: water writes stencil=STENCIL_WATER → the tunnel road + border
      // (below the water) draw on top of it = visible through the water ✓.  Mountain / city roads:
      // terrain/cliffs/buildings over-stamp stencil=STENCIL_OCCLUDER ≠ STENCIL_WATER → hidden ✓.
      // (Bridge-over-bay double-draw is gone since the surface copies over-stamp
      // stencil=STENCIL_OCCLUDER where visible — the SeeThrough copy only draws
      // where water remains the visible surface, so the two copies are mutually
      // exclusive per pixel.)
      const stBase = {
        transparent: true, depthTest: false, depthWrite: false,
        stencilWrite: true, stencilWriteMask: 0x00,
        stencilFunc: THREE.EqualStencilFunc, stencilRef: NCZ.STENCIL_WATER, stencilFuncMask: 0xff,
        stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      };
      // SeeThrough variants match the normal pass — full-strength additive (see
      // the decoded-constant note on normalRoadsMat above).
      roadsMat   = new THREE.MeshBasicNodeMaterial({ ...stBase, color: roadColor,   opacity: 1.0, blending: THREE.AdditiveBlending });
      bordersMat = new THREE.MeshBasicNodeMaterial({ ...stBase, color: borderColor, opacity: 1.0, blending: THREE.AdditiveBlending });
      // No shadow multiply on the SeeThrough variants — they're an
      // infographic "see the tunnel through the water" effect (depthTest:false,
      // stencil=WATER), drawing road geometry that sits BELOW the water plane
      // and surrounding terrain. Sampling the shadow map at that underwater
      // world position reads as occluded by everything above → factor near 0
      // → tunnel rendered fully black. Keep these flat-coloured.

      applyMaterial(metroScene, metroMat);

      const stRoads   = makeSeeThrough(roadsScene,  roadsMat);
      const stBorders = makeSeeThrough(bordersScene, bordersMat);
      stRoads.name    = 'roads-seethrough';
      stBorders.name  = 'road-borders-seethrough';
      nameSubtree(stRoads,   'road-st');
      nameSubtree(stBorders, 'road-border-st');
      stRoads.traverse(o => { if (o.isMesh) o.renderOrder = 5; });
      stBorders.traverse(o => { if (o.isMesh) o.renderOrder = 5; });

      // Depth pre-passes (see depthPrepassMat above) — same geometry cloned
      // via makeSeeThrough with the colourless depth-writing material, drawn
      // one tier before their colour pass.
      const dpRoads   = makeSeeThrough(roadsScene,   depthPrepassMat);
      const dpBorders = makeSeeThrough(bordersScene, depthPrepassMat);
      dpRoads.name    = 'roads-depth-prepass';
      dpBorders.name  = 'road-borders-depth-prepass';
      nameSubtree(dpRoads,   'road-dp');
      nameSubtree(dpBorders, 'road-border-dp');
      dpRoads.traverse(o   => { if (o.isMesh) o.renderOrder = 1; });
      dpBorders.traverse(o => { if (o.isMesh) o.renderOrder = 3; });

      const roadsGroup = new THREE.Group();
      roadsGroup.name = 'roads';
      roadsGroup.add(roadsScene, bordersScene, stRoads, stBorders, dpRoads, dpBorders);
      metroScene.traverse(o => { if (o.isMesh) o.renderOrder = 6; });

      const metroGroup = new THREE.Group();
      metroGroup.name = 'metro';
      metroGroup.add(metroScene);

      layers.roads = roadsGroup;
      layers.metro = metroGroup;

      scene.add(roadsGroup, metroGroup);
      requestRender();
      freezeStatic(roadsGroup);
      freezeStatic(metroGroup);
      stepProgress(); // roads done
    } catch (err) {
      console.error('[NCZ] Roads/metro GLB load failed:', err);
    }
  }

  async function loadDistricts() {
    registerLoadStep(); // districts
    try {
      const data = await fetch('data/subdistricts.json').then(r => r.json());
      const outerGroup  = new THREE.Group(); // districts with subs — zoom-out only
      const alwaysGroup = new THREE.Group(); // no-sub districts + canonical:false subs — always visible
      const subGroup    = new THREE.Group(); // canonical subdistricts — zoom-in only
      outerGroup.name  = 'districts-outer';
      alwaysGroup.name = 'districts-always';
      subGroup.name    = 'subdistricts';

      // Name labels (CSS2DObject) live in their own group, rendered for free by
      // ThreeMarkers' CSS2DRenderer pass (it traverses the whole scene). Each
      // label is tagged with the visibility GROUP of its outline, so the label
      // shows exactly when its outline tier does (handled in
      // updateDistrictLabelVisibility — CSS2D visible doesn't cascade, so we set
      // it per-leaf). Default layer 0 → labels aren't gated by the Pins toggle.
      const labelGroup = new THREE.Group();
      labelGroup.name = 'district-labels';
      const addLabel = (name, posCet, colorHex, group, level) => {
        if (!name || !posCet) return null;
        // Anchor is what CSS2DRenderer positions (it overwrites the element's
        // inline transform each frame). The inner .district-label is free to
        // scale/glow on hover without fighting that transform.
        const anchor = document.createElement('div');
        anchor.className = 'district-label-anchor';
        const el = document.createElement('div');
        el.className = `district-label district-label-${level}`;
        el.textContent = name;
        el.style.setProperty('--label-color', colorHex);
        anchor.appendChild(el);
        const css = new CSS2DObject(anchor);
        css.position.set(posCet[0], 0, -posCet[1]); // CET (x,y) → world (x,0,-y)
        css.name = `district-label-${level}-${name}`;
        labelGroup.add(css);
        _districtLabels.push({ css, group });
        return el; // returned so the outline hover can emphasise its label in sync
      };

      for (const dist of data.districts) {
        const colorHex = window.NCZ.DISTRICT_COLORS[dist.id] || '#ffffff';
        const color = new THREE.Color(colorHex);
        const canonicalSubs = (dist.subdistricts || []).filter(s => s.canonical !== false);
        const hasSubs = canonicalSubs.length > 0;
        const distGroup = hasSubs ? outerGroup : alwaysGroup;

        // District outline — always group if no canonical subs, outer group otherwise
        if (dist.polygon?.length) {
          const line = buildLine(dist.polygon, color, window.NCZ.DISTRICT_LINE_WIDTH);
          line.name = `district-outline-${dist.id}`;
          distGroup.add(line);
          const labelEl = addLabel(dist.name, NCZ.polygonCentroid(dist.polygon), colorHex, distGroup, 'district');
          registerDistrictHover(dist.polygon, line, distGroup, labelEl, dist.id, null);
        } else if (hasSubs) {
          // Badlands has no district polygon (and no in-game district icon). The
          // mean of its subdistrict centroids lands in a cramped/built-up spot;
          // the maintainer picked this open patch of the badlands instead.
          const pos = NCZ.BADLANDS_LABEL_CET || null;
          if (pos) {
            const labelEl = addLabel(dist.name, pos, colorHex, distGroup, 'district');
            // No outline to hover, so register each subdistrict polygon as a
            // district-tier, label-only hover region pointing at the Badlands
            // label — hovering the badlands area emphasises the name.
            for (const sub of dist.subdistricts || []) {
              if (sub.polygon?.length) registerDistrictHover(sub.polygon, null, distGroup, labelEl, dist.id, null);
            }
          }
        }

        for (const sub of dist.subdistricts || []) {
          if (!sub.polygon?.length) continue;
          const line = buildLine(sub.polygon, color, window.NCZ.SUBDISTRICT_LINE_WIDTH);
          line.name = `subdistrict-outline-${dist.id}/${sub.id}`;
          // canonical:false (casino etc) — always visible; otherwise zoom-gated.
          const group = sub.canonical === false ? alwaysGroup : subGroup;
          group.add(line);
          const labelEl = addLabel(sub.name, NCZ.polygonCentroid(sub.polygon), colorHex, group, 'subdistrict');
          registerDistrictHover(sub.polygon, line, group, labelEl, dist.id, sub.id);
        }
      }

      // Wrap all three in a parent so districts toggle works as a unit
      const parent = new THREE.Group();
      parent.name = 'districts';
      parent.add(alwaysGroup, outerGroup, subGroup);
      subGroup.visible  = false;
      outerGroup.visible = true;

      _districtOuter  = outerGroup;
      _districtSub    = subGroup;
      _districtAlways = alwaysGroup;
      layers.districts = parent;
      scene.add(parent);
      scene.add(labelGroup);
      layers.districtLabels = labelGroup;
      updateDistrictLabelVisibility();
      requestRender();
      freezeStatic(parent);
      stepProgress(); // districts done
    } catch (err) {
      console.error('[NCZ] District lines load failed:', err);
    }
  }

  // ── Buildings ──────────────────────────────────────────────────────────
  // CPU decodes _data.dds (16-bit RGBA) → InstancedMesh matrices.
  // MeshLambertNodeMaterial with TSL `colorNode` (_m.dds planar UV modulation)
  // and `emissiveNode` (silhouette edge highlight). See buildBuildingMaterial.
  // Shadow casting/receiving handled automatically by Three.js.

  // ── Landmarks ─────────────────────────────────────────────────────────
  // GLBs are in local mesh space. World positions from cp2077_extract_footprints.py
  // --list-landmarks. Full quaternion from 3dmap_view.ent localTransform.Orientation.
  // CET (Z-up) → Three.js (Y-up) quaternion remap: (x=i, y=k, z=-j, w=r)
  // X-axis flip (rotation.y=PI, same as roads) combined into quaternion: flipQ * entityQ

  const LANDMARK_META = [
    // { file, cetX, cetY, cetZ, qi, qj, qk, qr }
    // XY from cp2077_extract_footprints.py --list-landmarks (CET world space)
    // Z from ent localTransform.Position.z (Bits/131072) — CET height = Three.js Y
    // qi/qj/qk/qr from ent Orientation [i,j,k,r]
    { file: '3dmap_obelisk.glb',                   cetX: -1714.5, cetY: -2331.3, cetZ:  35.68, qi: -0.0436, qj: -0.0019, qk:  0.9981, qr:  0.0436 },
    { file: 'monument_ave_pyramid.glb',             cetX: -1595.2, cetY: -2344.3, cetZ:  55.74, qi:  0.0000, qj:  0.0000, qk:  0.0000, qr:  1.0000 },
    { file: '3dmap_statue_splash_a.glb',            cetX: -1673.8, cetY: -2466.1, cetZ:  43.20, qi:  0.0000, qj:  0.0000, qk: -0.9483, qr:  0.3173 },
    { file: '3dmap_ext_monument_av_building_b.glb', cetX: -1717.3, cetY: -2412.0, cetZ:  -8.02, qi:  0.0000, qj:  0.0000, qk: -0.4462, qr:  0.8949 },
    { file: 'northoak_sign_a.glb',                  cetX:   196.9, cetY:   873.7, cetZ: 152.76, qi: -0.0200, qj:  0.0668, qk:  0.2864, qr:  0.9556 },
    { file: 'cz_cz_building_h_icosphere.glb',       cetX: -1974.8, cetY: -2701.0, cetZ: 102.70, qi:  0.4820, qj:  0.0921, qk: -0.8411, qr:  0.2276 },
    { file: 'rcr_park_ferris_wheel.glb',            cetX: -2442.4, cetY: -2178.0, cetZ:  34.26, qi:  0.0000, qj:  0.0000, qk: -0.7254, qr:  0.6884 },
    { file: 'rcr_park_ferris_wheel.glb',            cetX:   445.2, cetY: -1672.2, cetZ:  10.87, qi: -0.4513, qj: -0.2239, qk:  0.4591, qr:  0.7317 },
  ];

  async function loadLandmarks() {
    registerLoadStep(1);
    try {
      landmarkMat = new THREE.MeshLambertNodeMaterial({
        color: readThemeColor('--scene-landmarks', '#8aacbf'),
        flatShading: true,
      });
      const mat = landmarkMat;

      // Unique GLB files (ferris wheel is shared)
      const uniqueFiles = [...new Set(LANDMARK_META.map(m => m.file))];
      const glbMap = Object.fromEntries(
        await Promise.all(uniqueFiles.map(async f => [f, await loadGLB(f)]))
      );

      const group = new THREE.Group();
      group.name = 'landmarks';
      for (const { file, cetX, cetY, cetZ, qi, qj, qk, qr } of LANDMARK_META) {
        const source = glbMap[file];
        const container = new THREE.Group();
        container.name = `landmark-${file.replace(/\.glb$/, '')}`;

        // CET (Z-up) → Three.js (Y-up): x=qi, y=qk, z=-qj, w=qr
        const entityQ = new THREE.Quaternion(qi, qk, -qj, qr).normalize();
        container.quaternion.copy(entityQ);
        container.position.set(cetX, cetZ, -cetY);

        source.traverse(child => {
          if (!child.isMesh) return;
          const mesh = new THREE.Mesh(child.geometry, mat);
          // Preserve the source mesh's local transform — for meshopt-compressed
          // GLBs this carries the KHR_mesh_quantization dequant translate/scale
          // that maps int16 vertex positions back to mesh-local-space coords.
          // Without this, vertices render at raw quantized scale (0–65535).
          mesh.position.copy(child.position);
          mesh.quaternion.copy(child.quaternion);
          mesh.scale.copy(child.scale);
          mesh.castShadow    = true;
          mesh.receiveShadow = true;
          container.add(mesh);
        });
        nameSubtree(container, container.name);
        group.add(container);
      }

      layers.landmarks = group;
      scene.add(group);
      flagShadowUpdate();   // new shadow casters → re-render the depth map (loads after the post-terrain refit, so nothing else flags it)
      requestRender();
      freezeStatic(group);
      console.log(`[NCZ] Landmarks: ${LANDMARK_META.length} placed`);
      stepProgress();
    } catch (err) {
      console.error('[NCZ] Landmarks load failed:', err);
      stepProgress();
    }
  }

  async function loadBuildings() {
    registerLoadStep(DISTRICT_META.length); // one step per district
    try {
      // Source geometry — single unit cube reused by every district. Wrapped in
      // an InstancedBufferGeometry per-district so Three.js draws `instanceCount`
      // copies; the per-instance matrix lookup happens in our positionNode via
      // the storage buffer (`instanceMatricesBuffer.element(instanceIndex)`).
      const baseGeo = new THREE.BoxGeometry(1, 1, 1);
      const group   = new THREE.Group();
      group.name = 'buildings';
      const dummy   = new THREE.Object3D();

      // Asset set (user preference): 'fixed' uses malgalad's alignment-fixed
      // textures where available (meta.dataDdsFixed), 'cdpr' uses the base-game
      // textures. Districts without a fixed variant (ep1_spaceport) fall back to
      // dataDds in either set. Read once per (re)load.
      const assetSet = (typeof localStorage !== 'undefined' && localStorage.getItem(NCZ.ASSET_SET_KEY)) || NCZ.ASSET_SET_DEFAULT;

      // Debug aid: ?only=<district> renders only that DISTRICT_META entry by
      // name (e.g. ?only=my_district, ?only=ugly_building) — isolates a single
      // building cloud for diagnosing placement/content. Sibling of ?debug /
      // ?gamelight / ?webgpuprobe.
      const _only = new URLSearchParams(location.search).get('only');
      for (const meta of DISTRICT_META) {
        if (_only && meta.name !== _only) continue;
        // Fixed-only entries (e.g. the my_district corrections overlay) exist
        // only in the Fixed asset set — skip them entirely in CDPR mode.
        if (meta.fixedOnly && assetSet !== 'fixed') continue;
        setLoadingText(`Loading buildings [${meta.name}]…`);

        // ── _data.dds → CPU decode → packed Float32Array of mat4s ─────
        const dataDdsPath = (assetSet === 'fixed' && meta.dataDdsFixed) ? meta.dataDdsFixed : meta.dataDds;
        const { pixels, width: texW, height: texH } = await loadDataDds(dataDdsPath);
        const blockW = Math.floor(texW / 3);
        const blockH = Math.min(texH, blockW);

        // 16 floats per mat4. Allocate worst-case; we'll create the storage
        // buffer with the trimmed count and only upload that slice.
        const maxInstances = blockW * blockH;
        const matrixData   = new Float32Array(maxInstances * 16);

        let validCount = 0;
        for (let y = 0; y < blockH; y++) {
          for (let x = 0; x < blockW; x++) {
            const pi = (y * texW + x)           * 4;   // position block
            const ri = (y * texW + x + blockW)  * 4;   // rotation block
            const si = (y * texW + x + 2*blockW)* 4;   // scale block

            // Empty-cell detection — two encodings exist. Base-game textures
            // mark empties with near-zero position-block ALPHA; malgalad's
            // "3D World Map Fixed" textures keep alpha full and mark empties
            // with ZERO SCALE instead (see docs/3dmap-fixed-assets.md).
            // Skip on either; on base-game data the two sets coincide, so this
            // is a no-op there.
            const scaleEmpty = pixels[si + 0] < NCZ.DDS_ALPHA_THRESH
                            && pixels[si + 1] < NCZ.DDS_ALPHA_THRESH
                            && pixels[si + 2] < NCZ.DDS_ALPHA_THRESH;
            if (pixels[pi + 3] < NCZ.DDS_ALPHA_THRESH || scaleEmpty) continue;

            // Decode position → CET world space
            const pr = pixels[pi+0] / NCZ.UINT16_MAX, pg = pixels[pi+1] / NCZ.UINT16_MAX, pb = pixels[pi+2] / NCZ.UINT16_MAX;
            const cetX = meta.transMin[0] + (meta.transMax[0] - meta.transMin[0]) * pr + meta.offset[0];
            const cetY = meta.transMin[1] + (meta.transMax[1] - meta.transMin[1]) * pg + meta.offset[1];
            const cetZ = meta.transMin[2] + (meta.transMax[2] - meta.transMin[2]) * pb;

            // Decode quaternion: [0,65535] → [-1,1], remap CET Z-up → Three.js Y-up
            const qr = pixels[ri+0]/NCZ.UINT16_MAX*2-1, qg = pixels[ri+1]/NCZ.UINT16_MAX*2-1;
            const qb = pixels[ri+2]/NCZ.UINT16_MAX*2-1, qa = pixels[ri+3]/NCZ.UINT16_MAX*2-1;
            const ql = Math.hypot(qr, qg, qb, qa) || 1;
            // CET (qx,qy,qz,qw) → Three.js (qx, qz, -qy, qw)
            dummy.quaternion.set(qr/ql, qb/ql, -qg/ql, qa/ql);

            // Decode scale → CET half-extents → Three.js full extents (CET X→X, Z→Y, Y→Z)
            const hx = pixels[si+0]/NCZ.UINT16_MAX * meta.cubeSize;
            const hy = pixels[si+1]/NCZ.UINT16_MAX * meta.cubeSize;
            const hz = pixels[si+2]/NCZ.UINT16_MAX * meta.cubeSize;

            dummy.position.set(cetX, cetZ, -cetY);       // CET → Three.js
            dummy.scale.set(hx * 2, hz * 2, hy * 2);    // CET X→X, Z→Y, Y→Z
            dummy.updateMatrix();
            // Pack the 16 floats of the matrix at offset (validCount * 16).
            // Three.js stores Matrix4.elements in column-major order, which
            // matches WGSL's mat4x4f memory layout — direct copy, no transpose.
            matrixData.set(dummy.matrix.elements, validCount * 16);
            validCount++;
          }
        }

        // Storage buffer for the instance matrices. Held in `mat.userData` so
        // Phase 2B compute culling reaches it through the material reference.
        const matricesBuffer = instancedArray(validCount, 'mat4');
        matricesBuffer.value.set(matrixData.subarray(0, validCount * 16));

        // ── Phase 2B compute culling per-district setup ──────────────────
        // visibleIndices: every cull pass appends survivors as a packed prefix.
        // The vertex shader reads `visibleIndices.element(instanceIndex)` to
        // get the original instance ID, then fetches the matrix at that index.
        const visibleIndicesBuffer = instancedArray(validCount, 'uint');

        // Indirect draw struct — written by reset+cull computes, consumed by
        // `drawIndexedIndirect`. Layout follows the WebGPU indexed-draw spec:
        // [indexCount, instanceCount, firstIndex, baseVertex, firstInstance].
        // `instanceCount` is atomic so concurrent threads can append safely.
        const indirectAttribute = new THREE.IndirectStorageBufferAttribute(new Uint32Array(5), 5);
        const indirectStruct = struct({
          indexCount:    'uint',
          instanceCount: { type: 'uint', atomic: true },
          firstIndex:    'uint',
          baseVertex:    'uint',
          firstInstance: 'uint',
        }, `IndirectDraw_${meta.name}`);
        const drawStorage = storage(indirectAttribute, indirectStruct, 1);

        // (init compute) Run once at scene setup — writes the static draw
        // fields (everything except instanceCount, which the cull pass owns).
        const baseGeoIndexCount = baseGeo.index ? baseGeo.index.count : baseGeo.attributes.position.count;
        const initFn = Fn(() => {
          drawStorage.get('indexCount').assign(uint(baseGeoIndexCount));
          drawStorage.get('firstIndex').assign(uint(0));
          drawStorage.get('baseVertex').assign(uint(0));
          drawStorage.get('firstInstance').assign(uint(0));
          atomicStore(drawStorage.get('instanceCount'), uint(0));
        })().compute(1);

        // (reset compute) Per frame, ONE thread, clears the running count
        // before cull threads append. Separate dispatch from the cull so
        // there's no cross-workgroup synchronisation needed.
        const resetFn = Fn(() => {
          atomicStore(drawStorage.get('instanceCount'), uint(0));
        })().compute(1);

        // (cull compute) Per frame, N threads (one per instance). Each thread
        // tests its instance's bounding sphere against TWO 6-plane frusta:
        // the camera frustum AND the sun's shadow frustum. The instance is
        // visible if it passes either — that way off-screen buildings still
        // inside the shadow ortho box get into the indirect buffer and cast
        // shadows into the visible area (the original camera-only test
        // dropped them, making shadows pop at screen edges on pan).
        // Bounding sphere center  = matrix's translation column (4th column).
        // Radius (conservative)   = max column length × √3/2 (cube → sphere).
        const cullFn = Fn(() => {
          const idx       = instanceIndex;
          const matrix    = matricesBuffer.element(idx);
          const center    = vec4(matrix[3]).xyz;       // translation column
          const sx        = vec4(matrix[0]).xyz.length();
          const sy        = vec4(matrix[1]).xyz.length();
          const sz        = vec4(matrix[2]).xyz.length();
          const radius    = sx.max(sy).max(sz).mul(0.866);  // sqrt(3)/2
          const negRadius = radius.negate();
          const c4        = vec4(center, 1.0);

          // Visibility against a frustum = inside (or straddling) every plane.
          // dist = dot(plane.xyz, center) + plane.w
          // visible plane test: dist >= -radius
          const cameraVisible =
            _frustumPlaneUniforms[0].dot(c4).greaterThanEqual(negRadius)
              .and(_frustumPlaneUniforms[1].dot(c4).greaterThanEqual(negRadius))
              .and(_frustumPlaneUniforms[2].dot(c4).greaterThanEqual(negRadius))
              .and(_frustumPlaneUniforms[3].dot(c4).greaterThanEqual(negRadius))
              .and(_frustumPlaneUniforms[4].dot(c4).greaterThanEqual(negRadius))
              .and(_frustumPlaneUniforms[5].dot(c4).greaterThanEqual(negRadius));

          const shadowVisible =
            _shadowFrustumPlaneUniforms[0].dot(c4).greaterThanEqual(negRadius)
              .and(_shadowFrustumPlaneUniforms[1].dot(c4).greaterThanEqual(negRadius))
              .and(_shadowFrustumPlaneUniforms[2].dot(c4).greaterThanEqual(negRadius))
              .and(_shadowFrustumPlaneUniforms[3].dot(c4).greaterThanEqual(negRadius))
              .and(_shadowFrustumPlaneUniforms[4].dot(c4).greaterThanEqual(negRadius))
              .and(_shadowFrustumPlaneUniforms[5].dot(c4).greaterThanEqual(negRadius));

          If(cameraVisible.or(shadowVisible), () => {
            const slot = atomicAdd(drawStorage.get('instanceCount'), uint(1));
            visibleIndicesBuffer.element(slot).assign(uint(idx));
          });
        })().compute(validCount);

        // Run init once now (before first render); push reset+cull to be
        // dispatched every frame.
        renderer.compute(initFn);
        _cullComputes.push({ reset: resetFn, cull: cullFn });

        const mat  = buildBuildingMaterial(meta, await loadMDds(meta.mDds), matricesBuffer, visibleIndicesBuffer);
        mat.userData.instanceMatricesBuffer = matricesBuffer;
        mat.userData.visibleIndicesBuffer   = visibleIndicesBuffer;
        mat.userData.indirectAttribute      = indirectAttribute;

        // Per-district geometry — clone the unit cube (sharing would tie all
        // districts to a single indirect buffer) and wire up the indirect-
        // draw buffer. Critically NOT an `InstancedBufferGeometry`: when both
        // `instanceCount` and `setIndirect()` are set, Three.js picks the
        // former and silently ignores the indirect buffer. Regular
        // `BufferGeometry.clone()` + `setIndirect()` matches the canonical
        // `webgpu_struct_drawindirect` example — instance count comes solely
        // from the indirect buffer's `instanceCount` field, which the cull
        // compute writes each frame.
        const geo = baseGeo.clone();
        geo.setIndirect(indirectAttribute);

        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `buildings-${meta.name}`;
        mesh.castShadow    = true;
        mesh.receiveShadow = true;
        // Three.js's default frustum cull was already broken for our cube-
        // at-origin setup (recon: instWiki [[iigpu-perf-investigation]]). The
        // storage-buffer pattern moves all positioning to the GPU, so the host
        // bounding sphere is even more meaningless — disable cull explicitly
        // until Phase 2B's compute pass owns visibility.
        mesh.frustumCulled = false;

        group.add(mesh);
        buildingMeshes.push(mesh);
        // Over-stamp stencil=STENCIL_OCCLUDER so SeeThrough roads are blocked where buildings are visible
        mat.stencilWrite = true;
        mat.stencilRef   = NCZ.STENCIL_OCCLUDER;
        mat.stencilFunc  = THREE.AlwaysStencilFunc;
        mat.stencilZPass = THREE.ReplaceStencilOp;
        mat.needsUpdate  = true;
        buildingMaterials.push(mat);
        stepProgress(); // one building district done
        console.log(`[NCZ] Buildings [${meta.name}]: ${validCount.toLocaleString()} instances`);
      }

      layers.buildings = group;
      scene.add(group);
      flagShadowUpdate();   // new shadow casters → re-render the depth map (loads after the post-terrain refit, so nothing else flags it)
      requestRender();
      freezeStatic(group);
      console.log(`[NCZ] Buildings: ${DISTRICT_META.length} districts loaded`);
    } catch (err) {
      console.error('[NCZ] Buildings load failed:', err);
    }
  }

  // Build the MeshLambertNodeMaterial for one district.
  //
  // The TSL graph composes three effects on top of the standard Lambert pipeline:
  //
  //   0. Per-instance positioning + normals (vertex stage, via `geometryNode`)
  //      The buildings group is rendered as a non-instanced `Mesh` backed by
  //      an `InstancedBufferGeometry` whose instance matrices live in an
  //      `instancedArray` storage buffer (see `loadBuildings()`).
  //      `material.geometryNode` runs BEFORE the standard pipeline and
  //      mutates `positionLocal`/`normalLocal` in place — the same pattern
  //      `InstanceNode.setup()` uses for `InstancedMesh`. After it runs
  //      every downstream computation (positionWorld, normalView, lighting,
  //      shadow depth) sees the instance-transformed values automatically.
  //      Phase 2B compute culling will slot a `visibleIndices` lookup
  //      between `instanceIndex` and the matrix fetch with no other changes.
  //
  //   1. `_m.dds` surface modulation (pre-lighting, via `colorNode`)
  //      Original GLSL hook: `#include <color_fragment>`
  //      Samples the district's `_m` heightmap with a world-space planar UV
  //      and multiplies the diffuse colour. Because `geometryNode` already
  //      put the instance-transformed position into `positionLocal`,
  //      `positionWorld` (= modelWorldMatrix · positionLocal) gives the
  //      correct world position automatically — same code path as Phase 1.
  //
  //   2. Edge highlight (pre-lighting, via `colorNode`)
  //      The game's gbuffer shader lerps EdgeColor into the ALBEDO before
  //      lighting (decoded from a PIX capture), so the
  //      edge is a recoloured lit surface, not an emissive overlay. We mix on
  //      `colorNode` for the same result. See `buildingEdgeCoverage`.
  //
  // Per-district `uniform()` node refs are stashed on `mat.userData.tslUniforms`
  // so the colour-binding registry (`getColorBindings.buildingsEdge`) can mutate
  // `.value` during theme switches and flyover beat-driven colour tweens.
  function buildBuildingMaterial(meta, mTex, instanceMatricesBuffer, visibleIndicesBuffer) {
    const mat = new THREE.MeshLambertNodeMaterial({
      color: readThemeColor('--scene-buildings', '#7a8fa0'),
    });

    // Per-district uniforms (the equivalents of the WebGL onBeforeCompile uniforms)
    const uTransMin      = uniform(new THREE.Vector2(meta.transMin[0], meta.transMin[1]));
    const uTransMax      = uniform(new THREE.Vector2(meta.transMax[0], meta.transMax[1]));
    const uOffset        = uniform(new THREE.Vector2(meta.offset[0], meta.offset[1]));
    const uEdgeColor     = uniform(readThemeColor('--scene-buildings-edge', '#ffffff'));
    // Edge highlight constants, decoded from 3d_map_cubes.mt (per-district):
    //   uEdgeSharpness — EdgeSharpnessPower (30 / 50): the exponent of the
    //                  pow(X, power) edge gradient.
    //   uEdgeCamCoeff — the camera-distance widening, k = camDist·0.002·
    //                  EdgeThickness, pre-divided by cubeSize (the game divides
    //                  by the per-face world size; cubeSize is its stand-in —
    //                  the term is sub-pixel at map zoom regardless).
    const uEdgeSharpness = uniform(meta.edgeSharpness);
    const uEdgeCamCoeff = uniform(NCZ.BUILDING_EDGE_CAMDIST_K * meta.edgeThickness / meta.cubeSize);
    // Edge "glow": when on, the edge highlight is also written to emissiveNode
    // so it stays lit regardless of sun/shadow — neon, strongest at dawn/dusk
    // (a true halo needs the bloom pass; this is the cheap self-lit version).
    // Binary on/off at the fixed NCZ.EDGE_GLOW_INTENSITY; per-theme default from
    // --scene-edge-glow, overridable via the Settings toggle (_edgeGlowOn).
    const uEdgeGlow = uniform(_edgeGlowOn ? NCZ.EDGE_GLOW_INTENSITY : 0);
    // uEdgeColor + uEdgeGlow need runtime mutation (theme rewire / flyover tweens).
    mat.userData.tslUniforms = { uEdgeColor, uEdgeGlow };

    // (0) Per-instance positioning + normals — explicit space transforms.
    //
    // `material.normalNode` is consumed by `NodeMaterial.setupNormal()` as:
    //   `vec3(this.normalNode).normalize()` — used DIRECTLY for lighting
    //   without any further matrix transforms. So whatever we provide must
    //   already be in VIEW space.
    //
    // Composition:
    //   1. `transformNormal(normalLocal, instMatrix)` — applies the instance
    //      matrix to the local normal using the inverse-transpose form
    //      (handles non-uniform building scale). Output is in WORLD space
    //      because our matrices encode world transforms (group at origin).
    //   2. `transformNormalToView(...)` — applies modelNormalMatrix
    //      (identity for our group) and cameraViewMatrix.transformDirection
    //      to take world → view. This is the same helper Three.js uses
    //      internally for the default `normalLocal → normalView` path.
    //
    // Earlier attempts that set `normalNode` directly to a world-space
    // value (via `transformNormal` alone or `mat3(M).mul(normalLocal)`)
    // produced view-dependent lighting because lighting was computing
    // dot(world_normal, view_lightDir) — values in different coordinate
    // spaces.
    // Phase 2B: `instanceIndex` is the COMPACTED draw index (0..visibleCount).
    // We dereference through `visibleIndicesBuffer` to get the original
    // instance index, then fetch that instance's matrix. Compute pass writes
    // visibleIndices each frame; vertex shader reads through it transparently.
    const realIndex  = visibleIndicesBuffer.element(instanceIndex);
    const instMatrix = instanceMatricesBuffer.element(realIndex);
    mat.positionNode = instMatrix.mul(vec4(positionLocal, 1)).xyz;
    const worldNormal = transformNormal(normalLocal, instMatrix); // also drives the _m slope guard below
    mat.normalNode   = transformNormalToView(worldNormal);

    // World-space planar UV — XZ plane, normalised against the district's CET
    // bounds. Original GLSL: vMUv = ((wx - off.x - min.x)/(max.x - min.x),
    //                                (-wz - off.y - min.y)/(max.y - min.y))
    // We read the instance-transformed world position directly from the
    // matrix multiplication chain rather than `positionWorld` — under WebGPU
    // with a custom `positionNode`, `positionWorld` evaluates to
    // `modelWorldMatrix · positionLocal` (without the instance transform).
    const instWorldPos4 = instMatrix.mul(vec4(positionLocal, 1));
    const wx    = instWorldPos4.x;
    const wzNeg = instWorldPos4.z.negate();
    const planarUv = vec2(
      wx.sub(uOffset.x).sub(uTransMin.x).div(uTransMax.x.sub(uTransMin.x)),
      wzNeg.sub(uOffset.y).sub(uTransMin.y).div(uTransMax.y.sub(uTransMin.y))
    );

    // Sloped-face guard: ~12.5% of instances have oblique quaternions
    // (_data.dds census — 32k of 255k tilted >2° off any 90° multiple), and on
    // their slanted faces the fragment-position planar UV paints a recognisable
    // 2-D patch of the district map — a top-down projection landing on a
    // non-horizontal surface. The game has the same latent artifact (its
    // vertical-AO gbuffer term ships disabled, and its near-top-down map camera
    // never shows walls), but our tilting camera does. Steep faces therefore
    // sample _m at the instance's own centre instead — each building's walls
    // and slopes carry their own roof texel, which cannot image — blended by
    // the world normal's up-ness so flat roofs keep the exact decoded planar
    // sample.
    const instCenter4 = instMatrix.mul(vec4(0, 0, 0, 1)); // unit-cube origin = box centre
    const centerUv = vec2(
      instCenter4.x.sub(uOffset.x).sub(uTransMin.x).div(uTransMax.x.sub(uTransMin.x)),
      instCenter4.z.negate().sub(uOffset.y).sub(uTransMin.y).div(uTransMax.y.sub(uTransMin.y))
    );
    const upness = smoothstep(
      float(NCZ.BUILDING_TEX_SLOPE_FADE_START),
      float(NCZ.BUILDING_TEX_SLOPE_FADE_END),
      worldNormal.normalize().y
    );
    const mUv = mix(centerUv, planarUv, upness);

    // (1) Diffuse modulation — sample _m, scale base colour. The game's
    // gbuffer shader applies `surface = 0.4 + 0.5·m` to the albedo (decoded from
    // a PIX capture; the shader's vertical-AO term is disabled by the default
    // DebugScaleOffset, so it collapses to floor+range).
    const mVal = texture(mTex, mUv.clamp(0, 1)).r;
    const modulation = float(NCZ.BUILDING_TEX_FLOOR).add(mVal.mul(NCZ.BUILDING_TEX_RANGE));

    // (2) Edge highlight — the decoded game algorithm with fwidth AA standing
    // in for the game's TAA (see `buildingEdgeCoverage`). The game lerps the
    // edge into the gbuffer ALBEDO before lighting, so we mix on `colorNode`,
    // before the _m modulation, to match. `camTerm` = the game's
    // camDist·0.002·EdgeThickness/cubeSize widening.
    //
    // The game's edge tint is `EdgeColor · 2 · luma(BaseColorScale)` — a
    // brightness boost that drives the rim toward (clamped) white. The HUE
    // stays theme-driven (uEdgeColor); only the 2·luma scale is the game's.
    // Dropping it (an earlier port did) leaves the rim far too dim vs the
    // in-game map.
    const camDist  = instWorldPos4.xyz.sub(cameraPosition).length();
    const edge     = buildingEdgeCoverage(uv(), uEdgeSharpness, camDist.mul(uEdgeCamCoeff));
    const baseLuma = materialColor.r.mul(0.299)
                     .add(materialColor.g.mul(0.587))
                     .add(materialColor.b.mul(0.114));
    const edgeTint = uEdgeColor.mul(baseLuma.mul(2));
    mat.colorNode  = mix(materialColor, edgeTint, edge).mul(modulation);

    // Opt-in edge glow (gated by --scene-edge-glow, 0 by default → no-op for
    // every theme that doesn't set it). Emissive = the same edge tint × coverage,
    // self-lit so it doesn't dim in shadow / at low sun. uEdgeColor (not edgeTint)
    // keeps the glow at the theme's pure edge hue rather than the luma-boosted
    // albedo tint, so neon colour stays saturated.
    mat.emissiveNode = uEdgeColor.mul(edge).mul(uEdgeGlow);

    return mat;
  }

  // District line materials — stored so resolution can be updated on resize
  const districtLineMaterials = [];

  // Drop consecutive ring vertices within ε CET units of each other. The
  // cleanup script (scripts/regenerate_subdistricts.py) runs Shapely boolean
  // ops on subdistrict polygons and rounds the output to 2 decimal places —
  // when two operation-produced vertices land within 0.01 wu of each other,
  // rounding collapses them to identical coordinates, leaving a zero-length
  // edge in the ring. Line2NodeMaterial's screen-space line shader divides by
  // `length(ndcEnd - ndcStart)` to get the segment direction; degenerate
  // (or sub-pixel after projection) edges produce NaN/Inf direction vectors,
  // which render as long colored rays across the viewport at close zoom.
  //
  // ε = 0.1 wu catches only the literally-degenerate cases observed in
  // data/subdistricts.json (0.000, 0.010, 0.020 wu edges in badlands subs);
  // legit polygon corners with closely-spaced vertices (smallest seen ≥ 0.347
  // wu) are preserved. Bump ε if the rays survive at this threshold.
  function dedupRing(ring, epsilon = 0.1) {
    if (ring.length < 2) return ring;
    const eps2 = epsilon * epsilon;
    const out = [ring[0]];
    for (let i = 1; i < ring.length; i++) {
      const prev = out[out.length - 1];
      const cur = ring[i];
      const dx = cur[0] - prev[0];
      const dy = cur[1] - prev[1];
      if (dx * dx + dy * dy > eps2) out.push(cur);
    }
    // Drop the implicit closing edge if first ≈ last too
    if (out.length >= 2) {
      const first = out[0], last = out[out.length - 1];
      const dx = first[0] - last[0];
      const dy = first[1] - last[1];
      if (dx * dx + dy * dy <= eps2) out.pop();
    }
    return out;
  }

  // Build a Line2 (fat line) from CET [x, y] ring points.
  // depthTest:false means lines always render over terrain/buildings, matching
  // the game's UI overlay approach (depth is ignored entirely, so a brightened
  // outline shows through even tall downtown towers). Adjacent districts/
  // subdistricts share exact border vertices, so their outlines are coincident
  // at Y=0; with no depth test the renderer's back-to-front transparent sort is
  // unstable for equal-distance coplanar lines, so the hovered (bright) line is
  // not guaranteed to paint last and a faint 0.05 neighbour can overdraw its
  // edges. The hover code promotes the hovered line's renderOrder to force it
  // last — see setHoveredDistrict / DISTRICT_HOVER_RENDER_ORDER.
  function buildLine(ring, color, lineWidth) {
    const cleaned = dedupRing(ring);
    if (cleaned.length < 3) {
      // Degenerate polygon after dedup — can't draw a meaningful ring. Build
      // an empty Line2 so the caller's group structure is preserved.
      const empty = new LineGeometry();
      empty.setPositions([]);
      const placeholderMat = new THREE.Line2NodeMaterial({ color, linewidth: lineWidth, depthTest: false, transparent: true, opacity: 0 });
      districtLineMaterials.push(placeholderMat);
      return new Line2(empty, placeholderMat);
    }

    const positions = [];
    for (const pt of cleaned) positions.push(pt[0], 0, -pt[1]);
    // Close the ring
    positions.push(cleaned[0][0], 0, -cleaned[0][1]);

    const geometry = new LineGeometry();
    geometry.setPositions(positions);

    // Line2NodeMaterial reads the viewport size from a TSL screen node at
    // shader-execution time — no `resolution` field to keep in sync on resize
    // like the WebGL LineMaterial required.
    const material = new THREE.Line2NodeMaterial({
      color,
      linewidth: lineWidth,
      depthTest: false,
      transparent: true,
      opacity: NCZ.DISTRICT_LINE_OPACITY,
      // Line2NodeMaterial defaults alphaToCoverage:true, gated in-shader on
      // renderer.currentSamples > 0. On r184 that gate never fired; r185's
      // MSAA sample-count fixes activated it, and alpha-to-coverage QUANTIZES
      // alpha to covered samples — the 5% base opacity rounds to 0 of 4
      // samples = invisible lines (hover at ~1.0 still showed). We want the
      // smooth faint alpha blend, not coverage dithering.
      alphaToCoverage: false,
    });
    districtLineMaterials.push(material);

    const line = new Line2(geometry, material);
    line.computeLineDistances();
    line.renderOrder = DISTRICT_LINE_RENDER_ORDER;
    return line;
  }

  // ── E5 intro fly-in ────────────────────────────────────────────────────
  // On first load the camera eases from a far, leaned-back pose down to a
  // whole-city framing. Replaces the old fitCameraToBox opening: that fit
  // distance always exceeded controls.maxDistance (the terrain box is far
  // taller than the ~6650 wu the FOV can frame at maxDistance), so the map
  // silently opened fully zoomed out — the "opens too far" bug E5 closes.

  // Camera pose for the intro: position offset from the framing target by
  // `distance` at `tiltDeg` off vertical, along the fixed intro azimuth.
  // The target is SCHEMA_INTRO_REST_CENTER ([cetX, cetY]) or world centre —
  // the same point for the start and rest poses, so the fly-in is a straight
  // top-down descent with no sideways pan. (Three spherical: phi = polar
  // angle from +Y, theta = azimuth.)
  function introCameraPose(distance, tiltDeg) {
    const c = NCZ.SCHEMA_INTRO_REST_CENTER;
    const target = c
      ? new THREE.Vector3(c[0], 0, -c[1])
      : new THREE.Vector3(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    const phi    = (tiltDeg * Math.PI) / 180;
    const theta  = NCZ.SCHEMA_INTRO_AZIMUTH;
    const position = new THREE.Vector3(
      target.x + distance * Math.sin(phi) * Math.sin(theta),
      target.y + distance * Math.cos(phi),
      target.z + distance * Math.sin(phi) * Math.cos(theta),
    );
    return { target, position };
  }

  const easeInOutCubic = (u) =>
    u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

  // Start the intro fly-in. When a ?mod= deep-link is present the intro is
  // skipped — the camera snaps straight to the rest pose so app.js's
  // deep-link handler flies to the pin from a sensible whole-city framing.
  function playIntro() {
    if (!controls || !camera) return;
    const rest = introCameraPose(NCZ.SCHEMA_INTRO_REST_DISTANCE, NCZ.SCHEMA_INTRO_REST_TILT);

    if (new URLSearchParams(window.location.search).get(NCZ.URL_PARAM_MOD)) {
      controls.target.copy(rest.target);
      camera.position.copy(rest.position);
      controls.update();
      requestRender();
      return;
    }

    const start = introCameraPose(NCZ.SCHEMA_INTRO_START_DISTANCE, NCZ.SCHEMA_INTRO_START_TILT);
    _introTween = {
      startTarget: start.target, endTarget: rest.target,
      startPos:    start.position, endPos:  rest.position,
      elapsed: 0,
      duration: NCZ.SCHEMA_INTRO_DURATION_MS,
    };
    _introLastTime = performance.now();
    setContinuousRender(true);   // hold the loop open for the fly's duration
    requestRender();
  }

  // Advance the intro fly-in one frame. Called at the top of frame() so
  // the camera mutation lands before controls.update() reconciles it — that
  // reconcile fires the 'change' listener, refreshing district zoom, metro
  // LOD, the shadow camera, scale bar and cull frustum as the camera moves.
  function updateIntroTween() {
    if (!_introTween) return;
    const now = performance.now();
    _introTween.elapsed += now - _introLastTime;
    _introLastTime = now;
    const e = easeInOutCubic(Math.min(_introTween.elapsed / _introTween.duration, 1));
    controls.target.lerpVectors(_introTween.startTarget, _introTween.endTarget, e);
    camera.position.lerpVectors(_introTween.startPos, _introTween.endPos, e);
    if (_introTween.elapsed >= _introTween.duration) {
      _introTween = null;
      setContinuousRender(false);  // release the hold; render-on-demand resumes
    }
  }

  // ── Render loop ────────────────────────────────────────────────────────

  const tiltDisplay = document.getElementById('scene-tilt-display');

  // Debug instrumentation — only active when URL has ?debug=1.
  // stats.js panels (vertical stack, all visible): FPS / MS / MB / draw calls / triangles.
  const DEBUG_MODE = new URLSearchParams(window.location.search).has('debug');
  let stats = null, statsCallsPanel = null, statsTrisPanel = null;

  // Rolling time-based buffer of frame intervals — feeds dumpDebugInfo() with
  // avg/p50/p95. The window is *time*, not frame count: a count-based cap was
  // 0.4s on a 280fps machine and 4s on a 15fps machine, defeating the point of
  // a "wait a few seconds and click" workflow. 5s is enough to smooth jitter
  // without hiding sustained changes, at any FPS.
  const FRAME_SAMPLE_DURATION_MS = 5000;
  const _frameTimes = [];
  let _frameTimeSum = 0;        // running sum, for O(1) eviction-boundary check
  let _lastFrameTime = 0;

  function initStats(container) {
    if (!DEBUG_MODE || stats) return;
    stats = new Stats();
    // Anchor inside #map-3d so the panel sits below the page header automatically,
    // regardless of header height. top-right keeps it clear of the scene-tilt display.
    // Flex-column stacks the visible panels vertically so the rightmost ones don't
    // overflow into the viewport edge — Stats.addPanel()'d entries (Calls, Tris/k)
    // bypass the built-in showPanel(0) cycling and stay permanently visible.
    stats.dom.style.position      = 'absolute';
    stats.dom.style.top           = '16px';
    stats.dom.style.right         = '20px';
    stats.dom.style.left          = 'auto';
    stats.dom.style.zIndex        = '9999';
    stats.dom.style.display       = 'flex';
    stats.dom.style.flexDirection = 'column';
    stats.dom.style.gap           = '4px';
    // pointer-events:none disables stats.js's built-in click-to-cycle handler
    // (so all panels stay visible always) AND lets mouse drags pass through
    // to the canvas underneath — useful since the panel sits over the 3D map.
    stats.dom.style.pointerEvents = 'none';
    statsCallsPanel = stats.addPanel(new Stats.Panel('Calls',  '#ff8', '#221'));
    statsTrisPanel  = stats.addPanel(new Stats.Panel('Tris/k', '#f8f', '#212'));
    // Force every panel visible — the constructor calls showPanel(0) which
    // hides MS and MB. We want all five (FPS / MS / MB / Calls / Tris/k) on
    // screen at once so the user can read every metric without interaction.
    for (const child of stats.dom.children) child.style.display = 'block';
    container.appendChild(stats.dom);

    // "Copy debug info" button — sits below the 5 stats panels.
    // Stats height: 5 × 48px panels + 4 × 4px gaps = 256px → button starts at 16+256+8 = 280px.
    const dumpBtn = document.createElement('button');
    dumpBtn.textContent  = 'Copy debug info';
    dumpBtn.style.cssText = [
      'position:absolute', 'top:280px', 'right:20px', 'z-index:9999',
      'padding:6px 10px', 'background:#221', 'color:#ff8',
      'border:1px solid #ff8', 'border-radius:3px',
      'font-family:monospace', 'font-size:11px', 'cursor:pointer',
      'pointer-events:auto', 'opacity:0.9',
    ].join(';');
    dumpBtn.addEventListener('click', () => {
      dumpDebugInfo();
      const orig = dumpBtn.textContent;
      dumpBtn.textContent = 'Copied ✓';
      setTimeout(() => { dumpBtn.textContent = orig; }, 1500);
    });
    container.appendChild(dumpBtn);

    console.log('[NCZ] Debug mode active. Try:');
    console.log('  NCZ.ThreeScene.getRenderInfo()       → draw calls / tris / textures snapshot');
    console.log('  NCZ.ThreeScene.getCullCounts()       → await: visible vs total building instances after the compute cull');
    console.log('  NCZ.ThreeScene.setOverrideMaterial(true|false)  → flat-shade everything to test fragment cost');
    console.log('  NCZ.ThreeScene.dumpDebugInfo()       → full diagnostic snapshot (also bound to the "Copy debug info" button)');
  }

  // Render-on-demand over renderer.setAnimationLoop — the WebGPU-native frame
  // driver (issue #768; the WebGL-era manual rAF chain is retired). The loop
  // fn stays armed while work exists and early-returns on non-dirty ticks;
  // after IDLE_DISARM_MS of consecutive idle ticks it disarms itself via
  // setAnimationLoop(null), so a truly idle map costs zero renders AND zero
  // rAF wakeups. requestRender() marks the frame dirty and re-arms — hook it
  // into any state mutation that affects pixels. The grace window (rather
  // than disarm-on-first-idle-tick) keeps bursty input (wheel ticks, hover
  // in/out) on a warm loop instead of churning setAnimationLoop.
  // Damping continuation is detected from controls.update()'s return value
  // (true = state still interpolating).
  //
  // _suppressed — flyover stops the schema loop and drives frames through
  // _flyoverFrame (setFlyoverFrame below) on this same animation loop. Beat-
  // driven transitionToColors still fires requestRender during the flyover,
  // which would otherwise mark the schema path dirty and race the flyover
  // camera. The flag gates requestRender so the flyover callback stays the
  // sole renderer.
  const IDLE_DISARM_MS = 250;
  let _continuousRenderRefs = 0;
  let _suppressed = false;
  let _frameDirty = false;
  let _loopArmed = false;
  let _idleSince = 0;
  let _flyoverFrame = null;   // showcase per-frame callback; loop persists while set
  let _framesRendered = 0;    // lifetime renderer.render count — idle verification

  function armLoop() {
    if (_loopArmed || !renderer) return;
    renderer.setAnimationLoop(frame);
    _loopArmed = true;
  }

  function disarmLoop() {
    if (!_loopArmed) return;
    renderer.setAnimationLoop(null);
    _loopArmed = false;
  }

  function frame(time) {
    if (_flyoverFrame) { _flyoverFrame(time); return; }
    if (_suppressed || (!_frameDirty && _continuousRenderRefs === 0)) {
      // Idle tick — nothing changed since the last render. Disarm once the
      // grace window has passed with no new work.
      if ((time ?? performance.now()) - _idleSince > IDLE_DISARM_MS) disarmLoop();
      return;
    }
    _frameDirty = false;
    if (stats) stats.begin();
    updateIntroTween();   // E5 intro fly-in — mutate the camera before controls.update() reconciles
    stepDistrictHoverFade(performance.now()); // district outline opacity tween
    const dampingActive = controls.update();
    // Phase 2B: dispatch per-district reset+cull computes BEFORE render.
    // Each district's `reset` clears its indirect.instanceCount to 0; `cull`
    // tests every instance against the camera frustum and atomically appends
    // visible IDs into `visibleIndicesBuffer`. The vertex shader then draws
    // only `instanceCount` instances via the indirect-draw indirection.
    // Sequential dispatches in the same encoder are guaranteed to run in
    // order, so reset finishes before cull begins (no cross-workgroup sync
    // needed). Gated by render-on-demand: if the camera hasn't moved, this
    // whole block is skipped along with the render.
    for (const c of _cullComputes) {
      renderer.compute(c.reset);
      renderer.compute(c.cull);
    }
    renderer.render(scene, camera);
    _framesRendered++;
    NCZ.ThreeMarkers?.render?.();
    if (stats) {
      statsCallsPanel.update(renderer.info.render.calls,         200);
      statsTrisPanel .update(renderer.info.render.triangles/1000, 2000);
      stats.end();
    }
    // Frame-time sampling for dumpDebugInfo(). Cap dt so a long idle gap
    // between render-on-demand frames doesn't poison the rolling average —
    // anything over 1s is treated as "loop was paused, ignore this delta".
    const _now = performance.now();
    if (_lastFrameTime) {
      const dt = _now - _lastFrameTime;
      if (dt < 1000) {
        _frameTimes.push(dt);
        _frameTimeSum += dt;
        while (_frameTimes.length > 1 && _frameTimeSum - _frameTimes[0] > FRAME_SAMPLE_DURATION_MS) {
          _frameTimeSum -= _frameTimes.shift();
        }
      }
    }
    _lastFrameTime = _now;
    // Compute tilt: 0° = horizontal, 90° = straight down (top-down)
    // Convert OrbitControls polarAngle (distance from up vector) to camera tilt angle
    // tilt = 90° - polarAngle
    if (tiltDisplay) {
      const polarDegrees = controls.getPolarAngle() * 180 / Math.PI;
      const tilt = Math.round(90 - polarDegrees);
      tiltDisplay.textContent = `Tilt: ${tilt}°`;
    }
    if (dampingActive || _continuousRenderRefs > 0) _frameDirty = true;
    else _idleSince = performance.now();
  }

  // Schedule one frame. Idempotent — multiple calls within the same tick
  // collapse to a single dirty flag. Hook into any state change that affects
  // pixels. Re-arms the animation loop if it has idle-disarmed.
  function requestRender() {
    if (_suppressed) return;
    if (!renderer || !scene || !camera) return;
    _frameDirty = true;
    armLoop();
  }

  // Hold the loop open across an arbitrary number of frames. Counter-based so
  // multiple animations (theme dissolve + sun arc + beat pulse) compose cleanly
  // — each pairs a true/false call. Flyover doesn't use this; it bypasses the
  // schema frame body entirely via its setFlyoverFrame callback.
  function setContinuousRender(active) {
    _continuousRenderRefs = Math.max(0, _continuousRenderRefs + (active ? 1 : -1));
    if (_continuousRenderRefs > 0) requestRender();
  }

  // Showcase frame driver (issue #768). While a callback is set, the shared
  // animation loop invokes it every tick instead of the schema frame body —
  // a cinematic is continuous by nature, so no dirty flag and no idle disarm.
  // Clearing it falls back to the schema path, which (still _suppressed until
  // startRenderLoop) idles out through the normal grace window.
  function setFlyoverFrame(fn) {
    _flyoverFrame = fn || null;
    if (_flyoverFrame) armLoop();
  }

  // Backward-compat shims — external callers (app.js view switch, flyover
  // restart) still talk to start/stop. start = "ensure at least one frame
  // renders soon" which on-demand satisfies via a single requestRender.
  // start also clears the flyover suppression flag in case stopRenderLoop
  // was the call that engaged it; stop sets it so any in-flight requestRender
  // (e.g. from a still-running color tween) doesn't mark the schema path dirty.
  function startRenderLoop() {
    _suppressed = false;
    // The showcase flyover fits the shadow camera, the cull-frustum uniforms,
    // and the metro LOD pseudo-zoom to its own PerspectiveCamera (renderFrame
    // below). When it hands control back, snap all three back to the schema
    // camera's view before the next schema frame — otherwise the cull's first
    // post-showcase dispatch would test against the flyCamera's last frustum
    // and the metro LOD would be stuck on the synthetic perspective zoom
    // until the user moved the camera (firing the controls 'change' reset).
    updateShadowCamera();
    updateFrustumUniforms();
    if (metroDistanceUniform && camera && controls) {
      metroDistanceUniform.value = camera.position.distanceTo(controls.target);
    }
    requestRender();
  }

  function stopRenderLoop() {
    _suppressed = true;
    _frameDirty = false;
    // Disarm now unless the flyover is (about to be) driving frames — in the
    // flyover start sequence setFlyoverFrame() follows immediately and re-arms.
    if (!_flyoverFrame) disarmLoop();
    _lastFrameTime = 0; // Reset so the next frame after restart doesn't sample the gap
  }

  // ── Debug helpers (always exposed; useful from DevTools console) ───────

  // Snapshot of renderer.info — counts that explain CPU vs GPU bottlenecks.
  function getRenderInfo() {
    if (!renderer) return null;
    return {
      // Lifetime count of frames actually rendered (schema + flyover) — poll
      // twice to verify render-on-demand idles at zero (issue #768 acceptance).
      framesRendered: _framesRendered,
      drawCalls:  renderer.info.render.calls,
      triangles:  renderer.info.render.triangles,
      points:     renderer.info.render.points,
      lines:      renderer.info.render.lines,
      geometries: renderer.info.memory.geometries,
      textures:   renderer.info.memory.textures,
      // WebGPU tracks compiled pipelines as a count on info.memory.programs;
      // the WebGL2-era info.programs array doesn't exist on this backend.
      programs:   renderer.info.memory.programs ?? 0,
    };
  }

  // Phase 2B cull-effectiveness probe. `renderer.info.render.triangles` is
  // CPU-computed and never round-trips the indirect buffer's atomic
  // instanceCount, so it reads 0 under indirect draws — the only way to know
  // how many building instances actually survive the compute frustum cull is
  // to read the GPU copy back. `getArrayBufferAsync` maps the storage buffer
  // to the CPU; index [1] of the 5-uint IndirectDraw struct is instanceCount.
  // Returns { total, visible, byDistrict: [{ name, instanceCount }] } or null.
  async function getCullCounts() {
    if (!renderer || !buildingMaterials.length) return null;
    const byDistrict = [];
    let total = 0, visible = 0;
    // buildingMeshes and buildingMaterials are pushed in lockstep in loadBuildings,
    // so the index aligns — use it for the district name (`buildings-<district>`).
    for (let i = 0; i < buildingMaterials.length; i++) {
      const mat  = buildingMaterials[i];
      const attr = mat.userData.indirectAttribute;
      if (!attr) continue;
      const cap  = mat.userData.instanceMatricesBuffer?.value?.count ?? null;
      const buf  = await renderer.getArrayBufferAsync(attr);
      const instanceCount = new Uint32Array(buf)[1];
      byDistrict.push({ name: buildingMeshes[i]?.name || mat.name || `district-${i}`, instanceCount, capacity: cap });
      if (cap != null) total += cap;
      visible += instanceCount;
    }
    return { total: total || null, visible, fraction: total ? visible / total : null, byDistrict };
  }

  // Override-material diagnostic: replaces every material in the scene with a
  // flat MeshBasicMaterial. If FPS jumps when enabled → fragment-bound (shader cost).
  // If FPS stays the same → vertex/CPU-bound (geometry or draw calls).
  let _debugOverrideMat = null;
  function setOverrideMaterial(enabled) {
    if (!scene) return;
    if (enabled) {
      if (!_debugOverrideMat) _debugOverrideMat = new THREE.MeshBasicNodeMaterial({ color: 0x00ff00 });
      scene.overrideMaterial = _debugOverrideMat;
    } else {
      scene.overrideMaterial = null;
    }
    requestRender();
  }

  // Comprehensive diagnostic snapshot — bound to the "Copy debug info" button
  // and exposed for console use. Logs human-readable text, copies it to the
  // clipboard, and returns the structured object for programmatic use.
  function dumpDebugInfo() {
    // FPS stats from the rolling frame-time buffer
    let fps = { available: false };
    if (_frameTimes.length > 10) {
      const sorted = [..._frameTimes].sort((a, b) => a - b);
      const avg    = _frameTimes.reduce((s, t) => s + t, 0) / _frameTimes.length;
      const p50    = sorted[Math.floor(sorted.length * 0.5)];
      const p95    = sorted[Math.floor(sorted.length * 0.95)];
      fps = {
        available:     true,
        avgFps:        Math.round(1000 / avg),
        p50Fps:        Math.round(1000 / p50),
        worstP95Fps:   Math.round(1000 / p95),
        sampleSeconds: (_frameTimes.reduce((s, t) => s + t, 0) / 1000).toFixed(1),
      };
    }

    // GPU details — two paths:
    //   WebGPU: pull from the cached GPUAdapterInfo on the backend adapter.
    //           WGSL spec exposes `vendor` and `architecture`/`description`;
    //           Three.js caches whatever the browser surfaces at adapter request.
    //   WebGL2: legacy WEBGL_debug_renderer_info extension, gated by browser
    //           anti-fingerprinting policy (some browsers return null UNMASKED_*).
    let gpu = 'unknown', vendor = 'unknown', maxTexture = '?', maxRb = '?';
    if (renderer) {
      try {
        if (renderer.isWebGPURenderer) {
          // r184's WebGPUBackend keeps the GPUAdapter local to init() — it's not
          // on `renderer.backend`. The device, however, exposes `adapterInfo`
          // (spec-stable GPUDevice.adapterInfo). Chrome's anti-fingerprinting
          // policy blanks `device`/`description` for non-allowlisted origins, but
          // `vendor` ("nvidia", "amd"…) and `architecture` ("blackwell", "rdna3"…)
          // still come through — same caveat the WebGL2 path's UNMASKED_* had.
          const adapterInfo = renderer.backend?.device?.adapterInfo;
          if (adapterInfo) {
            gpu    = adapterInfo.description || adapterInfo.architecture || 'unknown';
            vendor = adapterInfo.vendor || 'unknown';
          }
          const limits = renderer.backend?.device?.limits;
          if (limits) {
            maxTexture = limits.maxTextureDimension2D ?? '?';
            // No direct renderbuffer limit in WebGPU — use storage-buffer binding size
            // as the closest analogue; surfaces under the same "how big can a single
            // GPU resource be" question as the WebGL value.
            maxRb      = limits.maxStorageBufferBindingSize ?? '?';
          }
        } else if (renderer.getContext) {
          const gl  = renderer.getContext();
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          if (ext) {
            gpu    = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
            vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
          }
          maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
          maxRb      = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
        }
      } catch (_) { /* introspection unavailable — leave defaults */ }
    }

    const shadowTypeNames = ['BasicShadowMap', 'PCFShadowMap', 'PCFSoftShadowMap', 'VSMShadowMap'];
    const dump = {
      timestamp: new Date().toISOString(),
      fps,
      render: renderer ? {
        // Per Three.js Info.js: `info.render.calls` = lifetime render() calls,
        // `info.render.frameCalls` = current-frame render() calls (usually 1),
        // `info.render.drawCalls` = current-frame DRAW count. Earlier Phase 1
        // code mislabelled `calls` as "drawCalls" — it's the lifetime render
        // counter, not the per-frame draw counter.
        drawCallsThisFrame: renderer.info.render.drawCalls ?? 0,
        rendersTotal:       renderer.info.render.calls,
        triangles:    renderer.info.render.triangles,
        lines:        renderer.info.render.lines,
        // Compute stats live at `info.compute.{calls, frameCalls}` on
        // WebGPURenderer — NOT under `info.render`. WebGL2 fallback has
        // neither, so we coalesce to 0.
        computeTotal:      renderer.info.compute?.calls ?? 0,
        computeFrameCalls: renderer.info.compute?.frameCalls ?? 0,
        geometries:   renderer.info.memory.geometries,
        textures:     renderer.info.memory.textures,
        // Indirect-storage-buffer bytes — confirms Phase 2B's draw buffers
        // (5 u32s × 8 districts = 160 bytes minimum) are allocated.
        indirectBufferBytes: renderer.info.memory.indirectStorageAttributesSize ?? 0,
        // WebGPU exposes the compiled-pipeline count at info.memory.programs
        // (the WebGL2-era info.programs array doesn't exist on this backend).
        programs:     renderer.info.memory.programs ?? null,
      } : null,
      rendererSettings: renderer ? {
        pixelRatio:     renderer.getPixelRatio(),
        // No `getContextAttributes()` on WebGPURenderer — track from constructor
        // params via a sentinel set at init time. Falls back to the legacy path
        // for WebGL2 where the WebGL context exposes these directly.
        antialias:      _webgpuActive
                          ? !!_rendererInitParams?.antialias
                          : !!(renderer.getContextAttributes?.() && renderer.getContextAttributes().antialias),
        backend:        _webgpuActive ? 'WebGPU' : 'WebGL2',
        // _shadowsOn is the user-facing state; renderer.shadowMap.enabled stays
        // true permanently (the toggle flips shadow intensity, not the pass).
        shadowsEnabled: _shadowsOn,
        shadowMapType:  shadowTypeNames[renderer.shadowMap.type] || String(renderer.shadowMap.type),
        shadowMapSize:  NCZ.SHADOW_MAP_SIZE,
      } : null,
      display: {
        windowSize:       `${window.innerWidth}x${window.innerHeight}`,
        screenSize:       `${screen.width}x${screen.height}`,
        canvasSize:       renderer ? `${renderer.domElement.width}x${renderer.domElement.height}` : 'unknown',
        devicePixelRatio: window.devicePixelRatio,
        effectivePixels:  Math.round(window.innerWidth * window.innerHeight * window.devicePixelRatio),
      },
      hardware: {
        gpu, vendor,
        hardwareConcurrency: navigator.hardwareConcurrency || 'unknown',
        deviceMemoryGB:      navigator.deviceMemory || 'unknown',
        maxTextureSize:      maxTexture,
        maxRenderbufferSize: maxRb,
      },
      browser: {
        userAgent: navigator.userAgent,
        language:  navigator.language,
      },
    };

    // Build the human-readable text format
    const lines = [
      `NCZoning Debug Dump — ${dump.timestamp}`,
      '─'.repeat(50),
    ];
    if (fps.available) {
      lines.push(`FPS:           avg ${fps.avgFps} / p50 ${fps.p50Fps} / worst-5% ${fps.worstP95Fps}    (${fps.sampleSeconds}s sample)`);
    } else {
      lines.push('FPS:           (not enough samples — render loop not running?)');
    }
    if (dump.render) {
      lines.push(`Draw calls:    ${dump.render.drawCallsThisFrame} (this frame)`);
      lines.push(`Renders total: ${dump.render.rendersTotal} (lifetime)`);
      const compFrame = dump.render.computeFrameCalls;
      const compTotal = dump.render.computeTotal;
      if (compTotal > 0) {
        lines.push(`Compute:       ${compFrame} this frame  /  ${compTotal} lifetime`);
      } else {
        lines.push(`Compute:       (none — running on WebGL2 fallback?)`);
      }
      lines.push(`Triangles:     ${dump.render.triangles.toLocaleString()}`);
      // Programs is WebGL2-only — show "n/a" rather than "null" under WebGPU.
      const programsField = dump.render.programs == null ? 'n/a (WebGPU)' : dump.render.programs;
      lines.push(`Geometries:    ${dump.render.geometries}    Textures: ${dump.render.textures}    Programs: ${programsField}`);
      if (dump.render.indirectBufferBytes > 0) {
        lines.push(`Indirect bufs: ${dump.render.indirectBufferBytes} bytes`);
      }
    }
    if (dump.rendererSettings) {
      const r = dump.rendererSettings;
      lines.push('');
      const shadowText = r.shadowsEnabled ? `${r.shadowMapType} / ${r.shadowMapSize}²` : 'off';
      lines.push(`Renderer:      ${r.backend} / DPR ${r.pixelRatio} / AA ${r.antialias ? 'on' : 'off'} / Shadows ${shadowText}`);
    }
    lines.push(`Display:       ${dump.display.windowSize} window, ${dump.display.screenSize} screen, ${dump.display.devicePixelRatio} DPR`);
    lines.push(`Effective px:  ${dump.display.effectivePixels.toLocaleString()}`);
    lines.push(`Canvas:        ${dump.display.canvasSize}`);
    lines.push('');
    lines.push(`GPU:           ${dump.hardware.gpu}`);
    lines.push(`Vendor:        ${dump.hardware.vendor}`);
    // navigator.hardwareConcurrency returns logical processors (threads), not physical cores.
    // navigator.deviceMemory is implemented only in Chromium-based browsers (Chrome, Edge,
    // Brave, etc.); Firefox and Safari return undefined, which falls through to "unknown".
    // Where it IS supported, the value is quantised to the largest power of 2 strictly less
    // than the actual RAM (spec caps at 8 GB; Chromium ignores the cap but still applies the
    // rounding — verified by user reports of 64 GB → 32 and 16 GB → 8). The actual RAM
    // therefore lies in (reported, 2 × reported]; we display that half-open range so readers
    // don't misread the floor as a precise figure. Phrased as "browser reports …" rather
    // than naming Chrome, since the rounding is observable in every Chromium variant.
    const memText = typeof dump.hardware.deviceMemoryGB === 'number'
      ? `${dump.hardware.deviceMemoryGB}–${dump.hardware.deviceMemoryGB * 2} GB (browser reports power-of-2 floor)`
      : 'unknown';
    lines.push(`CPU threads:   ${dump.hardware.hardwareConcurrency}    Memory: ${memText}`);
    lines.push(`Max texture:   ${dump.hardware.maxTextureSize}`);
    lines.push('');
    lines.push(`User agent:    ${dump.browser.userAgent}`);

    const text = lines.join('\n');
    console.log('[NCZ] Debug dump:\n' + text);
    console.log('[NCZ] Dump object:', dump);

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => console.log('[NCZ] Copied to clipboard ✓'),
        err => console.warn('[NCZ] Could not copy to clipboard:', err)
      );
    }

    return dump;
  }

  // ── WebGPU diagnostic probe (?webgpuprobe) ─────────────────────────────
  // Three.js collapses every WebGPU negotiation failure into one opaque log
  // line ("WebGPU is not available, running under WebGL2 backend"), and r184's
  // WebGPUBackend keeps the GPUAdapter local to its init() — so post-init we
  // can't see *why* it bailed. This pre-init probe replicates the exact
  // adapter/device requests Three.js makes and surfaces the real rejection.
  //
  // Output convention follows the project's devtools `copy()` debug pattern
  // (see learnings/shadowtrace-spacebar-marker-pattern): the full text is
  // stashed on window.__webgpuProbe so the tester runs `copy(__webgpuProbe)`
  // and pastes it back — no clipboard user-gesture needed at page load.
  async function runWebGPUProbe() {
    const lines = [];
    const log = (s) => lines.push(s);
    // Each GPUAdapter vends exactly one device; reusing one across the three
    // requestDevice() attempts would test an already-consumed adapter and
    // give misleading results. Always pull a fresh adapter per attempt.
    const freshAdapter = () => navigator.gpu.requestAdapter();

    try {
      log('NCZoning WebGPU Probe — ' + new Date().toISOString());
      log('─'.repeat(50));
      log('User agent:            ' + navigator.userAgent);
      log('navigator.gpu present: ' + !!navigator.gpu);

      if (!navigator.gpu) {
        log('');
        log('navigator.gpu is absent — this browser does not expose WebGPU.');
      } else {
        const adapter = await navigator.gpu.requestAdapter();
        log('');
        log('requestAdapter() (default):');
        if (!adapter) {
          log('  → null (no adapter returned)');
        } else {
          log('  isFallbackAdapter: ' + adapter.isFallbackAdapter);
          const info = adapter.info || {};
          log('  info.vendor:       ' + info.vendor);
          log('  info.architecture: ' + info.architecture);
          log('  info.device:       ' + info.device);
          log('  info.description:  ' + info.description);
          log('  features:          ' + [...adapter.features].sort().join(', '));

          const lim = adapter.limits;
          log('');
          log('adapter.limits (for-in enumeration):');
          const keys = [];
          for (const k in lim) keys.push(k);
          keys.sort();
          if (keys.length === 0) {
            log('  (for-in yielded no keys — see explicit key limits below)');
          } else {
            for (const k of keys) log('  ' + k + ' = ' + lim[k]);
          }
          // Explicit readout of the limits that decide the buildings path,
          // independent of whether for-in enumerates getters on this browser.
          log('');
          log('key limits (explicit):');
          for (const k of [
            'maxStorageBuffersInVertexStage',
            'maxStorageBuffersInFragmentStage',
            'maxStorageBuffersPerShaderStage',
            'maxStorageBufferBindingSize',
            'maxBufferSize',
          ]) {
            log('  ' + k + ' = ' + lim[k] + ' (typeof ' + typeof lim[k] + ')');
          }
          log('');
          log('  >>> maxStorageBuffersInVertexStage = ' +
              lim.maxStorageBuffersInVertexStage +
              '  (this is the make-or-break number)');
        }

        const adapterHP = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        log('');
        log('requestAdapter({powerPreference:"high-performance"}): ' +
            (adapterHP ? ('ok, isFallbackAdapter=' + adapterHP.isFallbackAdapter) : 'null'));

        // (4) Exactly what three-scene.js currently asks Three.js to request.
        log('');
        log('requestDevice({requiredLimits:{maxStorageBuffersInVertexStage:1}}):');
        try {
          const a = await freshAdapter();
          const d = await a.requestDevice({ requiredLimits: { maxStorageBuffersInVertexStage: 1 } });
          log('  → SUCCESS. device.limits.maxStorageBuffersInVertexStage = ' +
              d.limits.maxStorageBuffersInVertexStage);
          d.destroy();
        } catch (err) {
          log('  → REJECTED. name=' + err.name + '  message=' + err.message);
        }

        // (5) Contrast control — does the device come up at all without limits?
        log('');
        log('requestDevice() (no requiredLimits — contrast control):');
        try {
          const a = await freshAdapter();
          const d = await a.requestDevice();
          log('  → SUCCESS. device.limits.maxStorageBuffersInVertexStage = ' +
              d.limits.maxStorageBuffersInVertexStage);
          d.destroy();
        } catch (err) {
          log('  → REJECTED. name=' + err.name + '  message=' + err.message);
        }

        // (6) Pre-validates the Phase B fix: only request the limit when the
        // adapter actually reports it.
        log('');
        log('requestDevice() (clamped — request limit only if adapter supports ≥1):');
        try {
          const a = await freshAdapter();
          const supports = !!(a && a.limits && a.limits.maxStorageBuffersInVertexStage >= 1);
          log('  adapter.limits.maxStorageBuffersInVertexStage = ' +
              (a && a.limits ? a.limits.maxStorageBuffersInVertexStage : '(no adapter)') +
              ' → ' + (supports ? 'requesting it' : 'omitting it'));
          const d = await a.requestDevice(
            supports ? { requiredLimits: { maxStorageBuffersInVertexStage: 1 } } : undefined
          );
          log('  → SUCCESS. device.limits.maxStorageBuffersInVertexStage = ' +
              d.limits.maxStorageBuffersInVertexStage);
          d.destroy();
        } catch (err) {
          log('  → REJECTED. name=' + err.name + '  message=' + err.message);
        }
      }
    } catch (outer) {
      log('');
      log('PROBE ERROR (unexpected): ' + ((outer && outer.stack) || outer));
    }

    const text = lines.join('\n');
    window.__webgpuProbe = text;
    console.log(
      '[NCZ] WebGPU probe complete. Run  copy(__webgpuProbe)  in this console ' +
      'to copy it, then paste it back.\n\n' + text
    );
    // Opportunistic — works if the page happens to be focused; the
    // copy(__webgpuProbe) path above is the reliable one at page load.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => console.log('[NCZ] WebGPU probe — also copied to clipboard ✓'),
        ()  => { /* expected without a user gesture — use copy(__webgpuProbe) */ }
      );
    }
  }

  // ── Flyover API ────────────────────────────────────────────────────────
  // Called by flyover.js — kept minimal to avoid exposing internals.

  function renderFrame(cam) {
    if (!renderer || !scene) return;
    // The showcase flyover renders through its own PerspectiveCamera —
    // re-fit the shadow camera AND the cull-frustum uniforms to *its* view
    // each frame (the schema frame body is suppressed during showcase, so
    // nothing else is keeping these in sync). Then dispatch the per-frame
    // Phase 2B cull computes the same way frame() does — without this,
    // the indirect buffer's instanceCount is frozen at whatever the schema
    // cam last culled, so both the shadow pass and the main pass draw a
    // stale building set (the original symptom: shadows missing under
    // showcase, and buildings popping as the cinematic moves).
    if (cam && cam !== camera) {
      updateShadowCamera(cam);   // also refreshes the union-cull's shadow frustum
      updateFrustumUniforms(cam); // and the camera-frustum half
      // Metro LOD: pin to the R-tier (dotted close-zoom variant) for the whole
      // showcase. Dashed reads well from any cinematic angle and avoids tier
      // transitions mid-flight. Any distance < METRO_LOD_DISTANCE_NEAR forces
      // the discard expression to keep only R; 0 is the unambiguous floor.
      if (metroDistanceUniform && cam.isPerspectiveCamera) {
        metroDistanceUniform.value = 0;
      }
      for (const c of _cullComputes) {
        renderer.compute(c.reset);
        renderer.compute(c.cull);
      }
    }
    renderer.render(scene, cam);
    _framesRendered++;
  }

  function setControlsEnabled(enabled) {
    if (controls) controls.enabled = enabled;
  }

  function getCanvasElement() {
    return renderer ? renderer.domElement : null;
  }

  // ── Theme update ───────────────────────────────────────────────────────
  // Called by app.js when the user switches theme.

  function resetCamera() {
    if (!controls) return;

    // Snap back to the E5 intro's rest pose — the whole-city framing the
    // camera comes to rest at on first load. Cancel an in-flight intro
    // (and release its render-loop hold) if Reset is hit during the fly-in.
    if (_introTween) { _introTween = null; setContinuousRender(false); }
    const rest = introCameraPose(NCZ.SCHEMA_INTRO_REST_DISTANCE, NCZ.SCHEMA_INTRO_REST_TILT);
    controls.target.copy(rest.target);
    camera.position.copy(rest.position);
    camera.lookAt(rest.target);
    camera.up.set(0, 1, 0);

    controls.autoRotate = false;
    controls.autoRotateSpeed = 0;
    controls.update();
    requestRender();
  }

  function updateMaterials() {
    if (!scene) return;

    scene.background = readThemeColor('--primary', '#0a192f');

    // Colour grade + braindance LUT follow the theme (--scene-grade): on for
    // the Game / Preem map-replica themes, off for the stylised themes. A theme
    // switch resets any manual Settings "LUT" override back to the theme default.
    applyGrade(themeGradeEnabled());
    // Same for the edge-glow toggle (default-on for Synthwave only).
    applyEdgeGlow(themeEdgeGlowDefault());

    // Terrain/water/cliffs: base colour is material.color; the grid line
    // colour is the shared uGrid uniform stashed on each material.
    const gridColour = readThemeColor('--scene-grid', '#6d8ab0');
    const setHillshade = (m, baseVar, baseFallback) => {
      if (!m) return;
      m.color.copy(readThemeColor(baseVar, baseFallback));
      const u = m.userData.tslUniforms;
      if (u) u.uGrid.value.copy(gridColour);
    };
    setHillshade(terrainMat, '--scene-terrain', '#566c88');
    setHillshade(waterMat,   '--scene-water',   '#2a3f57');
    setHillshade(cliffsMat,  '--scene-cliffs',  '#566c88');
    if (roadsMat)         roadsMat.color.copy(readThemeColor('--overlay-road-color',         '#504b41'));
    if (normalRoadsMat)   normalRoadsMat.color.copy(readThemeColor('--overlay-road-color',    '#504b41'));
    if (bordersMat)       bordersMat.color.copy(readThemeColor('--overlay-road-border-color', '#1ec3c8'));
    if (normalBordersMat) normalBordersMat.color.copy(readThemeColor('--overlay-road-border-color', '#1ec3c8'));
    if (metroMat)   metroMat.color.copy(readThemeColor('--overlay-metro-color',        '#dcaa28'));

    // Update landmark material — its own --scene-landmarks colour. The game's
    // monument meshes are a separate material from the building cubes; the
    // Preem Map mod recolours buildings but leaves the monuments vanilla, so
    // landmarks must be themed independently.
    if (landmarkMat) landmarkMat.color.copy(readThemeColor('--scene-landmarks', '#7a8fa0'));

    // Update building materials — MeshLambertNodeMaterial.color + TSL edge-colour uniform
    if (buildingMaterials.length) {
      const base = readThemeColor('--scene-buildings', '#7a8fa0');
      const edge = readThemeColor('--scene-buildings-edge', '#ffffff');
      for (const mat of buildingMaterials) {
        mat.color.copy(base);
        const u = mat.userData.tslUniforms;
        if (u?.uEdgeColor) u.uEdgeColor.value.copy(edge);
      }
      // Edge-glow uniforms handled by applyEdgeGlow() above (theme default /
      // Settings override) — uses the fixed intensity, not the raw CSS number.
    }
    requestRender();
  }

  // ── Color bindings registry ────────────────────────────────────────────────
  // Each entry: { key, cssVar, fallback, get, reset, lerp }
  // Adding a new material = one new entry here. Everything else is automatic.
  // Exposed as getSceneColorVars() so flyover.js can read CSS vars without
  // knowing about Three.js material internals.
  function getColorBindings() {
    const mat = (m, extra) => ({
      get:   () => m?.color.clone() ?? null,
      reset: c  => m?.color.copy(c),
      lerp:  (f, t, a) => m?.color.lerpColors(f, t, a),
      ...extra,
    });
    // The grid line colour is one uniform shared by all three hillshade mats.
    const eachGridUniform = (op) => [terrainMat, waterMat, cliffsMat].forEach(m => {
      const u = m?.userData.tslUniforms; if (u) op(u.uGrid.value);
    });
    return [
      { key: 'bg', cssVar: '--primary', fallback: '#0a192f',
        get:   () => scene?.background?.clone() ?? null,
        reset: c  => { if (scene?.background && c) scene.background.copy(c); },
        lerp:  (f, t, a) => { if (scene?.background && f && t) scene.background.lerpColors(f, t, a); },
      },
      { key: 'terrain',  cssVar: '--scene-terrain',  fallback: '#566c88', ...mat(terrainMat) },
      { key: 'water',    cssVar: '--scene-water',    fallback: '#2a3f57', ...mat(waterMat) },
      { key: 'cliffs',   cssVar: '--scene-cliffs',   fallback: '#566c88', ...mat(cliffsMat) },
      { key: 'grid',     cssVar: '--scene-grid',     fallback: '#6d8ab0',
        get:   () => terrainMat?.userData.tslUniforms?.uGrid.value.clone() ?? null,
        reset: c  => { if (c) eachGridUniform(v => v.copy(c)); },
        lerp:  (f, t, a) => { if (f && t) eachGridUniform(v => v.lerpColors(f, t, a)); },
      },
      { key: 'roads',    cssVar: '--overlay-road-color', fallback: '#504b41',
        get:   () => roadsMat?.color.clone() ?? null,
        reset: c  => { roadsMat?.color.copy(c); normalRoadsMat?.color.copy(c); },
        lerp:  (f, t, a) => { roadsMat?.color.lerpColors(f, t, a); normalRoadsMat?.color.lerpColors(f, t, a); },
      },
      { key: 'borders', cssVar: '--overlay-road-border-color', fallback: '#1ec3c8',
        get:   () => bordersMat?.color.clone() ?? null,
        reset: c  => { bordersMat?.color.copy(c); normalBordersMat?.color.copy(c); },
        lerp:  (f, t, a) => { bordersMat?.color.lerpColors(f, t, a); normalBordersMat?.color.lerpColors(f, t, a); },
      },
      { key: 'metro',    cssVar: '--overlay-metro-color', fallback: '#dcaa28', ...mat(metroMat) },
      { key: 'buildings', cssVar: '--scene-buildings', fallback: '#8aacbf',
        get:   () => buildingMaterials[0]?.color.clone() ?? null,
        reset: c  => { buildingMaterials.forEach(m => m.color.copy(c)); },
        lerp:  (f, t, a) => { buildingMaterials.forEach(m => m.color.lerpColors(f, t, a)); },
      },
      { key: 'landmarks', cssVar: '--scene-landmarks', fallback: '#8aacbf', ...mat(landmarkMat) },
      { key: 'buildingsEdge', cssVar: '--scene-buildings-edge', fallback: '#ffffff',
        get:   () => buildingMaterials[0]?.userData.tslUniforms?.uEdgeColor.value.clone() ?? null,
        reset: c  => buildingMaterials.forEach(m => { const u = m.userData.tslUniforms; if (u) u.uEdgeColor.value.copy(c); }),
        lerp:  (f, t, a) => buildingMaterials.forEach(m => { const u = m.userData.tslUniforms; if (u) u.uEdgeColor.value.lerpColors(f, t, a); }),
      },
    ];
  }

  function getSceneColorVars() {
    return getColorBindings().map(({ key, cssVar, fallback }) => ({ key, cssVar, fallback }));
  }

  // Snapshot current material colors — call before applyTheme so the old
  // values are captured for use as the "from" end of a transition lerp.
  function captureColors() {
    const snap = {};
    for (const b of getColorBindings()) snap[b.key] = b.get();
    return snap;
  }

  // Lerp scene/material colors from a snapshot to explicit THREE.Color targets.
  // Used by the flyover beat cycle — no CSS read, no building update, no overhead.
  function transitionToColors(from, to, durationMs = 800) {
    if (!scene) return;
    const bindings = getColorBindings();
    for (const b of bindings) if (from[b.key]) b.reset(from[b.key]);
    const start = performance.now();
    function step() {
      const rawT = Math.min((performance.now() - start) / durationMs, 1);
      const t    = rawT * rawT * (3 - 2 * rawT);
      for (const b of bindings) if (from[b.key] && to[b.key]) b.lerp(from[b.key], to[b.key], t);
      requestRender();
      if (rawT < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // Smoothly lerp scene/material colors from a captured snapshot to the
  // current CSS custom property values (new theme already applied).
  // Buildings snap immediately via updateMaterials(); only the main scene
  // colors are lerped to keep the per-frame cost low.
  function transitionMaterials(from, durationMs = 1000) {
    if (!scene) return;
    const bindings = getColorBindings();

    // Restore to pre-theme state
    for (const b of bindings) if (from[b.key]) b.reset(from[b.key]);

    // Read targets from CSS (new theme class already on <html>)
    const to = {};
    for (const b of bindings) to[b.key] = readThemeColor(b.cssVar, b.fallback);

    const start = performance.now();
    function step() {
      const rawT = Math.min((performance.now() - start) / durationMs, 1);
      const t    = rawT * rawT * (3 - 2 * rawT);
      for (const b of bindings) if (from[b.key]) b.lerp(from[b.key], to[b.key], t);
      requestRender();
      if (rawT < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ── Sun / hillshade control ────────────────────────────────────────────────
  // azimuthRad: from south, positive westward (SunCalc convention)
  // altitudeRad: elevation above horizon (0 = horizon, π/2 = zenith)
  //
  // GLB space axes: East = +X, South = +Z, West = -X, North = -Z, Up = +Y
  // So az=0 (south) → Z+; az=π/2 (west) → X-; az=-π/2 (east) → X+
  function setSunPosition(azimuthRad, altitudeRad) {
    // Store the requested state BEFORE the lights-exist guard. getSunElevation()
    // — and the app.js UI-sync poll that reverse-maps it onto the sun slider —
    // must see what was requested even when this call lands before init() has
    // built the lights (the slider's initial applySunTime fires that early).
    // When the request was dropped here instead, the poll read the placeholder
    // elevation (~63°), wrote it back onto the slider, and the post-terrain
    // re-apply then locked the wrong sun in on every cold load.
    _sunAz = azimuthRad;
    _sunEl = altitudeRad;
    if (!_dirLight || !_hemiLight) return;
    const el = altitudeRad;
    const az = azimuthRad;

    // Sun direction (unit, ground→sun). Floor the Y at ~6° elevation so the
    // shadow camera's lookAt never goes degenerate-horizontal; the visible sun
    // sphere below uses the *unclamped* elevation so it still sets at the horizon.
    _sunDir.set(-Math.cos(el) * Math.sin(az), Math.max(0.1, Math.sin(el)), Math.cos(el) * Math.cos(az)).normalize();
    // Re-orient the light around its current target (updateShadowCamera owns the
    // target = visible-ground centre; here we just keep the light up the sun ray
    // from it). Orthographic ⇒ only the direction matters for shading.
    _dirLight.position.copy(_dirLight.target.position).addScaledVector(_sunDir, NCZ.SUN_DIST);
    flagShadowUpdate();   // sun moved ⇒ re-render the shadow depth map next frame (no-op while shadows off)

    // Sun + ambient colour and intensity are fixed (calibrated to 3dmap.envparam,
    // set once at light construction) — the in-game map has no time-of-day
    // variation. The slider only moves the sun's direction, above.

    // Move the visible sun sphere (shown during showcase only).
    // Centred on Night City (WORLD_CX, 0, -WORLD_CY) so it hangs over the map.
    if (_sunSphere) {
      const SUN_SPHERE_DIST = NCZ.SUN_SPHERE_DIST;
      const nx = -Math.cos(el) * Math.sin(az);
      const ny =  Math.sin(el); // unclamped — terrain naturally occludes it at sunrise/sunset
      const nz =  Math.cos(el) * Math.cos(az);
      _sunSphere.position.set(
        NCZ.WORLD_CX + nx * SUN_SPHERE_DIST,
        ny * SUN_SPHERE_DIST,
        -NCZ.WORLD_CY + nz * SUN_SPHERE_DIST,
      );
    }
    requestRender();
  }

  function setSunSphereVisible(visible) {
    if (_sunSphere) _sunSphere.visible = visible;
    requestRender();
  }

  // Re-fit the single shadow camera (the OrthographicCamera that renders the
  // sun's depth map) to exactly the visible-ground footprint of `renderCam`,
  // capped at SHADOW_MAX_DISTANCE so it can't balloon at the zoomed-out + tilted
  // extreme. Re-centres the sun light + its target on that footprint so the
  // shadow tracks what you see. Called on every camera change, on resize, after
  // terrain loads, on flyover frames (renderCam = the fly cam), and from
  // startRenderLoop. Single map for now; CSM is a queued follow-up
  // (see [[align-schematic-camera-to-game]] for the rationale shift).
  function updateShadowCamera(renderCam = camera) {
    if (!_dirLight || !renderCam) return;
    const shadowCam = _dirLight.shadow.camera;

    // Two fit paths — the camera shapes are too different to share one.
    //
    // Schema cam (interactive top-down perspective with controls): sphere-fit.
    // Ray-cast NDC corners → Y=0 → bounding sphere (centroid + enclosing
    // radius). Tight, sharp, matches the user's view, and — unlike the AABB —
    // rotation-invariant, so the texel size below stays constant as you orbit
    // and the texel snap holds. Always succeeds for the schema cam because
    // controls constrain tilt below horizontal, so corners always hit ground at
    // reasonable distances. This is the "shadows look good on schema map" path.
    //
    // Showcase fly cam (cinematic perspective, often near-horizontal) AND the
    // schema cam when zoomed out past the cap: a WORLD-LOCKED cap-sized box (half =
    // `SHADOW_MAX_DISTANCE + GROUND_MARGIN`) centred on the world. Since that box
    // already spans the whole ~12 km world, there's no texel-density gain from
    // following the camera — and a camera-following centre clamps toward a world
    // edge (leaving the far side unshadowed) and crawls. World-locking gives full
    // coverage and a static centre every frame; only the moving-sun crawl remains,
    // masked by the wider showcase PCF blur (`SHADOW_RADIUS_SHOWCASE`). Coarser
    // texels than the tight schema fit, but cinematic motion masks that.
    // (History: the fly cam previously used a forward-ray-to-ground + tHit-cap
    // fit to avoid the "shadow box pop" rect-fit caused at horizon-crossing
    // waypoints — see shadow_trace_2/3.json; world-locking subsumes that.)
    let half, center;
    let rectValid = false;
    if (renderCam === camera && controls) {
      _computeVisibleGroundSphere(renderCam);
      rectValid = _groundSphereValid;
      if (rectValid && _groundSphereRadius > NCZ.SHADOW_MAX_DISTANCE) {
        // View is larger than the shadow map can cover (zoomed out). Capping a box
        // centred on the visible footprint turns it into a camera-tracking slice
        // that leaves the rest of the world unshadowed — the "moving shadow box":
        // the footprint centroid even clamps to a world corner at extreme tilt.
        // Instead, cover the WHOLE WORLD from its centre. The world half-diagonal
        // (~8564 wu) is ≤ cap+margin, so a cap-sized box centred here reaches every
        // corner, and a fixed centre means it no longer tracks the camera.
        half = NCZ.SHADOW_MAX_DISTANCE + NCZ.SHADOW_GROUND_MARGIN;
        center = _shadowScratchV.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
      } else if (rectValid) {
        // View fits inside the cap (zoomed in): tight camera-fit, sharp + tracks
        // exactly what you see.
        half = _groundSphereRadius + NCZ.SHADOW_GROUND_MARGIN;
        center = _shadowScratchV.copy(_groundSphereCenter);
      } else {
        // Degenerate (shouldn't happen for the schema cam given controls.maxPolarAngle,
        // but the safety net stays). World-centered fallback at the cap.
        half = NCZ.SHADOW_MAX_DISTANCE + NCZ.SHADOW_GROUND_MARGIN;
        center = _shadowScratchV.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
      }
    } else {
      // External cam (showcase fly cam) — world-locked box, same as the schema
      // zoomed-out case above. The box is already cap-sized (half ≈ 9200 wu),
      // which spans the whole ~12 km world, so centring it on the camera buys no
      // texel-density gain — it only risks clamping toward a world edge (leaving
      // the far side unshadowed) and crawling as the cam moves. World-locking
      // gives full coverage every frame and a static centre (only the moving-sun
      // crawl remains, masked by SHADOW_RADIUS_SHOWCASE). This replaces the old
      // forward-ray-to-ground + tHit-cap fit, now redundant.
      half = NCZ.SHADOW_MAX_DISTANCE + NCZ.SHADOW_GROUND_MARGIN;
      center = _shadowScratchV.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    }
    // Clamp the centre to world bounds. The scene is finite (~12km × 12km);
    // nothing is rendered outside it, so a centre past the world edge wastes
    // half the shadow texture covering empty void. Three Z = -CET Y, so the
    // world Z range in three-space is [-WORLD_MAX_Y, -WORLD_MIN_Y].
    center.x = Math.max(NCZ.WORLD_MIN_X, Math.min(NCZ.WORLD_MAX_X, center.x));
    center.z = Math.max(-NCZ.WORLD_MAX_Y, Math.min(-NCZ.WORLD_MIN_Y, center.z));

    // Stabilisation (quantise size + texel-snap centre) — SCHEMA CAM ONLY.
    // Both steps assume a STATIC texel grid frame-to-frame: constant texelSize AND
    // a constant light-space basis. The interactive schema cam satisfies that (the
    // sun only moves on a slider drag). The showcase fly cam does NOT — flyover.js
    // arcs the sun every frame (setSunPosition), so the snap basis (built from
    // _sunDir) rotates continuously; combined with the fly cam's far forward-
    // projected centre near the horizon, a tiny basis rotation swings center·snapX
    // by several texels and the snapped centre jitters → worse flicker than no snap.
    // The fly cam keeps its prior fixed-box behaviour (constant half, raw centre);
    // its residual moving-sun shimmer is inherent aliasing (would want TAA), separate
    // from the schema swim this fix targets.
    if (renderCam === camera) {
      // Quantise the box size to a multiplicative ladder so texelSize is
      // piecewise-constant. The snap only cancels swim while texelSize holds; the
      // sphere fit already keeps `half` constant under pan/azimuth (congruent
      // footprint), but TILTING toward the horizon grows the footprint continuously
      // — without this the grid rescales every frame and edges shimmer despite the
      // snap. Rounding UP to the next rung holds the box across a slow tilt/zoom,
      // trading continuous swim for the odd resolution step. Capped at the diagonal.
      const rung = Math.log(half) / Math.log(NCZ.SHADOW_SIZE_QUANTUM);
      half = Math.min(
        Math.pow(NCZ.SHADOW_SIZE_QUANTUM, Math.ceil(rung)),
        NCZ.SHADOW_MAX_DISTANCE + NCZ.SHADOW_GROUND_MARGIN,
      );

      // Texel-snap the footprint centre to the sun's depth-map grid. The ortho box
      // covers 2·half world units across SHADOW_MAP_SIZE texels; if its centre
      // drifts by a fraction of a texel between frames, the same geometry
      // re-rasterises onto shifted texel centres and shadow edges crawl ("swim").
      // Project the centre onto the light's right/up axes, round each to a whole
      // texel, shift by the residual so the grid lands on the same world positions
      // every frame. Build the basis the way Three aims the shadow camera:
      //   z = (eye − target).normalize() = _sunDir,  x = (up × z)̂,  y = z × x.
      const texelSize = (2 * half) / NCZ.SHADOW_MAP_SIZE;
      _snapZ.copy(_sunDir);
      _snapX.crossVectors(_SHADOW_UP, _snapZ);
      if (_snapX.lengthSq() < 1e-8) _snapX.set(1, 0, 0); // sun ≈ straight up → degenerate basis
      _snapX.normalize();
      _snapY.crossVectors(_snapZ, _snapX).normalize();
      const px = center.dot(_snapX), py = center.dot(_snapY);
      center.addScaledVector(_snapX, Math.round(px / texelSize) * texelSize - px);
      center.addScaledVector(_snapY, Math.round(py / texelSize) * texelSize - py);
    }

    // Capture fit for getShadowSnapshot trace.
    _lastShadowFit.half = half;
    _lastShadowFit.cx = center.x;
    _lastShadowFit.cz = center.z;
    _lastShadowFit.fallback = !rectValid && renderCam === camera;
    _lastShadowFit.lastUpdateMs = performance.now();

    shadowCam.left = -half; shadowCam.right = half;
    shadowCam.top  =  half; shadowCam.bottom = -half;
    shadowCam.near = NCZ.SHADOW_CAM_NEAR;
    shadowCam.far  = NCZ.SHADOW_CAM_FAR;
    shadowCam.updateProjectionMatrix();
    // Normal-bias the receiver samples by a few shadow texels' worth of world
    // units — scaled with the footprint so it's the same texel offset at every
    // zoom (a constant world bias is too small zoomed out → grazing-sun acne
    // ["the wave" on flat terrain/water], too large zoomed in → shadows detach).
    _dirLight.shadow.normalBias = NCZ.SHADOW_NORMAL_BIAS_TEXELS * (2 * half / NCZ.SHADOW_MAP_SIZE);

    // Soften the edge for the showcase fly cam. It can't texel-snap (arcing sun →
    // no frame-coherent grid), so a wider PCF blur hides its moving-sun edge-crawl;
    // the schema cam stays crisp. A uniform-width blur, not physical penumbra.
    _dirLight.shadow.radius = (renderCam === camera) ? NCZ.SHADOW_RADIUS : NCZ.SHADOW_RADIUS_SHOWCASE;

    // Keep the sun light SUN_DIST up the sun ray from the footprint centre.
    // Orthographic ⇒ only the direction matters for shading; the distance just
    // places the shadow camera comfortably above the footprint so nothing clips.
    // Three copies these into the shadow camera during the shadow pass.
    _dirLight.target.position.copy(center);
    _dirLight.position.copy(center).addScaledVector(_sunDir, NCZ.SUN_DIST);

    // Refresh the shadow-camera frustum planes that the union cull reads —
    // off-screen casters still inside this box need to make it into the
    // building indirect-draw buffer so their shadows land in view.
    updateShadowFrustumUniforms();

    flagShadowUpdate();  // shadow camera/footprint moved ⇒ re-render the depth map next frame (no-op while shadows off)
  }

  // Single chokepoint for "the shadow silhouette changed — re-render the depth map
  // next frame." Under WebGPURenderer the shadow pass is gated by
  // light.shadow.needsUpdate (autoUpdate is held false at init), so this is the only
  // thing that schedules a shadow render. Gated on _shadowsOn: while the Shadows
  // overlay is off we never flag, so ShadowNode.updateBefore() early-returns and the
  // 4096² depth pass is skipped entirely. Call it wherever a shadow CASTER or the
  // sun/shadow-camera moves — updateShadowCamera (camera/resize/terrain/flyover/
  // re-enable), setSunPosition, async caster loads (buildings, landmarks). NOT on
  // theme/colour changes: shadow depth is geometry-only, so those frames skip it.
  function flagShadowUpdate() {
    if (_shadowsOn && _dirLight) _dirLight.shadow.needsUpdate = true;
  }

  function setShadowsEnabled(enabled) {
    _shadowsOn = enabled;
    // Genuinely SKIP the shadow depth pass when off — not just dim it — without
    // tearing down the depth texture (toggling castShadow / renderer.shadowMap.
    // enabled does that and crashes WebGPURenderer: "Cannot read properties of
    // null (reading 'depthTexture')").
    //
    // We hold _dirLight.shadow.autoUpdate = false permanently (init) and drive
    // re-renders through flagShadowUpdate(), which no-ops while _shadowsOn is false.
    // So turning shadows off is just "stop flagging + drop any pending flag":
    // ShadowNode.updateBefore() then early-returns every frame and updateShadow()
    // never runs. The depthTexture stays intact (sampled at intensity 0 → no visual,
    // no recompile, no crash).
    //
    // Two more savings while off: intensity 0 zeroes residual sampling so the look is
    // correct immediately, and updateShadowFrustumUniforms poisons the cull's shadow
    // frustum so off-screen casters stop being drawn into the main pass.
    if (_dirLight) {
      _dirLight.shadow.intensity = enabled ? _shadowIntensity : 0;
      if (!enabled) _dirLight.shadow.needsUpdate = false;  // drop any pending re-render so the pass truly stops
    }
    if (enabled && renderer) {
      updateShadowCamera();          // refit + restore the real shadow frustum (un-poison) + flagShadowUpdate → renders next frame
    } else {
      updateShadowFrustumUniforms(); // poison the cull frustum now, don't wait for a camera move
    }
    requestRender();
  }

  function getShadowsEnabled() { return _shadowsOn; }
  function getSunElevation() { return _sunEl; }

  // Exposure setter — driven by the time-of-day curve (applySunTime /
  // updateFlyoverSun) and the metering harness.
  function setSceneExposure(v)    { if (renderer)   renderer.toneMappingExposure = v; requestRender(); }
  function getLightingState() {
    return {
      sun:      _dirLight  ? _dirLight.intensity         : null,
      ambient:  _hemiLight ? _hemiLight.intensity        : null,
      exposure: renderer   ? renderer.toneMappingExposure : null,
      // Stored, not live — the live value goes to 0 when the Shadows overlay
      // is off; this returns the tuned strength regardless of on/off state.
      shadow:   _shadowIntensity,
    };
  }

  // Comprehensive shadow + lighting state snapshot for the `__shadowTrace`
  // debug logger (set NCZ.__shadowTrace = true to enable per-frame logging
  // in flyover.js). Captures everything that could explain "shadows turn
  // off at some waypoints": light pose, shadow camera bounds, fit state,
  // renderer flags, hemisphere fill — so a post-mortem of the trace can
  // disambiguate any failure mode without re-instrumenting.
  function getShadowSnapshot() {
    if (!_dirLight || !renderer) return null;
    const sc = _dirLight.shadow?.camera;
    return {
      sun: {
        pos:    _dirLight.position.toArray().map(v => Math.round(v)),
        tar:    _dirLight.target.position.toArray().map(v => Math.round(v)),
        dir:    _sunDir.toArray().map(v => +v.toFixed(3)),
        elDeg:  +(_sunEl * 180 / Math.PI).toFixed(1),
        intens: +_dirLight.intensity.toFixed(2),
        color:  _dirLight.color.getHexString(),
      },
      shadow: {
        cast:    _dirLight.castShadow,
        intens:  +_dirLight.shadow.intensity.toFixed(2),
        mapSize: _dirLight.shadow.mapSize.toArray(),
        bias:    _dirLight.shadow.bias,
        nBias:   +_dirLight.shadow.normalBias.toFixed(2),
        cam: sc ? {
          lrtb: [Math.round(sc.left), Math.round(sc.right), Math.round(sc.top), Math.round(sc.bottom)],
          nf:   [Math.round(sc.near), Math.round(sc.far)],
        } : null,
      },
      fit: {
        half:     Math.round(_lastShadowFit.half),
        center:   [Math.round(_lastShadowFit.cx), Math.round(_lastShadowFit.cz)],
        fallback: _lastShadowFit.fallback,
        ageMs:    Math.round(performance.now() - _lastShadowFit.lastUpdateMs),
      },
      rend: {
        smEnabled:    renderer.shadowMap.enabled,
        smType:       renderer.shadowMap.type,
        // Real WebGPU shadow-pass gate lives on the light, not renderer.shadowMap
        // (whose autoUpdate/needsUpdate are inert here). autoUpdate is held false;
        // needsUpdate true means a re-render is queued for the next frame.
        lightAutoUpd:  _dirLight.shadow.autoUpdate,
        lightNeedsUpd: _dirLight.shadow.needsUpdate,
      },
      hemi: _hemiLight ? {
        intens: +_hemiLight.intensity.toFixed(2),
        sky:    _hemiLight.color.getHexString(),
        ground: _hemiLight.groundColor?.getHexString?.(),
      } : null,
    };
  }

  function getLayerVisibility(name) {
    if (name === 'shadows') return _shadowsOn;
    if (name === 'pins')    return NCZ.ThreeMarkers?.getOverlayVisible?.() ?? null;
    return layers[name]?.visible ?? null;
  }

  // Has init() run? app.js uses this to let the E5 intro own the *first* SCHEMA
  // entry (skip view-sync) while syncing on every later toggle.
  function isInitialized() {
    return initialized;
  }

  // ── View-sync with the 2D Leaflet map ──────────────────────────────────
  // Read the current camera as an equivalent Leaflet centre + zoom (for the
  // SCHEMA→SAT switch). Ground target → CET → Leaflet; distance → zoom via the
  // shared horizontal-extent transform. Returns null if the scene isn't built.
  function getLeafletView({ leafletPxW }) {
    if (!controls || !camera) return null;
    const cetX = controls.target.x;
    const cetY = -controls.target.z;          // inverse of cetToThree
    const distance = camera.position.distanceTo(controls.target);
    const { lat, lng, zoom } = NCZ.cameraExtentToLeafletView({
      cetX, cetY, distance, aspect3d: camera.aspect, fov: camera.fov, leafletPxW,
    });
    return { center: [lat, lng], zoom };
  }

  // Frame a Leaflet centre + zoom in the 3D camera (for the SAT→SCHEMA switch).
  // Preserves the user's current azimuth/tilt — only the ground target and the
  // along-view distance move, so heading/tilt carry across the switch. Kept
  // separate from setCameraState (which restores an absolute stored pose +
  // sun state); this *derives* the pose from preserved θ/φ + computed distance.
  function frameLeafletView({ center, zoom, leafletPxW }) {
    if (!controls || !camera) return;
    const { cetX, cetY, distance } = NCZ.leafletViewToCameraExtent({
      centerLat: center[0], centerLng: center[1], zoom,
      leafletPxW, aspect3d: camera.aspect, fov: camera.fov,
    });
    const d = NCZ.clamp(distance, controls.minDistance, controls.maxDistance);
    const theta = controls.getAzimuthalAngle();
    const phi   = controls.getPolarAngle();
    const target = new THREE.Vector3(cetX, 0, -cetY);
    const position = new THREE.Vector3(
      target.x + d * Math.sin(phi) * Math.sin(theta),
      target.y + d * Math.cos(phi),
      target.z + d * Math.sin(phi) * Math.cos(theta),
    );
    // Cancel any in-flight intro fly-in so it doesn't fight the framing.
    if (_introTween) { _introTween = null; setContinuousRender(false); }
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    requestRender();
  }

  function getCameraState() {
    if (!controls || !camera) return null;
    return {
      target:    controls.target.toArray(),
      position:  camera.position.toArray(),
      polar:     controls.getPolarAngle(),
      azimuth:   controls.getAzimuthalAngle(),
      sunAz:     _sunAz,
      sunEl:     _sunEl,
      sunSlider: document.getElementById('scene-sun-slider')?.value ?? null,
    };
  }

  function setCameraState(s) {
    if (!controls || !camera) return;
    controls.target.fromArray(s.target);
    camera.position.fromArray(s.position);
    controls.update();
    camera.updateProjectionMatrix();
    if (s.sunAz !== undefined) setSunPosition(s.sunAz, s.sunEl);
    // Restore sun slider so the UI reflects the saved position
    if (s.sunSlider !== null && s.sunSlider !== undefined) {
      const slider = document.getElementById('scene-sun-slider');
      if (slider) { slider.value = s.sunSlider; slider.dispatchEvent(new Event('input')); }
    }
    requestRender();
  }

  return { init, startRenderLoop, stopRenderLoop, requestRender, setContinuousRender, setFlyoverFrame, setResizeSuppressed, forceDistrictBand, resetCamera, setLayerVisibility, getLayerVisibility, updateMaterials, renderFrame, setControlsEnabled, getCanvasElement, captureColors, transitionMaterials, transitionToColors, setSunPosition, setShadowsEnabled, getShadowsEnabled, setSceneExposure, getLightingState, getSunElevation, setGradeEnabled, getGradeEnabled, setEdgeGlowEnabled, getEdgeGlowEnabled, setSunSphereVisible, getShadowSnapshot, getCameraState, setCameraState, isInitialized, getLeafletView, frameLeafletView, getSceneColorVars, getRenderInfo, getCullCounts, setOverrideMaterial, dumpDebugInfo, isWebGPUActive };
})();

window.NCZ.ThreeScene = ThreeScene;
