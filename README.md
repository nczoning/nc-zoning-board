# NC Zoning Board

**An interactive web map and coordinate registry for Cyberpunk 2077 location mods — helping the community track what's been built and where.**

> ⚠️ **Fan Content Disclaimer:** This is an unofficial fan project not approved or endorsed by CD PROJEKT RED. See [ASSETS.md](ASSETS.md) for licensing details and game asset attribution.

🌍 **[View the Live Map](https://nczoning.net/)**

## What is This?

As the CP2077 modding community grows, so does the number of custom locations, apartments, and overhauled zones. This repository is a centralized registry where mod authors can **register their in-game coordinates** to help the community track what's been built and where.

The live interactive map displays all registered mods on an 8k Night City map, allowing authors to see what's been built and coordinate with other projects. By registering a valid Nexus ID, the application will automatically fetch and display the mod's official thumbnail and promotional image using the free Nexus Mods GraphQL API.

> [!NOTE]
> The NC Zoning Board was originally envisioned and spearheaded by **[Kaoziun](https://www.nexusmods.com/profile/Kaoziun/mods?gameId=3333)**.

## Quick Start

### Viewing the Map

Just visit the [Live Map](https://nczoning.net/) — no setup needed.

### Join the Community

Join the **[Locations Hub Discord](https://discord.gg/sc4yEx2fNf)** — a community dedicated to Cyberpunk 2077 location mods and collaborative projects. Players and authors are welcome!

The NC Zoning Board is a side project of the Locations Hub. Visit the **#nc-zoning-board** channels to discuss mapping, get help with submissions, and coordinate with other modders.

### Running Locally

```bash
# Clone the repo
git clone https://github.com/spuddeh/nc-zoning-board.git
cd nc-zoning-board

# Install dependencies (only needed for tile generation)
npm install

# Start a local server
npx serve .
# Open http://localhost:3000
```

> **Note:** The app uses `fetch()` to load mod data, so you need a local HTTP server — opening `index.html` directly will cause CORS errors.

### Regenerating Map Tiles

If you have a new map source image, regenerate the tiles:

```bash
# Place your 8k source image at: raw maps/8k/night_city.png
node scripts/generate_tiles.js
# Tiles are generated in assets/tiles/
```

See [Tile Generation Guide](docs/tile-generation.md) for details.

## Submitting Your Mod

### Preferred Method (NCZoning Auto-Discovery)

Add your mod to the map directly from Nexus — no GitHub account required:

1. Tag your mod on Nexus with **NCZoning**
2. Use the **[+] Submit** button on the map to generate your metadata block
3. Paste the block into your mod description and save

Your pin will appear on the map within a few minutes. See the **[NCZoning Auto-Discovery Guide](docs/nczoning-auto-discovery.md)** for full details.

### GitHub Issue Method

Prefer a permanent, manually curated entry? See **[docs/adding-mods.md](docs/adding-mods.md)** for instructions on submitting via GitHub issue or pull request.

## Documentation

| Guide | Description |
|-------|-------------|
| [NCZoning Auto-Discovery](docs/nczoning-auto-discovery.md) | Add your mod to the map directly from Nexus |
| [Adding Mods](docs/adding-mods.md) | GitHub issue / manual PR submission, mods.json schema |
| [Coordinate System](docs/coordinate-system.md) | CET ↔ Leaflet transform, calibration data |
| [Architecture](docs/architecture.md) | File structure, data flow, tech stack |
| [Tile Generation](docs/tile-generation.md) | Map tiling, source images, upgrading resolution |
| [Roadmap](docs/roadmap.md) | Current status, planned features |

## Tech Stack

- **[Leaflet.js](https://leafletjs.com/)** — Interactive map (`L.CRS.Simple` with custom tiles)
- **Vanilla JS / CSS** — No frameworks, purely static files
- **[Sharp](https://sharp.pixelplumbing.com/)** — 8k map tile generation (dev dependency)
- **GitHub Actions** — Automated JSON validation and PR pipeline
- **Cloudflare Pages** — Static hosting (Git integration)

## Contributors & Community

Built by modders, for modders. A huge thanks to everyone who's contributed:

- **[Kaoziun](https://www.nexusmods.com/profile/Kaoziun/mods?gameId=3333)** — Original vision & community leadership
- **[manavortex](https://www.nexusmods.com/profile/manavortex/mods?gameId=3333)** — Data structure & guidance
- **[Spuddeh](https://www.nexusmods.com/profile/Spuddeh/mods?gameId=3333)** — Active development
- **[Akiway](https://www.nexusmods.com/profile/Akiway/mods?gameId=3333)** — UI/UX & design
- **Locations Hub Council & community** — Testing, ideas, and support

Want to help? See **[CONTRIBUTING.md](CONTRIBUTING.md)** — we'd love to have you!

## Licensing

**Software Code:** MIT License (see [`LICENSE`](LICENSE) file)

**Game Assets:** Subject to CD PROJEKT RED's Fan Content Policy (see [`ASSETS.md`](ASSETS.md) for details)

This project is non-commercial and free. Game data and assets are used under CD PROJEKT RED's fan content terms, which require attribution and prohibit commercial use.
