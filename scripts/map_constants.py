"""
map_constants.py — Single source of truth for all coordinate transforms.

All Python scripts in this project should import from here instead of defining
their own WORLD_MIN/MAX constants.

The world extent values come from the game's TweakDB:
  WorldMap.DefaultSettings.cursorBoundaryMin = Vector2(-5500, -7300)
  WorldMap.DefaultSettings.cursorBoundaryMax = Vector2(6050,  5000)

These define the in-game map viewport pan limits in CET world-space coordinates.
The image canvas (8192×8192 pixels) maps to this exact world extent.

Leaflet uses L.CRS.Simple with tileSize=256 and maxNativeZoom=5:
  - Full image = 256 × 2^5 = 8192 pixels
  - Leaflet lng: [0, 256] (left to right, maps to CET X)
  - Leaflet lat: [-256, 0] (top to bottom, maps to CET Y inverted)
"""

# ---------------------------------------------------------------------------
# Authoritative world extent (CET world-space)
# Source: The Realistic Map 8k mod's terrain quad UV→world mapping.
# The mod replaces the 5-submesh terrain with a single 4-vertex quad and maps
# the satellite image (night_city_8k_transparent.png) via custom UVs:
#   CET_X = 12112.3 * U + (-6297.5)   →  U=0: X=-6298, U=1: X=5815
#   CET_Y = -12111.5 * V + (7684.3)   →  V=0: Y=7684,  V=1: Y=-4427
# This is the authoritative mapping for both the satellite tiles and our terrain tiles.
#
# Note: TweakDB WorldMap.DefaultSettings CursorBoundary (-5500,-7300)→(6050,5000)
# defines the PAN LIMIT (how far the player can scroll), NOT the render extent.
# The base game's 5-submesh terrain has inconsistent per-submesh UV mappings,
# so the mod author's clean quad is the correct reference.
# ---------------------------------------------------------------------------
WORLD_MIN_X = -6298.0   # UV U=0 → CET_X (western edge)
WORLD_MAX_X =  5815.0   # UV U=1 → CET_X (eastern edge)
WORLD_MIN_Y = -7684.0   # UV V=0 → CET_Y (southern edge) — mod quad uses CET_Y = -GLB_Z
WORLD_MAX_Y =  4427.0   # UV V=1 → CET_Y (northern edge)

# Derived ranges
WORLD_WIDTH  = WORLD_MAX_X - WORLD_MIN_X   # 11550.0
WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y   # 12300.0

# ---------------------------------------------------------------------------
# Canvas / tile constants
# ---------------------------------------------------------------------------
IMG_SIZE = 8192           # Output canvas size in pixels (8k)
LEAFLET_EXTENT = 256      # Leaflet coordinate range (0..256 for lng, -256..0 for lat)
LEAFLET_SCALE = IMG_SIZE / LEAFLET_EXTENT   # 32.0 (pixels per Leaflet unit)

# ---------------------------------------------------------------------------
# Transform functions
# ---------------------------------------------------------------------------

def cet_to_pixel(cet_x, cet_y):
    """CET world coordinates → pixel position on 8192×8192 canvas.

    (0, 0) is top-left. X increases right, Y increases down.
    """
    px = (cet_x - WORLD_MIN_X) / WORLD_WIDTH * IMG_SIZE
    py = (WORLD_MAX_Y - cet_y) / WORLD_HEIGHT * IMG_SIZE
    return px, py


def cet_to_leaflet(cet_x, cet_y):
    """CET world coordinates → Leaflet [lat, lng].

    lat ∈ [-256, 0] (north = 0, south = -256)
    lng ∈ [0, 256]  (west = 0, east = 256)
    """
    lng = (cet_x - WORLD_MIN_X) / WORLD_WIDTH * LEAFLET_EXTENT
    lat = (cet_y - WORLD_MAX_Y) / WORLD_HEIGHT * LEAFLET_EXTENT
    return [lat, lng]


def pixel_to_cet(px, py):
    """Pixel position on 8192×8192 canvas → CET world coordinates."""
    cet_x = px / IMG_SIZE * WORLD_WIDTH + WORLD_MIN_X
    cet_y = WORLD_MAX_Y - py / IMG_SIZE * WORLD_HEIGHT
    return cet_x, cet_y


def leaflet_to_cet(lat, lng):
    """Leaflet [lat, lng] → CET world coordinates."""
    cet_x = lng / LEAFLET_EXTENT * WORLD_WIDTH + WORLD_MIN_X
    cet_y = lat / LEAFLET_EXTENT * WORLD_HEIGHT + WORLD_MAX_Y
    return cet_x, cet_y


