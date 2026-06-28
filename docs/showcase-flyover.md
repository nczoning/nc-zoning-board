# Showcase Flyover

A cinematic flyover of Night City synced to the in-game radio broadcast *Good Morning Night City*. Implemented as an opt-in module (`flyover.js`) — add or remove the `<script>` tag in `index.html` to include or exclude the feature.

## Activation

Click the **Showcase** button in the 3D scene controls. The browser enters native fullscreen, the scene fades in from black, and the audio begins. Press **Esc** or click **Exit showcase** to exit early. The showcase runs once and exits automatically when the audio ends.

## Audio

`assets/audio/GMNC.mp3` — *Good Morning Night City*, a Cyberpunk 2077 radio broadcast (~800 KB, ~57 s). The audio clock (`audio.currentTime`) drives:

- Beat-triggered theme transitions
- Sun position (sunrise → sunset arc)
- End-of-showcase fade (triggered by `audio.ended`, not a timer)

## Waypoints

11 camera positions spanning 57.417 s, timed to Audacity label timestamps so the camera is over the named district exactly when the announcer mentions it.

| WP | Time (s) | Location | Note |
|----|----------|----------|------|
| 0 | 0.000 | Open ocean | Build-up music; bare terrain, sun rising |
| 1 | 6.948 | Western coastline | "Good Morning Night City" |
| 2 | 10.948 | Watson | Low sweep south |
| 3 | 14.842 | Heywood | Top-down |
| 4 | 20.842 | City Center | Banking sweep west |
| 5 | 26.977 | Santo Domingo | Low sweep, city skyline ahead |
| 6 | 34.743 | Westbrook | Approach from east |
| 7 | 43.377 | Pacifica | Top-down |
| 8 | 48.077 | Dogtown | Low sweep |
| 9 | 52.747 | Badlands | Rising, looking east — districts off |
| 10 | 57.417 | Rocky Ridge | High, city silhouette on the horizon |

Waypoint positions are in GLB space (`X = CET_X`, `Y = elevation`, `Z = -CET_Y`). Edit `FLYOVER_WAYPOINTS` in `flyover.js` to adjust.

## Layer State

The showcase always controls its own starting layer state, then restores the user's exact pre-showcase state on exit.

The `FLYOVER_REVEAL_LAYERS` constant at the top of `flyover.js` controls the starting mode:

| Value | Behaviour |
|-------|-----------|
| `false` (default) | Roads, metro, and buildings are **on from frame 1** — building shadows visible immediately during the ocean/coastline approach |
| `true` | All layers hidden at WP0, staggered back in over 6.9 s (original cinematic reveal) |

Either way, WP0 always applies Night Corp theme. At WP9 (Badlands, city behind camera) districts are turned off. On exit, all overlay checkboxes and the sun slider are restored exactly.

### Layer reveal timings (when `FLYOVER_REVEAL_LAYERS = true`)

| Time | Layer |
|------|-------|
| +1.5 s | Roads |
| +3.0 s | Metro |
| +4.5 s | Buildings |
| ~~+6.0 s~~ | ~~Districts~~ (omitted — cleaner showcase without boundary lines) |

## Beat-Driven Theme Visualiser

