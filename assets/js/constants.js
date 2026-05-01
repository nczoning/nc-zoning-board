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

// 3D scene GLB source folder. Flip to "assets/glb" to load the original
// uncompressed meshes; "assets/glb-meshopt" loads the gltfpack-compressed copies
// (~79% smaller, decoded via MeshoptDecoder — small ~30 KB WASM, fast decode,
// preserves vertex/index ordering for GPU efficiency).
// Both folders are committed, so toggling is a one-line revert with no asset redeploy.
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
NCZ.RECENTLY_UPDATED_DAYS = 7;
NCZ.UPDATED_LABEL = "RECENTLY UPDATED";
NCZ.THUMB_CACHE_KEY = "nc_nexus_thumbs";
NCZ.THUMB_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
NCZ.AUTODISCOVERY_CACHE_KEY = "nc_nexus_autodiscovery";
NCZ.AUTODISCOVERY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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

// Camera — orthographic projection, positioned above world centre looking straight down
NCZ.CAMERA_NEAR     = -50000;           // near plane behind the camera (orthographic — not a clip distance)
NCZ.CAMERA_FAR      =  50000;           // far plane in front; large to ensure terrain/buildings never clip
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

// Shadow map — PCFSoftShadowMap, orthographic frustum centred on Night City
// The shadow camera sits at the sun position (NCZ.SUN_DIST away) and looks down.
NCZ.SHADOW_MAP_SIZE    = 4096;  // px² — dynamically concentrated by zoom; ~0.07 CET units/texel at zoom=50
NCZ.SHADOW_FRUSTUM     = 7000;  // ±7000 units at full zoom-out; scaled down by camera.zoom for sharper shadows when zoomed in
NCZ.SHADOW_FRUSTUM_MIN =  400;  // minimum frustum radius — prevents over-concentration at extreme zoom+tilt
NCZ.SHADOW_CAM_NEAR    =   10;  // near clip — 10 units from the light; avoids near-plane artefacts
NCZ.SHADOW_CAM_FAR     = 25000; // far clip — must reach the terrain from the sun's position (~8000 units away) with headroom
NCZ.SHADOW_BIAS        = -0.0005; // depth bias — small negative value reduces shadow acne (self-shadowing artefacts)
NCZ.SHADOW_NORMAL_BIAS =  0.01;  // offset along surface normal — prevents acne on sloped faces
NCZ.SHADOW_MIN_ELEV    =    5;   // degrees — shadow casting disabled below this sun elevation
                                  // (avoids infinitely long degenerate projections near sunrise/sunset)

// Lighting — directional sun + ambient
NCZ.AMBIENT_INTENSITY  = 0.35;   // ambient light share; sun gets (1 - ambient) when at full elevation
NCZ.SUN_DIST           = 8000;   // distance from world centre to directional light position (CET units)
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
