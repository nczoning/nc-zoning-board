# Roadmap

## Current Status

The NC Zoning Board is an interactive map and coordinate registry for Cyberpunk 2077 location mods.

### What Works

- ✅ 16k WebP tiled map with zoom levels 0–8 (native to 6, upscaled to 8)
- ✅ Transparent map background — tiles regenerated from source
- ✅ CET coordinate transform (16-point calibrated, linear, accurate)
- ✅ Mod pins with clickable popups (name, authors, description, Nexus link)
- ✅ Cyberpunk-themed UI (Orbitron/Rajdhani fonts, dark theme)
- ✅ mods.json schema validation (CI via GitHub Actions)
- ✅ Automated mod submission via GitHub Issue form → PR pipeline
- ✅ GitHub Pages deployment
- ✅ Tile generation script (`scripts/generate_tiles.js`)
- ✅ **Data refactor** — split `mods.json` into individual JSON files for cleaner management
- ✅ **Custom pin icons** — colour-coded by mod category
- ✅ **Tagging system** — dynamic filters with hover tooltips and definitions
- ✅ **Multi-author & credits** — support for authorship arrays and team credits
- ✅ **URL optimisation** — store only the Nexus mod ID and generate links dynamically
- ✅ **Image support** — dynamically fetching thumbnails and full-size images from the Nexus GraphQL API
- ✅ **Pin clustering** — group nearby pins at low zoom, with 4-tier colour thresholds and inlined MarkerCluster CSS
- ✅ **Cluster menu panel** — clicking a cluster opens a resizable side panel listing all mods with thumbnails, tags, and descriptions
- ✅ **Marker tooltips** — hovering a pin shows a smart-positioned tooltip with the mod name
- ✅ **Dynamic popup positioning** — popups stay within map bounds with directional arrows
- ✅ **NCZoning auto-discovery** — automatic pin creation from Nexus-tagged mods via GraphQL API, with BBCode generator modal
- ✅ **Mod update indicator** — API-driven badge for recently updated mods (within 7 days)
- ✅ **Preferences menu** — in-app theme selection (Night Corp, Arasaka, Militech, Aldecaldos)
- ✅ **Sort by last updated** — locations list sortable by most recently updated
- ✅ **Discover a location button** — quick-jump UI to find a random or nearby pin
- ✅ **Progressive cluster colours** — smooth colour gradients across cluster size tiers
- ✅ **Less restrictive map panning** — map edge allows movement up to halfway across the screen
- ✅ **Nexus API documentation** — full reference for queries, fields, caching, and known limitations
- ✅ **Deep links to mod pins** — URL param (e.g. `?mod=13821`) jumps directly to a pin on the map; Copy Link button copies shareable URLs

### In Progress

- 🔄 **Building / road / metro overlays** — extracting game geometry and aligning to CET coordinate space
- 🔄 **District overlays** — district and subdistrict boundary outlines rendered as GeoJSON layers, zoom-switchable

## Planned Features

### Medium Priority

- [ ] **Mobile layout / optimisations** — responsive sidebar and touch-friendly markers
- [ ] **Sort controls** — ascending/descending toggles and additional sort methods for the locations list

### Low Priority / Nice to Have

- [ ] **SLM integration** — button on mod popup to generate a Simple Location Manager export string
- [ ] **Search handles credits** — location search should match against the credits field as well as name/author
- [ ] **Unofficial district overlays** — community-recognised areas not in the base game (North/East/South Badlands subdivisions, Rocky Ridge, Casino, Sonora Canyon)
- [ ] **New theme: Netrunner**
- [ ] **New theme: Blade Runner**
- [ ] **New theme: Deus Ex**
- [ ] **Showcase editor** — GUI tool for creating custom flyover sequences (very low priority)
- [ ] **Theme editor** — GUI tool for creating and customising themes (very low priority)
- [ ] **Multiple coordinate sets** — support `coords`, `additional_coords`, `nav_coords` on a single mod entry

### Blocked

- [ ] **16k tile support** — higher zoom fidelity; blocked pending performance impact assessment
- [ ] **32k tile support** — dependent on 16k work
- [ ] **Click-on-map coordinates** — implemented but removed at collaborator request; revisit if consensus changes
