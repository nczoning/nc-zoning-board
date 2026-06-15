# CP2077 District Hierarchy

Full district hierarchy extracted from TweakDB `District_Record` entries (132 records).
Source: `scripts/extract_tweakdb_map.wscript` run in WolvenKit.

## District Outline Colors

From `world_map_style.inkstyle` → `MainColors` in `main_colors.inkstyle`:

| District | UiState | Ink Color | HDR RGBA | RGB | Hex |
|----------|---------|-----------|----------|-----|-----|
| Default (base) | Default | MainColors.White | [1, 1, 1, 1] | (255, 255, 255) | #ffffff |
| City Center | CityCenter | MainColors.Yellow | [1.119, 0.844, 0.257, 1] | (255, 215, 65) | #ffd741 |
| Heywood | Heywood | MainColors.Green | [0.114, 0.929, 0.514, 1] | (29, 237, 131) | #1ded83 |
| Pacifica | Pacifica | MainColors.Red | [1.176, 0.381, 0.348, 1] | (255, 97, 88) | #ff6158 |
| Santo Domingo | SantoDomingo | MainColors.Blue | [0.369, 0.965, 1, 1] | (94, 246, 255) | #5ef6ff |
| Watson | Watson | MainColors.CombatRed | [1.570, 0.244, 0.205, 1] | (255, 62, 52) | #ff3e34 |
| Westbrook | Westbrook | MainColors.Orange | [1.280, 0.320, 0, 1] | (255, 81, 0) | #ff5100 |
| Morro Rock | MorroRock | MainColors.MildBlue | [0.204, 0.569, 0.592, 1] | (52, 145, 151) | #349197 |
| Dogtown | Dogtown | MainColors.DarkGreen | [0, 0.639, 0.173, 1] | (0, 163, 44) | #00a32c |

Default outline opacity: 0.6 (from `District.outlineOpacity` in Default state).

## Zoom Level Configuration

From TweakDB `WorldMapZoomLevel_Record` entries. Camera range: zoomMin=800, zoomMax=15000.

| Level | Game Zoom | ShowDistricts | ShowSubDistricts | PanSpeed |
|-------|-----------|:---:|:---:|----------|
| BaseZoomLevel | 1 | - | - | 1 |
| ExtraMappins | 1000 | - | - | 1400 |
| AllMappins | 2500 | - | - | 1400 |
| Vendors | 3500 | - | - | 1400 |
| Important | 4500 | - | - | 1400 |
| SubDistricts | 7000 | - | Yes | 3000 |
| Districts | 11000 | Yes | - | 3500 |

All levels use FOV=25 and Yaw=-85 rotation.

## Map Bounds

### Render Extent (authoritative — used for tile/overlay projection)

From the Realistic Map mod terrain quad UV mapping (see `docs/coordinate-system.md`):

| Parameter | Value |
|-----------|-------|
| WORLD_MIN_X | -6298 |
| WORLD_MAX_X | 5815 |
| WORLD_MIN_Y | -7684 |
| WORLD_MAX_Y | 4427 |
| Width | 12113 CET units |
| Height | 12111 CET units |
| Centre | (-242, -1628) |

### In-Game Pan Limit (TweakDB — NOT the render extent)

From TweakDB `WorldMap.DefaultSettings` — defines how far the player can scroll the map in-game, not what is rendered:

| Parameter | Value |
|-----------|-------|
| CursorBoundaryMin | X=-5500, Y=-7300 |
| CursorBoundaryMax | X=6050, Y=5000 |

## Full Hierarchy

Legend:
- **Bold** = has UiState color (rendered on map)
- `[Q]` = isQuestDistrict
- Gang affiliations shown where applicable

### Night City Districts

#### **City Center** `[Q]` — UiState: CityCenter (Yellow #ffd741)
- Corpo Plaza `[Q]`
  - Arasaka Tower Atrium
  - Arasaka Tower CEO Floor
  - Arasaka Tower Jenkins Office
  - Arasaka Tower Jungle
  - Arasaka Tower Lobby
  - Arasaka Tower Nest
  - Arasaka Tower Saburo Office
  - Arasaka Tower Unlisted Floors
  - Arasaka Tower Upper Atrium
  - Corpo Plaza Apartment
  - q201 Cyberspace
- Downtown
  - Jinguji
  - The Hammer

#### **Watson** `[Q]` — UiState: Watson (CombatRed #ff3e34) — Maelstrom
- Arasaka Waterfront
  - Abandoned Warehouse
  - Konpeki Plaza
- Kabuki
  - Judy's Apartment
  - Lizzie's Bar
  - No-Tell Motel
- Little China
  - Afterlife
  - Misty's Shop
  - Q101 Cyberspace
  - Riot Club
  - Tom's Diner
  - V's Apartment
  - Victor's Clinic
- Northside
  - All Foods
  - CleanCut
  - Northside Apartment
  - Totentanz
  - WNS

#### **Westbrook** `[Q]` — UiState: Westbrook (Orange #ff5100)
- Charter Hill
  - Au Cabanon
  - Power Plant
