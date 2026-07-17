/**
 * generate_tiles.js: Slice a map image into Leaflet-compatible WebP tiles
 *
 * Usage: node scripts/generate_tiles.js
 *
 * Input:  raw maps/16k/night_city_16k.png  (16384×16384)
 * Output: assets/tiles/{z}/{x}/{y}.webp
 *
 * Generates zoom levels 0–6 with 256×256 tiles.
 * At zoom 6 (native), 16384/256 = 64×64 = 4096 tiles.
 * Total across all zoom levels: 5,461 tiles.
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const INPUT = path.join(__dirname, '..', 'raw maps', '16k', 'night_city_16k.png');
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'tiles');
const TILE_SIZE = 256;
const MAX_ZOOM = 6; // 2^6 = 64 tiles per axis → 64×256 = 16384

// WebP encoding options:
//   quality 90: visually indistinguishable from lossless at tile size, ~5× smaller
//   effort 6:   maximum compression effort (slower encode, smaller files)
const WEBP_OPTIONS = { quality: 90, effort: 6 };

function reportProgress(completedTiles, totalTiles, zoomLevel) {
    if (completedTiles % 10 !== 0 && completedTiles !== totalTiles) return;

    const pct = ((completedTiles / totalTiles) * 100).toFixed(1);
    const filled = Math.round(completedTiles / totalTiles * 30);
    const bar = '█'.repeat(filled) + '░'.repeat(30 - filled);

    process.stdout.write(`\r  [${bar}] ${pct}% (${completedTiles}/${totalTiles} tiles, zoom ${zoomLevel})`);
}

async function generateTiles() {
    console.log('Loading source image...');
    const metadata = await sharp(INPUT, { limitInputPixels: false }).metadata();
    console.log(`Source: ${metadata.width}×${metadata.height} (${metadata.format})`);

    const imgSize = metadata.width; // Assumes square
    if (imgSize !== metadata.height) {
        console.warn(`Warning: Image is not square (${metadata.width}×${metadata.height}). Using width.`);
    }

    // Calculate total tile count upfront
    let totalTiles = 0;
    for (let z = 0; z <= MAX_ZOOM; z++) {
        totalTiles += Math.pow(4, z);
    }
    console.log(`Generating ${totalTiles} WebP tiles (zoom 0–${MAX_ZOOM})...\n`);

    let completedTiles = 0;
    const startTime = Date.now();

    for (let z = 0; z <= MAX_ZOOM; z++) {
        const tilesPerAxis = Math.pow(2, z);
        const scaledSize = tilesPerAxis * TILE_SIZE;
        const scale = scaledSize / imgSize;

        console.log(`Zoom ${z}: ${tilesPerAxis}×${tilesPerAxis} tiles (scale ${scale.toFixed(3)})`);

        // Resize the source image for this zoom level
        const buffer = await sharp(INPUT, { limitInputPixels: false })
            .resize(scaledSize, scaledSize, { fit: 'fill' })
            .raw()
            .toBuffer();

        for (let x = 0; x < tilesPerAxis; x++) {
            const tileDir = path.join(OUTPUT_DIR, String(z), String(x));
            fs.mkdirSync(tileDir, { recursive: true });

            for (let y = 0; y < tilesPerAxis; y++) {
                const left = x * TILE_SIZE;
                const top = y * TILE_SIZE;

                const tilePath = path.join(tileDir, `${y}.webp`);

                await sharp(buffer, {
                        raw: { width: scaledSize, height: scaledSize, channels: 4 },
                        limitInputPixels: false
                    })
                    .extract({ left, top, width: TILE_SIZE, height: TILE_SIZE })
                    .webp(WEBP_OPTIONS)
                    .toFile(tilePath);

                completedTiles++;
                reportProgress(completedTiles, totalTiles, z);
            }
        }

        console.log(`\n  → ${tilesPerAxis * tilesPerAxis} tiles written`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone! ${completedTiles} tiles generated in ${elapsed}s → ${OUTPUT_DIR}`);
}

generateTiles().catch(err => {
    console.error('Error generating tiles:', err);
    process.exit(1);
});
