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
    logo: "assets/img/nightcorp-logo.svg",
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

// Data API (B7) — the site consumes the server-built /v1 dataset instead of
// running the Nexus auto-discovery merge client-side. Base URL is chosen by
// hostname so environments line up with the API's: prod → prod API; everything
// else (dev.nczoning.net, *.pages.dev previews, localhost) → staging API.
NCZ.API_BASE =
  location.hostname === "nczoning.net" || location.hostname === "www.nczoning.net"
    ? "https://api.nczoning.net"
    : "https://api-dev.nczoning.net";
// { etag, data } for the full-locations list. Freshness is driven by the ETag
// (If-None-Match → 304), not a TTL, so this is stored raw rather than via the
// TTL-based cacheGet/cacheSet.
NCZ.API_LOCATIONS_CACHE_KEY = "nc_api_locations_full";

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

// District icon atlas (district_icons.png, 1192×256) — UV rects (Left/Top/
// Right/Bottom) for the `_large` icon of each district, extracted from
// district_icons.inkatlas. The icons are pre-coloured per district (Watson red,
// etc.), so they render as-is. Used by the hover info panel (NCZ.DistrictInfo).
NCZ.DISTRICT_ICON_ATLAS = {
  src: "assets/img/district_icons.png",
  w: 1192,
  h: 256,
  parts: {
    city_center:    { l: 0.45302, t: 0.40234, r: 0.54614, b: 0.76563 }, // ico_district_center_large
    watson:         { l: 0.43121, t: 0.00391, r: 0.51342, b: 0.38672 }, // ico_district_watson_large
    westbrook:      { l: 0.06711, t: 0.00391, r: 0.16443, b: 0.45703 }, // ico_district_westbrook_large
    heywood:        { l: 0.00084, t: 0.48438, r: 0.09815, b: 0.93750 }, // ico_district_heywood_large
    santo_domingo:  { l: 0.25671, t: 0.00391, r: 0.34060, b: 0.39453 }, // ico_district_domingo_large
    pacifica:       { l: 0.34396, t: 0.00391, r: 0.42785, b: 0.39453 }, // ico_district_pacifica_large
    dogtown:        { l: 0.54950, t: 0.35547, r: 0.64262, b: 0.71875 }, // ico_district_dogtown_large
    ncx_morro_rock: { l: 0.27852, t: 0.41016, r: 0.36242, b: 0.80078 }, // ico_district_morro_rock_large
    badlands:       { l: 0.19128, t: 0.41016, r: 0.27517, b: 0.80078 }, // ico_district_badlands_large
  },
};
// (The atlas also has north/south badlands icons, but in TweakDB all of our
//  badlands subdistricts belong to the central Districts.Badlands, so we only
//  use the central badlands icon — see the district-info panel.)

// Badlands has no district polygon, so its name label has no centroid to sit at.
// Hand-placed CET [x, y] in an open patch of the badlands (maintainer-chosen);
// world (x,0,-y) in the 3D scene. Note y is negated from the three-space target.
NCZ.BADLANDS_LABEL_CET = [2957.33, -691.04];

// Overlay zoom thresholds (Leaflet zoom levels)
NCZ.DISTRICT_ZOOM_THRESHOLD = 3;  // below = districts only, above = subdistricts