33 bass-beat timestamps from an Audacity beat-finder export fire a theme cross-dissolve every ~1.34 s (the track's tempo), cycling through all five themes:

**Night Corp → Militech → Arasaka → Aldecaldos → Synthwave → repeat**

Colors are read directly from CSS custom properties at first use via `readThemeColors(themeId)` — the function temporarily swaps the theme class on `<html>`, reads computed styles, then restores. This means the beat cycle **automatically stays in sync with `theme.css`** — no hardcoded color values, no separate update needed when themes change.

Buildings are included in beat transitions (terrain, water, cliffs, roads, metro, and buildings all transition together).

Beat timestamps are defined in `BEAT_TIMESTAMPS_MS` in `flyover.js`. To update them, re-export from Audacity (**Analyze → Beat Finder**) and paste the cluster-start values.

## Sun Animation

`updateFlyoverSun(audio.currentTime)` is called every frame. It maps `audio.currentTime / FLYOVER_DURATION_S` to the summer solstice (June 21) sunrise→sunset window at **Morro Bay, CA** (35.37°N, 120.85°W) — Night City's real-world location — via SunCalc.

- Directional light colour: warm orange at the horizon, neutral white overhead
- Sun sphere: visible orb in the sky, tracks the exact sun direction
- Best shadow moments: WP7–WP8 (6–7:30 pm, sun low in the west, long evening shadows over Pacifica and Dogtown)

## Shadows

Shadows are always enabled during the showcase (regardless of the overlay checkbox), then restored to the user's checkbox state on exit.

## Fade In / Out

The overlay div (`#flyover-fade`) is **created dynamically** when the showcase starts and **removed from the DOM** on exit.

- Fade in: `FLYOVER_FADE_MS` (2 s, black → scene)
- Fade to black: `FLYOVER_FADE_MS` (2 s, triggered by `audio.ended`)
- Escape / early exit: instant reset, no fade-to-black

## State Save / Restore

Before the showcase starts, the following state is captured:
- Active theme (restored via cross-dissolve on exit)
- All `[data-overlay]` checkbox states
- Sun slider value

On exit, each checkbox is restored to its saved state and a `change` event dispatched, so layer visibility, shadow state, and UI all stay in sync. The sun slider is also restored and an `input` event dispatched.

## Flyover Constants

All tuneable values are module-level constants at the top of `flyover.js` (kept there rather than `constants.js` since flyover is opt-in):

| Constant | Default | Purpose |
|----------|---------|---------|
| `FLYOVER_DURATION_S` | 57.417 | Audio track length (seconds) |
| `FLYOVER_FOV` | 55 | Perspective camera field of view |
| `FLYOVER_CAM_NEAR` | 1 | Perspective camera near clip |
| `FLYOVER_CAM_FAR` | 120000 | Perspective camera far clip |
| `FLYOVER_FADE_MS` | 2000 | Fade in/out duration (ms) |
| `FLYOVER_BEAT_DISSOLVE` | 938 | Theme dissolve duration per beat (ms) |
| `FLYOVER_REVEAL_LAYERS` | false | Layer start mode (see Layer State above) |
| `FLYOVER_REVEAL_ROADS` | 1500 | Roads stagger delay (ms, when reveal=true) |
| `FLYOVER_REVEAL_METRO` | 3000 | Metro stagger delay (ms, when reveal=true) |
| `FLYOVER_REVEAL_BLDGS` | 4500 | Buildings stagger delay (ms, when reveal=true) |
| `MORRO_BAY` | 35.37°N, 120.85°W | Night City real-world location for SunCalc |

## Audacity Label Files

Beat-finder and label-track files used to sync this showcase are kept at:

```
E:\Audio\Cyberpunk 2077\GMNC - beat finder.txt
E:\Audio\Cyberpunk 2077\GMNC - District beats.txt
```

## NCZ.ThreeScene API used by flyover.js

| Method | Purpose |
|--------|---------|
| `stopRenderLoop()` / `startRenderLoop()` | Pause/resume the ortho render loop |
| `setControlsEnabled(bool)` | Disable OrbitControls during flyover |
| `renderFrame(camera)` | Render one frame with the perspective camera |
| `getCanvasElement()` | Size the perspective camera on creation |
| `captureColors()` | Snapshot material colors before a theme transition (includes buildings) |
| `transitionMaterials(from, ms)` | Lerp materials to new CSS theme values |
| `transitionToColors(from, to, ms)` | Lerp materials to explicit colors — beat cycle (includes buildings) |
| `setLayerVisibility(name, bool)` | Toggle terrain/water/cliffs/roads/metro/buildings/districts |
| `getLayerVisibility(name)` | Read current layer visibility (used for state save/restore) |
| `setSunPosition(az, alt)` | Move directional light + sun sphere |
| `setShadowsEnabled(bool)` | Toggle shadow casting |
| `setSunSphereVisible(bool)` | Show/hide the visible sun orb |
