/**
 * extract_tweakdb_map.wscript
 * ===========================
 * WolvenKit script to extract map-related TweakDB records for the NC Zoning Board.
 *
 * Extracts:
 *   1. WorldMapSettings — CursorBoundaryMin/Max (map viewport bounds), zoom level refs
 *   2. WorldMapZoomLevel entries — Zoom, Fov, ShowDistricts, ShowSubDistricts, etc.
 *   3. WorldMapFreeCameraSettings — ZoomMin/Max/Default, FovMin/Max
 *   4. District records — LocalizedName, UiState, UiIcon, ParentDistrict hierarchy
 *
 * Output:
 *   Saves JSON files to the project raw folder via wkit.SaveToRaw().
 *   Copy output files from WolvenKit raw folder to the NC Zoning Board repo data/ directory.
 *
 * Usage:
 *   1. Open your map_data_export project in WolvenKit
 *   2. Open Script Manager, load this script
 *   3. Run — output files appear in your project's raw/ folder
 *
 * Note: TweakDB must be loaded. If GetRecords() returns empty, the script will
 *       attempt a warmup by saving/opening a temporary YAML file.
 */

import * as Logger from 'Logger.wscript';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enumerableToArray(enumerable) {
    var arr = [];
    for (var item of enumerable) {
        arr.push(item);
    }
    return arr;
}

function parseJsonSafe(text, label) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (e) {
        Logger.Warning("Failed to parse JSON for " + label);
        return null;
    }
}

function tryWarmTweakDb() {
    var records;
    try {
        records = enumerableToArray(wkit.GetRecords());
    } catch (_) {
        records = [];
    }
    if (records.length > 0) {
        Logger.Info("TweakDB already loaded: " + records.length + " records");
        return records;
    }

    Logger.Info("TweakDB not loaded, attempting warmup...");
    try {
        wkit.SaveToResources("__tweakdb_warmup__.yaml", "{}\n");
        wkit.OpenDocument("__tweakdb_warmup__.yaml");
        wkit.Sleep(3000);
    } catch (_) {}

    try {
        records = enumerableToArray(wkit.GetRecords());
    } catch (_) {
        records = [];
    }

    try {
        wkit.DeleteFile("__tweakdb_warmup__.yaml", "resources");
    } catch (_) {}

    Logger.Info("After warmup: " + records.length + " records");
    return records;
}

// ---------------------------------------------------------------------------
// Extract a single record by path, return parsed JSON or null
// ---------------------------------------------------------------------------

function getRecord(path) {
    try {
        var text = wkit.GetRecord(path);
        return parseJsonSafe(text, path);
    } catch (_) {
        return null;
    }
}

