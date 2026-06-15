/**
 * NC Zoning Board — Shared Constants
 * Creates the NCZ global namespace and defines all configuration values.
 */
window.NCZ = window.NCZ || {};

// Theme definitions (selector + body class + header logo)
NCZ.THEMES = [
  {
    id: "night-corp",
    label: "Night Corp",
    className: "theme-night-corp",
    logo: "assets/img/nightcorp-logo.webp",
    logoAlt: "Night Corp",
  },
  {
    id: "arasaka",
    label: "Arasaka",
    className: "theme-arasaka",
    logo: "assets/img/arasaka.png",
    logoAlt: "Arasaka",
  },
  {
    id: "militech",
    label: "Militech",
    className: "theme-militech",
    logo: "assets/img/militech_logo.png",
    logoAlt: "Militech",
  },
  {
    id: "aldecaldos",
    label: "Aldecaldos",
    className: "theme-aldecaldos",
    logo: "assets/img/aldecaldos.png",
    logoAlt: "Aldecaldos",
  },
  {
    id: "synthwave",
    label: "Synthwave",
    className: "theme-synthwave",
    logo: "assets/img/synthwave-logo.png",
    logoAlt: "Synthwave",
  },
  {
    id: "game",
    label: "Game",
    className: "theme-game",
    logo: "assets/img/game-logo.png",
    logoAlt: "Night City",
  },
  {
    id: "preem",
    label: "Preem Map",
    className: "theme-preem",
    logo: "assets/img/preem-logo.png",
    logoAlt: "Preem Map",
  },
];

// Category visual styles (color, label, CSS class)
NCZ.CATEGORY_STYLES = {
  "location-overhaul": {
    color: "var(--category-location-overhaul)",
    label: "Overhaul",
    class: "cat-location-overhaul",
  },
  "new-location": {
    color: "var(--category-new-location)",
    label: "New Location",
    class: "cat-new-location",
  },
  other: {
    color: "var(--category-other)",
    label: "Other",
    class: "cat-other",
  },
};

// Nexus Mods API
NCZ.NEXUS_GAME_ID = 3333; // Cyberpunk 2077
NCZ.NEXUS_GQL_ENDPOINT = "https://api.nexusmods.com/v2/graphql";
NCZ.NEXUS_BATCH_SIZE = 50;

// Data paths
NCZ.DATA_MODS_PATH = "mods.json";
NCZ.DATA_TAGS_PATH = "data/tags.json";
// nexus_ids tagged "NCZoning" on Nexus but intentionally kept off the map
// (mistaken/minor tags). Honoured by auto-discovery and the health monitor.
NCZ.DATA_EXCLUDED_PATH = "data/excluded_mods.json";

// 3D scene GLB source folder. The committed runtime path is "assets/glb-meshopt"
// (gltfpack-compressed via EXT_meshopt_compression, decoded by MeshoptDecoder).
// WolvenKit-exported source GLBs live at the gitignored "assets/glb-source/" —
// drop fresh exports there and run `npm run encode-meshopt` to regenerate.
// Flip this constant to "assets/glb-source" to test against uncompressed locally
// (only works when the source folder is populated).
NCZ.GLB_DIR = "assets/glb-meshopt";

// Content limits
NCZ.DESCRIPTION_MAX_LENGTH = 500;
NCZ.COPY_FEEDBACK_MS = 2000;
NCZ.SEARCH_DEBOUNCE_MS = 200;

// Deep-linking / URL sharing
NCZ.SITE_URL      = "https://nczoning.net";
NCZ.URL_PARAM_MOD = "mod";

// Map world extent (CET world-space)
// Source: Realistic Map 8k mod terrain quad UV mapping — the authoritative projection
// for the satellite tile layer (16k WebP tiles) and terrain tiles.
// See docs/coordinate-system.md for derivation and why TweakDB bounds differ.
NCZ.WORLD_MIN_X = -6298;
NCZ.WORLD_MAX_X =  5815;
NCZ.WORLD_MIN_Y = -7684;
NCZ.WORLD_MAX_Y =  4427;