- Japantown — Tyger Claws
  - Clouds
  - Dark Matter
  - Fingers
  - Fourth Wall BD Studio
  - Hiromi's Apartment
  - Japantown Apartment
  - Megabuilding H8
  - VR Tutorial
  - Wakako's Pachinko Parlor
- North Oak
  - Arasaka Estate
  - Columbarium
  - Denny's Estate
  - Kerry's Estate

#### **Heywood** `[Q]` — UiState: Heywood (Green #1ded83) — Valentinos
- The Glen
  - Embers
  - Glen Apartment
  - Music Store
  - NCPD Lab
  - Wicked Tires
- Vista Del Rey
  - Abandoned Apartment Building
  - Delamain HQ
  - El Coyote Cojo
  - La Catrina
- Wellsprings

#### **Santo Domingo** `[Q]` — UiState: SantoDomingo (Blue #5ef6ff) — 6th Street
- Arroyo
  - Arasaka Warehouse
  - Claire's Garage
  - Cytech Factory
  - Kendachi Parking
  - Kenmore Cafe
  - Las Palapas (Arroyo)
  - Red Dirt
  - Tire Empire
- Rancho Coronado
  - Caliente
  - Gun-O-Rama
  - Piez
  - Softsys
  - Stylishly

#### **Pacifica** `[Q]` — UiState: Pacifica (Red #ff6158) — Voodoo Boys
- Coastview — Voodoo Boys
  - Batty's Hotel
  - Butcher Shop
  - Grand Imperial Mall
  - Rundown Apartment
  - VDB Chapel
  - VDB Maglev
  - q110 Cyberspace
- West Wind Estate — Animals

#### **Dogtown** `[Q]` — UiState: Dogtown (DarkGreen #00a32c) — Barghest
- Akebono
- Capitan Caliente
- Cynosure Facility
- Expo
- Hideout
- Worldmap Sub

#### **Morro Rock** — UiState: MorroRock (MildBlue #349197)
- NCX (Spaceport)

### Badlands — UiState: None (no map border)

#### Badlands `[Q]` — Aldecaldos
- Biotechnica Flats
- ~~Dry Creek~~ *(nomad lifepath start, not on world map)*
- Jackson Plains
- Laguna Bend
  - Lake Hut
- ~~Las Palapas~~ *(motel chain located within Biotechnica Flats, not a geographic subdistrict)*
- ~~NC Spaceport~~ *(this is Morro Rock/NCX, already listed above)*
- North Sunrise Oil Field
- Rattlesnake Creek
- Red Peaks
- Rocky Ridge
- ~~Santa Clara~~ *(unknown location, no community references found)*
- Sierra Sonora
- SoCal Border Crossing
- Vasquez Pass
- ~~Yucca~~ *(nomad lifepath start, not on world map)*
- ~~Yucca Garage~~ *(nomad lifepath start, not on world map)*
- ~~Yucca Radio Tower~~ *(nomad lifepath start, not on world map)*

#### North Badlands

#### South Badlands
- Edgewood Farm
- Poppy Farm
- Trailer Park
- q201 Space Station

### Other
- Brooklyn (Dogtown sub, orphaned — parentDistrict: None in TweakDB)
- q307 Langley Clinic (orphaned)

## Boundary Data Sources

| District Type | Source | Status |
|---------------|--------|--------|
| 8 main city districts | `3dmap_view.ent.json` trigger polygons | Extracted |
| 16 city subdistricts | `3dmap_view.ent.json` trigger polygons | Extracted |
| Badlands subdistricts | Streaming sector `worldLocationAreaNode` | All 10 extracted and in `data/subdistricts.json` |
| Deep locations (bars, apartments) | In-game trigger volumes | Not applicable for map |

### Streaming Sector Exports (Badlands)

| Sector File | Subdistricts |
|-------------|-------------|
| `exterior_0_-1_0_6.streamingsector` | Laguna Bend, Red Peaks, Rocky Ridge |
| `exterior_1_-1_0_6.streamingsector` | Sierra Sonora, Vasquez Pass |
| `exterior_-1_-1_0_6.streamingsector` | Jackson Plains |
| `exterior_-1_-2_0_6.streamingsector` | Rattlesnake Creek, Biotechnica Flats |
| `exterior_-1_1_0_6.streamingsector` | North Sunrise Oil Field |
| `exterior_-3_-6_0_4.streamingsector` | SoCal Border Crossing |

**Renderable Badlands subdistricts** (10): Biotechnica Flats, Jackson Plains, Laguna Bend, North Sunrise Oil Field, Rattlesnake Creek, Red Peaks, Rocky Ridge, Sierra Sonora, SoCal Border Crossing, Vasquez Pass

**Not on world map** (skipped): Dry Creek, Yucca, Yucca Garage, Yucca Radio Tower (nomad lifepath start); Las Palapas (motel within Biotechnica Flats); NC Spaceport (= Morro Rock/NCX); Santa Clara (unknown/unused)