function getFlat(path) {
    try {
        var text = wkit.GetFlat(path);
        return parseJsonSafe(text, path);
    } catch (_) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// 1. WorldMapSettings
// ---------------------------------------------------------------------------

function extractWorldMapSettings() {
    Logger.Info("--- Extracting WorldMapSettings ---");

    // Try known TweakDB paths for the world map settings record.
    // The game accesses this via native GetSettings() which resolves the path internally.
    // From InheritanceMap.yaml we know these WorldMap.* paths exist:
    //   WorldMap.FreeCameraSettingsDefault, WorldMap.TopDownCameraSettingsDefault,
    //   WorldMap.BaseZoomLevel, WorldMap.ZoomLevel*, WorldMap.WorldMapQuickFiltersList
    var settingsPaths = [
        "WorldMap.Settings",
        "WorldMap.Default",
        "WorldMap.WorldMapSettings",
        "WorldMapSettings.Default",
        "WorldMap.MapSettings"
    ];

    var settings = null;
    var settingsPath = null;
    for (var i = 0; i < settingsPaths.length; i++) {
        settings = getRecord(settingsPaths[i]);
        if (settings) {
            settingsPath = settingsPaths[i];
            Logger.Success("Found WorldMapSettings at: " + settingsPath);
            break;
        }
    }

    if (!settings) {
        Logger.Warning("Could not find WorldMapSettings by record lookup. Trying flat lookups...");
        Logger.Info("Searching for any record path containing 'WorldMapSettings'...");
    }

    // Try getting CursorBoundary flats directly (flats use record.field syntax)
    var flatPrefixes = [
        "WorldMap.Settings", "WorldMap.Default", "WorldMap.WorldMapSettings",
        "WorldMapSettings.Default", "WorldMap.MapSettings"
    ];
    var cursorMin = null;
    var cursorMax = null;
    for (var p = 0; p < flatPrefixes.length; p++) {
        if (!cursorMin) cursorMin = getFlat(flatPrefixes[p] + ".cursorBoundaryMin");
        if (!cursorMax) cursorMax = getFlat(flatPrefixes[p] + ".cursorBoundaryMax");
        // Also try PascalCase
        if (!cursorMin) cursorMin = getFlat(flatPrefixes[p] + ".CursorBoundaryMin");
        if (!cursorMax) cursorMax = getFlat(flatPrefixes[p] + ".CursorBoundaryMax");
        if (cursorMin && cursorMax) break;
    }

    var result = {
        record: settings,
        recordPath: settingsPath,
        cursorBoundaryMin: cursorMin,
        cursorBoundaryMax: cursorMax
    };

    Logger.Info("CursorBoundaryMin: " + JSON.stringify(cursorMin));
    Logger.Info("CursorBoundaryMax: " + JSON.stringify(cursorMax));

    return result;
}

// ---------------------------------------------------------------------------
// 2. WorldMapZoomLevels
// ---------------------------------------------------------------------------

function extractZoomLevels(allRecords) {
    Logger.Info("--- Extracting WorldMapZoomLevels ---");

    // Known zoom level record paths from InheritanceMap.yaml:
    //   WorldMap.BaseZoomLevel (parent)
    //     - WorldMap.ZoomLevelAllMappins
    //     - WorldMap.ZoomLevelImportant
    //     - WorldMap.ZoomLevelVendors
    //     - WorldMap.ZoomLevelExtraMappins
    //     - WorldMap.ZoomLevelSubDistricts
    //     - WorldMap.ZoomLevelDistricts
    var knownZoomPaths = [
        "WorldMap.BaseZoomLevel",
        "WorldMap.ZoomLevelAllMappins",
        "WorldMap.ZoomLevelImportant",
        "WorldMap.ZoomLevelVendors",
        "WorldMap.ZoomLevelExtraMappins",
        "WorldMap.ZoomLevelSubDistricts",
        "WorldMap.ZoomLevelDistricts"
    ];

    var zoomLevels = [];

    // Extract known zoom level records
    for (var i = 0; i < knownZoomPaths.length; i++) {
        var record = getRecord(knownZoomPaths[i]);
        if (record) {
            Logger.Success("  Found: " + knownZoomPaths[i]);
            zoomLevels.push({
                path: knownZoomPaths[i],
                record: record
            });
        } else {
            Logger.Warning("  Missing: " + knownZoomPaths[i]);
        }
    }

    // Also search for any other zoom level records we might have missed
    var additionalPaths = allRecords.filter(function(r) {
        return r.indexOf("ZoomLevel") !== -1 &&
               !knownZoomPaths.some(function(kp) { return kp === r; });
    });

    for (var j = 0; j < additionalPaths.length; j++) {
        var rec = getRecord(additionalPaths[j]);
        if (rec) {
            Logger.Info("  Additional: " + additionalPaths[j]);
            zoomLevels.push({
                path: additionalPaths[j],
                record: rec
            });
        }
    }

    Logger.Info("Extracted " + zoomLevels.length + " zoom level entries");
    return zoomLevels;
}

// ---------------------------------------------------------------------------
// 3. WorldMapFreeCameraSettings
// ---------------------------------------------------------------------------

function extractCameraSettings(allRecords) {
    Logger.Info("--- Extracting FreeCameraSettings ---");

    // Known camera settings records from InheritanceMap.yaml:
    //   WorldMap.FreeCameraSettingsDefault (parent)
    //     - WorldMap.TopDownCameraSettingsDefault
    var knownCameraPaths = [
        "WorldMap.FreeCameraSettingsDefault",
        "WorldMap.TopDownCameraSettingsDefault"
    ];

    var cameraSettings = [];

    for (var i = 0; i < knownCameraPaths.length; i++) {
        var record = getRecord(knownCameraPaths[i]);
        if (record) {
            Logger.Success("  Found: " + knownCameraPaths[i]);
            cameraSettings.push({
                path: knownCameraPaths[i],
                record: record
            });
        } else {
            Logger.Warning("  Missing: " + knownCameraPaths[i]);
        }
    }

    // Search for any additional camera settings
    var additionalPaths = allRecords.filter(function(r) {
        return (r.indexOf("CameraSettings") !== -1 || r.indexOf("TopDownCamera") !== -1) &&
               !knownCameraPaths.some(function(kp) { return kp === r; });
    });

    for (var j = 0; j < additionalPaths.length; j++) {
        var rec = getRecord(additionalPaths[j]);
        if (rec) {
            Logger.Info("  Additional: " + additionalPaths[j]);
            cameraSettings.push({
                path: additionalPaths[j],
                record: rec
            });
        }
    }

    Logger.Info("Extracted " + cameraSettings.length + " camera settings entries");
    return cameraSettings;
}

// ---------------------------------------------------------------------------
// 4. District records
// ---------------------------------------------------------------------------

function extractDistricts(allRecords) {
    Logger.Info("--- Extracting District Records ---");

    // Filter for District records (but not DistrictManager, etc.)
    var districtPaths = allRecords.filter(function(r) {
        return r.indexOf("Districts.") === 0 ||
               r.indexOf("District.") === 0 ||
               (r.indexOf("District") !== -1 && r.indexOf("Manager") === -1 &&
                r.indexOf("Controller") === -1 && r.indexOf("Preset") === -1);
    });

    // Deduplicate and limit to likely district records
    var seen = {};
    var uniquePaths = [];
    for (var i = 0; i < districtPaths.length; i++) {
        if (!seen[districtPaths[i]]) {
            seen[districtPaths[i]] = true;
            uniquePaths.push(districtPaths[i]);
        }
    }

    Logger.Info("Found " + uniquePaths.length + " potential district records");

    // Extract a manageable subset — focus on known district names
    var knownDistricts = [
        "CityCenter", "Watson", "Westbrook", "Heywood",
        "SantoDomingo", "Pacifica", "Badlands", "Dogtown",
        // Subdistricts
        "Downtown", "CorpoPlaza",
        "LittleChina", "Kabuki", "Northside", "ArasakaWaterfront",
        "Japantown", "NorthOak", "CharterHill",
        "Wellsprings", "TheGlen", "VistaDelRey",
        "Arroyo", "RanchoCoronado",
        "WestWindEstate", "Coastview"
    ];

    var districts = [];

    // First try known district paths
    for (var k = 0; k < knownDistricts.length; k++) {
        var paths = [
            "Districts." + knownDistricts[k],
            "District." + knownDistricts[k]
        ];
        for (var p = 0; p < paths.length; p++) {
            var record = getRecord(paths[p]);
            if (record) {
                districts.push({
                    path: paths[p],
                    name: knownDistricts[k],
                    record: record
                });
                break;
            }
        }
    }

    // Also try extracting all records with "Districts." prefix
    var allDistrictPaths = allRecords.filter(function(r) {
        return r.indexOf("Districts.") === 0;
    });

    for (var d = 0; d < allDistrictPaths.length; d++) {
        var alreadyHave = districts.some(function(existing) {
            return existing.path === allDistrictPaths[d];
        });
        if (!alreadyHave) {
            var rec = getRecord(allDistrictPaths[d]);
            if (rec) {
                districts.push({
                    path: allDistrictPaths[d],
                    name: allDistrictPaths[d].replace("Districts.", ""),
                    record: rec
                });
            }
        }
    }

    Logger.Info("Extracted " + districts.length + " district records");
    return districts;
}

// ---------------------------------------------------------------------------
// 5. Bonus: search for any WorldMap.* records/flats
// ---------------------------------------------------------------------------

function extractWorldMapRecords(allRecords) {
    Logger.Info("--- Extracting all WorldMap.* records ---");

    var wmPaths = allRecords.filter(function(r) {
        return r.indexOf("WorldMap") !== -1;
    });

    Logger.Info("Found " + wmPaths.length + " WorldMap-related records");

    var results = [];
    for (var i = 0; i < wmPaths.length; i++) {
        var record = getRecord(wmPaths[i]);
        if (record) {
            results.push({
                path: wmPaths[i],
                record: record
            });
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

Logger.Info("=== NC Zoning Board: TweakDB Map Data Extraction ===");

// Step 0: Ensure TweakDB is loaded
var allRecords = tryWarmTweakDb();
if (allRecords.length === 0) {
    Logger.Error("TweakDB has no records. Make sure a game project is loaded in WolvenKit.");
    Logger.Error("Try: File > Open Project > (select your CP2077 WolvenKit project)");
} else {
    // Step 1: Extract WorldMapSettings
    var mapSettings = extractWorldMapSettings();

    // Step 2: Extract zoom levels
    var zoomLevels = extractZoomLevels(allRecords);

    // Step 3: Extract camera settings
    var cameraSettings = extractCameraSettings(allRecords);

    // Step 4: Extract district records
    var districts = extractDistricts(allRecords);

    // Step 5: Extract all WorldMap.* records (catch-all)
    var worldMapRecords = extractWorldMapRecords(allRecords);

    // Step 6: Save everything to raw folder
    var output = {
        extractedAt: new Date().toISOString(),
        totalRecords: allRecords.length,
        worldMapSettings: mapSettings,
        zoomLevels: zoomLevels,
        cameraSettings: cameraSettings,
        districts: districts,
        worldMapRecords: worldMapRecords
    };

    var outputJson = JSON.stringify(output, null, 2);
    wkit.SaveToRaw("nczoning_tweakdb_map_data.json", outputJson);

    Logger.Success("=== Extraction complete ===");
    Logger.Success("Output saved to raw/nczoning_tweakdb_map_data.json");
    Logger.Info("Total records in TweakDB: " + allRecords.length);
    Logger.Info("WorldMap records: " + worldMapRecords.length);
    Logger.Info("Zoom levels: " + zoomLevels.length);
    Logger.Info("Camera settings: " + cameraSettings.length);
    Logger.Info("Districts: " + districts.length);

    // Also save a summary of all WorldMap-related record paths for debugging
    var wmRecordPaths = allRecords.filter(function(r) {
        return r.indexOf("WorldMap") !== -1 || r.indexOf("District") !== -1;
    });
    wkit.SaveToRaw("nczoning_tweakdb_paths.json", JSON.stringify(wmRecordPaths, null, 2));
    Logger.Info("Record paths saved to raw/nczoning_tweakdb_paths.json");
}