// Derived world centre + height (used by Three.js scene setup)
NCZ.WORLD_CX = (NCZ.WORLD_MIN_X + NCZ.WORLD_MAX_X) / 2;  // -241.5
NCZ.WORLD_CY = (NCZ.WORLD_MIN_Y + NCZ.WORLD_MAX_Y) / 2;  // -1628.5
NCZ.WORLD_H  =  NCZ.WORLD_MAX_Y - NCZ.WORLD_MIN_Y;        //  12111 CET units

// CET <-> Leaflet transform derived coefficients (from WORLD_MIN/MAX)
// Used by cetToLeaflet() and the scale indicator for distance conversion.
NCZ.CET_TO_LEAFLET_X_SCALE = 256 / (NCZ.WORLD_MAX_X - NCZ.WORLD_MIN_X);  // 0.02113734
NCZ.CET_TO_LEAFLET_Y_SCALE = 256 / (NCZ.WORLD_MAX_Y - NCZ.WORLD_MIN_Y);  // 0.02113385
NCZ.CET_TO_LEAFLET_X_OFFSET = -NCZ.WORLD_MIN_X * NCZ.CET_TO_LEAFLET_X_SCALE;
NCZ.CET_TO_LEAFLET_Y_OFFSET = -NCZ.WORLD_MAX_Y * NCZ.CET_TO_LEAFLET_Y_SCALE;
// Set this if you want to calibrate CET units to physical meters.
// Default assumes 1 CET unit ~= 1 meter.
NCZ.CET_UNITS_PER_METER = 1;

// LocalStorage cache keys & TTLs
NCZ.THEME_PREFERENCE_KEY = "nc_theme_id";
NCZ.SHOWCASE_OPTIONS_KEY = "nc_showcase_options";
NCZ.RECENTLY_UPDATED_DAYS = 7;
NCZ.UPDATED_LABEL = "RECENTLY UPDATED";
NCZ.THUMB_CACHE_KEY = "nc_nexus_thumbs";
NCZ.THUMB_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
NCZ.AUTODISCOVERY_CACHE_KEY = "nc_nexus_autodiscovery";
NCZ.AUTODISCOVERY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Three.js Object3D.layers — bitmask channels that cameras opt into via Camera.layers.
// Layer 0 (default) carries the static scene (terrain, water, buildings, roads, metro,
// districts, landmarks). The pins/clusters/popup/tooltip overlay lives on its own layer
// so it can be toggled independently per camera: the schema camera has both layers
// enabled by default; the showcase flyover camera enables LAYER_PINS only when the user
// opts into "Show mod pins during showcase".
NCZ.LAYER_DEFAULT = 0;
NCZ.LAYER_PINS    = 1;

// Pin tooltip positioning
NCZ.PIN_TOOLTIP_MARGIN_PX = 10;
NCZ.PIN_TOOLTIP_GAP_PX = 8;
NCZ.PIN_TOOLTIP_ARROW_SIZE_PX = 6;
NCZ.PIN_TOOLTIP_ARROW_EDGE_PADDING_PX = 12;

// Pin popup positioning
NCZ.PIN_POPUP_MARGIN_PX = 12;
NCZ.PIN_POPUP_GAP_PX = 10;
NCZ.PIN_POPUP_ARROW_SIZE_PX = 10;
NCZ.PIN_POPUP_ARROW_EDGE_PADDING_PX = 18;

// Responsive
NCZ.MOBILE_BREAKPOINT = 768;

// Cluster panel sizing
NCZ.CLUSTER_PANEL_WIDTH_KEY = "nc_cluster_panel_width";
NCZ.CLUSTER_PANEL_DEFAULT_WIDTH = 400;
NCZ.CLUSTER_PANEL_MIN_WIDTH = 260;
NCZ.CLUSTER_PANEL_MAX_WIDTH = 720;

