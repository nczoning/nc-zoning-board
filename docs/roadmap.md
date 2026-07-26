# Roadmap

## Current Status

The NC Zoning Board is an interactive map and coordinate registry for Cyberpunk 2077 location mods.

### What Works

#### Map and data

- ✅ 16k WebP tiled map with zoom levels 0–8 (native to 6, upscaled to 8)
- ✅ Transparent map background: tiles regenerated from source
- ✅ CET coordinate transform (16-point calibrated, linear, accurate)
- ✅ Mod pins with clickable popups (name, authors, description, Nexus link)
- ✅ Tile generation script (`scripts/generate_tiles.js`)
- ✅ **Data refactor**: split `mods.json` into individual JSON files for cleaner management
- ✅ **Custom pin icons**: colour-coded by mod category
- ✅ **Tagging system**: dynamic filters with hover tooltips and definitions
- ✅ **Multi-author & credits**: support for authorship arrays and team credits
- ✅ **URL optimisation**: store only the Nexus mod ID and generate links dynamically
- ✅ **Image support**: dynamically fetching thumbnails and full-size images from the Nexus GraphQL API
- ✅ **Pin clustering**: group nearby pins at low zoom, with 4-tier colour thresholds and inlined MarkerCluster CSS
- ✅ **Cluster menu panel**: clicking a cluster opens a resizable side panel listing all mods with thumbnails, tags, and descriptions
- ✅ **Marker tooltips**: hovering a pin shows a smart-positioned tooltip with the mod name
- ✅ **Dynamic popup positioning**: popups stay within map bounds with directional arrows
- ✅ **NCZoning auto-discovery**: automatic pin creation from Nexus-tagged mods via GraphQL API, with BBCode generator modal
- ✅ **Mod update indicator**: API-driven badge for recently updated mods (within 7 days)
- ✅ **Sort by last updated**: locations list sortable by most recently updated
- ✅ **Discover a location button**: quick-jump UI to find a random or nearby pin
- ✅ **Progressive cluster colours**: smooth colour gradients across cluster size tiers
- ✅ **Less restrictive map panning**: map edge allows movement up to halfway across the screen
- ✅ **Deep links to mod pins**: URL param (e.g. `?mod=13821`) jumps directly to a pin on the map; Copy Link button copies shareable URLs

#### 3D scene

- ✅ **3D map view**: live Three.js scene rendering the game's terrain, roads, metro and buildings, switchable with the 2D satellite view
- ✅ **Native WebGPU renderer**: TSL materials, storage buffers, and GPU compute-shader instance culling, with a WebGL2 fallback
- ✅ **Outdoor lighting and shadows**: fitted shadow map with texel snapping, shadow-aware cull frustum, and a working Shadows toggle
- ✅ **Game-matched colour pipeline**: ACES output transform ported from the in-game 3D map, plus bloom
- ✅ **Building shading**: game flat-AO base with sun and shadows layered on top
- ✅ **See-through roads**: stencil-masked road rendering through open water (the Pacifica tunnel)
- ✅ **Fixed-asset integration**: 3D World Map Fixed community assets
- ✅ **Cinematic intro camera** on first load, and a showcase fly-through
- ✅ **Three.js r185**: render loop on `setAnimationLoop`, custom TSL line material for district outlines

#### Districts

- ✅ **District overlays**: district and subdistrict boundary outlines, zoom-switchable
- ✅ **District name labels and icons** at polygon centroids, from the game's own atlas
- ✅ **District hover info panel**, with a 250 ms brighten fade on the outlines

#### Data API

- ✅ **Read-only `/v1` API** at `api.nczoning.net` — locations, districts, tags and meta, served from a Cloudflare Worker
- ✅ **Server-side merge engine** with district enrichment, refreshed to KV by cron with last-known-good and Discord alerting
- ✅ **Mod file names**: each record lists the `.archive`/`.xl` files it installs, so in-game mods can detect what a player has
- ✅ **Published API docs**: OpenAPI spec rendered at the API root, plus a written reference
- ✅ **The website consumes `/v1`** rather than querying Nexus client-side

#### Presentation and infrastructure

- ✅ Cyberpunk-themed UI (Orbitron/Rajdhani fonts, dark theme)
- ✅ **Preferences menu**: in-app theme selection
- ✅ **Themes**: Night Corp, Arasaka, Militech, Aldecaldos, Default Game (matching the in-game map palette), and Preem Map
- ✅ **Attribution footer**: CDPR Fan Policy and mod credits
- ✅ **Nexus API documentation**: full reference for queries, fields, caching, and known limitations
- ✅ mods.json schema validation (CI via GitHub Actions)
- ✅ Automated mod submission via GitHub Issue form → PR pipeline
- ✅ Cloudflare Pages deployment

### In Progress

- 🔄 **NCZoningCore framework mod**: the in-game consumer of the Data API, built in the CP2077 modding workspace

## Planned Features

### High Priority

- [ ] **Night Stage 2 — glowing district map**: per-district emissive lighting
- [ ] **Night Stage 3b — lit-window facades**: procedural window lighting in TSL

### Medium Priority

- [ ] **Sort controls**: ascending/descending toggles and additional sort methods for the locations list
- [ ] **Building/block selection editor**: interactive correction of the building segmentation

### Low Priority / Nice to Have

- [ ] **SLM integration**: button on mod popup to generate a Simple Location Manager export string
- [ ] **Mobile layout / optimisations**: responsive sidebar and touch-friendly markers
- [ ] **Search handles credits**: location search should match against the credits field as well as name/author
- [ ] **Multiple coordinate sets**: support `coords`, `additional_coords`, `nav_coords` on a single mod entry
- [ ] **Fix holes in the terrain GLB**
- [ ] **Road borders in Pacifica/Dogtown**: over-bright and flickering triangles, caused by a defect in the vanilla mesh

### Blocked

- [ ] **Click-on-map coordinates**: implemented but removed at collaborator request; revisit if consensus changes
- [ ] **Quality presets (Low/Medium/High)**: Stage 2 of the quality work
- [ ] **Pin occlusion during the showcase flyover**: scrapped; see the decision record

## Ideas / Under Consideration

Not committed to, and tracked as drafts rather than issues.

- Unofficial district overlays: community-recognised areas not in the base game
- New themes: Netrunner, Blade Runner, Deus Ex
- Showcase editor: GUI tool for creating custom flyover sequences
- Theme editor: GUI tool for creating and customising themes
- Terrain contour lines in the 3D scene
- CSM revisit: world-anchored outer cascade with camera-aligned inner cascades
- PCSS for physical shadow penumbra (soft, distance-dependent)
- Moon disc phase terminator (crescent shading)
- Content-aware metric for the lighting metering harness
- F11 fullscreen should hide all overlays and UI
- Live player position on the web map (opt-in heartbeat)
- Submission system Worker: authentication and a moderation queue
- Installed-mod awareness, with in-game map pins and roulette
- Fast travel / metro station POI extraction for the API
- Generate our own building box cloud from streaming sectors, instead of decoding CDPR's `_data.dds`
