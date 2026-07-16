# Coordinate System

## Overview

The map uses two coordinate systems that are linked by a simple linear transform:

1. **CET Coordinates**: the in-game `[X, Y, Z]` values from Cyber Engine Tweaks (X=east/west, Y=north/south, Z=height)
2. **Leaflet Coordinates**: the `[lat, lng]` values used internally by the map

**Note:** The 2D map placement uses only X and Y coordinates. The Z (height/elevation) coordinate is stored for reference and future features (like teleport scripts or 3D visualisation). 

Mod authors only need to know CET coordinates. The app handles the conversion automatically.

## Getting CET Coordinates

### Using Cyber Engine Tweaks (CET)

1. Install [Cyber Engine Tweaks](https://www.nexusmods.com/cyberpunk2077/mods/107)
2. In-game, press `~` to open the CET console
3. Run: `local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))`
4. Note the **X**, **Y**, **Z**, and **Yaw** values from the output

### Using Simple Location Manager (Recommended)

[Simple Location Manager](https://www.nexusmods.com/cyberpunk2077/mods/26454) (SLM) is a CET mod that lets you save, name, and teleport to locations. It's the tool we used to record all 16 calibration points.

#### Importing the Calibration Preset

We have a pre-built SLM preset containing all 16 calibration grid points. To import it:

1. Install Simple Location Manager
2. Open the SLM interface in-game
3. Click **Import**
4. Paste the following export string:

<details>
<summary>Click to expand export string</summary>

```
eyJjYXRlZ29yaWVzIjpbeyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9LHsibmFtZSI6Ik5DIFpvbmluZyIsImljb24iOiJGbG9vclBsYW4ifSx7Im5hbWUiOiJOQyBab25pbmciLCJpY29uIjoiRmxvb3JQbGFuIn0seyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9LHsibmFtZSI6Ik5DIFpvbmluZyIsImljb24iOiJGbG9vclBsYW4ifSx7Im5hbWUiOiJOQyBab25pbmciLCJpY29uIjoiRmxvb3JQbGFuIn0seyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9LHsibmFtZSI6Ik5DIFpvbmluZyIsImljb24iOiJGbG9vclBsYW4ifSx7Im5hbWUiOiJOQyBab25pbmciLCJpY29uIjoiRmxvb3JQbGFuIn0seyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9LHsibmFtZSI6Ik5DIFpvbmluZyIsImljb24iOiJGbG9vclBsYW4ifSx7Im5hbWUiOiJOQyBab25pbmciLCJpY29uIjoiRmxvb3JQbGFuIn0seyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9LHsibmFtZSI6Ik5DIFpvbmluZyIsImljb24iOiJGbG9vclBsYW4ifSx7Im5hbWUiOiJOQyBab25pbmciLCJpY29uIjoiRmxvb3JQbGFuIn0seyJuYW1lIjoiTkMgWm9uaW5nIiwiaWNvbiI6IkZsb29yUGxhbiJ9XSwidHlwZSI6ImJhdGNoIiwiZGF0YSI6W3siZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOlstMjI2OC4yOCwtMjM5My42MTcsNDUuMl0sInIiOi0yOS40NTYsInMiOjE1LCJpIjoiMTc3MjU4Mzk2NS0zMTc4IiwiZCI6NiwibiI6IiMwMSJ9LHsiZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOlstOTI0LjY3NywtMjM3OC45MDcsMTQuMjM0XSwiciI6LTMwLjM2OSwicyI6MjQsImkiOiIxNzcyNTg0MTQ2LTM0OTciLCJkIjo3LCJuIjoiIzAyIn0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6WzQ1NS42MzUsLTIzOTQuODAzLDE3OS4yMV0sInIiOjIxLjAyNCwicyI6MTQsImkiOiIxNzcyNTg0MzEzLTkwNDQiLCJkIjo1LCJuIjoiIzAzIn0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6WzE4MTguNTQxLC0yNDA2LjQyNCwyMzMuNTk2XSwiciI6MzAuNjAzLCJzIjoyMCwiaSI6IjE3NzI1ODQ0OTEtNDU2MyIsImQiOjcsIm4iOiIjMDQifSx7ImRlc2MiOiJDYWxpYnJhdGlvbiBwb2ludCIsImMiOiJOQyBab25pbmciLCJwIjpbLTIyNjcuMzA1LC04NjguNTA0LDY3LjU4Ml0sInIiOjkzLjkwNiwicyI6MTAsImkiOiIxNzcyNTg0NjM0LTk4NTQiLCJkIjo0LCJuIjoiIzA1In0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6Wy05MDAuMDA3LC04NzEuOTgzLC0wLjkyMV0sInIiOjQ0LjM4LCJzIjoxMywiaSI6IjE3NzI1ODQ3NTktNjExNyIsImQiOjUsIm4iOiIjMDYifSx7ImRlc2MiOiJDYWxpYnJhdGlvbiBwb2ludCIsImMiOiJOQyBab25pbmciLCJwIjpbNDMyLjAxNywtODgwLjc2MiwyNC42MDRdLCJyIjowLjc2NSwicyI6MTQsImkiOiIxNzcyNTg0ODYxLTc1MTQiLCJkIjo1LCJuIjoiIzA3In0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6WzE4MDAuOTI2LC04ODEuMjE2LDU4LjI5NF0sInIiOjIyLjQ3MiwicyI6MjMsImkiOiIxNzcyNTg0OTk3LTE0ODMiLCJkIjo3LCJuIjoiIzA4In0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6Wy0yMjY1LjY2Nyw2NjEuNTM5LC0wLjkxOV0sInIiOi0xNzcuMzY5LCJpIjoiMTc3MjU4NTEwNi0zMTI5IiwiZCI6MywibiI6IiMwOSJ9LHsiZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOlstOTE4LjMwMSw2NTQuMDMxLC0wLjkyMV0sInIiOi0xNDQuMjM4LCJzIjo1LCJpIjoiMTc3MjU4NTI0Ni0xMjQzIiwiZCI6MiwibiI6IiMxMCJ9LHsiZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOls0NTcuNjEyLDY2OS45MzEsMTUxLjM2M10sInIiOjkwLjExNywicyI6NywiaSI6IjE3NzI1ODU1MTEtMTU4MiIsImQiOjIsIm4iOiIjMTEifSx7ImRlc2MiOiJDYWxpYnJhdGlvbiBwb2ludCIsImMiOiJOQyBab25pbmciLCJwIjpbMTc3Ny4yNzMsNjQwLjU1MiwxNTcuNjgxXSwiciI6ODcuODc2LCJzIjoyMywiaSI6IjE3NzI1ODU3MTgtNzc2OCIsImQiOjcsIm4iOiIjMTIifSx7ImRlc2MiOiJDYWxpYnJhdGlvbiBwb2ludCIsImMiOiJOQyBab25pbmciLCJwIjpbLTIyOTMuNjU4LDIxNzAuNjQ0LDguOTkzXSwiciI6LTkuNDE2LCJzIjo0LCJpIjoiMTc3MjU4NTgyOC0yNDg4IiwiZCI6MSwibiI6IiMxMyJ9LHsiZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOlstOTA0LjE2NiwyMTYyLjEzMyw1MS4wMzRdLCJyIjoxNzkuNDM4LCJzIjoyLCJpIjoiMTc3MjU4NTk5Mi0zNzk4IiwiZCI6MSwibiI6IiMxNCJ9LHsiZGVzYyI6IkNhbGlicmF0aW9uIHBvaW50IiwiYyI6Ik5DIFpvbmluZyIsInAiOls0NDMuNjA3LDIxNzIuODgyLDE1Ny43ODhdLCJyIjotMTc5LjQxOCwicyI6MTgsImkiOiIxNzcyNTg2MTQzLTU1MjYiLCJkIjo3LCJuIjoiIzE1In0seyJkZXNjIjoiQ2FsaWJyYXRpb24gcG9pbnQiLCJjIjoiTkMgWm9uaW5nIiwicCI6WzE4NzQuODIxLDIxODIuMzA2LDE3Ni42MjRdLCJyIjoxNzkuNzk0LCJzIjoxOCwiaSI6IjE3NzI1ODYzNjEtNjEwOSIsImQiOjcsIm4iOiIjMTYifV0sInYiOjJ9
```

</details>

1. This creates an **"NC Zoning"** category with 16 named calibration points (#01–#16)
2. Teleport to any point to verify or re-record its CET coordinates

## The Transform

### Formulas

The mapping is a simple linear transform with **decoupled axes**: latitude depends only on CET Y, and longitude depends only on CET X:

```
Leaflet lat = 0.02101335 × CET_Y − 93.68566
Leaflet lng = 0.02086230 × CET_X + 132.80160
```

Inverse:

```
CET_X = (lng − 132.80160) / 0.02086230
CET_Y = (lat + 93.68566) / 0.02101335
```

These coefficients were derived from a **16-point uniform grid calibration** (see below).

### Implementation

In `utils.js` (exposed as `NCZ.cetToLeaflet`):

```javascript
function cetToLeaflet(cetX, cetY) {
    const lat = 0.02101335 * cetY - 93.68566;
    const lng = 0.02086230 * cetX + 132.80160;
    return [lat, lng];
}

function leafletToCet(lat, lng) {
    const cetY = (lat + 93.68566) / 0.02101335;
    const cetX = (lng - 132.80160) / 0.02086230;
    return [cetX, cetY];
}
```

### Leaflet Coordinate Space

The map uses `L.CRS.Simple`, a flat, non-geographic coordinate reference system. The 8192×8192px image is mapped by `map.unproject()` at zoom level 5 to:

- **Latitude:** −256 (bottom/south) to 0 (top/north)
- **Longitude:** 0 (left/west) to 256 (right/east)

## Calibration Data

### 16-Point Grid Survey

The transform was calibrated by placing 16 markers in a 4×4 grid on the Leaflet map, then visiting each location in-game to record the CET coordinates using Simple Location Manager.

| # | Leaflet (lat, lng) | CET (X, Y) |
|---|-------------------|-------------|
| 1 | (−500, −1500) | (−2268.28, −2393.62) |
| 2 | (−500, −500) | (−924.68, −2378.91) |
| 3 | (−500, 500) | (455.64, −2394.80) |
| 4 | (−500, 1500) | (1818.54, −2406.42) |
| 5 | (500, −1500) | (−2267.30, −868.50) |
| 6 | (500, −500) | (−900.01, −871.98) |
| 7 | (500, 500) | (432.02, −880.76) |
| 8 | (500, 1500) | (1800.93, −881.22) |
| 9 | (1500, −1500) | (−2265.67, 661.54) |
| 10 | (1500, −500) | (−918.30, 654.03) |
| 11 | (1500, 500) | (457.61, 669.93) |
| 12 | (1500, 1500) | (1777.27, 640.55) |
| 13 | (2500, −1500) | (−2293.66, 2170.64) |
| 14 | (2500, −500) | (−904.17, 2162.13) |
| 15 | (2500, 500) | (443.61, 2172.88) |
| 16 | (2500, 1500) | (1874.82, 2182.31) |

> **Note:** The Leaflet coordinates in this table reference the **original calibration bounds** (`[-4000, -4500]` to `[4000, 4500]`), not the current tile bounds. The transform coefficients were scaled to the tile coordinate system (`[-256, 0]` to `[0, 256]`).

### Accuracy

- **Max grid error:** lat ±12, lng ±44 (from measurement noise at map edges)
- **Typical error:** ±5–15 game units (~0.3–1 Leaflet unit)

## Recalibrating

If the map image changes (new source, different crop, etc.), you'll need to recalibrate:

1. **Enable the calibration grid** in `app.js`: uncomment the `CALIBRATION GRID` block
2. **Place markers** at known Leaflet positions on the map
3. **Import the SLM preset** (above) or manually visit each marker location in-game
4. **Record CET coordinates** for each grid point
5. **Compute the transform** using linear regression:
   - `CET_X = a × lng + b` → solve for `a` and `b` using all grid points
   - `CET_Y = c × lat + d` → solve for `c` and `d`
6. **Invert** to get `cetToLeaflet()`: `lat = (CET_Y - d) / c`, `lng = (CET_X - b) / a`
7. **Scale** the coefficients if the Leaflet coordinate space changes (e.g., different tile bounds)