// District border colors — matched to game's main_colors.inkstyle
NCZ.DISTRICT_COLORS = {
  city_center:    "#ffd741",  // MainColors.Yellow
  watson:         "#ff3e34",  // MainColors.CombatRed
  westbrook:      "#ff5100",  // MainColors.Orange
  heywood:        "#1ded83",  // MainColors.Green
  santo_domingo:  "#5ef6ff",  // MainColors.Blue
  pacifica:       "#ff6158",  // MainColors.Red
  dogtown:        "#00a32c",  // MainColors.DarkGreen
  ncx_morro_rock: "#349197",  // MainColors.MildBlue
  badlands:       "#c882ff",  // Bright violet
};

// Overlay zoom thresholds (Leaflet zoom levels)
NCZ.DISTRICT_ZOOM_THRESHOLD = 3;  // below = districts only, above = subdistricts

// District border appearance — shared between SAT (Leaflet) and SCHEMA (Three.js)
NCZ.DISTRICT_LINE_WIDTH     = 4;  // px — main district borders
NCZ.SUBDISTRICT_LINE_WIDTH  = 3;  // px — subdistrict borders
NCZ.DISTRICT_LINE_OPACITY   = 0.85;

// ── Three.js 3D scene ──────────────────────────────────────────────────────────

// WebGLRenderer pixel-ratio cap. GPU fragment cost scales as DPR², so on
// high-DPI displays (Retina 2.0, 4K@200% 2.0, 1440p@200% 2.0, etc.) the
// uncapped path costs 78%+ more shader work than 1.5 for a soft-edge difference
// the user is unlikely to notice — pin/popup/tooltip text is unaffected because
// CSS2DRenderer rasterises HTML at the real device DPR regardless. The cap is a
// no-op for everyone at DPR ≤ 1.5, so most desktops see zero change.
NCZ.MAX_DEVICE_PIXEL_RATIO = 1.5;

// Camera — perspective projection, positioned above world centre looking straight down.
// Source: TweakDB WorldMap.TopDownCameraSettingsDefault — see docs/data/worldmap_tweakdb_tree.json.
// The schema camera matches the game's TopDown view (FOV 25°, distance in CET / world units).
NCZ.SCHEMA_CAMERA_FOV              = 25;     // degrees — game canonical (TopDownCameraSettingsDefault.fovMin/Max)
NCZ.SCHEMA_CAMERA_NEAR             = 10;     // CET units — perspective near clip; must be > 0
NCZ.SCHEMA_CAMERA_FAR              = 50000;  // CET units — far clip; covers shadow camera + sun sphere
NCZ.SCHEMA_CAMERA_MIN_DISTANCE     = 800;    // CET units — zoom-in limit  (TweakDB zoomMin)
NCZ.SCHEMA_CAMERA_MAX_DISTANCE     = 15000;  // CET units — zoom-out limit (TweakDB zoomMax)
NCZ.SCHEMA_FLY_TO_DISTANCE         = 1250;   // CET units — fly-to-pin target distance (TweakDB zoomToZoomValue)

// 3D-map intro fly-in (E5) — on first load the camera drops in from a far,
// near-straight-down pose, descending and leaning back to a resting framing
// of the city. Skipped when a ?mod= deep-link is present (the deep-link
// fly-to takes over). The near-vertical start "feels" like a top-down reveal;
// the rest tilt matches the game's leaned-back default for its world map.
//
// START_TILT is 2°, not 0°: at *exactly* straight-down the camera-to-target
// offset is (0, +y, 0) and OrbitControls derives the azimuth as
// atan2(0, 0) — degenerate, so float noise picks the angle and makeSafe()
// perpetuates it as a camera roll (the map renders rotated/upside-down).
// 2° gives the offset a solid z-component → stable azimuth 0. Visually
// indistinguishable from dead top-down.
NCZ.SCHEMA_INTRO_START_DISTANCE = 15000;       // CET units — far pose (= SCHEMA_CAMERA_MAX_DISTANCE)
NCZ.SCHEMA_INTRO_REST_DISTANCE  = 12200;       // CET units — resting framing distance (whole city in frame)
NCZ.SCHEMA_INTRO_START_TILT     = 2;           // degrees off vertical at the far pose — near top-down (see note above)
NCZ.SCHEMA_INTRO_REST_TILT      = 11;          // degrees off vertical at the rest pose — game world-map lean-back
NCZ.SCHEMA_INTRO_AZIMUTH        = 0;           // radians — compass heading of the lean; constant start→rest (no sweep)
NCZ.SCHEMA_INTRO_DURATION_MS    = 1200;        // fly-in length — ~"first second after load" per E5
NCZ.SCHEMA_INTRO_REST_CENTER    = [-800, -500]; // [cetX, cetY] framed by the rest pose — the city's visual centre
                                                // (not the world centre, which is biased south into the badlands)

