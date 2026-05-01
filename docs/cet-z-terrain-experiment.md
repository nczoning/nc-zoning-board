# CET Z vs Terrain Y — In-Game Calibration Experiment

> Sanity-check whether CET Z (player position) and the terrain GLB Y are in
> the same coordinate space. If yes, pin placement in 3D needs no offset.
> If there's a constant offset, we bake it into `cetToThree`. If the offset
> varies per location, we need to raycast.

## Why this matters

The wiki entry [coordinate-system-3d.md:31](../wiki/sources/coordinate-system-3d.md#L31)
claimed an "elevation gap" between CET Z and terrain Y of 7–23m. Those samples
were taken on top of buildings/platforms — we'd be measuring infrastructure
height, not a coordinate system mismatch. This experiment is the redo.

## What you need

- **Cyber Engine Tweaks** open in-game
- Recommended (not required): god mode (`Game.GodMode(true, "Player")`) — the
  teleport now drops you from only ~5m above measured terrain Y, so fall
  damage should be trivial, but a slope landing might bounce you.
- **CSV**: `cet-z-terrain-experiment.csv` in this folder. Open in Excel,
  Google Sheets, or any text editor. Each row already has its
  `teleport_z` and our pre-computed `terrain_glb_y`; you fill `recorded_*`
  and `landed_on`.

## Teleport commands (copy-paste, two lines per point)

Each pair is the teleport itself, then the read. Paste both, wait for the
player to settle on the surface, then copy the read output into the CSV.

Heights below are 5m above the terrain GLB Y at each (X, Y) — pre-computed
via `scripts/query_terrain_heights.py`.

### 1. Eastern badlands  (X=3500, Y=−1500)

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(3500, -1500, 150, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

### 2. Northeast outskirts  (X=1500, Y=5000)

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(1500, 5000, 244, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

### 3. South ranchland  (X=−1000, Y=−6000) — *possible mountain, skip if slope*

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(-1000, -6000, 513, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

### 4. Charter Hill terrain  (X=−3000, Y=3500)

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(-3000, 3500, 69, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

### 5. Coastal desert NW  (X=−500, Y=5500)

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(-500, 5500, 88, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

### 6. Eastern oilfield flats  (X=4000, Y=0)

```lua
Game.GetTeleportationFacility():Teleport(GetPlayer(), Vector4.new(4000, 0, 123, 1), EulerAngles.new(0, 0, 0))
local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
```

## Filling in the CSV

For each point, copy the printed values into the row:

- `recorded_x`, `recorded_y`, `recorded_z`, `recorded_yaw` ← from the read output
- `landed_on` ← categorical, one of:
  - `terrain` — bare ground / dirt / sand / rock
  - `water` — you're swimming
  - `road` — paved surface
  - `building` — clipped into / on top of a structure
  - `clipped` — fell through the world / underground
  - `other:DESCRIPTION` — anything else worth flagging
- `notes` (optional) — visible terrain features, slope, weird behaviour

## What to skip

- **Skip rows where you land on water, road, or clipped** — leave the recorded
  fields blank, just fill `landed_on`. I'll pick a different (X, Y) for those.
- **Don't worry if `recorded_x` / `recorded_y` differ slightly from `target_x`
  / `target_y`** — the player can drift a bit while landing. The drift is
  small enough (<5m typically) to not affect the comparison.

## What I'll do with the data

For each row where `landed_on = terrain`:

1. Load `assets/glb/3dmap_terrain.glb` in a Node script.
2. Raycast straight down at `(recorded_x, recorded_y)`.
3. Compute `delta = recorded_z - terrain_glb_y`.

Three possible outcomes:

| Outcome | Pattern in delta column | Action |
| --- | --- | --- |
| **Same space** | All deltas within ±2m (≈ player eye height) | Trust CET Z directly. Update the wiki. No code change. |
| **Constant offset** | All deltas similar but ≠ 0 (e.g. all ≈ +5m) | Bake offset into `cetToThree`. No per-pin raycast. |
| **Variable offset** | Deltas differ wildly across locations | Real elevation-gap phenomenon. Restore the raycast machinery in `three-markers.js` and document why. |

My bet: **same space**. Ships with no code change beyond a wiki update.

## How to send back

Save the CSV with your filled-in columns. Either:
- Drop it back into this folder and tell me you're done, OR
- Paste the rows directly into chat.

Either way works — I just need the six recorded readouts.
