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

// Camera — orthographic projection, positioned above world centre looking straight down
NCZ.CAMERA_NEAR     = -20000;           // near plane behind the camera (orthographic — not a clip distance)
NCZ.CAMERA_FAR      =  20000;           // far plane in front; sized for max-tilt + max-pan worst case (~23k) with margin
NCZ.CAMERA_HEIGHT   =  10000;           // Y position above world centre (CET units)

// Camera controls (OrbitControls) — source: TweakDB WorldMap.FreeCameraSettingsDefault
NCZ.CAMERA_MIN_TILT     = 0;              // min polar angle (Three.js default: 0)           — 0 = perfectly top-down
NCZ.CAMERA_MAX_TILT     = Math.PI * 0.39; // max polar angle (Three.js default: Math.PI)     — ~70° tilt from top-down
NCZ.CAMERA_DAMPING      = 0.05;           // dampingFactor   (Three.js default: 0.05)        — higher = more inertia/lag
NCZ.CAMERA_ZOOM_MIN     = 2.0;            // minZoom         (Three.js default: 0)           — zoom-out limit; small = small map
NCZ.CAMERA_ZOOM_MAX     = 50.0;           // maxZoom         (Three.js default: Infinity)    — zoom-in limit; large = close up
NCZ.CAMERA_ZOOM_SPEED   = 2.0;            // zoomSpeed       (Three.js default: 1.0)         — scroll wheel rate; increase if too slow
NCZ.CAMERA_PAN_SPEED    = 1.0;            // panSpeed        (Three.js default: 1.0)         — left-drag pan rate
NCZ.CAMERA_ROTATE_SPEED = 0.6;            // rotateSpeed     (Three.js default: 1.0)         — right-drag tilt rate; lower = more precise

// Shadow map — one OrthographicCamera fitted each frame to exactly the visible-
// ground footprint (updateShadowCamera in three-scene.js), rendered into a
// single depth32float texture (the WebGPU `shadowMapping` pattern). No cascades:
// our schema camera is orthographic (uniform pixels-per-world-unit), so there's
// no perspective near/far disparity for cascaded maps to exploit — one tight map
// is simpler and, for this camera, sharper.
NCZ.SHADOW_MAP_SIZE      = 4096;  // px² — ~3 u/texel at a whole-city zoom; razor-sharp zoomed in (the footprint shrinks with zoom)
NCZ.SHADOW_MAX_DISTANCE  = 12000; // CET units — cap on the footprint half-side. Keeps the shadow reasonably sharp at the zoomed-out + max-tilt extreme (where the visible ground would otherwise run ~20 km wide); ground past the cap is a clean unshadowed falloff. Never bites at normal zooms.
NCZ.SHADOW_GROUND_MARGIN =   600; // CET units the footprint extends past the visible ground — covers building heights / terrain relief + a sliver of just-off-screen casters. Wider off-screen-caster coverage waits on the union-frustum cull (a follow-up).
NCZ.SHADOW_CAM_NEAR      =     1; // shadow camera near clip
NCZ.SHADOW_CAM_FAR       = 40000; // shadow camera far clip — the camera sits SUN_DIST up the sun ray, so this must still reach the far edge of the footprint even at a low sun (orthographic ⇒ a wide range costs no precision)
NCZ.SHADOW_BIAS          =     0; // NDC depth bias — 0; native depth32float + reverse-Z have ample depth precision (the old -0.0005 was for the WebGL RGBA8-packed path). The geometric self-shadow ("texel patch covers a depth range") is handled by the normal bias instead:
NCZ.SHADOW_NORMAL_BIAS_TEXELS = 2.5; // receiver-sample offset along the surface normal, in shadow-texel widths — converted to world units per-frame by updateShadowCamera (scaling with the footprint keeps it the same texel offset at every zoom). Raise to kill residual grazing-sun acne ("the wave" on flat terrain/water); lower if shadows visibly detach from their casters at high zoom.

// Lighting — directional sun + hemisphere fill
NCZ.AMBIENT_INTENSITY  = 0.35;   // hemisphere-fill share; the sun gets (1 - this) at full elevation
NCZ.SUN_DIST           = 22000;  // CET units the sun light (and its shadow camera) sits up the sun ray from the visible-ground centre — only the direction matters for shading; large enough that the whole footprint stays in front of the shadow camera even at a low sun
NCZ.SUN_SPHERE_DIST    = 20000;  // visible sun disc distance from world centre
NCZ.SUN_SPHERE_RADIUS  =   600;  // CET units — ≈1.7° apparent diameter at SUN_SPHERE_DIST (≈3× real sun)
NCZ.SUN_COLOR_ELEV     =    20;  // degrees — light is warm orange below this, neutral white above
NCZ.SUN_INTENSITY_ELEV =    30;  // degrees — full intensity reached above this elevation
NCZ.SUN_INTENSITY_MIN  =   0.2;  // minimum intensity multiplier at the horizon
NCZ.SUN_AMBIENT_MIN    =   0.4;  // minimum ambient intensity scale factor (prevents total darkness at night)