// Pan envelope — clamps controls.target so the camera can't roam off the map.
// Source: TweakDB WorldMap.DefaultSettings.cursorBoundary{Min,Max}.
// CET → Three.js: X stays as-is; CET Y maps to Three Z with a sign flip
// (GLB_Z = -CET_Y), so CET Y range (-7300..5000) becomes Three Z (-5000..7300).
NCZ.PAN_BOUND_MIN_X =  -5500;  // CET / Three X — TweakDB cursorBoundaryMin.X
NCZ.PAN_BOUND_MAX_X =   6050;  // CET / Three X — TweakDB cursorBoundaryMax.X
NCZ.PAN_BOUND_MIN_Z =  -5000;  // Three Z — derived from -cursorBoundaryMax.Y
NCZ.PAN_BOUND_MAX_Z =   7300;  // Three Z — derived from -cursorBoundaryMin.Y

// Camera controls (OrbitControls)
NCZ.CAMERA_MIN_TILT     = 0;              // min polar angle (Three.js default: 0)           — 0 = perfectly top-down
NCZ.CAMERA_MAX_TILT     = Math.PI * 0.39; // max polar angle (Three.js default: Math.PI)     — ~70° tilt from top-down
NCZ.CAMERA_DAMPING      = 0.05;           // dampingFactor   (Three.js default: 0.05)        — higher = more inertia/lag
NCZ.CAMERA_ZOOM_SPEED   = 2.0;            // zoomSpeed       (Three.js default: 1.0)         — scroll wheel rate; increase if too slow
NCZ.CAMERA_PAN_SPEED    = 1.0;            // panSpeed        (Three.js default: 1.0)         — left-drag pan rate
NCZ.CAMERA_ROTATE_SPEED = 0.6;            // rotateSpeed     (Three.js default: 1.0)         — right-drag tilt rate; lower = more precise

