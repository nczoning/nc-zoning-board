# NC Zoning Board

**An interactive web map and coordinate registry for Cyberpunk 2077 location mods, helping the community track what's been built and where.**

> ⚠️ **Fan Content Disclaimer:** This is an unofficial fan project not approved or endorsed by CD PROJEKT RED. See [ASSETS.md](ASSETS.md) for licensing details and game asset attribution.

🌍 **[View the Live Map](https://nczoning.net/)**

## What is This?

As the CP2077 modding community grows, so does the number of custom locations, apartments, and overhauled zones. This repository is a centralised registry where mod authors can **register their in-game coordinates** to help the community track what's been built and where.

The live interactive map displays all registered mods on an 8k Night City map, allowing authors to see what's been built and coordinate with other projects. Register a valid Nexus ID and the app automatically fetches and displays the mod's official thumbnail and promotional image via the free Nexus Mods GraphQL API.

> [!NOTE]
> The NC Zoning Board was originally envisioned and spearheaded by **[Kaoziun](https://www.nexusmods.com/profile/Kaoziun/mods?gameId=3333)**.

## Quick Start

### Viewing the Map

Just visit the [Live Map](https://nczoning.net/), no setup needed.

### Join the Community

Join the **[Locations Hub Discord](https://discord.gg/sc4yEx2fNf)**, a community dedicated to Cyberpunk 2077 location mods and collaborative projects. Players and authors are welcome!

The NC Zoning Board is a side project of the Locations Hub. Visit the **#nc-zoning-board** channels to discuss mapping, get help with submissions, and coordinate with other modders.

### Running Locally

```bash
# Clone the repo
git clone https://github.com/nczoning/nc-zoning-board.git
cd nc-zoning-board

# Install dependencies (only needed for tile generation)
npm install

# Start a local server
npx serve .
# Open http://localhost:3000
```

> **Note:** The app uses `fetch()` to load mod data, so you need a local HTTP server. Opening `index.html` directly will cause CORS errors.

### Regenerating Map Tiles

If you have a new map source image, regenerate the tiles:

```bash
# Place your 8k source image at: raw maps/8k/night_city.png
node scripts/generate_tiles.js
# Tiles are generated in assets/tiles/
```

See [Tile Generation Guide](docs/tile-generation.md) for details.

## Submitting Your Mod

Submit it from the map. No GitHub account, no Git, one way to do it.

1. Get your in-game coordinates from the CET console
2. Open [nczoning.net](https://nczoning.net) and press **[+] Submit**
3. Pick your mod, or paste its Nexus link, then fill in the rest
4. A maintainer reviews it, and approving it puts your pin on the map within seconds

Tagging your mod **NCZoning** on Nexus is still worth doing: it puts your mod in
the picker with its name, description and author already filled in. It no longer
publishes a pin on its own.

Already on the map? Correct your pin from its own popup with **Suggest a fix**,
which sends only the fields you change. The same form can request removal.

See **[docs/adding-mods.md](docs/adding-mods.md)** for the CET command and the
full field reference.

## Documentation

| Guide | Description |
|-------|-------------|
| [Adding Mods](docs/adding-mods.md) | Submitting from the map, CET coordinates, the field reference |
| [The NCZoning Tag](docs/nczoning-auto-discovery.md) | What tagging your mod on Nexus prefills, and what it no longer does |
| [Submission Pipeline](docs/submission-pipeline.md) | What happens between pressing Submit and the pin appearing |
| [Coordinate System](docs/coordinate-system.md) | CET ↔ Leaflet transform, calibration data |
| [Architecture](docs/architecture.md) | File structure, data flow, tech stack |
| [Tile Generation](docs/tile-generation.md) | Map tiling, source images, upgrading resolution |
| [Roadmap](https://github.com/orgs/nczoning/projects/1) | Current status and planned work. The project board is the roadmap |

## Tech Stack

- **[Leaflet.js](https://leafletjs.com/)**: Interactive map (`L.CRS.Simple` with custom tiles)
- **Vanilla JS / CSS**: No frameworks, no bundler
- **[Sharp](https://sharp.pixelplumbing.com/)**: 8k map tile generation (dev dependency)
- **Cloudflare Workers + D1 + KV**: the `/v1` Data API, the location registry, and the served dataset
- **Cloudflare Pages**: hosting for the site and the admin dashboard (Git integration)

## Contributors & Community

Built by modders, for modders. A huge thanks to everyone who's contributed:

- **[Kaoziun](https://www.nexusmods.com/profile/Kaoziun/mods?gameId=3333)**: Original vision & community leadership
- **[manavortex](https://www.nexusmods.com/profile/manavortex/mods?gameId=3333)**: Data structure & guidance
- **[Spuddeh](https://www.nexusmods.com/profile/Spuddeh/mods?gameId=3333)**: Active development
- **[Akiway](https://www.nexusmods.com/profile/Akiway/mods?gameId=3333)**: UI/UX & design
- **Locations Hub Council & community**: Testing, ideas, and support

Want to help? See **[CONTRIBUTING.md](CONTRIBUTING.md)**. We'd love to have you!

## Licensing

**Software Code:** MIT License (see [`LICENSE`](LICENSE) file)

**Game Assets:** Subject to CD PROJEKT RED's Fan Content Policy (see [`ASSETS.md`](ASSETS.md) for details)

This project is non-commercial and free. Game data and assets are used under CD PROJEKT RED's fan content terms, which require attribution and prohibit commercial use.
