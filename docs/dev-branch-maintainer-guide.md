# Dev Branch: Maintainer Guide

This document covers what the `dev` branch contains, why it exists, and how to contribute to the Three.js 3D map migration happening on it. For infrastructure details (Cloudflare Pages setup, build config), see [`dev-environment.md`](dev-environment.md).

## Why the dev branch exists

The NC Zoning Board site at [nczoning.net](https://nczoning.net) is currently a 2D Leaflet map with a rasterised terrain image. The `dev` branch is the long-running integration branch for the **Three.js 3D map migration**: a 7-phase project that replaces the 2D schematic view with a live 3D scene rendering the game's actual terrain, roads, metro, buildings, and landmarks.

The migration happens on `dev` (not directly on `main`) because:

- **Main must stay fully functional.** It's the live site. Users visit it daily. Partial features or broken states can't ship.
- **Each phase produces a visible but incomplete state.** Phase 1 has terrain but no buildings. Phase 2 adds roads and districts. Phase 3 adds buildings. Etc. None of these are "shippable" on their own.
- **Phases need integration testing together.** Adding pins in Phase 4 might reveal coordinate issues from Phase 3 that only manifest when clicking on specific buildings.
- **Staging needs its own URL.** Testing the 3D view requires seeing it live, not just on localhost.

The dev branch exists from **before Phase 0 started** through the eventual merge of all 7 phases. When everything is complete and verified on `dev.nczoning.net`, `dev` merges to `main` in a single final PR.

## Environment summary

| Environment | Branch | URL | Deploys via |
|-------------|--------|-----|-------------|
| Production | `main` | [nczoning.net](https://nczoning.net) | Cloudflare Pages (native Git integration) |
| Staging | `dev` | [dev.nczoning.net](https://dev.nczoning.net) | Cloudflare Pages (native Git integration) |

Both environments are separate Cloudflare Pages projects on the same repo (prod builds `main`, staging builds `dev`). Cloudflare runs `node scripts/build_mods.js` on every push to the project's branch and deploys the result. No GitHub Actions secrets or tokens needed. Cloudflare's GitHub integration handles authentication itself.

## Contributing to a phase

The migration is structured as discrete phases with clear goals and verification criteria. Current phase-by-phase work is tracked in the [GitHub Project](https://github.com/users/spuddeh/projects/1) under the **WebGPU Migration** stream.

### Starting a new phase

```bash
git checkout dev
git pull origin dev
git checkout -b feat/three-js-phase-N
```

Create the phase branch off `dev`, not `main`. This picks up all completed prior phases.

### Working on a phase

1. **Read the migration plan section for your phase**: it lists the specific files to create/modify and the expected output.
2. **Read the relevant reference docs**:
   - [`three-js-scene.md`](three-js-scene.md): current Three.js scene implementation reference
   - [`coordinate-system-3d.md`](coordinate-system-3d.md): CET / GLB / building instance coordinate system details
   - [`3dmap-asset-reference.md`](3dmap-asset-reference.md): asset inventory and transform chains
3. **Keep `dev` merged in periodically** if the phase is long-running, so you pick up upstream bugfixes and new location data:
   ```bash
   git fetch origin
   git merge origin/dev
   ```
4. **Test locally**: `node scripts/build_mods.js` then `npx serve .`
5. **Update the changelog**: add entries under `## [Unreleased]` in `CHANGELOG.md` describing what the phase adds
6. **Update `three-js-scene.md`** if you change any architectural decisions, add new GLB assets, or change the data pipeline

### Finishing a phase

1. Push the feature branch:
   ```bash
   git push -u origin feat/three-js-phase-N
   ```
2. Open a PR **targeting `dev`** (not `main`):
   ```bash
   gh pr create --base dev --title "feat(3d): Phase N - <summary>"
   ```
3. Cloudflare Pages will build a preview deployment for the PR branch: use it to verify visual correctness on the staging URL
4. Merge when ready. Cloudflare redeploys `dev.nczoning.net` automatically.

### What NOT to do

- **Do not PR phase branches to `main`.** Phase 0 was an exception because it was a non-breaking pure refactor; all subsequent phases are visible changes that must stay on `dev` until the whole migration is done.
- **Do not push directly to `dev`** for feature work. Always use phase feature branches and PRs, even for small changes.
- **Do not rebase `dev` onto `main`.** The branches have diverged; merge main into dev periodically instead.

## Keeping dev in sync with main

Main receives regular updates that dev needs:

- **New location JSONs** from the auto-PR submission workflow (mod authors adding locations)
- **Bugfixes** to the Leaflet satellite view
- **Documentation updates**

To pull these into dev:

```bash
git checkout dev
git pull origin dev                    # Get any recent dev work
git fetch origin main
git merge origin/main --no-edit         # Merge main's changes
git push origin dev
```

Do this **ad-hoc, whenever `main` has changes `dev` needs**: a Leaflet/satellite-view bugfix, new location JSONs, tooling, or docs. There is **no fixed cadence**: no weekly schedule, no per-phase requirement. Sync on demand.

Merge conflicts are **almost always limited to `CHANGELOG.md`**, and the conflict is structural: `dev` carries a long-lived `[Unreleased]` block (the 3D-map changelog) that `main` doesn't have, while `main` accumulates released `[0.3.x]` sections `dev` doesn't have. **Resolve by union, in order:** keep dev's entire `[Unreleased]` body, then place main's released `[0.3.x]` sections immediately below it (above the previously-newest released version). Drop neither side: a correct resolution just removes the `<<<<<<<` / `=======` / `>>>>>>>` markers with both blocks intact.

## Phase status

As of the last update to this document:

| Phase | Name | Status | PR |
|-------|------|--------|-----|
| 0 | View-agnostic data layer | ✅ Merged to main + dev | #567 |
| 1 | Terrain scene + view switching | ✅ Merged to dev | #572 |
| 2 | Roads, metro, district borders | ✅ Merged to dev | #573 |
| 3 | Buildings as instanced cubes | 🟡 In progress | - |
| 4 | Location pins in 3D | ⏳ Not started | - |
| 5 | Landmarks | ⏳ Not started | - |
| 6 | Polish and integration | ⏳ Not started | - |

Check `CHANGELOG.md` and recent PRs for the current state.

## Technical context for the Three.js scene

### Files that make up the 3D view

```
assets/js/
  three-scene.js       - Three.js scene: renderer, camera, GLB loading, buildings
  three-markers.js     - CSS2D pins and clustering (Phase 4)
  overlay.js           - Leaflet district border overlay (shared with SAT view)

assets/glb/
  3dmap_terrain.glb    - Terrain surface mesh (18 MB)
  3dmap_water.glb      - Water plane
  3dmap_cliffs.glb     - Dogtown cliffs
  3dmap_roads.glb      - Road surfaces
  3dmap_metro.glb      - Metro tracks

data/
  buildings_3d.json    - 254k building instances (cetX, cetY, surfaceY, width, depth, height, brightness, districtIdx, yaw)
  subdistricts.json    - District/subdistrict polygon data in CET coordinates

scripts/
  build_buildings_3d.py      - Extracts buildings from WolvenKit _data.png textures
  fix_building_heights.py    - Raycasts terrain GLB to set building surface Y
  minimap_instance_shader.hlsl - Reference: the game's own instance shader
```

### Coordinate systems in one sentence

CET (game world) and GLB (terrain mesh) share the same XZ coordinate space at 1:1 scale. CET Z (elevation) does NOT match GLB Y. Use `fix_building_heights.py` to raycast terrain for actual surface Y at each building. Full details in [`coordinate-system-3d.md`](coordinate-system-3d.md).

### Building data pipeline

```
*_data.png (WolvenKit export, per-district instance textures)
    ↓
build_buildings_3d.py
  - Decodes position from R,G,B channels via TRANS_MIN/MAX
  - Decodes quaternion from Block 2, extracts yaw
  - Samples _m texture for brightness
  - Applies DISTRICT_OFFSETS for X,Y world position
    ↓
data/buildings_3d.json (intermediate, cetZ = CET Z from texture)
    ↓
fix_building_heights.py
  - Loads terrain GLB
  - Raycasts downward at each building XZ
  - Replaces cetZ with actual terrain surface Y
    ↓
data/buildings_3d.json (final, consumed by three-scene.js)
```

To regenerate after a game update:

```bash
python scripts/build_buildings_3d.py
python scripts/fix_building_heights.py
```

Python dependencies: `numpy`, `Pillow`, `trimesh`, `scipy`, `rtree`.

### Dev server

```bash
node scripts/build_mods.js   # Rebuild mods.json from data/locations/*.json first
npx serve .                   # Serve the repo root
```

Always rebuild `mods.json` before testing: it's gitignored and won't exist on a fresh clone.

## Troubleshooting

**Buildings don't appear**
- Check the browser console for errors in `loadBuildings()`
- Verify `data/buildings_3d.json` exists and has ~254k instances: `node -e "console.log(require('./data/buildings_3d.json').instances.length)"`
- Check that `fix_building_heights.py` was run after `build_buildings_3d.py`: the field at index 2 should be the terrain surface Y, not the original CET Z

**Terrain and buildings don't align**
- Districts are the reference truth: they're drawn from `subdistricts.json` in CET coordinates
- If districts align with terrain but not buildings, check building XY extraction in `build_buildings_3d.py`
- If nothing aligns, check `DISTRICT_OFFSETS` in `build_buildings_3d.py`: these translate district-local coordinates to CET world coordinates

**Camera behaves oddly when tilting**
- The camera uses `up=(0,1,0)` (standard Three.js up). Do NOT change this to `(0,0,-1)`: that causes a Y-axis inversion bug where buildings appear upside down when tilted. This was Phase 3's blocker and the one-line fix was restoring the standard up vector.

**Cloudflare Pages build fails**
- Check the build log in the Cloudflare dashboard (Workers & Pages → nc-zoning-board-dev → Deployments)
- Usually a missing dependency or a syntax error in a recent commit
- Verify `package.json` dependencies haven't broken

**Data desync between local and deployed**
- `mods.json` is generated at deploy time. If local testing shows stale data, run `node scripts/build_mods.js` before `npx serve .`
- Location file changes on main need to be merged into dev (`git merge origin/main`)

## Finalising the migration

When all 7 phases are complete and verified on `dev.nczoning.net`:

1. Final testing pass on all themes (Night Corp, Arasaka, Militech, Aldecaldos)
2. Run the full local test suite: `npx serve .`, click every view toggle, every overlay, every filter
3. Take screenshots of the before/after for the PR description
4. Open the final PR: `gh pr create --base main --title "feat(3d): Three.js 3D schematic map"`
5. Merge: GitHub Actions deploys to nczoning.net
6. Delete the `dev` branch (no longer needed), or keep it for the next major feature

## Related documentation

- [GitHub Project](https://github.com/users/spuddeh/projects/1): current phase-by-phase work, organised by Stream (WebGPU Migration / Three.js Parity / Roadmap / Bugs) and Release (Schema map / Post schema map / Future / Ongoing)
- [`three-js-scene.md`](three-js-scene.md): Current implementation reference
- [`coordinate-system-3d.md`](coordinate-system-3d.md): CET/GLB/instance texture coordinate details
- [`3dmap-asset-reference.md`](3dmap-asset-reference.md): Game asset inventory and transform chains
- [`map-data-extraction.md`](map-data-extraction.md): How texture data becomes JSON
- [`dev-environment.md`](dev-environment.md): Infrastructure setup (Cloudflare Pages)