// Shadow map — one OrthographicCamera fitted each frame to exactly the visible-
// ground footprint (updateShadowCamera in three-scene.js), rendered into a
// single depth32float texture (the WebGPU `shadowMapping` pattern). Single map
// for now; a CSM revisit is queued — the original "no cascades because schema
// is ortho" rationale no longer holds since the schema camera moved to perspective
// (FOV 25°, TweakDB-aligned), see [[align-schematic-camera-to-game]].
NCZ.SHADOW_MAP_SIZE      = 4096;  // px² — ~3 u/texel at a whole-city zoom; razor-sharp zoomed in (the footprint shrinks with zoom)
NCZ.SHADOW_MAX_DISTANCE  =  8600; // CET units — cap on the footprint half-side. Matches the world half-diagonal (sqrt((WORLD_MAX_X-WORLD_MIN_X)² + (WORLD_MAX_Y-WORLD_MIN_Y)²) / 2 ≈ 8565 wu) with tiny headroom: nothing renders past the world bounds, so a larger cap just stretches texels over empty void. Trace data on PR #656 showed `half` pinned at the cap (12600 = 12000 cap + 600 margin) every showcase frame; reducing the cap shrinks the box uniformly → ~1.4× sharper texels for free at no performance cost.
NCZ.SHADOW_GROUND_MARGIN =   600; // CET units the footprint extends past the visible ground — covers building heights / terrain relief + a sliver of just-off-screen casters. Wider off-screen-caster coverage waits on the union-frustum cull (a follow-up).
NCZ.SHADOW_CAM_NEAR      =     1; // shadow camera near clip
NCZ.SHADOW_CAM_FAR       = 40000; // shadow camera far clip — the camera sits SUN_DIST up the sun ray, so this must still reach the far edge of the footprint even at a low sun (orthographic ⇒ a wide range costs no precision)
NCZ.SHADOW_BIAS          =     0; // NDC depth bias — 0; native depth32float + reverse-Z have ample depth precision (the old -0.0005 was for the WebGL RGBA8-packed path). The geometric self-shadow ("texel patch covers a depth range") is handled by the normal bias instead:
NCZ.SHADOW_NORMAL_BIAS_TEXELS = 2.5; // receiver-sample offset along the surface normal, in shadow-texel widths — converted to world units per-frame by updateShadowCamera (scaling with the footprint keeps it the same texel offset at every zoom). Raise to kill residual grazing-sun acne ("the wave" on flat terrain/water); lower if shadows visibly detach from their casters at high zoom.

// Lighting — recalibrated to the decoded in-game 3D world map environment
// (base/weather/24h_basic/3dmap.env + 3dmap.envparam).
//
// The flat-looking buildings were a lighting problem, not a colour one: the
// old sun:ambient ratio (1.1 : 0.42 ≈ 2.6 : 1) had ambient washing every face
// to nearly the same tone. The in-game map's within-building contrast is
// ~10× (bright sun-faces vs shadow faces); decoding the envparam and fitting
// against the in-game SDR capture gives a sun:ambient ratio of ~50 : 1.
//
// Decode note — the in-game map exposes through a *physical camera*
// (`CameraAreaSettings`: f/3.0, ISO 35, 1/300 s ⇒ EV100 12.9, exposure
// 1/(1.2·2^EV) = 0.000108; cross-confirmed in PIX event-306 cb12 [50].x =
// 0.000108025). That exposure can't be used literally here: the roads, metro
// and district lines are *unlit* materials with plain [0,1] colours, and a
// 0.000108 global `toneMappingExposure` would crush them to black. So the
// renderer works in a normalised gauge — exposure stays at the value the
// unlit overlays need (0.85), and the lights are scaled by the same factor
// (0.000108/0.85). The building result is identical; the overlays survive.
//
// SUN/AMBIENT are still a capture-fit ratio (the exact engine lux awaits the
// PIX light-accumulation pass — TODO(pix)). Sun + ambient COLOURS are exact
// decoded envparam values (linear RGB).
NCZ.SCENE_EXPOSURE     = 0.720;                     // renderer.toneMappingExposure — init fallback + ?gamelight reference exposure (fixed for colour calibration)

// Time-of-day exposure curve, keyed on SUN ELEVATION (degrees above horizon).
// Our sun is real SunCalc data, so without help the scene crushes to black at
// dawn/dusk. But the goal is NOT constant brightness — the map should still
// read like real-world light: bright midday, dim/atmospheric at sunrise &
// sunset. So this is a gentle "floor the darkness" curve, not a normalise:
// exposure stays at the calibrated midday value for most of the day (letting
// the sun's own N·L falloff carry the natural variation), and only opens up
// modestly near the horizon — CAPPED — so low sun stays dim without going
// unusably black. (An earlier version held a fixed target brightness all day;
// that flattened the day/night feel and over-exposed sunrise/sunset.)
//
// Keyed on elevation (not time) so BOTH the time-of-day slider (applySunTime)
// and the showcase flyover (updateFlyoverSun) drive it from the same function
// (NCZ.exposureForSunElevation in utils.js) — the flyover animates the sun via
// setSunPosition directly, so it must apply exposure itself.
//
// [elevationDeg, exposure], ascending; interpolated piecewise-linear, clamped
// to the endpoints. Tune the two ends: row 0 = horizon cap (dawn/dusk),
// last row = midday base.
NCZ.SCENE_EXPOSURE_CURVE = [
  [0,  0.95],  // horizon (sunrise/sunset) — capped lift so it stays atmospheric, not daylight
  [5,  0.80],
  [15, 0.58],
  [30, 0.49],
  [50, 0.45],  // calibrated midday base — natural variation comes from the sun, not exposure
  [90, 0.45],
];

