# 3D World Map Fixed — asset integration

How NC Zoning Board integrates **malgalad's "3D World Map Fixed"** mod
([Nexus #26500](https://www.nexusmods.com/cyberpunk2077/mods/26500), author
profile [malgalad](https://www.nexusmods.com/profile/malgalad)) as the default
3D-map building data, selectable via a Settings toggle. Permission to use the
assets was granted by the author (2026-04-14).

> The base game's 3D world map has misaligned / broken building geometry in
> places (e.g. a single solid block filling the Corpo Plaza roundabout). This
> mod corrects it. We ship both the original (CDPR) and fixed building sets and
> let the user choose; **Fixed is the default.**

## How the mod is structured (three deliverables)

The exported mod (`3d_map_fixed_export/`) contains **three distinct building
representations**, encoded differently. Understanding which is which is the key
to the integration:

1. **Fixed per-district textures** —
   `base/fx/textures/3dmap/static/<district>_data.xbm` for 7 districts
   (city_center, heywood, pacifica, santo_domingo, watson, westbrook,
   ep1_dogtown — **no spaceport**). These sit at the **vanilla depot paths** and
   are the same dimensions as the base-game textures (DX10 header byte-identical;
   only the pixel data differs). They **remove** the game's broken blocks but do
   **not** add replacements.
2. **`my_district` — combined corrections overlay** — `my_district.xbm`, a
   single world-space point cloud (~19k buildings spread across the whole city)
   rendered by the mod's own entity (`3dmap_view.ent` → `3dmap_triangle_soup.mesh`).
   This is **sparse** — it holds malgalad's *corrected/added* buildings (e.g. the
   Corpo Plaza cluster), filling the gaps the per-district pass left. It is **not**
   a full dense city; it overlays on top of the per-district base.
3. **`ugly_building` add-on** — malgalad's optional *"returns the ugly building
   to Watson"* download. A tiny standalone cloud (`ugly_building.xbm`, 72×24) at
   its own world position.

So the faithful render = **per-district fixed (broken blocks removed) + `my_district`
(corrections fill the gaps) + `ugly_building` (the returned building)**. Verified
at Corpo Plaza: per-district alone leaves the centre empty; `my_district` places
the replacement cluster exactly there.

### Surface texture

`my_district` and `ugly_building` reference `c_pacifica_m.xbm` as their surface
(`BaseColor`) — the game's stock Pacifica surface, which malgalad reuses for his
additions (he hasn't cracked the edge-highlight texture). In this repo that file
already exists as `assets/dds/pacifica_m.dds` (the `c_` prefix was dropped when
it was first added); the two are byte-identical, so the overlays **reuse
`pacifica_m.dds`** rather than shipping a duplicate.

## How NC Zoning Board renders it

All in `assets/js/three-scene.js` (`DISTRICT_META` + `loadBuildings()`):

- **`DISTRICT_META.dataDdsFixed`** — the 7 per-district entries gain a
  `dataDdsFixed` path (`assets/dds/fixed/<district>_data.dds`) alongside the
  base-game `dataDds`. `ep1_spaceport` has no fixed version → it stays on
  `dataDds` in both sets.
- **`my_district` and `ugly_building`** are extra `DISTRICT_META` entries flagged
  `fixedOnly: true` — loaded only when the Fixed set is active. Their `offset` is
  the **entity world position** decoded from the mod's `.ent`
  (`my_district` = `[-828, -531]`, `ugly_building` = `[-1630, 1404]`; CP2077
  `FixedPoint` WorldPosition → divide `Bits` by `131072`).
- **Asset-set selection** — `loadBuildings()` reads `localStorage[NCZ.ASSET_SET_KEY]`
  (`'fixed'` default, `'cdpr'` = base game). For each district it picks
  `dataDdsFixed` when Fixed is active, else `dataDds`; `fixedOnly` entries are
  skipped entirely in CDPR mode. The Settings → **Map data → Fixed building
  assets** toggle writes the preference and reloads the page (the data is CPU-
  decoded once at scene init).

### Empty-cell encoding gotcha

The point-cloud decode skips empty grid cells. Base-game textures mark empties
with near-zero position **alpha**; malgalad's fixed textures keep alpha full and
mark empties by **zero scale** instead. `loadBuildings()` therefore skips a cell
when its alpha is below `NCZ.DDS_ALPHA_THRESH` **OR** its scale is ~0 on all
three axes — correct for both encodings (on base-game data the two sets of
empties coincide, so it's a no-op there). Without the scale test, the fixed
textures would render thousands of degenerate zero-scale cubes.

## Updating when malgalad ships a new version

The mod is in active development (more districts / fixes planned). To refresh:

1. Open the updated `.archive` in WolvenKit; export the changed
   `*_data.xbm` as **DDS** (16-bit, default settings — see
   [`docs/3dmap-asset-reference.md`](3dmap-asset-reference.md) for the building
   texture format).
2. Copy into `assets/dds/fixed/` (per-district keeps the repo basename, e.g.
   `ep1_dogtown_data.xbm` → `dogtown_data.dds`).
3. Run the validator: `node scripts/validate_3dmap_assets.js` — checks each
   fixed DDS's DX10 dimensions, asserts `width % 3 === 0`, derives the block
   height, and reports it against the matching `DISTRICT_META` entry. Catches a
   bad export or a dimension/bounds change before it ships.
4. **New district added by the author?** Add a `DISTRICT_META` entry: pull
   `TransMin/TransMax/CubeSize` from its material (`*.mesh.json` →
   `localMaterialBuffer`) and the world `offset` from its `.ent` component
   position (FixedPoint `Bits / 131072`). Drop both `_data` and the base-game
   `_m`, then re-validate.
5. Commit; PR → `dev`.

## Asset provenance

| File(s) | Source | Notes |
| --- | --- | --- |
| `assets/dds/fixed/<district>_data.dds` ×7 | mod, vanilla depot path | alignment-fixed per-district clouds |
| `assets/dds/fixed/my_district_data.dds` | mod (`my_district.xbm`) | combined corrections overlay |
| `assets/dds/fixed/ugly_building_data.dds` | mod (`ugly_building.xbm`) | optional "ugly building" add-on |
| `assets/dds/<district>_data.dds` / `_m.dds` | base game | original CDPR set (toggle = off) |
| `assets/dds/pacifica_m.dds` | base game (`c_pacifica_m`) | surface reused by the overlays |

All game-derived assets are covered by CD PROJEKT RED's Fan Content Policy; the
mod assets are used with the author's permission and credited in the in-app
About panel. See `ASSETS.md`.

## Debugging

`?only=<district>` renders a single cloud in isolation — `?only=my_district`
shows just the corrections overlay, `?only=ugly_building` just the add-on. See
[`docs/url-parameters.md`](url-parameters.md).
