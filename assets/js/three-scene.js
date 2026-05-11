/**
 * NC Zoning Board — Three.js Scene
 * Namespace: NCZ.ThreeScene
 *
 * Manages the WebGL renderer, orthographic camera, OrbitControls,
 * GLB loading (tiered), lighting, and render loop for the schematic 3D view.
 *
 * Camera/coordinate notes (derived from render_terrain_3d.html):
 *   GLB space: X = CET_X, Y = height, Z = -CET_Y
 *   Camera sits high on Y, looks down, up vector = (0, 0, -1) so north faces up.
 *   Cliffs GLB requires a position offset: (-2255, 0, 3050).
 */

import * as THREE from 'three';
import {
  attribute, uniform, texture, positionWorld, positionLocal, normalLocal,
  transformNormal, transformNormalToView, uv, vec2, vec4, float, materialColor,
  instancedArray, instanceIndex,
  // Phase 2B compute culling
  Fn, If, storage, struct, atomicStore, atomicAdd, uint,
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
import Stats from 'three/addons/libs/stats.module.js';

window.NCZ = window.NCZ || {};

// Default sun direction (unit, points from the ground toward the sun) until the
// real SunCalc-driven position arrives via setSunPosition.
const SUN_DIR = new THREE.Vector3(-1, 1.5, -1).normalize();
const _GROUND_NORMAL = new THREE.Vector3(0, 1, 0);
// Hemisphere-fill sky colour, lerped by sun elevation: hazy cool daylight when
// high, warm hazy when low (the real sky scatters orange at golden hour too).
const SKY_NOON    = new THREE.Color(0x8a96a6);
const SKY_HORIZON = new THREE.Color(0xc9a878);

const ThreeScene = (() => {
  let renderer, camera, scene, controls;
  let animationId = null;
  let initialized = false;
  let loadingEl      = null;
  let loadingFillEl  = null;
  let loadStepsTotal = 0;
  let loadStepsDone  = 0;
  let _dirLight      = null; // the sun (DirectionalLight + single fitted shadow camera)
  let _hemiLight     = null; // sky/ground fill (replaces a flat AmbientLight)
  let _sunDir        = SUN_DIR.clone(); // unit, ground→sun; updated by setSunPosition, consumed by updateShadowCamera
  let _shadowGroundCenter = new THREE.Vector3(); // world point the shadow camera is centred on (the visible-ground centre)
  let _shadowScratchV = new THREE.Vector3();     // reused by updateShadowCamera so it doesn't allocate per camera move
  let _shadowsOn     = true;  // shadows on by default; checkbox reflects this via poll
  let _sunSphere     = null; // visible sun disc — shown during showcase only
  let _sunAz = Math.PI * 0.25, _sunEl = Math.PI * 0.35; // last setSunPosition args
  let _terrainBox = null;     // THREE.Box3 of the terrain GLB; gates pan-bound clamp
                              // because the bound shouldn't activate before terrain loads

  // Material refs — stored so updateMaterials() can re-apply theme colors live
  let terrainMat = null;
  let waterMat   = null;
  let cliffsMat  = null;
  let roadsMat        = null;  // SeeThrough pass (water stencil)
  let bordersMat      = null;  // SeeThrough pass (water stencil)
  let normalRoadsMat  = null;  // Normal depth-tested pass
  let normalBordersMat= null;  // Normal depth-tested pass
  let metroMat        = null;
  let metroZoomUniform = null; // TSL uniform() node — mutated from controls 'change'
  // Captured at WebGPURenderer construction so dumpDebugInfo can introspect
  // the antialias flag — WebGPURenderer has no getContextAttributes() to read it
  // back from, unlike WebGLRenderer.
  let _rendererInitParams = null;

  // ── Phase 2B compute culling state ─────────────────────────────────────
  // Six camera-frustum planes shared by every district's cull compute. We
  // recompute them on every `controls.change` (CPU-side, via Three's
  // existing `THREE.Frustum.setFromProjectionMatrix`) and push to the same
  // 6 uniform nodes — much cheaper than packing/passing the projection×view
  // matrix and re-deriving planes per-thread on the GPU. Each plane is a
  // vec4 packing `(normal.xyz, constant)`; the visibility test is
  //   `dot(plane.xyz, center) + plane.w >= -radius`.
  const _frustumPlaneUniforms = [
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
    uniform(new THREE.Vector4()), uniform(new THREE.Vector4()),
  ];
  const _frustumScratch = new THREE.Frustum();
  const _frustumScratchMat = new THREE.Matrix4();
  // Per-district compute nodes (reset + cull) registered during loadBuildings.
  // Dispatched in pairs from `renderLoop` before `renderer.render`.
  const _cullComputes = [];

  function updateFrustumUniforms() {
    if (!camera) return;
    _frustumScratchMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
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
  let buildingMeshes     = [];    // one InstancedMesh per district
  let buildingMaterials  = [];    // parallel ShaderMaterial array for theme updates
  let landmarkMat        = null;  // shared MeshLambertMaterial for all landmark GLBs

  // District metadata — sourced directly from 3dmap_triangle_soup.Material.json.
  // dataDds: _data.dds (DXGI_FORMAT_R16G16B16A16_UNORM — raw 16-bit RGBA instance data)
  // mDds:    _m.dds   (DXGI_FORMAT_R8_UNORM — 8-bit greyscale surface detail, 10 mips)
  // transMin/transMax: district-local CET XYZ bounds (before district offset)
  // offset: world XY offset applied to decoded positions (no Z offset)
  // cubeSize: half-extent multiplier (from CubeSize shader parameter)
  const DISTRICT_META = [
    { name: 'westbrook',     dataDds: 'assets/dds/westbrook_data.dds',    mDds: 'assets/dds/westbrook_m.dds',    cubeSize: 197.0,        transMin: [-1078.94739, -1148.69434, -18.4205875],  transMax: [1155.12,      1562.87903,  507.894714],  offset: [  -97.209,    590.849] },
    { name: 'city_center',   dataDds: 'assets/dds/city_center_data.dds',  mDds: 'assets/dds/city_center_m.dds',  cubeSize: 168.289993,   transMin: [ -770.609192, -530.549133, -40.6581497],  transMax: [1316.82483,    649.75531,  642.893127],  offset: [-2116.637,    106.508] },
    { name: 'heywood',       dataDds: 'assets/dds/heywood_data.dds',      mDds: 'assets/dds/heywood_m.dds',      cubeSize: 197.236832,   transMin: [-1080.35107,  -418.153046, -38.4002304],  transMax: [1136.94556,   1372.15979,  374.181305],  offset: [-1576.732,  -1002.811] },
    { name: 'pacifica',      dataDds: 'assets/dds/pacifica_data.dds',     mDds: 'assets/dds/pacifica_m.dds',     cubeSize: 305.600006,   transMin: [-4008.396,   -4575.14941, -51.9539986],  transMax: [8258.31641,   7254.10059,  264.306946],  offset: [-2422.441,  -2368.156] },
    { name: 'santo_domingo', dataDds: 'assets/dds/santo_domingo_data.dds',mDds: 'assets/dds/santo_domingo_m.dds',cubeSize: 139.342102,   transMin: [-1328.95288, -1880.02502, -37.5960007],  transMax: [1555.26318,   1369.01294,  332.348328],  offset: [  -15.944,  -1610.080] },
    { name: 'watson',        dataDds: 'assets/dds/watson_data.dds',       mDds: 'assets/dds/watson_m.dds',       cubeSize: 237.175003,   transMin: [-1254.46997, -1258.68469, -24.7028503],  transMax: [1988.5448,    2032.52405,  475.268005],  offset: [-1979.372,   1873.951] },
    { name: 'ep1_dogtown',   dataDds: 'assets/dds/dogtown_data.dds',      mDds: 'assets/dds/dogtown_m.dds',      cubeSize: 198.020691,   transMin: [-2650.0,     -3126.6084,   -0.750015974], transMax: [-1025.51855, -1803.58118,  493.576111],  offset: [    0.0,        0.0  ] },
    { name: 'ep1_spaceport', dataDds: 'assets/dds/spaceport_data.dds',    mDds: 'assets/dds/spaceport_m.dds',    cubeSize: 115.298218,   transMin: [-1168.5874,   -765.104614, -41.4592323],  transMax: [1219.45483,   1018.70129,  296.498138],  offset: [-4200.000,    200.000] },
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

  // Derive edge highlight colour from the building base colour.

  function makeHillshadeMaterial(colorVar, fallback, extra = {}) {
    return new THREE.MeshLambertNodeMaterial({
      color: readThemeColor(colorVar, fallback),
      flatShading: true,
      side: THREE.DoubleSide,
      ...extra,
    });
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

  // ── Scene init ─────────────────────────────────────────────────────────

  async function init(containerId) {
    if (initialized) return;
    initialized = true;

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
    _rendererInitParams = {
      antialias: true,
      stencil: true,
      reversedDepthBuffer: true,
      // requiredLimits: tell the WebGPU adapter we need to read storage
      // buffers from the vertex stage (default is 0). Buildings use an
      // `instancedArray` storage buffer to fetch per-instance matrices
      // directly in the vertex shader — without this, the first draw call
      // throws a binding-visibility validation error.
      requiredLimits: {
        maxStorageBuffersInVertexStage: 1,
      },
    };
    renderer = new THREE.WebGPURenderer(_rendererInitParams);
    await renderer.init();   // WebGPURenderer requires async init before any use
    // Make the sRGB-correct colour pipeline explicit. These match Three.js r170
    // defaults (since r152 / r155 respectively) but stating them here protects
    // the scene's appearance against future Three.js default changes — both flags
    // have shifted in past major versions.
    THREE.ColorManagement.enabled = true;
    renderer.outputColorSpace     = THREE.SRGBColorSpace;
    // Cap effective DPR — see NCZ.MAX_DEVICE_PIXEL_RATIO. The debug-dump
    // "Renderer DPR" line shows the capped value; "Display ... DPR" still shows
    // the raw window.devicePixelRatio, so the two diverge for capped users.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, NCZ.MAX_DEVICE_PIXEL_RATIO));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    // Render-on-demand already decides *whether* a frame renders; this decides
    // whether the shadow map re-renders within a frame. updateShadowCamera()
    // (camera moved) and setSunPosition() (sun moved) raise needsUpdate; renders
    // that change nothing geometric (theme tweens, pin hover) skip the shadow pass.
    renderer.shadowMap.autoUpdate = false;
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

    // Orthographic camera — frustum updated after terrain loads
    const aspect = container.clientWidth / container.clientHeight;
    const frustumH = NCZ.WORLD_H / 2;
    camera = new THREE.OrthographicCamera(
      -frustumH * aspect, frustumH * aspect,
       frustumH, -frustumH,
      NCZ.CAMERA_NEAR, NCZ.CAMERA_FAR
    );
    camera.name = 'schema-camera';
    // Positioned above world centre, looking straight down.
    // Z = -WORLD_CY because GLB_Z = -CET_Y.
    camera.position.set(NCZ.WORLD_CX, NCZ.CAMERA_HEIGHT, -NCZ.WORLD_CY);
    camera.lookAt(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    camera.up.set(0, 1, 0);  // Standard Three.js up vector
    camera.updateProjectionMatrix();

    // ── Lighting: outdoor model — directional sun + hemisphere fill ──
    // The sun: a DirectionalLight whose direction tracks the real Morro Bay sun
    // (SunCalc, via setSunPosition; default NW hillshade until then). One shadow
    // map, an OrthographicCamera fitted each move to exactly the visible-ground
    // footprint (updateShadowCamera) — no cascades: for a top-down ortho camera
    // there's no perspective near/far disparity to split, so a single tight map
    // beats CSM and is far simpler. castShadow stays on permanently; the
    // "shadows" layer toggle flips shadow *intensity* (toggling castShadow on a
    // live light tears its depth texture down mid-frame and crashes WebGPURenderer).
    _dirLight = new THREE.DirectionalLight(0xffffff, 1.0 - NCZ.AMBIENT_INTENSITY);
    _dirLight.name = 'sun';
    _dirLight.castShadow         = true;
    _dirLight.shadow.mapSize.set(NCZ.SHADOW_MAP_SIZE, NCZ.SHADOW_MAP_SIZE);
    _dirLight.shadow.camera.near = NCZ.SHADOW_CAM_NEAR;
    _dirLight.shadow.camera.far  = NCZ.SHADOW_CAM_FAR; // orthographic ⇒ a wide range costs no precision
    _dirLight.shadow.camera.name = 'sun-shadow-cam';
    _dirLight.shadow.bias        = NCZ.SHADOW_BIAS;        // 0 — native depth32float + reverse-Z need no depth cushion
    // normalBias is set per-frame by updateShadowCamera (scaled with the footprint).
    _dirLight.shadow.intensity   = _shadowsOn ? 1 : 0;
    _dirLight.target.name = 'sun-target';
    // Position the light + target are set by updateShadowCamera (it centres the
    // shadow on the visible ground); seed them at the world centre so the first
    // frame before that runs isn't degenerate.
    _dirLight.target.position.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    _dirLight.position.copy(_dirLight.target.position).addScaledVector(_sunDir, NCZ.SUN_DIST);
    scene.add(_dirLight);
    scene.add(_dirLight.target);

    // Hemisphere fill — sky-colour from above (hazy cool daylight), darker
    // ground-colour bounce from below. Reads more like an outdoor scene than a
    // flat AmbientLight: building tops catch the sky, sides get a 50/50 mix →
    // subtle face-to-face contrast for free. Intensity tracks the day in setSunPosition.
    _hemiLight = new THREE.HemisphereLight(0x8a96a6, 0x1c2128, NCZ.AMBIENT_INTENSITY);
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

    // OrbitControls — left=pan, right=tilt, middle=zoom
    controls = new OrbitControls(camera, renderer.domElement);
    controls.mouseButtons = {
      LEFT:   THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT:  THREE.MOUSE.ROTATE,
    };
    controls.minPolarAngle  = NCZ.CAMERA_MIN_TILT;
    controls.maxPolarAngle  = NCZ.CAMERA_MAX_TILT;
    controls.dampingFactor  = NCZ.CAMERA_DAMPING;
    controls.minZoom        = NCZ.CAMERA_ZOOM_MIN;
    controls.maxZoom        = NCZ.CAMERA_ZOOM_MAX;
    controls.zoomSpeed      = NCZ.CAMERA_ZOOM_SPEED;
    controls.panSpeed       = NCZ.CAMERA_PAN_SPEED;
    controls.rotateSpeed    = NCZ.CAMERA_ROTATE_SPEED;
    controls.enableDamping  = true;
    controls.screenSpacePanning = true;
    controls.target.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    controls.update();
    updateFrustumUniforms();   // seed frustum planes for the first cull dispatch
    updateShadowCamera();      // seed the shadow camera from the initial pose
    controls.addEventListener('change', () => {
      updateDistrictZoom();
      if (metroZoomUniform) metroZoomUniform.value = camera.zoom;
      updateShadowCamera();
      updateFrustumUniforms();   // Phase 2B: refresh the 6 cull-frustum planes
      updateScaleBar();
      requestRender();
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
      if (!_terrainBox) return;  // terrain not loaded yet — no bound to clamp against
      const t = controls.target;
      const f = NCZ.PIN_3D_PAN_EDGE_FRACTION;
      const Vx = (camera.right - camera.left) / camera.zoom;
      const Vz = (camera.top - camera.bottom) / camera.zoom;
      const offsetX = (f - 0.5) * Vx;
      const offsetZ = (f - 0.5) * Vz;
      const xMin = _terrainBox.min.x - offsetX;
      const xMax = _terrainBox.max.x + offsetX;
      const zMin = _terrainBox.min.z - offsetZ;
      const zMax = _terrainBox.max.z + offsetZ;
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

  function onResize() {
    if (!renderer) return;
    const container = renderer.domElement.parentElement;
    if (!container || container.style.display === 'none') return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false); // updateStyle:false — CSS width/height stay at 100%
    const aspect = w / h;
    const frustumH = (camera.top - camera.bottom) / 2;
    camera.left   = -frustumH * aspect;
    camera.right  =  frustumH * aspect;
    camera.updateProjectionMatrix();
    updateShadowCamera();   // shadow camera follows the schema camera's aspect
    // flyCamera resize is handled in flyover.js
    // Line2NodeMaterial pulls viewport size from a TSL screen node at
    // shader-execution time, so the legacy resolution-set loop is no longer
    // needed here — left as a single retained `districtLineMaterials` ref so
    // the registry still exists for any future per-material resize work.
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
  let _districtOuter = null; // districts with subs — visible when zoomed OUT
  let _districtSub   = null; // canonical subdistricts — visible when zoomed IN

  function setLayerVisibility(name, visible) {
    if (name === 'districts') {
      if (layers.districts) layers.districts.visible = visible;
      if (visible) updateDistrictZoom();
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

  function updateDistrictZoom() {
    if (!_districtOuter || !_districtSub) return;
    const zoomedIn = camera.zoom > NCZ.SUBDISTRICT_ZOOM_3D;
    _districtOuter.visible = !zoomedIn;
    _districtSub.visible   =  zoomedIn;
  }

  // ── Scale bar ───────────────────────────────────────────────────────
  // Mirrors Leaflet's L.control.scale: pick a "nice" round length (1, 2, or
  // 5 × 10ⁿ metres) closest to PIN_3D_SCALE_TARGET_PX wide on screen, render
  // a horizontal bar of that pixel width, label it. CET unit ≈ metre, so no
  // unit conversion needed beyond CET_UNITS_PER_METER (default 1).
  //
  // Computed from camera frustum width: metres-per-pixel along the screen-X
  // axis = (camera.right - camera.left) / camera.zoom / canvas_pixel_width.
  // Screen-X is parallel to the ground regardless of tilt (camera right
  // vector stays in the world XZ plane for our orthographic top-down + tilt
  // setup), so the bar reads true even when the camera is tilted.
  function updateScaleBar() {
    if (!camera || !renderer) return;
    const el = document.querySelector('#scene-scale .leaflet-control-scale-line');
    if (!el) return;
    const canvasWidth = renderer.domElement.clientWidth;
    if (!canvasWidth) return;
    const worldPerPixel = (camera.right - camera.left) / (camera.zoom * canvasWidth);
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

      terrainMat = makeHillshadeMaterial('--scene-terrain', '#566c88');
      // Water writes stencil=2 — SeeThrough roads only render where stencil==2 (Pacifica tunnel)
      waterMat   = makeHillshadeMaterial('--scene-water', '#2a3f57', {
        stencilWrite: true, stencilRef: 2,
        stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      });
      cliffsMat  = makeHillshadeMaterial('--scene-cliffs',   '#566c88');
      applyMaterial(terrainScene, terrainMat);
      applyMaterial(waterScene,   waterMat);
      applyMaterial(cliffsScene,  cliffsMat);

      // Shadow flags — terrain and cliffs cast and receive (hills shadow valleys);
      // water receives only (no hard shadow edges on flat ocean); buildings skipped.
      terrainScene.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; c.frustumCulled = false; } });
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
      _terrainBox = box;
      fitCameraToBox(box);

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
        .then(hideLoading);

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

      // Normal depth-tested pass — surface roads/borders sit correctly in scene
      normalRoadsMat   = new THREE.MeshBasicNodeMaterial({ color: roadColor,   transparent: true, opacity: 0.8 });
      normalBordersMat = new THREE.MeshBasicNodeMaterial({ color: borderColor, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });

      applyMaterial(roadsScene,   normalRoadsMat);
      applyMaterial(bordersScene, normalBordersMat);

      // Metro: normal depth-tested, renderOrder=1 so it renders above roads.
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
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      metroZoomUniform        = uniform(camera.zoom);
      const uMetroLODMed_node  = uniform(NCZ.METRO_LOD_ZOOM_MED);
      const uMetroLODNear_node = uniform(NCZ.METRO_LOD_ZOOM_NEAR);
      const lodColor = attribute('color');
      const discardCondition =
        lodColor.b.greaterThan(0.5).and(metroZoomUniform.greaterThan(uMetroLODMed_node))
          .or(
            lodColor.g.greaterThan(0.5).and(
              metroZoomUniform.lessThan(uMetroLODMed_node).or(metroZoomUniform.greaterThan(uMetroLODNear_node))
            )
          )
          .or(
            lodColor.r.greaterThan(0.5).and(metroZoomUniform.lessThan(uMetroLODNear_node))
          );
      metroMat.maskNode = discardCondition.not();

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

      // SeeThrough pass: depthTest:false + stencil=EQUAL(2) → only renders where water is above road
      // Pacifica tunnel: water writes stencil=2 → tunnel visible ✓
      // Mountain roads: terrain has no stencil=2 → hidden ✓
      // Buildings: stencil=1 ≠ 2 → hidden ✓
      const stBase = {
        transparent: true, depthTest: false, depthWrite: false,
        stencilWrite: true, stencilWriteMask: 0x00,
        stencilFunc: THREE.EqualStencilFunc, stencilRef: 2, stencilFuncMask: 0xff,
        stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
      };
      roadsMat   = new THREE.MeshBasicNodeMaterial({ ...stBase, color: roadColor,   opacity: 0.8 });
      bordersMat = new THREE.MeshBasicNodeMaterial({ ...stBase, color: borderColor, opacity: 0.6, blending: THREE.AdditiveBlending });

      applyMaterial(metroScene, metroMat);

      const stRoads   = makeSeeThrough(roadsScene,  roadsMat);
      const stBorders = makeSeeThrough(bordersScene, bordersMat);
      stRoads.name    = 'roads-seethrough';
      stBorders.name  = 'road-borders-seethrough';
      nameSubtree(stRoads,   'road-st');
      nameSubtree(stBorders, 'road-border-st');
      stRoads.traverse(o => { if (o.isMesh) o.renderOrder = 1; });
      stBorders.traverse(o => { if (o.isMesh) o.renderOrder = 1; });

      const roadsGroup = new THREE.Group();
      roadsGroup.name = 'roads';
      roadsGroup.add(roadsScene, bordersScene, stRoads, stBorders);
      metroScene.traverse(o => { if (o.isMesh) o.renderOrder = 2; });

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

      for (const dist of data.districts) {
        const color = new THREE.Color(window.NCZ.DISTRICT_COLORS[dist.id] || '#ffffff');
        const canonicalSubs = (dist.subdistricts || []).filter(s => s.canonical !== false);
        const hasSubs = canonicalSubs.length > 0;

        // District outline — always group if no canonical subs, outer group otherwise
        if (dist.polygon?.length) {
          const line = buildLine(dist.polygon, color, window.NCZ.DISTRICT_LINE_WIDTH);
          line.name = `district-outline-${dist.id}`;
          (hasSubs ? outerGroup : alwaysGroup).add(line);
        }

        for (const sub of dist.subdistricts || []) {
          if (!sub.polygon?.length) continue;
          const line = buildLine(sub.polygon, color, window.NCZ.SUBDISTRICT_LINE_WIDTH);
          line.name = `subdistrict-outline-${dist.id}/${sub.id}`;
          if (sub.canonical === false) {
            alwaysGroup.add(line); // casino etc — always visible
          } else {
            subGroup.add(line);    // zoom-gated
          }
        }
      }

      // Wrap all three in a parent so districts toggle works as a unit
      const parent = new THREE.Group();
      parent.name = 'districts';
      parent.add(alwaysGroup, outerGroup, subGroup);
      subGroup.visible  = false;
      outerGroup.visible = true;

      _districtOuter = outerGroup;
      _districtSub   = subGroup;
      layers.districts = parent;
      scene.add(parent);
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
        color: readThemeColor('--scene-buildings', '#8aacbf'),
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

      for (const meta of DISTRICT_META) {
        setLoadingText(`Loading buildings [${meta.name}]…`);

        // ── _data.dds → CPU decode → packed Float32Array of mat4s ─────
        const { pixels, width: texW, height: texH } = await loadDataDds(meta.dataDds);
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

            if (pixels[pi + 3] < NCZ.DDS_ALPHA_THRESH) continue;  // alpha < ~1% → invalid slot

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
        // tests its instance's bounding sphere against the 6 frustum planes;
        // visible instances atomically append their original index to the
        // visibleIndices buffer.
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

          // Visibility = inside (or straddling) every plane.
          // dist = dot(plane.xyz, center) + plane.w
          // visible plane test: dist >= -radius
          const distP0 = _frustumPlaneUniforms[0].dot(c4);
          const distP1 = _frustumPlaneUniforms[1].dot(c4);
          const distP2 = _frustumPlaneUniforms[2].dot(c4);
          const distP3 = _frustumPlaneUniforms[3].dot(c4);
          const distP4 = _frustumPlaneUniforms[4].dot(c4);
          const distP5 = _frustumPlaneUniforms[5].dot(c4);
          const visible =
            distP0.greaterThanEqual(negRadius)
              .and(distP1.greaterThanEqual(negRadius))
              .and(distP2.greaterThanEqual(negRadius))
              .and(distP3.greaterThanEqual(negRadius))
              .and(distP4.greaterThanEqual(negRadius))
              .and(distP5.greaterThanEqual(negRadius));

          If(visible, () => {
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
        // Write stencil=1 so SeeThrough roads are blocked where buildings are
        mat.stencilWrite = true;
        mat.stencilRef   = 1;
        mat.stencilFunc  = THREE.AlwaysStencilFunc;
        mat.stencilZPass = THREE.ReplaceStencilOp;
        mat.needsUpdate  = true;
        buildingMaterials.push(mat);
        stepProgress(); // one building district done
        console.log(`[NCZ] Buildings [${meta.name}]: ${validCount.toLocaleString()} instances`);
      }

      layers.buildings = group;
      scene.add(group);
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
  //   2. Edge highlight (post-lighting, via `emissiveNode`)
  //      Original GLSL hook: `outgoingLight = mix(outgoingLight, edgeColor, ef)`
  //      WebGPU has no user-facing post-lighting hook (NodeMaterial's
  //      `outgoingLightNode` is a builder-local). `emissiveNode` is the closest
  //      idiomatic fit — emissive is added to the lit colour at exactly the
  //      same point in the pipeline. At our default 0.15 intensity the additive
  //      vs mix difference is visually indistinguishable, and we keep tonemap.
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
    const uEdgeThickness = uniform(NCZ.BUILDING_EDGE_THICKNESS);
    const uEdgeSharpness = uniform(NCZ.BUILDING_EDGE_SHARPNESS);
    const uEdgeIntensity = uniform(NCZ.BUILDING_EDGE_INTENSITY);
    // Surfaced for runtime mutation (theme rewire, debug intensity tweaks)
    mat.userData.tslUniforms = { uEdgeColor, uEdgeIntensity, uEdgeThickness, uEdgeSharpness };

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
    mat.normalNode   = transformNormalToView(transformNormal(normalLocal, instMatrix));

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

    // (1) Diffuse modulation — sample _m, scale base colour
    const mVal = texture(mTex, planarUv.clamp(0, 1)).r;
    const modulation = float(NCZ.BUILDING_TEX_FLOOR).add(mVal.mul(NCZ.BUILDING_TEX_RANGE));
    mat.colorNode = materialColor.mul(modulation);

    // (2) Edge highlight — distance-from-edge in local UV → emissive add
    // ed = min(min(u, 1-u), min(v, 1-v)) — minimum of all 4 face-edge distances
    // ef = (1 - pow(clamp(ed/thick, 0, 1), sharp)) * intens — sharp ramp near edge
    const luv = uv();
    const ed = luv.x.min(float(1).sub(luv.x)).min(luv.y).min(float(1).sub(luv.y));
    const ef = float(1).sub(ed.div(uEdgeThickness).clamp(0, 1).pow(uEdgeSharpness)).mul(uEdgeIntensity);
    mat.emissiveNode = uEdgeColor.mul(ef);

    return mat;
  }

  // District line materials — stored so resolution can be updated on resize
  const districtLineMaterials = [];

  // Build a Line2 (fat line) from CET [x, y] ring points.
  // depthTest:false means lines always render over terrain, matching the game's UI overlay approach.
  function buildLine(ring, color, lineWidth) {
    const positions = [];
    for (const pt of ring) positions.push(pt[0], 0, -pt[1]);
    // Close the ring
    if (ring.length > 0) positions.push(ring[0][0], 0, -ring[0][1]);

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
    });
    districtLineMaterials.push(material);

    const line = new Line2(geometry, material);
    line.computeLineDistances();
    return line;
  }

  function fitCameraToBox(box) {
    const size   = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z);
    const aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight;

    camera.left   = -maxDim * aspect / 2;
    camera.right  =  maxDim * aspect / 2;
    camera.top    =  maxDim / 2;
    camera.bottom = -maxDim / 2;
    camera.updateProjectionMatrix();

    controls.target.set(center.x, 0, center.z);
    camera.position.set(center.x, NCZ.CAMERA_HEIGHT, center.z);
    camera.lookAt(center.x, 0, center.z);
    controls.update();
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
    console.log('  NCZ.ThreeScene.setOverrideMaterial(true|false)  → flat-shade everything to test fragment cost');
    console.log('  NCZ.ThreeScene.dumpDebugInfo()       → full diagnostic snapshot (also bound to the "Copy debug info" button)');
  }

  // Render-on-demand: rAF runs only when something has changed (camera moved,
  // damping in progress, sun/theme/layer/material updated, pins added, or a
  // module explicitly held the loop open via setContinuousRender). Idle map
  // views cost zero GPU/CPU — the previous unconditional rAF chewed a full
  // frame's worth of work even when the scene was identical to the last one.
  // Triggered via requestRender(); any state mutation that affects pixels
  // calls it. Damping continuation is detected from controls.update()'s
  // return value (true = state still interpolating).
  //
  // _suppressed — flyover stops the schema loop and runs its own rAF that
  // calls renderFrame(flyCamera) directly. Beat-driven transitionToColors
  // still fires requestRender during the flyover, which would otherwise
  // resurrect the schema renderLoop and race the flyover camera. The flag
  // gates requestRender so the flyover's own loop stays the sole renderer.
  let _continuousRenderRefs = 0;
  let _suppressed = false;

  function renderLoop() {
    animationId = null;
    if (stats) stats.begin();
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
    if (dampingActive || _continuousRenderRefs > 0) requestRender();
  }

  // Schedule one frame. Idempotent — multiple calls within the same tick
  // collapse to a single rAF. Hook into any state change that affects pixels.
  function requestRender() {
    if (_suppressed) return;
    if (animationId !== null) return;
    if (!renderer || !scene || !camera) return;
    animationId = requestAnimationFrame(renderLoop);
  }

  // Hold the loop open across an arbitrary number of frames. Counter-based so
  // multiple animations (theme dissolve + sun arc + beat pulse) compose cleanly
  // — each pairs a true/false call. Flyover doesn't use this; it bypasses the
  // schema renderLoop entirely with its own rAF + renderFrame(flyCamera) path.
  function setContinuousRender(active) {
    _continuousRenderRefs = Math.max(0, _continuousRenderRefs + (active ? 1 : -1));
    if (_continuousRenderRefs > 0) requestRender();
  }

  // Backward-compat shims — external callers (app.js view switch, flyover
  // restart) still talk to start/stop. start = "ensure at least one frame
  // renders soon" which on-demand satisfies via a single requestRender.
  // start also clears the flyover suppression flag in case stopRenderLoop
  // was the call that engaged it; stop sets it so any in-flight requestRender
  // (e.g. from a still-running color tween) doesn't resurrect the loop.
  function startRenderLoop() {
    _suppressed = false;
    // The showcase flyover fits the shadow camera to its own PerspectiveCamera
    // (renderFrame below); when it hands control back, re-fit to the schema
    // camera's view before the next schema frame.
    updateShadowCamera();
    requestRender();
  }

  function stopRenderLoop() {
    _suppressed = true;
    if (animationId !== null) {
      cancelAnimationFrame(animationId);
      animationId = null;
    }
    _lastFrameTime = 0; // Reset so the next frame after restart doesn't sample the gap
  }

  // ── Debug helpers (always exposed; useful from DevTools console) ───────

  // Snapshot of renderer.info — counts that explain CPU vs GPU bottlenecks.
  function getRenderInfo() {
    if (!renderer) return null;
    return {
      drawCalls:  renderer.info.render.calls,
      triangles:  renderer.info.render.triangles,
      points:     renderer.info.render.points,
      lines:      renderer.info.render.lines,
      geometries: renderer.info.memory.geometries,
      textures:   renderer.info.memory.textures,
      programs:   renderer.info.programs ? renderer.info.programs.length : 0,
    };
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

  // Runtime control of the building edge highlight intensity. The TSL
  // uEdgeIntensity uniform is captured from NCZ.BUILDING_EDGE_INTENSITY at
  // material-compile time, so changing the constant alone doesn't propagate
  // to live materials — this iterates the cached uniform refs and updates them.
  // Diagnostic use: set to 0 to test whether shimmer disappears entirely;
  // future Stage 2 quality preset use: dim/disable highlight on Low.
  function setBuildingEdgeIntensity(value) {
    for (const mat of buildingMaterials) {
      const u = mat.userData.tslUniforms;
      if (u?.uEdgeIntensity) u.uEdgeIntensity.value = value;
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
          const adapterInfo = renderer.backend?.adapterInfo;
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
        // `info.programs` is a WebGL2-only array; WebGPU compiles pipelines
        // lazily and doesn't expose a comparable count.
        programs:     renderer.info.programs ? renderer.info.programs.length : null,
      } : null,
      rendererSettings: renderer ? {
        pixelRatio:     renderer.getPixelRatio(),
        // No `getContextAttributes()` on WebGPURenderer — track from constructor
        // params via a sentinel set at init time. Falls back to the legacy path
        // for WebGL2 where the WebGL context exposes these directly.
        antialias:      renderer.isWebGPURenderer
                          ? !!_rendererInitParams?.antialias
                          : !!(renderer.getContextAttributes?.() && renderer.getContextAttributes().antialias),
        backend:        renderer.isWebGPURenderer ? 'WebGPU' : 'WebGL2',
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

  // ── Flyover API ────────────────────────────────────────────────────────
  // Called by flyover.js — kept minimal to avoid exposing internals.

  function renderFrame(cam) {
    if (!renderer || !scene) return;
    // The showcase flyover renders through its own PerspectiveCamera — re-fit
    // the shadow camera to *its* view each frame (it moves continuously).
    // startRenderLoop re-fits to the schema camera when the flyover ends.
    if (cam && cam !== camera) updateShadowCamera(cam);
    renderer.render(scene, cam);
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
    const aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight;
    const frustumH = NCZ.WORLD_H / 2;
    camera.left   = -frustumH * aspect;
    camera.right  =  frustumH * aspect;
    camera.top    =  frustumH;
    camera.bottom = -frustumH;
    camera.updateProjectionMatrix();

    // Reset to top-down view: target at sea level, camera directly above
    controls.target.set(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    camera.position.set(NCZ.WORLD_CX, NCZ.CAMERA_HEIGHT, -NCZ.WORLD_CY);
    camera.lookAt(NCZ.WORLD_CX, 0, -NCZ.WORLD_CY);
    camera.up.set(0, 1, 0);

    // Reset OrbitControls state (polar angle = π/2 for top-down)
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0;
    controls.update();
    requestRender();
  }

  function updateMaterials() {
    if (!scene) return;

    scene.background = readThemeColor('--primary', '#0a192f');

    if (terrainMat) terrainMat.color.copy(readThemeColor('--scene-terrain',      '#566c88'));
    if (waterMat)   waterMat.color.copy(readThemeColor('--scene-water',           '#2a3f57'));
    if (cliffsMat)  cliffsMat.color.copy(readThemeColor('--scene-cliffs',         '#566c88'));
    if (roadsMat)         roadsMat.color.copy(readThemeColor('--overlay-road-color',         '#504b41'));
    if (normalRoadsMat)   normalRoadsMat.color.copy(readThemeColor('--overlay-road-color',    '#504b41'));
    if (bordersMat)       bordersMat.color.copy(readThemeColor('--overlay-road-border-color', '#1ec3c8'));
    if (normalBordersMat) normalBordersMat.color.copy(readThemeColor('--overlay-road-border-color', '#1ec3c8'));
    if (metroMat)   metroMat.color.copy(readThemeColor('--overlay-metro-color',        '#dcaa28'));

    // Update landmark material — shares --scene-buildings colour
    if (landmarkMat) landmarkMat.color.copy(readThemeColor('--scene-buildings', '#7a8fa0'));

    // Update building materials — MeshLambertNodeMaterial.color + TSL edge-colour uniform
    if (buildingMaterials.length) {
      const base = readThemeColor('--scene-buildings', '#7a8fa0');
      const edge = readThemeColor('--scene-buildings-edge', '#ffffff');
      for (const mat of buildingMaterials) {
        mat.color.copy(base);
        const u = mat.userData.tslUniforms;
        if (u?.uEdgeColor) u.uEdgeColor.value.copy(edge);
      }
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
    return [
      { key: 'bg', cssVar: '--primary', fallback: '#0a192f',
        get:   () => scene?.background?.clone() ?? null,
        reset: c  => { if (scene?.background && c) scene.background.copy(c); },
        lerp:  (f, t, a) => { if (scene?.background && f && t) scene.background.lerpColors(f, t, a); },
      },
      { key: 'terrain',  cssVar: '--scene-terrain',  fallback: '#566c88', ...mat(terrainMat) },
      { key: 'water',    cssVar: '--scene-water',    fallback: '#2a3f57', ...mat(waterMat) },
      { key: 'cliffs',   cssVar: '--scene-cliffs',   fallback: '#566c88', ...mat(cliffsMat) },
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
        reset: c  => { buildingMaterials.forEach(m => m.color.copy(c)); landmarkMat?.color.copy(c); },
        lerp:  (f, t, a) => { buildingMaterials.forEach(m => m.color.lerpColors(f, t, a)); landmarkMat?.color.lerpColors(f, t, a); },
      },
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
    if (!_dirLight || !_hemiLight) return;
    _sunAz = azimuthRad;
    _sunEl = altitudeRad;
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
    if (renderer) renderer.shadowMap.needsUpdate = true;   // sun moved ⇒ re-render the shadow map

    // Colour: warm orange at horizon → neutral white above ~NCZ.SUN_COLOR_ELEV°.
    // setRGB writes linear-light values directly (ColorManagement does NOT convert
    // these from sRGB the way a hex string would be). Tuned by eye with sRGB output
    // gamma-encode active — do not "convert" them.
    const elevDeg = el * 180 / Math.PI;
    const t = Math.min(1, Math.max(0, elevDeg / NCZ.SUN_COLOR_ELEV));
    _dirLight.color.setRGB(1, 0.45 + t * 0.55, 0.1 + t * 0.9);

    // Intensity: dims near the horizon, full above ~NCZ.SUN_INTENSITY_ELEV°
    const intensity = NCZ.SUN_INTENSITY_MIN + (1 - NCZ.SUN_INTENSITY_MIN) * Math.min(1, Math.max(0, elevDeg / NCZ.SUN_INTENSITY_ELEV));
    _dirLight.intensity   = (1 - NCZ.AMBIENT_INTENSITY) * intensity;
    // Hemisphere fill: track the day's brightness, and warm the sky toward
    // sunset so the whole scene shifts warm (the real sky scatters orange too).
    _hemiLight.intensity  = NCZ.AMBIENT_INTENSITY * Math.max(NCZ.SUN_AMBIENT_MIN, intensity);
    _hemiLight.color.lerpColors(SKY_HORIZON, SKY_NOON, t);

    // Building materials use MeshLambertNodeMaterial — scene lights update automatically.

    // Move and recolour the visible sun sphere.
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
      // Warm orange at horizon → bright yellow at noon, slightly more saturated than the light
      _sunSphere.material.color.setRGB(
        Math.min(1, _dirLight.color.r * 1.3),
        Math.min(1, _dirLight.color.g * 1.15),
        Math.min(1, _dirLight.color.b * 0.8),
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
  // startRenderLoop. No cascades — our schema camera is orthographic (uniform
  // pixels-per-world-unit), so there's no perspective near/far disparity for
  // cascades to exploit; one tight map is both simpler and sharper here.
  function updateShadowCamera(renderCam = camera) {
    if (!_dirLight || !renderCam) return;
    const shadowCam = _dirLight.shadow.camera;

    let half, center;
    if (renderCam === camera && controls) {
      // Schema orthographic camera — analytic fit. The visible ground is a W×D
      // rectangle: W = the screen-horizontal world extent; D = the screen-vertical
      // extent stretched by 1/cos(tilt) (a tilted view sees a longer strip of
      // ground). A square of side = that rectangle's diagonal contains it from any
      // sun azimuth. Cap so it can't reach the horizon at the zoomed-out extreme.
      const W = 2 * camera.right / camera.zoom;
      const tilt = controls.getPolarAngle?.() ?? 0;
      const D = (2 * camera.top / camera.zoom) / Math.max(0.25, Math.cos(tilt)); // 0.25 ≈ cos 76°, past CAMERA_MAX_TILT
      half = Math.min(0.5 * Math.hypot(W, D), NCZ.SHADOW_MAX_DISTANCE) + NCZ.SHADOW_GROUND_MARGIN;
      // Pin the centre to the ground plane (Y = 0): controls.target can drift
      // off Y=0 with screen-space panning at a tilt, which would slide the
      // footprint off the terrain. The terrain is at Y≈0 — centre on it.
      center = _shadowScratchV.set(controls.target.x, 0, controls.target.z);
    } else {
      // External camera (showcase fly cam) — square at the shadow draw distance,
      // centred where the camera's forward ray meets the ground (Y = 0).
      half = NCZ.SHADOW_MAX_DISTANCE + NCZ.SHADOW_GROUND_MARGIN;
      const dir   = _shadowScratchV.set(0, 0, -1).applyQuaternion(renderCam.quaternion);
      const denom = dir.dot(_GROUND_NORMAL);
      const tHit  = Math.abs(denom) > 1e-4 ? Math.max(0, -renderCam.position.y / denom) : 0;
      center = _shadowGroundCenter.copy(renderCam.position).addScaledVector(dir, tHit);
    }

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

    // Keep the sun light SUN_DIST up the sun ray from the footprint centre.
    // Orthographic ⇒ only the direction matters for shading; the distance just
    // places the shadow camera comfortably above the footprint so nothing clips.
    // Three copies these into the shadow camera during the shadow pass.
    _dirLight.target.position.copy(center);
    _dirLight.position.copy(center).addScaledVector(_sunDir, NCZ.SUN_DIST);

    if (renderer) renderer.shadowMap.needsUpdate = true;  // shadowMap.autoUpdate is off
  }

  function setShadowsEnabled(enabled) {
    _shadowsOn = enabled;
    // Toggle shadow *intensity*, not castShadow or renderer.shadowMap.enabled —
    // either of those tears the shadow depth texture down mid-frame and crashes
    // WebGPURenderer ("Cannot read properties of null (reading 'depthTexture')").
    // intensity 0 keeps the texture alive but contributes no darkening; ShadowNode
    // reads it via a live `reference` node, so it applies next render with no
    // recompile. (The shadow pass still runs at intensity 0 — a visual switch,
    // not a perf one; disabling the pass safely under WebGPU is deferred.)
    if (_dirLight) _dirLight.shadow.intensity = enabled ? 1 : 0;
    requestRender();
  }

  function getShadowsEnabled() { return _shadowsOn; }
  function getSunElevation() { return _sunEl; }

  function getLayerVisibility(name) {
    if (name === 'shadows') return _shadowsOn;
    if (name === 'pins')    return NCZ.ThreeMarkers?.getOverlayVisible?.() ?? null;
    return layers[name]?.visible ?? null;
  }

  function getCameraState() {
    if (!controls || !camera) return null;
    return {
      target:    controls.target.toArray(),
      position:  camera.position.toArray(),
      zoom:      camera.zoom,
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
    camera.zoom = s.zoom;
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

  return { init, startRenderLoop, stopRenderLoop, requestRender, setContinuousRender, resetCamera, setLayerVisibility, getLayerVisibility, updateMaterials, renderFrame, setControlsEnabled, getCanvasElement, captureColors, transitionMaterials, transitionToColors, setSunPosition, setShadowsEnabled, getShadowsEnabled, getSunElevation, setSunSphereVisible, getCameraState, setCameraState, getSceneColorVars, getRenderInfo, setOverrideMaterial, setBuildingEdgeIntensity, dumpDebugInfo };
})();

window.NCZ.ThreeScene = ThreeScene;