# ---------------------------------------------------------------------------
# Zoom level mapping (from TweakDB WorldMap.ZoomLevel* records)
# ---------------------------------------------------------------------------
# Game zoom values (higher = more zoomed out):
#   BaseZoomLevel:      1     (closest)
#   ExtraMappins:       1000
#   AllMappins:         2500
#   Vendors:            3500
#   Important:          4500
#   SubDistricts:       7000  (showSubDistricts=1)
#   Districts:          11000 (showDistricts=1, most zoomed out)
#
# Camera zoom range (TopDownCameraSettingsDefault):
#   zoomMin: 800, zoomMax: 15000, zoomDefault: 3000
#
# Our Leaflet zoom range: 0 (most zoomed out) to 8 (most zoomed in)
# Mapping: game zoom is inversely proportional to Leaflet zoom
#   game 15000 (max zoom out) ≈ Leaflet 0
#   game 800   (max zoom in)  ≈ Leaflet 8
#
# District visibility thresholds (to be fine-tuned):
LEAFLET_DISTRICT_ZOOM_MAX = 3      # Districts visible at zoom <= 3
LEAFLET_SUBDISTRICT_ZOOM_MIN = 4   # Subdistricts visible at zoom >= 4

# ---------------------------------------------------------------------------
# District colors (UiState CNames from TweakDB District_Record)
# These map to Ink widget states; actual RGB values TBD (need in-game extraction)
# ---------------------------------------------------------------------------
DISTRICT_UI_STATES = {
    "CityCenter":   "CityCenter",
    "Watson":       "Watson",
    "Westbrook":    "Westbrook",
    "Heywood":      "Heywood",
    "SantoDomingo": "SantoDomingo",
    "Pacifica":     "Pacifica",
    "Dogtown":      "Dogtown",
    "MorroRock":    "MorroRock",
    # Badlands, NorthBadlands, SouthBadlands have UiState="None"
}

# Actual RGB colors from game Ink styles:
#   world_map_style.inkstyle → District.outlineColor → MainColors.*
#   main_colors.inkstyle → HDR RGBA float values → clamped to 0-255
# Default outline opacity: 0.6
DISTRICT_COLORS = {
    "CityCenter":   (255, 215,  65),   # MainColors.Yellow     HDR [1.119, 0.844, 0.257]
    "Watson":       (255,  62,  52),   # MainColors.CombatRed  HDR [1.570, 0.244, 0.205]
    "Westbrook":    (255,  81,   0),   # MainColors.Orange     HDR [1.280, 0.320, 0.000]
    "Heywood":      ( 29, 237, 131),   # MainColors.Green      HDR [0.114, 0.929, 0.514]
    "SantoDomingo": ( 94, 246, 255),   # MainColors.Blue       HDR [0.369, 0.965, 1.000]
    "Pacifica":     (255,  97,  88),   # MainColors.Red        HDR [1.176, 0.381, 0.348]
    "Dogtown":      (  0, 163,  44),   # MainColors.DarkGreen  HDR [0.000, 0.639, 0.173]
    "MorroRock":    ( 52, 145, 151),   # MainColors.MildBlue   HDR [0.204, 0.569, 0.592]
}
DISTRICT_OUTLINE_OPACITY = 0.6

# ---------------------------------------------------------------------------
# Base tile colors (theme-agnostic, used for permanent terrain tiles)
# ---------------------------------------------------------------------------
# Neutral dark grey palette — subtle land/water distinction, won't compete
# with any theme's accent colours. These can't be changed per theme.
TILE_TERRAIN_COLOR  = (45,   48,  55)   # #2d3037 — neutral dark grey
TILE_WATER_COLOR    = (25,   35,  50)   # #192332 — slightly cooler/darker
TILE_BACKGROUND     = (0,     0,   0)   # black — outside map area

# ---------------------------------------------------------------------------
# Game material colors (from 3dmap Material.json files, for reference/SVGs)
# ---------------------------------------------------------------------------
TERRAIN_BASE_COLOR  = (86,  108, 136)   # 3dmap_terrain BaseColorScale
TERRAIN_LINES_COLOR = (109, 138, 176)   # 3dmap_terrain LinesColor
WATER_COLOR         = (28,  179, 191)   # 3dmap_water Color
ROADS_FILL_COLOR    = (28,  179, 191)   # 3dmap_roads Color (same as water)
ROADS_BORDER_COLOR  = (30,  195, 200)   # 3dmap_roads_borders Color
BACKGROUND_COLOR    = (10,   22,  35)   # Dark navy (Night Corp theme bg)
BUILDING_DISSOLVE   = (0,   153, 255)   # DissolveBurnColor (cyan edge glow)
