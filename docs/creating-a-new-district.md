# Creating a New District in Cyberpunk 2077

This guide explains how to add a new district or subdistrict to the in-game map.

It uses the **North Oaks Casino** as a worked example — a cut-content area between North Oak, Red Peaks, and Rocky Ridge that the NC Zoning Board has computed a boundary polygon for.

---

## What You Need

- **WolvenKit** — the main modding tool for CP2077 files
- A **boundary polygon** — a list of X, Y coordinates in CET world-space that form the outline of your district
- A **TweakDB record** — configuration for the district (name, parent, colors, etc.)

The NC Zoning Board has already computed the boundary polygon for North Oaks Casino. See [Step 1](#step-1-the-boundary-polygon) below.

---

## Concepts

**CET world coordinates** are the same coordinates you see when you use the Cyber Engine Tweaks console in-game. X increases to the east, Y increases to the north.

**TweakDB** is the game's database of configuration records. Districts are stored here with their names, colors, and parent relationships.

**`gameStaticTriggerAreaComponent`** is the game object that detects when the player enters an area. Each district has one, with a polygon outline defining its shape.

---

## Step 1: The Boundary Polygon

The polygon for North Oaks Casino has been computed from the void between the three surrounding districts. It has **50 points** and fits exactly in the gap.

**Location:** X[397, 1565] Y[1219, 2069] (CET world-space)

**Parent district:** Westbrook (North Oak subdistrict specifically)

```json
[
  [1244.37, 1514.66], [1207.67, 1449.60], [1208.82, 1348.12],
  [1206.32, 1321.12], [1173.12, 1248.93], [1085.54, 1218.56],
  [959.11,  1242.01], [837.78,  1270.72], [746.11,  1360.34],
  [705.10,  1426.68], [675.15,  1456.03], [638.70,  1467.62],
  [602.00,  1503.50], [587.72,  1554.38], [573.74,  1594.03],
  [546.18,  1634.09], [518.65,  1646.80], [455.46,  1651.93],
  [413.30,  1688.38], [401.18,  1737.70], [396.64,  1798.98],
  [433.23,  1833.82], [450.00,  1856.49], [472.25,  1866.64],
  [547.48,  1884.36], [565.62,  1893.51], [571.06,  1918.09],
  [553.12,  1984.14], [550.48,  2032.15], [566.31,  2054.31],
  [585.35,  2066.26], [657.86,  2069.43], [787.13,  2067.04],
  [849.61,  2068.51], [884.33,  2047.01], [1066.69, 2039.96],
  [1086.48, 2034.18], [1100.08, 2019.57], [1101.94, 1970.54],
  [1108.40, 1950.80], [1140.43, 1919.23], [1172.90, 1894.62],
  [1230.01, 1874.36], [1283.67, 1855.19], [1363.74, 1788.93],
  [1374.79, 1779.46], [1384.04, 1755.86], [1282.30, 1604.48],
  [1564.64, 1305.73], [1281.91, 1604.89]
]
```

> **Note:** These coordinates define the boundary of the empty space between existing districts. They were computed mathematically, not measured in-game. You may want to test them in-game and adjust any edges that feel wrong.

---

## Step 2: Create a TweakDB Record for the District

The district needs a record in TweakDB with its name, parent district, and visual style.

### 2.1 Create a `.yaml` file

Create a file called `north_oaks_casino.yaml` in your mod's `r6/tweaks/` folder:

```yaml
Districts.NorthOaksCasino:
  $type: gamedataDistrict_Record
  localizedName: LocKey#NorthOaksCasino
  parentDistrict: Districts.NorthOaks
  uiState: Westbrook
  uiIcon: None
  isQuestDistrict: False
  crimeMultiplier: 1.0
  gunShotStimRange: 30.0
  explosiveDeviceStimRangeMultiplier: 1.0
  gangs: []
```

**Line by line explanation:**

| Line | What it means |
| ---- | ------------- |
| `Districts.NorthOaksCasino` | The TweakDB path for your district. Other mods reference it by this name. |
| `$type: gamedataDistrict_Record` | Tells the game this is a district record. Do not change this. |
| `localizedName: LocKey#NorthOaksCasino` | The display name (we will set the actual text in Step 2.2). |
| `parentDistrict: Districts.NorthOaks` | North Oaks is the parent. The game uses this for the district hierarchy. |
| `uiState: Westbrook` | Uses Westbrook's orange color (`#ff5100`) on the map. Change if you want a different color (see color list below). |
| `uiIcon: None` | No map icon. Set to `ico_district_westbrook_large` or similar if you add an icon. |
| `isQuestDistrict: False` | Set to `True` if quests reference this district. |

**Available `uiState` values and their colors:**

| uiState | Color | Hex |
| ------- | ----- | --- |
| `CityCenter` | Yellow | #ffd741 |
| `Watson` | Red | #ff3e34 |
| `Westbrook` | Orange | #ff5100 |
| `Heywood` | Green | #1ded83 |
| `SantoDomingo` | Blue | #5ef6ff |
| `Pacifica` | Pink-red | #ff6158 |
| `Dogtown` | Dark green | #00a32c |
| `MorroRock` | Teal | #349197 |

### 2.2 Add the localized name

Create a file called `north_oaks_casino_loc.json` in your mod's `r6/tweaks/` folder (or use an existing localization file):

```json
{
  "LocalizationPersistenceOnScreenEntries": [
    {
      "secondaryKey": "NorthOaksCasino",
      "femaleVariant": "North Oaks Casino",
      "maleVariant": ""
    }
  ]
}
```

> **Note:** CP2077 localization uses "femaleVariant" for the default text. Leave "maleVariant" empty to use the same text for everyone.

---

## Step 3: Create the Trigger Area in an Entity File

The trigger area is what the game uses to detect when the player is inside the district. It is defined in a `.ent` file.

### 3.1 Create a new entity file

In WolvenKit, create a new file:

1. In the **Project Explorer**, right-click your project folder
2. Select **New File → Entity (.ent)**
3. Name it `north_oaks_casino_district.ent`
4. Save it at a path like: `your_mod\districts\north_oaks_casino_district.ent`

### 3.2 Add a trigger area component

Inside the `.ent` file, add a `gameStaticTriggerAreaComponent` with your polygon.

In JSON format (WolvenKit can import this), the structure looks like this:

```json
{
  "$type": "gameStaticTriggerAreaComponent",
  "name": { "$type": "CName", "$storage": "string", "$value": "north_oaks_casino_trigger" },
  "isEnabled": 1,
  "outline": {
    "HandleId": "1",
    "Data": {
      "$type": "AreaShapeOutline",
      "points": [
        { "$type": "Vector3", "X": 1244.37, "Y": 1514.66, "Z": 0 },
        { "$type": "Vector3", "X": 1207.67, "Y": 1449.60, "Z": 0 },
        { "$type": "Vector3", "X": 1208.82, "Y": 1348.12, "Z": 0 },
        { "$type": "Vector3", "X": 1206.32, "Y": 1321.12, "Z": 0 },
        { "$type": "Vector3", "X": 1173.12, "Y": 1248.93, "Z": 0 },
        { "$type": "Vector3", "X": 1085.54, "Y": 1218.56, "Z": 0 },
        { "$type": "Vector3", "X":  959.11, "Y": 1242.01, "Z": 0 },
        { "$type": "Vector3", "X":  837.78, "Y": 1270.72, "Z": 0 },
        { "$type": "Vector3", "X":  746.11, "Y": 1360.34, "Z": 0 },
        { "$type": "Vector3", "X":  705.10, "Y": 1426.68, "Z": 0 },
        { "$type": "Vector3", "X":  675.15, "Y": 1456.03, "Z": 0 },
        { "$type": "Vector3", "X":  638.70, "Y": 1467.62, "Z": 0 },
        { "$type": "Vector3", "X":  602.00, "Y": 1503.50, "Z": 0 },
        { "$type": "Vector3", "X":  587.72, "Y": 1554.38, "Z": 0 },
        { "$type": "Vector3", "X":  573.74, "Y": 1594.03, "Z": 0 },
        { "$type": "Vector3", "X":  546.18, "Y": 1634.09, "Z": 0 },
        { "$type": "Vector3", "X":  518.65, "Y": 1646.80, "Z": 0 },
        { "$type": "Vector3", "X":  455.46, "Y": 1651.93, "Z": 0 },
        { "$type": "Vector3", "X":  413.30, "Y": 1688.38, "Z": 0 },
        { "$type": "Vector3", "X":  401.18, "Y": 1737.70, "Z": 0 },
        { "$type": "Vector3", "X":  396.64, "Y": 1798.98, "Z": 0 },
        { "$type": "Vector3", "X":  433.23, "Y": 1833.82, "Z": 0 },
        { "$type": "Vector3", "X":  450.00, "Y": 1856.49, "Z": 0 },
        { "$type": "Vector3", "X":  472.25, "Y": 1866.64, "Z": 0 },
        { "$type": "Vector3", "X":  547.48, "Y": 1884.36, "Z": 0 },
        { "$type": "Vector3", "X":  565.62, "Y": 1893.51, "Z": 0 },
        { "$type": "Vector3", "X":  571.06, "Y": 1918.09, "Z": 0 },
        { "$type": "Vector3", "X":  553.12, "Y": 1984.14, "Z": 0 },
        { "$type": "Vector3", "X":  550.48, "Y": 2032.15, "Z": 0 },
        { "$type": "Vector3", "X":  566.31, "Y": 2054.31, "Z": 0 },
        { "$type": "Vector3", "X":  585.35, "Y": 2066.26, "Z": 0 },
        { "$type": "Vector3", "X":  657.86, "Y": 2069.43, "Z": 0 },
        { "$type": "Vector3", "X":  787.13, "Y": 2067.04, "Z": 0 },
        { "$type": "Vector3", "X":  849.61, "Y": 2068.51, "Z": 0 },
        { "$type": "Vector3", "X":  884.33, "Y": 2047.01, "Z": 0 },
        { "$type": "Vector3", "X": 1066.69, "Y": 2039.96, "Z": 0 },
        { "$type": "Vector3", "X": 1086.48, "Y": 2034.18, "Z": 0 },
        { "$type": "Vector3", "X": 1100.08, "Y": 2019.57, "Z": 0 },
        { "$type": "Vector3", "X": 1101.94, "Y": 1970.54, "Z": 0 },
        { "$type": "Vector3", "X": 1108.40, "Y": 1950.80, "Z": 0 },
        { "$type": "Vector3", "X": 1140.43, "Y": 1919.23, "Z": 0 },
        { "$type": "Vector3", "X": 1172.90, "Y": 1894.62, "Z": 0 },
        { "$type": "Vector3", "X": 1230.01, "Y": 1874.36, "Z": 0 },
        { "$type": "Vector3", "X": 1283.67, "Y": 1855.19, "Z": 0 },
        { "$type": "Vector3", "X": 1363.74, "Y": 1788.93, "Z": 0 },
        { "$type": "Vector3", "X": 1374.79, "Y": 1779.46, "Z": 0 },
        { "$type": "Vector3", "X": 1384.04, "Y": 1755.86, "Z": 0 },
        { "$type": "Vector3", "X": 1282.30, "Y": 1604.48, "Z": 0 },
        { "$type": "Vector3", "X": 1564.64, "Y": 1305.73, "Z": 0 },
        { "$type": "Vector3", "X": 1281.91, "Y": 1604.89, "Z": 0 }
      ]
    }
  },
  "notifiers": [
    {
      "HandleId": "2",
      "Data": {
        "$type": "worldLocationAreaNotifier",
        "districtID": {
          "$type": "TweakDBID",
          "$storage": "string",
          "$value": "Districts.NorthOaksCasino"
        }
      }
    }
  ]
}
```

**Key things to check:**

- The `"$value": "Districts.NorthOaksCasino"` in the `districtID` must match exactly the TweakDB path you defined in Step 2.1.
- The `"Z": 0` on each point is fine — the game extends the trigger volume up and down automatically.

### 3.3 Set the entity's world position

The trigger component polygon points are in **world space** (they already include the absolute CET coordinates). Set the entity's root transform to position `(0, 0, 0)` with no rotation. Do not add an offset — the polygon coordinates already place it in the correct location.

---

## Step 4: Register the Entity in the World

The entity needs to be placed in the game world so it loads when the player is in that area of the map.

### Option A: Using Archive XL (recommended)

Archive XL can add world nodes without editing base game files. Create a `.xl` file that injects your entity:

```yaml
streaming:
  sectors:
    - path: base\worlds\03_night_city\_compiled\default\exterior_0_0_0_1.streamingsector
      expectedNodes: 0
      nodesToPatch:
        - index: 0
          type: nodeRef
          patches:
            - op: add
              entity: your_mod\districts\north_oaks_casino_district.ent
```

> **Note:** The exact sector file and injection method depends on your Archive XL version. Check the Archive XL documentation for the current method.

### Option B: Patching an existing streaming sector

You can add the entity directly to a streaming sector that covers the North Oak area:

- The relevant sector is near grid coordinates (0, 0) — look for exterior sectors around that area
- Add your entity as a new node in the sector's `nodes` array

---

## Step 5: Test In-Game

1. Install your mod
2. Load a save near the North Oak area
3. Walk into the casino zone
4. The HUD should show **"North Oaks Casino"** as the current district

If the HUD does not update:
- Check that `Districts.NorthOaksCasino` in the trigger's `districtID` exactly matches the TweakDB record path
- Check that the entity is loaded (use CET console: `GetPlayer():GetCurrentDistrict()` to query the active district)
- Check that the polygon points are correct — use CET to print your current position (`print(GetPlayer():GetWorldPosition())`) and verify you are inside the expected coordinate range: X[397, 1565] Y[1219, 2069]

---

## Coordinate Reference

These are the approximate boundary positions between North Oaks Casino and its neighbors:

| Neighbor | Shared border direction |
| -------- | ---------------------- |
| North Oak (Westbrook) | West and north edge |
| Red Peaks (Badlands) | South edge |
| Rocky Ridge (Badlands) | East edge |

The approximate center of the casino area is around **(880, 1640)** in CET world-space.

---

## Files Summary

| File | Location | Purpose |
| ---- | -------- | ------- |
| `north_oaks_casino.yaml` | `r6/tweaks/` | TweakDB district record |
| `north_oaks_casino_loc.json` | `r6/tweaks/` | Localized display name |
| `north_oaks_casino_district.ent` | `your_mod/districts/` | Trigger area entity |

---

## About the Boundary Polygon

The 50-point polygon in this document was computed mathematically by the NC Zoning Board project. It was not hand-traced — it was generated by finding the geometric area that is simultaneously within 1200 CET units of all three surrounding districts (North Oak, Red Peaks, Rocky Ridge), minus those districts themselves.

This gives the natural "pocket" shape of the cut-content zone. If you need to adjust edges — for example if your mod adds geometry that changes where the district boundary should be — you can modify individual points in the polygon freely.

The polygon is stored in `data/subdistricts.json` in the NC Zoning Board repository with `"canonical": false`, which means it is included in the map data but hidden by default in the public map unless a user specifically enables it. When the North Oaks Casino mod releases, this flag can be updated.
