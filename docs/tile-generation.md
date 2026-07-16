# Tile Generation

## Overview

The map image is too large to load as a single file. Instead, we slice it into 256×256 WebP tiles at multiple zoom levels. Leaflet loads only the visible tiles, making the map fast and responsive.

## Source Image

Tiles are generated from the **16k PNG** source (lossless) and encoded directly to WebP. This avoids double lossy compression: Sharp decodes the PNG into raw pixels, then encodes each tile to WebP in one step.

Source images are stored in `raw maps/` (not committed due to size):

| Resolution | File | Size | Status |
|-----------|------|------|--------|
| 4k (4096²) | `4k/night_city.png` | 27 MB | Archive |
| 8k (8192²) | `8k/night_city_8k_transparent.png` | 108 MB | Archive |
| **16k (16384²)** | **`16k/night_city_16k.png`** | **529 MB** | **Current tile source** |
| 32k (32768²) | `32k/night_city_32k.png` | ~1.7 GB | Available (too many tiles for Cloudflare Pages' 20k-file deploy limit) |

## Generating Tiles

### Prerequisites

```bash
npm install  # Installs sharp (image processing library)
```

### Running the Script

```bash
node scripts/generate_tiles.js
```

This reads `raw maps/16k/night_city_16k.png` and outputs tiles to `assets/tiles/`:

```
assets/tiles/
├── 0/0/0.webp         # Zoom 0: 1×1 tile (whole image at 256px)
├── 1/                  # Zoom 1: 2×2 tiles
├── 2/                  # Zoom 2: 4×4 tiles
├── 3/                  # Zoom 3: 8×8 tiles
├── 4/                  # Zoom 4: 16×16 tiles
├── 5/                  # Zoom 5: 32×32 tiles
└── 6/                  # Zoom 6: 64×64 tiles (native 16k resolution)
    ├── 0/
    │   ├── 0.webp
    │   ├── 1.webp
    │   └── ...
    └── 63/
        └── 63.webp
```

**Output:** 5,461 tiles total, ~35–50 MB (WebP quality 90, effort 6).

## How It Works

The script (`scripts/generate_tiles.js`) uses [Sharp](https://sharp.pixelplumbing.com/) to:

1. Load the 16k PNG source image (lossless)
2. For each zoom level (0–6):
   - Resize the image to `(2^z × 256)` pixels using raw pixel buffers
   - Extract each 256×256 tile
   - Encode to WebP (quality 90, effort 6)
   - Save as `assets/tiles/{z}/{x}/{y}.webp`

### WebP Encoding

- **Quality 90**: Visually indistinguishable from lossless at 256×256 tile size, ~5× smaller than PNG
- **Effort 6**: Maximum compression effort (slower encode, smaller files). One-time generation cost.
- **Source format matters**: Tiles are generated from PNG (lossless) to avoid generation loss from double lossy compression

### Tile Coordinates

- `{z}`: zoom level (0 = zoomed out, 6 = native resolution)
- `{x}`: column index (0 = left)
- `{y}`: row index (0 = top)

At zoom 6: 64 columns × 64 rows = 4,096 tiles.

## Leaflet Integration

In `app.js`, the tile layer is configured as:

```javascript
const maxNativeZoom = 6;
const southWest = map.unproject([0, 16384], maxNativeZoom);
const northEast = map.unproject([16384, 0], maxNativeZoom);
const mapBounds = new L.LatLngBounds(southWest, northEast);

L.tileLayer('assets/tiles/{z}/{x}/{y}.webp', {
    minZoom: 0,
    maxNativeZoom: 6,  // Highest zoom with real tiles
    maxZoom: 8,        // Allow zooming past native (upscaled)
    tileSize: 256,
    noWrap: true,
    bounds: mapBounds
}).addTo(map);
```

- `maxNativeZoom: 6` tells Leaflet zoom 6 is the best available
- `maxZoom: 8` lets users zoom 2 levels deeper (tiles are upscaled 4×)
- `bounds` is calculated via `map.unproject()` to align pixel coords with `CRS.Simple`

### Coordinate Projection

`map.unproject([0, 16384], 6)` resolves to the **same LatLng** as `map.unproject([0, 8192], 5)` in `CRS.Simple`. The projection formula divides pixel coordinates by `2^zoom`, so doubling both the image size and zoom level cancels out. All CET→Leaflet coordinate transforms remain valid.

## Why Not 32k?

The 32k source would give zoom 7 (128×128 = 16,384 tiles at native, ~21,845 total). That alone exceeds Cloudflare Pages' 20,000-files-per-deployment limit (before counting the ~5,461 existing tiles and all other assets), and adds significant repo size (~100+ MB) for diminishing returns: users already get sharp detail at zoom 6 with only 4× upscaling at max zoom. The 32k source is available if we move tiles to external object storage (e.g. Cloudflare R2) in the future.