// Building edge "glow" — self-lit emissive on the decoded edge highlight, a
// per-theme opt-in (see --scene-edge-glow). It's a binary on/off (no slider):
// when on, the edge emissive uses this fixed intensity. The per-theme CSS var
// is just the default on/off state; the Settings checkbox overrides it for the
// session. Synthwave defaults on; every other theme off.
NCZ.EDGE_GLOW_INTENSITY = 0.3;

NCZ.SUN_COLOR_RGB      = [0.975, 0.869, 0.774];     // envparam LightAreaSettings.sunColor — warm white (linear)
NCZ.SUN_INTENSITY      = 3.00;                      // envelope-fit (sun:ambient ratio + level tuned across V1/V2/V3/V4)
NCZ.AMBIENT_SKY_RGB    = [0.796, 0.895, 1.0];       // envparam AmbientOverride — the 5 bright cube faces, cool white (linear)
NCZ.AMBIENT_GROUND_RGB = [0.566, 0.766, 1.0];       // envparam AmbientOverride — the dim ground face, blue (linear)
NCZ.AMBIENT_INTENSITY  = 0.405;                     // envelope-fit — sun:ambient ≈ 7.4:1
NCZ.SHADOW_INTENSITY   = 0.60;                      // cast-shadow strength when "Shadows" overlay is on — tuned with the new lighting
NCZ.SUN_DIST           = 22000;  // CET units the sun light (and its shadow camera) sits up the sun ray from the visible-ground centre — only the direction matters for shading; large enough that the whole footprint stays in front of the shadow camera even at a low sun
NCZ.SUN_SPHERE_DIST    = 20000;  // visible sun disc distance from world centre
NCZ.SUN_SPHERE_RADIUS  =   600;  // CET units — ≈1.7° apparent diameter at SUN_SPHERE_DIST (≈3× real sun)

// Building instance decode — DDS _data.dds (DXGI_FORMAT_R16G16B16A16_UNORM, DX10 header)
// Each pixel encodes one building instance across three horizontal blocks: position | rotation | scale.
NCZ.DDS_PIXEL_OFFSET  = 148;      // byte offset to pixel data: 128-byte standard DDS header + 20-byte DX10 extension
NCZ.UINT16_MAX        = 65535.0;  // normalisation denominator — pixel channels are 0–65535
// 0.01 × UINT16_MAX — the "empty slot" cutoff. Used two ways in loadBuildings:
// base-game textures mark empties with near-zero position ALPHA below this;
// malgalad's "3D World Map Fixed" textures keep alpha full and mark empties by
// zeroing the SCALE block instead (see docs/3dmap-fixed-assets.md).
// Same 1% threshold serves both tests.
NCZ.DDS_ALPHA_THRESH  = 655;

// 3D-map building asset set: 'fixed' = malgalad's "3D World Map Fixed" textures
// (DISTRICT_META.dataDdsFixed); 'cdpr' = base-game textures (DISTRICT_META.dataDds).
// Persisted as a user preference (NOT theme-scoped) — selected in the Settings
// modal; loadBuildings reads it at load time. Fixed is the default.
NCZ.ASSET_SET_KEY     = 'ncz-asset-set';
NCZ.ASSET_SET_DEFAULT = 'fixed';