// District border appearance — shared between SAT (Leaflet) and SCHEMA (Three.js)
NCZ.DISTRICT_LINE_WIDTH     = 4;  // px — main district borders
NCZ.SUBDISTRICT_LINE_WIDTH  = 3;  // px — subdistrict borders
// Faint baseline matches the in-game inkLinePatternWidget.opacity (5%); the
// hover-brighten state fades to ~full over 250 ms. See
// wiki/sources/district-outline-widget.md.
NCZ.DISTRICT_LINE_OPACITY        = 0.05;
NCZ.DISTRICT_LINE_OPACITY_HOVER  = 1.0;
NCZ.DISTRICT_HOVER_FADE_MS       = 250;

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
NCZ.SHADOW_MAP_SIZE      = 8192;  // px² — ~1.5 u/texel at a whole-city zoom, razor-sharp zoomed in. Always-on (interactive + showcase): the fine texels keep the showcase's fast sun from shimmering. One fixed size, not resized per-mode (maintainer call).
NCZ.SHADOW_MAX_DISTANCE  =  8600; // CET units — cap on the footprint half-side. Matches the world half-diagonal (sqrt((WORLD_MAX_X-WORLD_MIN_X)² + (WORLD_MAX_Y-WORLD_MIN_Y)²) / 2 ≈ 8565 wu) with tiny headroom: nothing renders past the world bounds, so a larger cap just stretches texels over empty void. Trace data on PR #656 showed `half` pinned at the cap (12600 = 12000 cap + 600 margin) every showcase frame; reducing the cap shrinks the box uniformly → ~1.4× sharper texels for free at no performance cost.
NCZ.SHADOW_GROUND_MARGIN =   600; // CET units the footprint extends past the visible ground — covers building heights / terrain relief + a sliver of just-off-screen casters. Wider off-screen-caster coverage waits on the union-frustum cull (a follow-up).
NCZ.SHADOW_SIZE_QUANTUM  =  1.10; // multiplicative ladder the ortho box half-side snaps UP to, so texel size is piecewise-constant. The texel snap (updateShadowCamera) only cancels swim while texelSize holds frame-to-frame; pan/azimuth already keep `half` constant (sphere fit), but tilt + zoom change it continuously. Quantising holds the box on one rung across a slow tilt, trading continuous edge shimmer for an occasional ~10% resolution step. Smaller (→1.0) = sharper/adaptive but reintroduces swim; larger = more stable but coarser/poppier.
NCZ.SHADOW_RADIUS          = 1;   // PCFSoftShadowMap blur kernel (texels) for the interactive schema cam — 1 keeps shadows crisp. NOTE: a fixed-width blur, NOT physical penumbra (a DirectionalLight has zero angular size → no real penumbra/antumbra; distance-dependent softening would need PCSS).
NCZ.SHADOW_RADIUS_SHOWCASE = 4;   // wider blur during the showcase only. The fly cam can't use the texel snap (flyover arcs the sun every frame → no frame-coherent texel lattice), so its moving-sun edge-crawl is hidden by softening the edge instead. Higher = softer/less shimmer but mushier contact.
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
// to the endpoints. Tune the two ends: row 0 = deep-night floor, the [0,…] row
// = horizon cap (dawn/dusk), last row = midday base.
//
// Below the horizon (negative elevation) the night lighting takes over — a dim
// cool moon key + warm skyglow ambient (see MOON_* / AMBIENT_*_NIGHT). Exposure
// backs OFF from the dawn/dusk peak so the (already much dimmer) night radiance
// reads dark-but-readable rather than being lifted into a washed-out "day".
NCZ.SCENE_EXPOSURE_CURVE = [
  [-18, 0.68],  // astronomical night — dark but readable (lifted a touch for moonless-night legibility; calibrate live with ?night)
  [-6,  0.78],  // civil/nautical twilight transition
  [0,   0.95],  // horizon (sunrise/sunset) — capped lift so it stays atmospheric, not daylight
  [5,   0.80],
  [15,  0.58],
  [30,  0.49],
  [50,  0.45],  // calibrated midday base — natural variation comes from the sun, not exposure
  [90,  0.45],
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

// ── Bloom — the in-game 3D map's post-process glow (envparam BloomAreaSettings,
// base/weather/24h_basic/3dmap.envparam, decoded). It runs on the *linear* HDR
// scene before the ACES tonemap: the scene renders through a RenderPipeline
// (pass → bloom → composite → tonemap). Here it's a NIGHT effect — strength is
// faded in by nightFactor (updateDayNightLighting) so daytime stays bloom-free
// (the parked daytime concern: day buildings render equiluminant with terrain →
// flat haze; night gives bloom genuine bright-against-dark window/neon sources).
// Decoded BloomAreaSettings: bloomColorScale 1, blurSizeX/Y 1, luminanceThreshold
// Min 0 / Max 0.35, numDownsamplePasses 6, sceneColorScale 0.9. STRENGTH/RADIUS
// are partly REDengine units with no 1:1 Three.js mapping — calibration knobs.
NCZ.BLOOM_STRENGTH     = 0.4;   // envparam bloomColorScale (decoded 1.0) — pulled back further now the city glow carries the night look. NIGHT peak.
NCZ.BLOOM_DAY_STRENGTH = 0.12;  // daytime baseline — bloom never fully off; the night ramp eases up from here (see updateDayNightLighting)
NCZ.BLOOM_RADIUS       = 1.0;   // envparam blurSizeX/Y — pyramid blur spread (0..1, calibration knob)
NCZ.BLOOM_THRESHOLD    = 0.1;   // raised off the decoded 0.0 so only the brighter window/neon cores bloom (less overall haze)
NCZ.BLOOM_SMOOTH_WIDTH = 0.35;  // luminanceThresholdMax − Min — knee width to full bloom weight
NCZ.SCENE_COLOR_SCALE  = 0.9;   // envparam sceneColorScale — base scene dims to 0.9 at full night; bloom adds the energy back

// ── Atmospheric haze (Night) ────────────────────────────────────────────────
// A SECOND, wide, low-threshold bloom layer that spreads the lit windows/signage
// into a broad soft glow — the night light-pollution haze in the reference
// shots. Separate from the tight bloom above so crisp glints and wide haze tune
// independently. Night-only (strength = nf² · HAZE_STRENGTH; no daytime light
// pollution). Tune live with ?night.
NCZ.HAZE_STRENGTH     = 0.5;    // night-peak haze glow strength
NCZ.HAZE_RADIUS       = 1.0;    // max mip spread — the wide, soft falloff
NCZ.HAZE_THRESHOLD    = 0.05;   // low, so haze comes from the actual lights (not dark terrain)
NCZ.HAZE_SMOOTH_WIDTH = 0.6;    // soft knee — gentle ramp into the haze contribution

// ── Night Stage 2 — procedural lit windows ──────────────────────────────────
// At night the buildings light up like a real city: a world-space window grid on
// the vertical facades, each cell hash-lit on/off, warm-white-dominant with
// scattered neon accents. Emissive ONLY — the building albedo (theme colour) is
// never touched. Ramped by nightFactor; bloom (above) gives the windows their
// halo so they read as lights, not flat dots. World-space so window size is
// constant and taller/wider buildings simply have more of them. First-cut;
// calibrate live with ?night.
// CELL SIZE IS A LEGIBILITY KNOB, and it is worth being clear that it is one.
//
// The game's room is 3 x 4 m. Ours is 24 x 18 CET — about 8 rooms wide by 4.5 floors
// tall. That looks like a 6x error and it is not: because the lit AREA is
// `paneArea x P(lit)` and the pane is sized from the district's measured glass share,
// the average brightness is IDENTICAL at any cell size. The cell only decides how big
// each window blob READS at map zoom. At a true 3 x 4 m a cell is far under one pixel
// when zoomed out, the grid dissolves into a flat wash, and the city loses its window
// texture entirely — which is the whole reason this is coarse.
//
// So: not measured, not pretending to be. Tune for how it looks. URL: ?wincellw/?wincellh
NCZ.WINDOW_CELL_W        = 24;    // CET units — horizontal spacing of one window cell along a facade
NCZ.WINDOW_CELL_H        = 18;    // CET units — vertical spacing (≈ one floor)
// ── DEPRECATED. Legacy path only (?winmodel=legacy). ─────────────────────────
// The pane is no longer a constant: its AREA is the district's measured glass share and
// its SHAPE is the game's measured window aspect (WINDOW_PANE_ASPECT). A fixed 0.55 x
// 0.55 gave every district in the city identically-sized square windows, which is
// precisely the district signal the rebuild exists to restore.
NCZ.WINDOW_PANE_W        = 0.55;  // lit fraction of a cell horizontally (rest is dark mullion/frame)
NCZ.WINDOW_PANE_H        = 0.55;  // lit fraction of a cell vertically
NCZ.WINDOW_INTENSITY     = 2.0;   // emissive brightness of a lit window at full night (pre-bloom, pre-tonemap). Windows are night-only.
NCZ.WINDOW_TINT_FRACTION = 0.45;  // fraction of lit windows that use a NON-default light temperature (rest = WINDOW_COLORS[0]); the colourful neon now lives in signage, windows are just warm/cool whites
// Which surfaces get windows: only instances taller than this get the treatment,
// so flat/low structures (overpasses, walls, kiosks, ground clutter) stay dark —
// not everything in the building cloud is a windowed tower. Value is the instance
// matrix's Y-axis half-extent in CET units (length of column 1); soft-gated over
// a band above it. Landmarks/monuments use a different material and never get windows.
NCZ.WINDOW_MIN_HEIGHT   = 22;     // CET units (instance Y half-extent) below which a building stays dark
NCZ.WINDOW_HEIGHT_BAND  = 12;     // soft-gate width above the threshold (full windows by MIN_HEIGHT+BAND)

// ── Archetype rules — WHICH buildings get lit, and how densely ──────────────
// The height gate above is the first filter; this is the second. Each instance
// is classified purely from its own matrix (no per-building data needed):
//   verticality = Yhalf / max(Xhalf, Zhalf)   — slender ⇒ tower, squat ⇒ block
//   footprint   = max(Xhalf, Zhalf)            — horizontal half-extent (CET)
// Towers (tall + slim) get DENSE windows; mid blocks get SPARSE windows; broad
// low masses (podiums, parking, malls, industrial sheds, stadiums) are pushed
// dark even if they clear WINDOW_MIN_HEIGHT — so "not everything is a windowed
// tower" holds. All continuous (smoothstep) so there are no hard class edges.
NCZ.ARCH_VERTICALITY_LO   = 0.6;  // ≤ this verticality reads as a broad block (sparse windows)
NCZ.ARCH_VERTICALITY_HI   = 1.8;  // ≥ this reads as a slender tower (dense windows + brighter)
NCZ.ARCH_FOOTPRINT_BIG    = 90;   // CET half-extent: a non-slim mass this broad starts reading as podium/industrial
// Height veto on podium/industrial: a genuinely TALL mass is never a podium,
// however broad — a big-footprint skyscraper is a lit building, not a dark
// podium. Only LOW broad squat masses (malls, parking, sheds, oil tanks) stay
// industrial. Ramp on the BUILDING's height half-extent (bAttr.x, CET): below LO
// full podium eligibility, above HI never podium. (Measured: real low podiums
// sit < ~45 heightHalf; misclassed tall masses were 100–200+.)
NCZ.ARCH_PODIUM_HEIGHT_LO = 45;   // heightHalf below which a broad squat mass can read as podium
NCZ.ARCH_PODIUM_HEIGHT_HI = 85;   // heightHalf above which a mass is never podium (lit block/tower)
NCZ.ARCH_TOWER_BOOST      = 1.35; // tower windows this much brighter than block windows
// (B) Shape discriminators — the layer is the whole built environment, not just
// buildings. A real windowed building is reasonably WIDE on its narrow side and
// not too ELONGATED. These cull the infrastructure that geometry alone confuses
// with towers/blocks:
//   minFoot  = min(Xhalf, Zhalf)   — narrow-side half-extent. Below MIN_FOOTPRINT
//     ⇒ pole / bridge pillar / wind turbine / thin wall → dark.
//   elong    = maxFoot / minFoot   — above MAX_ELONGATION ⇒ wall / bridge deck /
//     container row / pipe → dark.
NCZ.ARCH_MIN_FOOTPRINT    = 8;    // CET narrow-side half-extent floor for "a building"
NCZ.ARCH_MAX_ELONGATION   = 4;    // maxFoot/minFoot above which a box reads as linear infrastructure
// Block clustering: the .dds has no building grouping — buildings are clusters of
// adjacent boxes (thin slabs etc.). At load we union boxes whose world AABBs are
// within this gap (CET) into one "building", then classify per BUILDING (a thin
// slab inherits its building's height/footprint) instead of per box. Bigger gap =
// merges across wider seams (risks fusing neighbours); smaller = more fragments.
NCZ.BUILDING_CLUSTER_GAP  = -2;   // LEGACY (union-find): kept as the tuning-harness baseline; the live path now uses height-discontinuity segmentation below.
// Building segmentation (height-discontinuity) — REPLACES the percolating
// union-find above. Adjacent .dds boxes share footprints with no street gap (the
// dense downtowns collapse to ONE megablob under union-find), but their ROOF
// heights resolve individual buildings. We rasterise box tops onto a CET ground
// grid (BUILDING_SEG_CELL) and region-grow: 8-adjacent cells join one building
// only if their roof heights are within BUILDING_SEG_DH; a taller-than-DH cliff
// is a boundary. Morphology-agnostic (flat / round / horizontal / vertical all
// segment as one region). Tiny roof-step slivers (< BUILDING_SEG_MIN_CELLS) are
// absorbed into the neighbour they border most. See scripts/tune_segment.js +
// _lighting_demo/tune/ for the derivation/renders. Larger DH = coarser (fewer,
// bigger buildings); uniform-height low-rise sprawl stays merged either way.
NCZ.BUILDING_SEG_CELL      = 8;    // ground-grid cell (CET)
NCZ.BUILDING_SEG_DH        = 18;   // roof-height cliff (CET) that separates two buildings
NCZ.BUILDING_SEG_MIN_CELLS = 3;    // regions smaller than this (cells) get absorbed into a neighbour
// Connectivity gate on the height-split. Height-splitting is ONLY needed to crack
// the percolated downtown megablob (one giant footprint-connected component of
// tens of thousands of cells). An ISOLATED structure is its own small component
// and must stay one building, however much its roof varies (e.g. Kujira — a ship
// with a tall superstructure + low deck + masts — was being cut into 3). So a
// footprint-component at/below this many cells is kept WHOLE (connectivity only);
// only larger components get height-split. Measured: dense districts have ONE
// component > ~18000 cells, every other structure < ~700.
NCZ.BUILDING_SEG_KEEP_WHOLE = 1200;
// Mega-blob SPLIT. The height segmenter still percolates FLAT, same-roof-height
// areas with no street gaps (Watson core, the spaceport apron, agri farms) into a
// single building spanning 1000+ CET — which mis-classifies and grabs one giant
// billboard. After segmentation, any region whose footprint SPAN exceeds
// BUILDING_SPLIT_MIN_SPAN (CET, full extent) is chopped into BUILDING_SPLIT_CELL
// world-grid chunks. Pure spatial chop (a flat plateau carries no split signal);
// the span gate spares tall megabuildings (compact footprint, many boxes). Set
// BUILDING_SPLIT_CELL = 0 to disable. URL: ?splitcell= / ?splitmin=.
NCZ.BUILDING_SPLIT_CELL     = 200;  // world-grid chunk size (CET) for chopping oversized regions
NCZ.BUILDING_SPLIT_MIN_SPAN = 900;  // region footprint span (CET) above which the chop fires
// ROAD-aware segmentation. The building footprint has no street gaps; the road
// network (3dmap_roads.glb) supplies the street grid. At load the roads are
// rasterised into a coverage grid; segmentBuildings carves road-covered cells that
// are STRUCTURALLY THIN (roof-floor < BUILDING_ROAD_CLEARANCE — a surface street /
// podium deck, not a real building) so region-grow can't merge buildings across a
// street → buildings separate by CITY BLOCK. Thickness-gated, so a building OVER a
// tunnel / UNDER an elevated highway is kept whole. Validated headless: largest-
// building share santo_domingo 65→5%, watson 71→21%, pacifica 68→20%. See wiki
// learnings/roads-as-segmentation-barriers. URL: ?roadcarve=0 / ?roadclear= .
NCZ.BUILDING_ROAD_CARVE     = 1;    // 0 = disable road-barrier segmentation
NCZ.BUILDING_ROAD_CLEARANCE = 40;   // CET roof-floor; below = thin street-level (carve), above = building (keep)
NCZ.BUILDING_ROAD_DILATE    = 1;    // widen road coverage by N grid cells (roads are thin)
// Tower-on-podium CONTAINMENT MERGE. The height split cuts a tall column (tower)
// from the lower base/apron (podium) it rises from → one building shows as two
// segments. Re-join a segment into the LOWER neighbour it SITS ON: the dominant
// neighbour is lower by > BUILDING_SEG_DH AND borders > FRAC of the segment's
// perimeter (the podium wraps the tower base). Side-by-side buildings touch along
// one edge only (< FRAC) so they DON'T merge. URL: ?podmerge=0 / ?podfrac= .
NCZ.BUILDING_PODIUM_MERGE      = 1;    // 0 = disable
NCZ.BUILDING_PODIUM_MERGE_FRAC = 0.45; // min fraction of a segment's perimeter bordering its podium to merge
// ── PART level (sub-building strata) ─────────────────────────────────────────
// A building is the unit the user names ("that tower"); a PART is the unit that
// emits light coherently — a tower, the podium it rises from, a mast, a fuel
// sphere. Parts are the same roof-cliff region-grow the building pass runs, with
// the BUILDING_SEG_KEEP_WHOLE reprieve REMOVED (isolated structures get split
// too) and no podium merge, then intersected with the final building label so a
// part never straddles a building boundary.
//
// Building = connectivity + keep-whole + DH + podium merge + zone merge + split.
// Part     = connectivity + DH (always) + absorb, ∩ building.
//
// Parts exist because class is a per-PART property: the podium is dark, the tower
// on it is lit. BUILDING_PODIUM_MERGE stays on — it is still correct for the
// building level — but the labels it unions are exactly the parts we keep.
// URL: ?partdh= (visualise with ?partdebug).
NCZ.BUILDING_PART_DH = 18;   // roof-height cliff (CET) that separates two PARTS of one building
// (A) World-region suppression — CET rects [minX, minY, maxX, maxY] where windows
// are forced off (ocean / oil fields / industrial zones the geometry can't tell
// apart). Empty = no-op. Compile-time (rebuild materials to apply). Fill from the
// map's coordinate readout. World→CET in shader: cetX = worldX, cetY = -worldZ.
NCZ.WINDOW_SUPPRESS_ZONES = [];
// (A) Per-DISTRICT window density — keyed by the TRUE district polygon
// (data/subdistricts.json), NOT the .dds cloud (which bleeds across boundaries:
// Pacifica's cloud holds Badlands boxes). Rasterized into a CET-space mask
// texture at load; the building shader samples it by world position and scales
// the window emissive by this 0..1 multiplier. So this is regional coverage on
// top of the per-box shape heuristic above. `_default` = anywhere outside every
// polygon (ocean / unzoned) → dark. Tune per district; reload to re-rasterize.
// Badlands is broadly dark here; specific lit spots come later via the polygon
// exception system.
// Feather distance (CET) for the density mask — after the polygons are painted,
// the mask is blurred by this radius so the glow/windows fall off SMOOTHLY past
// district edges (a light-pollution halo bleeding into the surroundings) instead
// of a hard polygon cutoff. Bigger = softer, wider bleed. 0 = hard edges.
NCZ.DISTRICT_MASK_FEATHER_CET = 1250;
NCZ.DISTRICT_NIGHT_DENSITY = {
  city_center:    1.0,
  watson:         1.0,
  westbrook:      0.95,
  heywood:        0.9,
  santo_domingo:  0.8,
  pacifica:       0.7,
  dogtown:        0.85,
  ncx_morro_rock: 0.4,
  badlands:       0.15,
  _default:       0.0,
};
// ── Per-subdistrict SIGN-DENSITY profile (Night Phase A) ─────────────────────
// The night look was uniform — Kabuki, City Center and Santo Domingo rendered the
// same neon. This MULTIPLIER scales the per-building sign GATES (SIGN_SPECKLE/
// BUILDING/PODIUM_FRACTION) so each district carries more or fewer signed buildings
// — true density, not a brightness dim. 0 ⇒ no neon at all (kills the industrial-
// zones-shouldn't-glow bug for Northside / spaceport / Badlands).
//
// VALUES are the LLM-VERIFIED bands from the local-LLM tagger (127 in-game shots →
// per-subdistrict `_feel.md`; see wiki/concepts/local-llm-offload.md +
// night-city-district-model.md). **1.0 = the LOUDEST district (Kabuki)** — i.e. the
// tuned baseline signage params ARE the loudest look, everything scales DOWN from
// there. Bands: loudest 1.0 · high 0.8 · low 0.3 · suppress 0.0. `sign_density` is
// the STRONG (trusted) signal; the big correction vs the old eyeball model is that
// corpo/commercial is DENSE (high 0.8), not "medium" — only industrial/rural/
// spaceport are suppressed.
//
// Keyed by subId; falls back to the districtId key (district-level tags like dogtown
// / ncx_morro_rock with no subdistrict polygon, AND any unlisted subId → its parent-
// district band), then SIGN_DENSITY_DEFAULT. subIds and districtIds never collide,
// so one flat map serves both. Looked up per BUILDING at load (polygon-based subId of
// its centroid) → baked into a per-instance buffer. URL ?nosignprof bakes a flat 1.0.
NCZ.SIGN_DENSITY_PROFILE = {
  // ── Loudest (1.0) — neon IS the district ──
  kabuki:             1.0,   // gaudy magenta/red, vertical strips, lanterns
  little_china:       1.0,   // cooler — blue/cyan/white/magenta
  japan_town:         1.0,   // big video billboards (cyan/orange/red/blue)
  // ── High (0.8) — dense commercial / corpo (the corrected band) ──
  corpo_plaza:        0.8,   // corpo, cleaner geometric (cyan/blue/white)
  downtown:           0.8,
  charter_hill:       0.8,   // denser than first thought
  vista_del_rey:      0.8,   // heywood commercial
  glen:               0.8,   // heywood
  coastview:          0.8,   // pacifica — warmer + more lit than the "ruin" guess
  rancho_coronado:    0.8,   // Santo Domingo — the AD-TOWERS (big billboards), NOT bare
  // ── Low (0.3) — industrial/calmer with a little neon ──
  arroyo:             0.3,   // industrial (red/amber/orange)
  wellspring:         0.3,   // calmer (blue/orange/amber)
  // ── Suppress (0.0) — industrial / rural / spaceport: no commercial neon ──
  northside:          0.0,   // INDUSTRIAL docks, dark
  north_oak:          0.0,   // quiet residential hills
  laguna_bend:        0.0, red_peaks: 0.0, rocky_ridge: 0.0, sierra_sonora: 0.0,
  vasquez_pass:       0.0, jackson_plains: 0.0, rattlesnake_creek: 0.0,
  biotechnica_flats:  0.0, north_sunrise_oil_field: 0.0, socal_border_crossing: 0.0,
  // ── District-level fallbacks (null subId, or unlisted subId → parent band) ──
  dogtown:            0.8,   // decayed-dense PL (green/hot-pink/cyan); high band
  ncx_morro_rock:     0.0,   // spaceport apron — bare
  badlands:           0.0,   // rural
  city_center:        0.8,   // corpo
  watson:             0.8,   // unlisted: arasaka_waterfront (corpo waterfront)
  westbrook:          0.8,   // unlisted: north_oaks_casino (bright)
  heywood:            0.6,   // mixed (vista/glen high, wellspring low)
  santo_domingo:      0.3,   // mixed, lean industrial
  pacifica:           0.6,   // unlisted: west_wind_estate (quieter than coastview)
};
// ── MEASURED night profile (data/night-profile.json) ─────────────────────────
// Generated by scripts/night_analyse.js from the raw streaming-sector dump (2.49M
// placed nodes). Fetched at scene load; every field below reads through it.
//
// It is FETCHED, not code-generated into this file, on purpose. A generator writing
// into the file we hand-tune would make "measured vs tuned" a DIFF instead of a
// SWITCH — and the two must be able to disagree in public. SIGN_DENSITY_PROFILE
// above (LLM-verified over 127 shots) and the measured sign ordinal in the profile
// are two measurements of DIFFERENT THINGS; where they disagree that is a finding,
// not a merge conflict.
NCZ.NIGHT_PROFILE_URL = "data/night-profile.json";
// The per-box window bake — one byte per building INSTANCE: the real glass area the game
// places on that box, over the box's facade area.
//
// ONE PER ASSET SET, and that is not an optimisation — it is a correctness requirement.
// The vanilla and Fixed clouds are different geometry (271,022 vs 263,258 boxes; the Fixed
// set is a rebuild, not a nudge), and this data is indexed by instance. Cross-applying them
// yields a city that is wrong in a way that still looks like a city.
//
//   node scripts/window_boxes.js --set fixed   --margin 6 --assign near --bake
//   node scripts/window_boxes.js --set vanilla --margin 6 --assign near --bake
NCZ.WINDOW_BOXES_URL = (set) => `data/window-boxes-${set === 'fixed' ? 'fixed' : 'vanilla'}.json`;
NCZ.WINDOW_BOXES_BIN_URL = (set) => `data/window-boxes-${set === 'fixed' ? 'fixed' : 'vanilla'}.bin`;

// ── ROUTE A: the game's REAL facade panels (?winmodel=panels) ───────────────
// 129,299 glass-bearing meshes at their exact world transforms — no box cloud, so no
// facade-area denominator to get wrong. Generated by `node scripts/window_panels.js --bake`.
// Asset-set independent: these are the GAME's panels, not our decoded boxes.
NCZ.WINDOW_PANELS_URL = "data/window-panels.json";
NCZ.WINDOW_PANELS_BIN_URL = "data/window-panels.bin";

// The game's own window module, in METRES — measured from the material's roomWidth /
// roomHeight (3 x 4 m), NOT the same thing as WINDOW_CELL_W/H (24 x 18 CET), which is a
// map-zoom legibility knob for painting windows across a whole building. On a real panel the
// grid must tile at the real room size or a 1.3 m kit piece draws nothing at all.
NCZ.WINDOW_ROOM_W = 3.0;
NCZ.WINDOW_ROOM_H = 4.0;
NCZ.NIGHT_PROFILE = null;   // filled by ThreeScene at load; null ⇒ every lookup falls back

// Which glass-share column the renderer believes. URL: ?glasssrc=
//   'panel' — glass AREA / facade AREA over kit PANELS only. THE TRUSTED ONE: it is
//             the only column where "this mesh is glass" is true of the whole mesh.
//   'area'  — the same without excluding bespoke part-glass megameshes, whose entire
//             facade lands in one bucket. Kept for A/B; it craters Corpo Plaza.
//   'count' — the original instance-count share. Kept for A/B; it made Charter Hill
//             the glassiest district in the city (35.6%), which the footage denies.
NCZ.GLASS_SHARE_SOURCE = "panel";

// HAND-TUNED glass-share overrides, per subId — the PEER of SIGN_DENSITY_PROFILE,
// not its replacement. EMPTY BY DESIGN: every entry added here is a claim that the
// maintainer's footage beats the sector data, and it must carry a comment saying why.
// The measurement has a known blind spot — bespoke part-glass megameshes cannot be
// apportioned (see `bulkArchShare` in the profile; Corpo Plaza is 24% unapportionable)
// — so this map is where that blind spot gets corrected BY HAND, visibly, and not by
// quietly bending the measurement until it agrees with intuition.
NCZ.GLASS_SHARE_OVERRIDE = {
  // little_china: 0.20,   // e.g. "footage shows near-full glass frontage; measured 0.067"
};
// Buildings tagged to no polygon (ocean / unzoned): no glass ⇒ dark.
NCZ.GLASS_SHARE_DEFAULT = 0.0;
// Global multiplier on every glass share — the one look knob on the window model,
// for pulling the whole city up or down without touching the measured ratios BETWEEN
// districts. URL: ?glassgain=
NCZ.GLASS_SHARE_GAIN = 1.0;

// Fraction of the windows INSIDE glass that are lit at night. MEASURED, not chosen:
// window_parallax_interior.mt's `AmountTurnOffAtNight`, area-weighted across every
// placed window material — mean 0.4464, so lit = 1 - 0.4464.
//
// READ THE NAME: it is the fraction that go DARK, not the fraction that stay lit. At
// the modal 0.5 the two readings coincide exactly, which is why the ambiguity went
// unnoticed. The outliers disambiguate it — a value of 0 means "none turn off" (a
// lobby lit all night), which is sensible; under the other reading it would mean a
// window material that is NEVER lit, which is not a thing.
//
// 0.5 covers 97% of placed glass area (0.2 and 0 make up the rest), so the handover's
// "identical for every archetype" is not LITERALLY true — but by area the outliers are a
// rounding error and one global constant is defensible. If the look is ever wrong, THIS
// is where a per-archetype term genuinely belongs. It is not a knob. URL: ?litglass=
NCZ.WINDOW_LIT_IN_GLASS = 0.5126;

// The game's window ASPECT RATIO (width ÷ height). MEASURED: the dominant glass module is
// 3 m wide × 4 m tall — exactly the room (roomWidth 3 on 91% of placed glass area,
// roomHeight 4 on 99%). A room-sized pane of glass, PORTRAIT, not a letterbox.
//
// An earlier reading of this said 2.14 (a wide 3.0 × 1.4 m ribbon) and it was upside
// down: it came from the era when object size was inferred from `worldNode.Bounds`, a
// field populated on 1.9% of nodes. Same trap as everything else that broke that day —
// see wiki/learnings/node-bounds-is-a-2-percent-sample. URL: ?winaspect=
NCZ.WINDOW_PANE_ASPECT = 0.75;   // 3 ÷ 4

// Which window model the shader compiles. URL: ?winmodel=glass|legacy
//   'glass'  — the measured model. Cell = a facade grid; the PANE inside each cell is
//              sized by the district's glass share (area) and the game's window aspect
//              (shape); a cell is lit at WINDOW_LIT_IN_GLASS, at random. Default.
//   'legacy' — the pre-rebuild look: fixed 0.55 x 0.55 panes, a flat 0.20 lit fraction
//              everywhere, WINDOW_COHERENCE/COLUMN_COHERENCE. Kept ONLY so the two can
//              be A/B'd on the same camera; delete it once the new model is signed off.
// The branch is read in JS, so the unused model emits no shader nodes and costs nothing.
NCZ.WINDOW_MODEL = "glass";
// `panels` = Route A: windows drawn on the game's REAL facade panels at their exact world
// transforms, with the box cloud's own window pass switched off. No facade-area denominator.
NCZ.WINDOW_MODELS = ["glass", "legacy", "panels"];

// Resolve a building's glass share: hand-tuned override → the measured profile →
// default. Mirrors signDensityFor's subId-then-districtId fallback exactly.
NCZ.glassShareFor = function (subId, districtId) {
  const o = NCZ.GLASS_SHARE_OVERRIDE;
  if (subId != null && o[subId] !== undefined) return o[subId];
  if (districtId != null && o[districtId] !== undefined) return o[districtId];
  const p = NCZ.NIGHT_PROFILE;
  if (!p) return NCZ.GLASS_SHARE_DEFAULT;
  const key = NCZ.GLASS_SHARE_SOURCE === "count" ? "glassShareCount"
            : NCZ.GLASS_SHARE_SOURCE === "area"  ? "glassShareArea"
            : "glassSharePanel";
  const r = (subId != null && p.subdistricts?.[subId])
         || (districtId != null && p.districts?.[districtId]);
  return r ? (r[key] ?? NCZ.GLASS_SHARE_DEFAULT) : NCZ.GLASS_SHARE_DEFAULT;
};

// Buildings tagged to no zone (ocean / unzoned): no signage.
NCZ.SIGN_DENSITY_DEFAULT = 0.0;
// Resolve a building's sign-density multiplier: subId first, then districtId, then
// the default. Both may be null (untagged) → default.
NCZ.signDensityFor = function (subId, districtId) {
  const p = NCZ.SIGN_DENSITY_PROFILE;
  if (subId != null && p[subId] !== undefined) return p[subId];
  if (districtId != null && p[districtId] !== undefined) return p[districtId];
  return NCZ.SIGN_DENSITY_DEFAULT;
};

// Fraction of a building's window CELLS that are lit at night.
//
// TWO NUMBERS MULTIPLY, and conflating them is the trap:
//
//   1. The game lights 50% of the windows IN A WINDOW PANEL.
//      (base\materials\window_parallax_interior.mt → `AmountTurnOffAtNight` = 0.5.
//       Identical for every archetype — Entropism apartment/office/industrial,
//       Militarism office, Neokitsch apartment. CDPR does NOT vary it by district.)
//
//   2. But a window panel is only PART OF A FACADE. Buildings are kit-bashed from
//      modular pieces, and only some of them are windows; the rest are solid wall.
//      Measured from the streaming sectors (LOD0 window vs wall panels):
//         Kabuki    38.9% of facade pieces are window panels
//         Arroyo    10.5%
//         Northside  0.0%   ← a genuinely windowless factory district
//
// Our shader stamps a uniform grid over the WHOLE facade, so our cell fraction has
// to carry BOTH terms:
//
//      lit_cells  =  window_panel_share  ×  0.5
//
// Kabuki — the densest district in the city — therefore lands at ~0.19, not 0.50.
// 0.50 was the count of lit windows *within the glass*, applied as though the entire
// building were glass. It lit the city like a lantern.
//
// 0.20 below is the Kabuki CEILING used as a global stand-in. It is too high for most
// of the city and flat wrong for Northside (which should be 0.00). The per-subdistrict
// values come from scripts/wkit/scan_signage.wscript (window vs wall panels per sector,
// binned into subdistrict polygons) — that is the real fix, and it is also where the
// district variation genuinely lives.
//
// History: these were 0.020 / 0.006, twenty-five times darker still. That was
// compensation for the interior-face bug (the emissive stamped windows onto every
// buried face of the box soup, ~80% of all wall area). Facemask v2 fixed the bug;
// nobody undid the compensation.
// URL: ?night&winlit= / &winlitb=
//
// ── DEPRECATED. Legacy path only (?winmodel=legacy). ─────────────────────────
// Superseded by the measured model: the district's GLASS SHARE (per-subdistrict, from
// data/night-profile.json) x WINDOW_LIT_IN_GLASS (0.5536, from the game's own material).
// The comment above got the STRUCTURE right — two numbers multiply — and both numbers
// wrong. It also guessed the wrong shape for the second one: `AmountTurnOffAtNight` is
// the fraction that go DARK, so lit = 1 - it, not it.
//
// The measured per-subdistrict shares (glass AREA / facade AREA, over kit panels):
//   rancho_coronado 26.6%   charter_hill 17.4%   corpo_plaza 10.7%
//   downtown        19.2%   japan_town   14.7%   kabuki        6.5%   northside 0.7%
// So 0.20 was not "the Kabuki ceiling" — it was roughly TRIPLE Kabuki's real share, and
// ~30x Northside's. Nothing about it was right except that it was a single number, which
// was the actual bug.
NCZ.WINDOW_LIT_FRACTION_TOWER = 0.20;
NCZ.WINDOW_LIT_FRACTION_BLOCK = 0.20;
// Floor/column COHERENCE (0..1). 0 = each window cell lights independently (pure
// per-cell hash — reads as scattered noise). 1 = lit windows cluster into lit
// FLOORS and COLUMNS (a per-row × per-column occupancy scales the local lit
// fraction), so the facade reads as a real window grid lighting by floor. The
// total average lit fraction is preserved at either end; only the spatial
// arrangement changes. URL: ?night&winco=
NCZ.WINDOW_COHERENCE = 0.0;
// Floor-vs-column balance WITHIN the coherence term. The lit-window gate clusters
// by FLOOR (cell.y = world height — identical on all four faces, so a lit floor
// WRAPS around the whole building) and by COLUMN (cell.x = wall-tangent axis —
// different per face). 0 = floor-only ⇒ continuous horizontal ribbons that light
// every side equally (the reference look + fixes "only one side gets windows").
// 1 = the old floor×column PRODUCT ⇒ isolated dots at row/column intersections,
// and sides with few active columns go blank. Mean-preserving at every value.
// URL: ?night&wincol=
NCZ.WINDOW_COLUMN_COHERENCE = 0.25;
// OUTER-SHELL gate (fixes box-soup window noise). A "building" is hundreds of
// OVERLAPPING boxes; the world-space window grid stamps onto interior/back faces
// too → depth-chaotic "circuit-board" noise instead of clean floor-bands. This
// keeps windows only on the OUTER shell, measured as DEPTH ALONG EACH FACE'S OWN
// NORMAL from the building centre, normalised by the narrow half-extent (footMin):
// d̂ = dot(fragXZ − bCenter, faceNormalXZ) / footMinHalf. Outer walls (long or
// short) have d̂ ≳ 1; interior boxes d̂ < 1; back faces negative. A fragment passes
// when d̂ ≥ this threshold (soft ±0.25). Orientation-correct, so it does NOT blank
// the short-end walls of elongated buildings. **-1.0 = OFF** (all faces pass);
// ~0.6 keeps the shell. URL: ?night&winshell=
NCZ.WINDOW_SHELL_GATE = -1.0;
// EXTERIOR-FACE occlusion mask (the ground-truth replacement for the shell gate
// above). At load, computeFaceOccluders() finds each box's 4 largest-overlap
// neighbour boxes; per fragment, the shader probes FACE_EPS in front of the wall
// and darkens windows AND all signage layers where that probe sits INSIDE one of
// those neighbours (exact OBB containment via per-box inverse matrices, so the
// verdict is correct per fragment — a slab poking out past its interpenetrating
// siblings lights exactly where it pokes). Errs LIT by design: a missed 5th+
// occluder leaves a fragment lit BEHIND geometry, which the depth buffer hides.
// 1.0 = full gate, 0 = OFF (compile-time no-op, restores the pre-mask look).
// URL: ?facemask=
NCZ.FACE_MASK_STRENGTH = 1.0;
// CET push-out of the occlusion probe along the fragment normal, so coplanar-
// abutting AND overlapping neighbours count as occluders. Must stay below any
// plausible box thickness or thin neighbours falsely bury walls. URL: ?faceeps=
NCZ.FACE_EPS = 0.35;
// Window light palette (sRGB hex) — interior light TEMPERATURES, not neon. Index 0
// is the default warm-white "lamp" most windows use; the rest are a mix of warm
// and cool whites picked per-window by hash (WINDOW_TINT_FRACTION), so the city's
// windows read like real mixed lighting. Saturated colour belongs to signage, not
// windows.
NCZ.WINDOW_COLORS = ["#ffe8c8", "#fff3e2", "#fbf7ff", "#e8f0ff", "#d2e2ff", "#ffeccf"];

// ── Night Stage 2 — signage ─────────────────────────────────────────────────
// The neon character. Big, sparse, saturated emissive panels on tall facades —
// the opposite of windows (small/dense/dim/warm). Same world-space facade
// technique, but COARSE cells + a per-building "has a sign" gate so signage
// clumps onto a fraction of buildings rather than tiling every face. Reuses the
// archetype + district gate (archMask), so it only lands on real tall buildings
// and respects per-district density. Night-only for now (billboards-on-by-day is
// a later add). Brighter than windows → the main bloom source. Tune with ?night.
NCZ.SIGN_BUILDING_FRACTION = 0.10; // fraction of eligible buildings that carry a BIG ROOF sign (selective — the skyline billboards). URL: ?night&signbf=
// Fraction of eligible buildings that carry the STREET speckle layer — decoupled
// from the big-sign gate so neon can scatter across the WHOLE city while big signs
// stay selective. Default == SIGN_BUILDING_FRACTION (gates identical ⇒ original
// look); raise toward 1 for city-wide speckle. URL: ?night&signspeckle=
NCZ.SIGN_SPECKLE_FRACTION = 0.10;
// Fraction of PODIUM buildings (malls, shop bases — normally unlit) that carry the
// street speckle, so ground-level neon spills onto the occasional mall front. The
// street layer is otherwise on lit towers/blocks EQUALLY (no tower bias). URL:
// ?night&signpod=
NCZ.SIGN_PODIUM_FRACTION = 0.0;
// Sign SHAPE varies per panel — width and height hash-picked independently from
// these (broad) ranges give square / long / tall rectangles; a per-sign shape hash
// also yields circles and triangles (see the shader). Cell-fraction.
NCZ.SIGN_PANE_W_MIN = 0.12;        // narrowest
NCZ.SIGN_PANE_W_MAX = 0.65;        // widest
NCZ.SIGN_PANE_H_MIN = 0.15;        // shortest
NCZ.SIGN_PANE_H_MAX = 0.92;        // tallest
// Sign shape mix: fraction that are RECTANGLES (read as billboards/screens). The
// remainder splits evenly between circles and triangles. Higher = cleaner, more
// sign-like, less "confetti". URL: ?night&signrect=
NCZ.SIGN_RECT_BIAS  = 0.50;
// A neon sign GLOWS onto the surrounding wall — a soft halo beyond the panel body
// (this spill is what reads as "a light on the facade", not a window cut into it).
// Cell-fraction width of the falloff outside the panel. Bloom amplifies it.
NCZ.SIGN_GLOW_WIDTH   = 0.16;
NCZ.SIGN_INTENSITY    = 7.0;       // emissive brightness at full night (bright — the main bloom source)
// HEIGHT-STRATIFIED signage — two layers blended by height fraction:
//   STREET (low): FINE grid, SMALL signs, DENSE — fades out going up.
//   ROOF  (high): COARSE grid, BIG signs, VERY SPARSE — fades in going up.
// The mid-building reads as their blend (medium size, low density). Each layer
// keeps the shape variety + glow. Grid = CET cell size; density = fraction of
// cells with a sign; size = panel-size multiplier.
NCZ.SIGN_STREET_CELL_W  = 26;  NCZ.SIGN_STREET_CELL_H = 26;
NCZ.SIGN_STREET_SIZE    = 0.55;
NCZ.SIGN_STREET_DENSITY = 0.45;
NCZ.SIGN_ROOF_CELL_W    = 75;  NCZ.SIGN_ROOF_CELL_H   = 85;
NCZ.SIGN_ROOF_SIZE      = 1.00;
NCZ.SIGN_ROOF_DENSITY   = 0.05;
// Height bands (fraction of building height, 0 base → 1 top) over which each layer
// blends in/out.
NCZ.SIGN_STREET_FADE_LO = 0.25; NCZ.SIGN_STREET_FADE_HI = 0.65; // street fades OUT across this band
NCZ.SIGN_ROOF_RISE_LO   = 0.45; NCZ.SIGN_ROOF_RISE_HI   = 0.90; // roof fades IN across this band
// Saturated neon palette (sRGB hex) — hash-picked per panel (uniform pick, so the
// distribution is WEIGHTED BY REPETITION). This is where the city's colour comes
// from (windows stay warm-white-dominant). Reference-leaning CP2077 mix: heavy on
// hot-pink / cyan / red / amber / white (the iconic neon hues), lighter on
// magenta / yellow / green / purple. Keep entries grouped so the weighting is
// readable. (District-cohesive hue biasing is a later feature.)
NCZ.SIGN_COLORS = [
  "#ff2d6f", "#ff2d6f",   // hot pink  ×2
  "#19e0ff", "#19e0ff",   // cyan      ×2
  "#ff1a3c", "#ff1a3c",   // red       ×2
  "#ff8a1e", "#ff8a1e",   // amber     ×2
  "#fff2e0",              // warm white×1
  "#ff36c4",              // magenta   ×1
  "#ffe14d",              // yellow    ×1
  "#39ff9e",              // green     ×1  (kept, demoted)
  "#9b6bff",              // purple    ×1  (demoted)
];
// ── Big billboard ── ONE large single-colour neon panel per selected tall building
// (gated by SIGN_BUILDING_FRACTION), placed on the upper facade. Unlike the tiled
// roof layer, this is a single coherent sign per building — the iconic "huge sign at
// the top". Seed-varied between a tall vertical strip and a wide banner. URL keys:
// bbcv / bbwmin / bbwmax / bbhmin / bbhmax / bbglow / bbint.
NCZ.SIGN_BB_CENTER_V      = 0.80;  // panel centre as height-fraction (upper facade)
// Half-extents are BOTH fractions of the facade half-width, so aspect ratio is
// consistent in world units. W and H are anti-correlated by one aspect hash:
// narrow+tall ⇒ vertical strip, wide+short ⇒ banner.
NCZ.SIGN_BB_W_MIN         = 0.20;  // panel half-width / facade half-width (narrow ⇒ vertical strip)
NCZ.SIGN_BB_W_MAX         = 0.70;  // (wide ⇒ banner)
NCZ.SIGN_BB_H_MIN         = 0.22;  // panel half-height / facade half-width (short ⇒ banner)
NCZ.SIGN_BB_H_MAX         = 0.95;  // (tall ⇒ strip)
NCZ.SIGN_BB_GLOW          = 0.04;  // soft falloff width for the bloom halo
NCZ.SIGN_BB_INTENSITY_MUL = 1.3;   // billboard brightness × SIGN_INTENSITY (the brightest element)
// Hard WORLD-size cap (CET) on a billboard half-extent. Stops an over-merged
// mega-block (facade 1000+ CET) from spawning a giant single-colour panel — the
// "giant billboard" artefact. Normal towers sit well under this. URL: ?night&bbmax=
NCZ.SIGN_BB_MAX_HALF      = 55;

// ── Night lighting (Stage 1 — moonlight foundation) ─────────────────────────
// Day-night runs on TWO permanent directional lights that crossfade by
// nightFactor (smoothstep on SUN elevation; see NCZ.nightFactorForSunElevation):
// a warm SUN that casts shadows (its shadow strength fades out as it sets — see
// SUN_SHADOW_FADE_* below) and a cool MOON that casts NONE. Moonlight shadows are
// physically imperceptible, and dropping them removes the night/dusk "shadow box"
// cut-out entirely (no caster ⇒ nothing to clip against the coverage cap). Crisp
// moon shadows at any zoom would need CSM (queued). castShadow is never toggled on
// either light (only shadow.intensity is faded) ⇒ no WebGPURenderer teardown crash.
// All values are first-cut, calibrated live with ?night + overlays off. Colours
// are linear RGB, matching the SUN/AMBIENT block.
NCZ.MOON_COLOR_RGB         = [0.62, 0.74, 1.00]; // cool moonlight (linear)
NCZ.MOON_INTENSITY         = 0.50;               // key intensity at full night & full phase, moon at zenith (vs SUN_INTENSITY 3.0)
NCZ.MOON_PHASE             = 0.85;               // illuminated fraction 0=new→1=full; tunable (real getMoonIllumination ignored so we never land on a dark new moon). Scales moonlight; disc-phase terminator is a follow-up.
NCZ.AMBIENT_SKY_RGB_NIGHT  = [0.12, 0.16, 0.28]; // dark blue from above at night
NCZ.AMBIENT_GROUND_RGB_NIGHT = [0.17, 0.18, 0.22]; // cool near-neutral fill from below — was a warm orange "light-pollution" bounce, but at the high moonless ambient it read sun-warm; deliberate neon/city underglow belongs in the theme-driven Stage 2, not the baseline
NCZ.AMBIENT_INTENSITY_NIGHT = 0.50;              // night ambient when the MOON IS UP — kept low so directional moonlight dominates
NCZ.AMBIENT_INTENSITY_NIGHT_MOONLESS = 0.85;     // night ambient when the moon is BELOW the horizon — skyglow/starlight fill so a moonless night stays legible (scaled in by 1−moonAlt; never washes out moonlit nights)

// ── Stage-2 city glow (night light-pollution fill) ──────────────────────────
// A SECOND hemisphere light layered on the moonlight baseline above — the city
// lighting itself. WARM up-glow from below (streets/neon bouncing onto lower
// facades) + a fainter cool tint from above, so buildings lift out of pure-black
// silhouette. Driven by nightFactor² (zero by day). This is the "ambient
// lighting" seen in the night reference shots; the baseline ambient deliberately
// omits it. Linear RGB. Tune live with ?night. (Global for now — it lifts the
// whole map's surfaces, not just the city; localising needs the region data.)
NCZ.CITY_GLOW_GROUND_RGB = [1.0, 0.62, 0.42];    // warm amber up-glow from street level (the dominant tint)
NCZ.CITY_GLOW_SKY_RGB    = [0.40, 0.30, 0.52];   // faint cool-purple from above (upper-atmosphere skyglow)
NCZ.CITY_GLOW_INTENSITY  = 0.25;                 // night-peak fill intensity
NCZ.CITY_GLOW_DAY_FACTOR = 0.25;  // fraction of the glow kept in full DAYLIGHT — a city always has some lights on. Glow intensity = INTENSITY · lerp(DAY_FACTOR, 1, nightFactor), so it's present but dim by day and brightest at night (dimmer as the day brightens). 0 = night-only.
NCZ.KEY_LIGHT_MIN_DIR_Y    = 0.10;               // floor on the SUN direction's Y (~5.7°) — shadow-camera safety so its lookAt can't degenerate near/below the horizon. Kept at 0.10: a lower floor lets a low sun graze further, lengthening dawn/dusk shadows until they overrun the SHADOW_MAX_DISTANCE coverage cap and cut out. Less critical now that SUN_SHADOW_FADE_* fades low-sun shadows out, but still the degeneracy guard.
// Sun-shadow strength fades with the sun's real elevation (deg): full at/above
// FULL, zero at/below OFF. Fades shadows out through dusk and kills them at night
// (sun below horizon) so there's no caster to clip against the coverage cap.
NCZ.SUN_SHADOW_FADE_OFF_DEG  =  3;               // sun elevation at/below which cast shadows are fully off
NCZ.SUN_SHADOW_FADE_FULL_DEG = 12;               // sun elevation at/above which cast shadows are at full strength
// nightFactor ramp, in SUN-elevation degrees: 0 (full day) at/above DAY, 1 (full
// night) at/below NIGHT. Deliberately WIDE (golden hour → past astronomical
// twilight) so the night look — glow, windows, bloom, ambient — eases in across
// ~3h of dusk as a smooth S-curve, rather than snapping on in the ~1h civil-
// twilight window (which read as a switch, not a cycle). Smoothstep between them.
NCZ.NIGHT_FACTOR_DAY_DEG   =  15;                // sun elevation at/above which nightFactor = 0 (lights fully off)
NCZ.NIGHT_FACTOR_NIGHT_DEG = -15;               // sun elevation at/below which nightFactor = 1 (full night)

// ── City lights: window + sign emissive, decoupled from the sun ──────────────
// The game never gates its window light on the time of day. Every lit window is a
// MATERIAL (window_parallax_interior.mt) whose parallax interior is ALWAYS there;
// the night parameter is called `AmountTurnOffAtNight` — night is when half of them
// turn OFF, not when they turn on. The sun-driven ramp above is OUR invention: it is
// what makes the lights READ, not what makes them exist.
//
// So the lights get their own control, independent of the sun:
//   'auto' — the nightFactor ramp above (dusk fades them in). The old behaviour.
//   'on'   — lit at every hour, floored at LIGHTS_DAY_FLOOR so noon doesn't blow out.
//   'off'  — dark. Windows, signage and city glow all go.
// Drives _buildingNightFactor (windows + signage emissive) and the city glow ONLY —
// sun, moon, ambient, bloom and shadows stay on the real sun, because those ARE the
// time of day. URL: ?lights=auto|on|off
NCZ.LIGHTS_MODE = "auto";
// Emissive floor in full daylight when LIGHTS_MODE is 'on'. This is an honest LOOK
// CHOICE for our schematic map — the one invented number in the whole lighting model,
// and it is invented on purpose. It is NOT derived from the game: nothing in the
// material data says how bright a lit window should read against a sunlit facade,
// because the game answers that with a full HDR pipeline we do not have. Do not file
// it alongside the measured constants (WINDOW_LIT_IN_GLASS, the glass shares) — those
// are claims about Night City; this is a claim about legibility.
// 0 = identical to 'auto'. 1 = full night-strength emissive at noon (blown out).
NCZ.LIGHTS_DAY_FLOOR = 0.3;
// Resolve the emissive strength for the city lights from the sun-driven nightFactor.
// The single place the mode is interpreted; both the scene and the UI read through it.
NCZ.lightsFactor = function (nightFactor) {
  if (NCZ.LIGHTS_MODE === "off") return 0;
  if (NCZ.LIGHTS_MODE === "on") return Math.max(nightFactor, NCZ.LIGHTS_DAY_FLOOR);
  return nightFactor;                       // 'auto' — the sun decides
};
NCZ.LIGHTS_MODES = ["auto", "on", "off"];
NCZ.MOON_SPHERE_RADIUS     = 360;                // visible moon disc — ~0.6× the sun disc (SUN_SPHERE_RADIUS 600); rule-of-cool, not to true scale
NCZ.MOON_SPHERE_COLOR      = 0xdfe8ff;           // cool-white disc (sRGB hex for MeshBasicNodeMaterial)

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
// Building zone overrides (the metadata/editor system). Working edits live in
// localStorage (ZONES_KEY) and take precedence over the committed repo baseline
// (data/building-zones.json); the ?zonetool UI exports/imports the JSON so a
// finalised set can be committed. Loaded at building-load time and applied to
// segmentation/classification (merge / forceClass / exclude / forceLit ops).
NCZ.ZONES_KEY         = 'ncz-building-zones';
// ?archdebug classification palette — the SINGLE source of truth for both the
// shader (discrete class colour) and the index.html legend (swatch + hover
// definition), so they line up exactly. rgb is linear 0..1 (matches the shader
// vec3); the legend converts to hex. Order = legend display order.
NCZ.ARCHDEBUG_COLORS = [
  { key: 'short',     rgb: [0.12, 0.12, 0.12], label: 'Short',     def: 'Below the height gate — kiosks, ground clutter, low detail. Not lit.' },
  { key: 'thin',      rgb: [1.00, 0.00, 0.00], label: 'Thin',      def: 'Narrow footprint — poles, masts, pillars, turbines. Not lit.' },
  { key: 'elongated', rgb: [1.00, 0.50, 0.00], label: 'Elongated', def: 'Long & thin — walls, bridge decks, pipes, container rows. Not lit.' },
  { key: 'podium',    rgb: [1.00, 0.85, 0.00], label: 'Podium',    def: 'Broad & low mass — malls, parking, sheds, oil tanks. Not lit.' },
  { key: 'tower',     rgb: [0.00, 1.00, 0.30], label: 'Tower',     def: 'Tall & slender — dense bright windows + signage.' },
  { key: 'block',     rgb: [0.20, 0.40, 1.00], label: 'Block',     def: 'Tall & broad building — sparser windows than a tower.' },
];
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

// ── Archetype-tuning param overrides (URL, debug only) ───────────────────────
// Lets the tuner (scripts/tune_archetypes.js) preview any candidate param set
// live WITHOUT editing the constants above — pair with ?archdebug, e.g.
//   ?archdebug&gap=-1&vlo=0.5&vhi=1.8&fbig=220&minf=8&maxe=4
// Runs synchronously here, before three-scene.js (a deferred module) reads any
// of these at material-build / loadBuildings time. Complete no-op unless at
// least one tuning key is present, so ordinary loads are untouched.
(function applyArchParamOverrides() {
  if (typeof location === "undefined" || !location.search) return;
  const q = new URLSearchParams(location.search);
  const MAP = {
    gap:     "BUILDING_CLUSTER_GAP",
    vlo:     "ARCH_VERTICALITY_LO",
    vhi:     "ARCH_VERTICALITY_HI",
    fbig:    "ARCH_FOOTPRINT_BIG",
    podlo:   "ARCH_PODIUM_HEIGHT_LO",
    podhi:   "ARCH_PODIUM_HEIGHT_HI",
    minf:    "ARCH_MIN_FOOTPRINT",
    maxe:    "ARCH_MAX_ELONGATION",
    winmin:  "WINDOW_MIN_HEIGHT",
    winband: "WINDOW_HEIGHT_BAND",
    // building segmentation (height-discontinuity) granularity
    cell:    "BUILDING_SEG_CELL",
    dh:      "BUILDING_SEG_DH",
    mincells:"BUILDING_SEG_MIN_CELLS",
    keepwhole:"BUILDING_SEG_KEEP_WHOLE",
    partdh:  "BUILDING_PART_DH",
    splitcell:"BUILDING_SPLIT_CELL",
    splitmin: "BUILDING_SPLIT_MIN_SPAN",
    roadcarve:"BUILDING_ROAD_CARVE",
    roadclear:"BUILDING_ROAD_CLEARANCE",
    roaddilate:"BUILDING_ROAD_DILATE",
    podmerge: "BUILDING_PODIUM_MERGE",
    podfrac:  "BUILDING_PODIUM_MERGE_FRAC",
    // night-lighting look (URL-tune with ?night&… then refresh)
    winlit:   "WINDOW_LIT_FRACTION_TOWER",
    winlitb:  "WINDOW_LIT_FRACTION_BLOCK",
    winco:    "WINDOW_COHERENCE",
    wincellw: "WINDOW_CELL_W",
    wincellh: "WINDOW_CELL_H",
    winpanew: "WINDOW_PANE_W",
    winpaneh: "WINDOW_PANE_H",
    winshell: "WINDOW_SHELL_GATE",
    facemask: "FACE_MASK_STRENGTH",
    faceeps:  "FACE_EPS",
    wincol:   "WINDOW_COLUMN_COHERENCE",
    winint:   "WINDOW_INTENSITY",
    signint:   "SIGN_INTENSITY",
    signglow:  "SIGN_GLOW_WIDTH",
    signbf:    "SIGN_BUILDING_FRACTION",
    signspeckle: "SIGN_SPECKLE_FRACTION",
    signpod:   "SIGN_PODIUM_FRACTION",
    signrect:  "SIGN_RECT_BIAS",
    stcell:    "SIGN_STREET_CELL_W",   // street grid (also sets H below in three-scene? no — set both)
    stcellh:   "SIGN_STREET_CELL_H",
    stsize:    "SIGN_STREET_SIZE",
    stdens:    "SIGN_STREET_DENSITY",
    stfadelo:  "SIGN_STREET_FADE_LO",
    stfadehi:  "SIGN_STREET_FADE_HI",
    rfcell:    "SIGN_ROOF_CELL_W",
    rfcellh:   "SIGN_ROOF_CELL_H",
    rfsize:    "SIGN_ROOF_SIZE",
    rfdens:    "SIGN_ROOF_DENSITY",
    rfriselo:  "SIGN_ROOF_RISE_LO",
    rfrisehi:  "SIGN_ROOF_RISE_HI",
    bbcv:      "SIGN_BB_CENTER_V",
    bbwmin:    "SIGN_BB_W_MIN",
    bbwmax:    "SIGN_BB_W_MAX",
    bbhmin:    "SIGN_BB_H_MIN",
    bbhmax:    "SIGN_BB_H_MAX",
    bbglow:    "SIGN_BB_GLOW",
    bbint:     "SIGN_BB_INTENSITY_MUL",
    bbmax:     "SIGN_BB_MAX_HALF",
    glowint:  "CITY_GLOW_INTENSITY",
    bloom:    "BLOOM_STRENGTH",
    lightsday: "LIGHTS_DAY_FLOOR",
    // measured window model
    glassgain: "GLASS_SHARE_GAIN",
    litglass:  "WINDOW_LIT_IN_GLASS",
    winaspect: "WINDOW_PANE_ASPECT",
  };
  // Params whose value is an ENUM, not a number — MAP above parseFloats everything,
  // so a string-valued constant needs its own pass or it lands as NaN.
  const STR_MAP = {
    lights:   { name: "LIGHTS_MODE", allow: NCZ.LIGHTS_MODES },
    winmodel: { name: "WINDOW_MODEL", allow: NCZ.WINDOW_MODELS },
    glasssrc: { name: "GLASS_SHARE_SOURCE", allow: ["panel", "area", "count"] },
  };
  const applied = {};
  for (const [key, name] of Object.entries(MAP)) {
    if (!q.has(key)) continue;
    const v = parseFloat(q.get(key));
    if (Number.isFinite(v)) { NCZ[name] = v; applied[name] = v; }
  }
  for (const [key, spec] of Object.entries(STR_MAP)) {
    if (!q.has(key)) continue;
    const v = q.get(key);
    if (spec.allow.includes(v)) { NCZ[spec.name] = v; applied[spec.name] = v; }
    else console.warn(`[NCZ] ?${key}=${v} ignored — expected one of ${spec.allow.join("|")}`);
  }
  if (Object.keys(applied).length) console.log("[NCZ] arch param override:", applied);
})();