// Building instance decode — DDS _data.dds (DXGI_FORMAT_R16G16B16A16_UNORM, DX10 header)
// Each pixel encodes one building instance across three horizontal blocks: position | rotation | scale.
NCZ.DDS_PIXEL_OFFSET  = 148;      // byte offset to pixel data: 128-byte standard DDS header + 20-byte DX10 extension
NCZ.UINT16_MAX        = 65535.0;  // normalisation denominator — pixel channels are 0–65535
NCZ.DDS_ALPHA_THRESH  = 655;      // 0.01 × UINT16_MAX — position alpha below this marks an empty/invalid slot

// Building shader — onBeforeCompile patches to MeshLambertMaterial
// EdgeThickness and EdgeSharpness match the game's 3d_map_cubes.mt shader parameters.
NCZ.BUILDING_EDGE_THICKNESS =  0.005;  // UV-space glow width — game default 0.0001 is sub-pixel and flickers; widened for stability
NCZ.BUILDING_EDGE_SHARPNESS =  4.0;   // power falloff — lower = softer gradient (game default: 30)
NCZ.BUILDING_EDGE_INTENSITY =  0.05;  // max mix weight — keeps effect subtle; game equivalent is full strength at tiny thickness
NCZ.BUILDING_TEX_FLOOR      =   0.3;  // minimum _m.dds brightness — prevents faces going pitch-black
NCZ.BUILDING_TEX_RANGE      =   0.7;  // brightness range above the floor (floor + range = max)

// Three.js orthographic camera.zoom threshold for district→subdistrict label switch
NCZ.SUBDISTRICT_ZOOM_3D = 2.5;

// Metro LOD zoom thresholds — vertex COLOR_0 channels are mutually exclusive tiers:
// B = wide solid line (far zoom only,    zoom < LOD_MED)   — VisibilityDistanceBold=30000
// G = thin solid line (medium zoom only, LOD_MED < zoom < LOD_NEAR) — VisibilityDistanceRegular=18000
// R = dotted line     (close zoom only,  zoom > LOD_NEAR)  — VisibilityDistanceDashed=5000
NCZ.METRO_LOD_ZOOM_MED  = 8.0;   // G→B transition zoom threshold
NCZ.METRO_LOD_ZOOM_NEAR = 20.0;  // B→R transition zoom threshold

// SeeThrough roads — the Pacifica tunnel: a road visible *through* the open bay water.
// Water (rendered in the transparent pass — see three-scene.js loadTerrain) writes
// stencil=STENCIL_WATER where it's the visible surface; terrain/cliffs/buildings over-stamp
// stencil=STENCIL_OCCLUDER where THEY are; the SeeThrough road pass renders where
// stencil==STENCIL_WATER AND the fragment is below WATER_LEVEL_Y (i.e. genuinely under water —
// so a road bridging the bay, whose deck is above the waterline, stays normal-styled rather
// than going cyan). Road geometry world-Y spans roughly -27.5 (the tunnel deck) to +229.5
// (elevated highways), so the waterline (≈ -1) cleanly separates "submerged" from "surface".
NCZ.STENCIL_WATER    = 2;     // stencil ref written by the water mesh / tested by the SeeThrough roads
NCZ.STENCIL_OCCLUDER = 1;     // stencil ref written by terrain / cliffs / buildings (visible-surface over-stamp)
NCZ.WATER_LEVEL_Y    = -1;    // world Y of the 3dmap_water.glb sea-level sheet; SeeThrough road fragments below this are "under water"
NCZ.WATER_OPACITY    = 1.0;   // water material opacity — water is in the transparent pass (so its stencil write is depth-limited to the visible bay) but renders visually opaque at 1.0; lower to make the ocean see-through

// 3D pin layer (NCZ.ThreeMarkers) — visual + UX tunables for CSS2DObject markers
// Used ONLY by pin/popup rendering. Mod data Z is read raw everywhere else.
NCZ.PIN_3D_GROUND_OFFSET            =  5;  // CET metres above player CET Z — purely cosmetic lift so the diamond reads above the surface, not embedded
NCZ.PIN_3D_DRAG_THRESHOLD_PX        =  4;  // pixels of pointerdown→pointerup movement before a click is treated as a drag (and thus does not close the popup)
NCZ.PIN_3D_POPUP_FLIP_PADDING_PX    = 24;  // pixels of clearance above the viewport top before the popup flips from above-pin to below-pin placement
NCZ.PIN_3D_FLY_DURATION_MS          = 700; // total tween time for sidebar click → camera fly-to-pin
NCZ.PIN_3D_FLY_ZOOM                 = 15;  // target camera.zoom at the end of the fly — close enough to read pin context, not max-zoom
NCZ.PIN_3D_CLUSTER_RADIUS_PX        = 40;  // screen-pixel radius for grouping pins into a cluster — matches Leaflet's maxClusterRadius
NCZ.PIN_3D_PAN_EDGE_FRACTION        = 0.5; // viewport-relative pan padding — at the bound, the world edge sits at screen-center (matches Leaflet's `panEdgeFraction`). Smaller = tighter bound.
NCZ.PIN_3D_SCALE_TARGET_PX          = 100; // ideal scale-bar width in pixels — the actual bar rounds to a "nice" length (1, 2, 5 × 10ⁿ metres) closest to this width