// Building edge highlight — decoded from the game's 3d_map_cubes.mt gbuffer
// pixel shader (PIX capture).
// Per-district EdgeThickness / EdgeSharpnessPower live in DISTRICT_META
// (three-scene.js) alongside the other per-district game constants.
NCZ.BUILDING_EDGE_CAMDIST_K =  0.002; // game's camera-distance widening coefficient: k = camDist × this × EdgeThickness
// _m surface modulation, decoded from the 3d_map_cubes.mt gbuffer shader
// (PIX capture). Game formula:
//   surface = 0.5·(0.05 + 0.75·ao + m)   →   ao = 1 (the vertical-AO term is
// gated by DebugScaleOffset, which ships at a default that disables it)
//   →   surface = 0.5·(0.8 + m) = 0.4 + 0.5·m
NCZ.BUILDING_TEX_FLOOR      =   0.4;  // _m.dds brightness floor — game 0.5·0.8
NCZ.BUILDING_TEX_RANGE      =   0.5;  // brightness range above the floor — game 0.5·m
// Sloped-face guard for the _m planar sample (see buildBuildingMaterial):
// world-normal Y thresholds for the smoothstep blend between the per-fragment
// planar UV (flat roofs — exact decoded behaviour) and the instance-centre UV
// (steep/oblique faces — the building's own roof texel, which can't paint a
// 2-D image of the district map onto a slanted surface).
// Thresholds are tight because a partially-blended UV still draws a (squashed)
// image: a ~30°-pitched face at a mid blend re-rendered the artifact as smeared
// streaks. 88% of instances are exactly axis-aligned (top normal.y = 1.0), so
// near-flat-only planar sampling leaves them untouched.
NCZ.BUILDING_TEX_SLOPE_FADE_START = 0.95;  // normal.y ≤ this (pitch ≥ ~18°) → fully centre-sampled
NCZ.BUILDING_TEX_SLOPE_FADE_END   = 0.995; // normal.y ≥ this (pitch ≤ ~6°)  → fully planar

// Terrain "graph-paper" grid — decoded from the game's 3d_map_terrain pixel
// shader (PIX DXIL capture). Three
// nested anti-aliased line grids on world XZ, combined into one line factor.
// Every value below is the game's exact decoded value — the "game:" note in
// each comment keeps the original recoverable if a value is later tuned.
NCZ.TERRAIN_GRID_CELLS       = [80, 8, 400]; // world-unit cell sizes, main/fine/major — game: [80, 8, 400]
NCZ.TERRAIN_GRID_LINE_N      = [20, 2, 75];  // line-width factors, line ≈ cell/N wide — game: [20, 2, 75]
NCZ.TERRAIN_GRID_FINE_OFFSET = 1423.6;       // phase offset on the fine grid — game: 1423.6
NCZ.TERRAIN_GRID_MAIN_WEIGHT = 0.65;         // main-grid contribution, before the fine grid is subtracted — game: 0.65
NCZ.TERRAIN_GRID_MAJOR_BOOST = 50;           // major-line emphasis: (1 + BOOST·major) multiplies the result — game: 50

// District / subdistrict outline visibility thresholds in CET camera-to-target
// distance. Three-state, matching the game's WorldMap.ZoomLevel* TweakDB records:
//   d ≥ DISTRICT_DISTANCE_3D            → main district outlines visible
//   SUBDISTRICT_DISTANCE_3D ≤ d < DISTRICT_DISTANCE_3D → subdistrict outlines visible
//   d < SUBDISTRICT_DISTANCE_3D          → neither (mappin tiers only)
// Sources: WorldMap.ZoomLevelDistricts.zoom = 11000 (showDistricts = 1),
// WorldMap.ZoomLevelSubDistricts.zoom = 7000 (showSubDistricts = 1). All
// closer zoom-level records (Important / Vendors / AllMappins / ExtraMappins)
// have both flags false — i.e. neither outline tier is shown below 7000.
NCZ.DISTRICT_DISTANCE_3D    = 11000;
NCZ.SUBDISTRICT_DISTANCE_3D =  7000;

