# URL Parameters

Query-string flags the app reads at load time. Append to the site URL, e.g.
`https://nczoning.net/?debug` or `http://localhost:3000/?only=my_district`.

| Parameter | Type | What it does | Read in |
| --- | --- | --- | --- |
| `?mod=<nexus_id>` | value | Deep-link: opens the given mod's pin/popup and flies to it on load. Used by the in-app "copy link" button. See `docs/` deep-link notes. | `app.js`, `three-scene.js` |
| `?debug` | flag | Shows the on-screen stats panel (FPS, draw calls, triangles) and a **Copy debug info** button; enables extra console diagnostics. | `three-scene.js` |
| `?webgpuprobe` | flag | Runs a WebGPU adapter/device negotiation probe and logs the result — diagnostic for "scene fell back to WebGL / won't start". | `three-scene.js` |
| `?forcewebgl` | flag | Forces the Three.js renderer to the WebGL2 backend instead of WebGPU (for comparison/debugging; the scene's compute buildings need WebGPU, so expect a degraded/2D fallback). | `three-scene.js` |
| `?gamelight` | flag | Lighting **calibration reference** mode: pins the decoded in-game sun, freezes the time-of-day slider, and strips Districts/Pins overlays so surfaces can be matched against the in-game capture. | `app.js`, `three-scene.js` |
| `?only=<district>` | value | Renders **only** the named `DISTRICT_META` building cloud (e.g. `?only=my_district`, `?only=ugly_building`, `?only=watson`) — isolates one cloud for diagnosing placement/content. | `three-scene.js` |

Notes:

- Flags are presence-based (`?debug` — no value needed); value params take `=<value>`.
- Combine with `&` (e.g. `?debug&only=my_district`).
- These are developer/diagnostic aids except `?mod`, which is a user-facing share link.

## Valid `?only=` district names

The value must match a `DISTRICT_META` entry name in `assets/js/three-scene.js`:

| Name | Set | Notes |
| --- | --- | --- |
| `westbrook` | both | |
| `city_center` | both | |
| `heywood` | both | |
| `pacifica` | both | |
| `santo_domingo` | both | |
| `watson` | both | |
| `ep1_dogtown` | both | Phantom Liberty |
| `ep1_spaceport` | both | no fixed variant — base-game in either set |
| `my_district` | Fixed only | malgalad's combined corrections overlay |
| `ugly_building` | Fixed only | malgalad's "ugly building" add-on (Watson) |

`my_district` / `ugly_building` only render when the **Fixed** asset set is
active (Settings → Map data). See [`3dmap-fixed-assets.md`](3dmap-fixed-assets.md).