// Metro LOD — decoded from the game's 3d_map_metro.mt pixel shader (PIX
// capture). The metro mesh carries
// three LOD tiers in COLOR_0, one channel per vertex:
//   R = dotted (closest)   G = thin solid (medium)   B = wide solid (far)
// Each tier is fully visible below its distance threshold and crossfades
// out over METRO_LOD_TRANSITION; past the far threshold the metro hides.
//
// The game drives this off `D = 2 × cameraZ`, comparing against
// VisibilityDistance{Dashed,Regular,Bold} = 5000 / 18000 / 30000. Our
// camera-to-target distance is that same metric halved, so the thresholds
// below are the game values ÷ 2 — FAR (15000) lands exactly on
// SCHEMA_CAMERA_MAX_DISTANCE, which is why the raw game values looked too
// large until the `2×` was decoded out of the camera cbuffer.
NCZ.METRO_LOD_DISTANCE_NEAR = 2500;   // R→G boundary  (game VisibilityDistanceDashed  5000 ÷ 2)
NCZ.METRO_LOD_DISTANCE_MED  = 9000;   // G→B boundary  (game VisibilityDistanceRegular 18000 ÷ 2)
NCZ.METRO_LOD_DISTANCE_FAR  = 15000;  // B→hidden      (game VisibilityDistanceBold    30000 ÷ 2)
NCZ.METRO_LOD_TRANSITION    = 150;    // crossfade band width (game TransitionLength 300 ÷ 2)

// SeeThrough roads — the Pacifica tunnel: a road visible *through* the open bay water.
// Water (rendered in the transparent pass — see three-scene.js loadTerrain) writes
// stencil=STENCIL_WATER where it's the visible surface; terrain/cliffs/buildings over-stamp
// stencil=STENCIL_OCCLUDER where THEY are; the SeeThrough road pass renders where
// stencil==STENCIL_WATER (with depthTest off, so it draws on top of the water).
NCZ.STENCIL_WATER    = 2;     // stencil ref written by the water mesh / tested by the SeeThrough roads
NCZ.STENCIL_OCCLUDER = 1;     // stencil ref written by terrain / cliffs / buildings (visible-surface over-stamp)
NCZ.WATER_OPACITY    = 1.0;   // water material opacity — water is in the transparent pass (so its stencil write is depth-limited to the visible bay) but renders visually opaque at 1.0; lower to make the ocean see-through

// 3D pin layer (NCZ.ThreeMarkers) — visual + UX tunables for CSS2DObject markers
// Used ONLY by pin/popup rendering. Mod data Z is read raw everywhere else.
NCZ.PIN_3D_GROUND_OFFSET            =  5;  // CET metres above player CET Z — purely cosmetic lift so the diamond reads above the surface, not embedded
NCZ.PIN_3D_DRAG_THRESHOLD_PX        =  4;  // pixels of pointerdown→pointerup movement before a click is treated as a drag (and thus does not close the popup)
NCZ.PIN_3D_POPUP_FLIP_PADDING_PX    = 24;  // pixels of clearance above the viewport top before the popup flips from above-pin to below-pin placement
NCZ.PIN_3D_FLY_DURATION_MS          = 700; // total tween time for sidebar click → camera fly-to-pin
// Fly-to-pin target distance lives in SCHEMA_FLY_TO_DISTANCE (TweakDB zoomToZoomValue = 1250)
NCZ.PIN_3D_CLUSTER_RADIUS_PX        = 40;  // screen-pixel radius for grouping pins into a cluster — matches Leaflet's maxClusterRadius
NCZ.PIN_3D_PAN_EDGE_FRACTION        = 0.5; // viewport-relative pan padding — at the bound, the world edge sits at screen-center (matches Leaflet's `panEdgeFraction`). Smaller = tighter bound.
NCZ.PIN_3D_SCALE_TARGET_PX          = 100; // ideal scale-bar width in pixels — the actual bar rounds to a "nice" length (1, 2, 5 × 10ⁿ metres) closest to this width
