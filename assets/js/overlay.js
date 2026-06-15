/**
 * NC Zoning Board — Overlay Module
 * Namespace: NCZ.Overlay
 *
 * Manages overlay layers for the Leaflet satellite view:
 *   - District/subdistrict GeoJSON borders (zoom-based switching)
 *
 * Roads and metro are SCHEMA-only (rendered as GLBs in Three.js).
 * The district toggle is shared: this module handles the SAT side;
 * NCZ.ThreeScene.setLayerVisibility() handles the SCHEMA side.
 *
 * Zoom behaviour (matches SCHEMA):
 *   Zoomed out: district outlines only (outer + always layers)
 *   Zoomed in:  subdistrict outlines + always layer (outer hidden)
 *   Always visible: districts with no canonical subs (Dogtown, Morro Rock)
 *                   + canonical:false subs (casino)
 *
 * Public API (called by app.js):
 *   NCZ.Overlay.init(map)             — load subdistricts.json, add layers
 *   NCZ.Overlay.setDistricts(visible) — show/hide district borders
 *
 * Depends on: constants.js (NCZ.DISTRICT_COLORS, NCZ.DISTRICT_ZOOM_THRESHOLD), utils.js
 */

NCZ.Overlay = (() => {
  let _map = null;
  let alwaysLayer    = null; // no-sub districts + canonical:false — always visible
  let outerLayer     = null; // districts with subs — zoom-out only
  let subLayer       = null; // canonical subdistricts — zoom-in only
  let districtsVisible = true;

  // Hover-brighten registry — mirrors the SCHEMA (Three.js) behaviour: outlines
  // sit at the faint baseline and brighten when the cursor is inside the
  // district's area (point-in-polygon, not a thin-line hit). Each entry knows
  // its tier so we only test outlines currently on the map. The 250 ms fade is
  // a CSS transition on the pane's paths (see .district-outline-pane in style.css).
  const _hoverFeatures = []; // { ring:[[lat,lng]], area, layer, tier }
  let _hovered = null;       // the currently brightened feature layer
  const _tierLayers = {};    // tier name → L.geoJSON layer (for hasLayer checks)

  const styleFeature = f => ({
    color:   f.properties.color,
    weight:  f.properties.level === "district" ? NCZ.DISTRICT_LINE_WIDTH : NCZ.SUBDISTRICT_LINE_WIDTH,
    opacity: NCZ.DISTRICT_LINE_OPACITY,
    fill:    false,
    pane:    "districtPane",
  });

  // Shoelace area (lat/lng space) — smallest matching ring wins so a small
  // nested outline (casino inside Westbrook) takes the hover over its parent.
  function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(a) / 2;
  }

  function onMapMouseMove(e) {
    if (!districtsVisible) return;
    const pt = [e.latlng.lat, e.latlng.lng];
    let best = null;
    for (const f of _hoverFeatures) {
      if (!_map.hasLayer(_tierLayers[f.tier])) continue;
      if (NCZ.pointInPolygon(pt, f.ring) && (!best || f.area < best.area)) best = f;
    }
    const layer = best ? best.layer : null;
    if (layer === _hovered) return;
    if (_hovered) _hovered.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY });
    if (layer)    layer.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY_HOVER });
    _hovered = layer;
  }

  function init(map) {
    _map = map;

    map.createPane("districtPane");
    map.getPane("districtPane").style.zIndex = 460;
    // Tag the pane so its SVG paths get the 250 ms stroke-opacity transition.
    map.getPane("districtPane").classList.add("district-outline-pane");

    fetch("data/subdistricts.json")
      .then(r => r.json())
      .then(data => {
        const alwaysFeatures = [];
        const outerFeatures  = [];
        const subFeatures    = [];

        for (const dist of data.districts) {
          const color = NCZ.DISTRICT_COLORS[dist.id] || "#ffffff";
          const canonicalSubs = (dist.subdistricts || []).filter(s => s.canonical !== false);
          const hasSubs = canonicalSubs.length > 0;

          // District outline
          if (dist.polygon?.length) {
            const coords = dist.polygon.map(pt => NCZ.cetToLeaflet(pt[0], pt[1]));
            const feature = {
              type: "Feature",
              // `ring` ([lat,lng]) is carried for the hover point-in-polygon test.
              properties: { color, name: dist.name, level: "district", ring: coords },
              geometry: { type: "Polygon", coordinates: [coords.map(c => [c[1], c[0]])] },
            };
            (hasSubs ? outerFeatures : alwaysFeatures).push(feature);
          }

          // Subdistrict outlines
          for (const sub of dist.subdistricts || []) {
            if (!sub.polygon?.length) continue;
            const coords = sub.polygon.map(pt => NCZ.cetToLeaflet(pt[0], pt[1]));
            const feature = {
              type: "Feature",
              properties: { color, name: sub.name, level: "subdistrict", ring: coords },
              geometry: { type: "Polygon", coordinates: [coords.map(c => [c[1], c[0]])] },
            };
            // canonical:false (casino etc) — always visible
            (sub.canonical === false ? alwaysFeatures : subFeatures).push(feature);
          }
        }

        const toLayer = (features, tier) => L.geoJSON(
          { type: "FeatureCollection", features },
          {
            style: styleFeature,
            pane: "districtPane",
            onEachFeature: (feature, layer) => {
              _hoverFeatures.push({
                ring: feature.properties.ring,
                area: ringArea(feature.properties.ring),
                layer,
                tier,
              });
            },
          }
        );

        alwaysLayer = toLayer(alwaysFeatures, "always");
        outerLayer  = toLayer(outerFeatures, "outer");
        subLayer    = toLayer(subFeatures, "sub");
        _tierLayers.always = alwaysLayer;
        _tierLayers.outer  = outerLayer;
        _tierLayers.sub    = subLayer;

        map.on("zoomend", updateZoom);
        map.on("mousemove", onMapMouseMove);
        if (districtsVisible) updateZoom();
      })
      .catch(err => console.error("[NCZ] Failed to load subdistricts.json:", err));
  }

  // Drop the brightened state — a feature hidden mid-hover (zoom tier swap or
  // districts toggled off) would otherwise stay bright when it re-appears.
  function clearHover() {
    if (_hovered) _hovered.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY });
    _hovered = null;
  }

  function updateZoom() {
    if (!_map || !alwaysLayer) return;
    if (!districtsVisible) return;
    clearHover();

    const zoomedIn = _map.getZoom() > NCZ.DISTRICT_ZOOM_THRESHOLD;

    if (!_map.hasLayer(alwaysLayer)) alwaysLayer.addTo(_map);

    if (zoomedIn) {
      if (_map.hasLayer(outerLayer)) _map.removeLayer(outerLayer);
      if (!_map.hasLayer(subLayer))  subLayer.addTo(_map);
    } else {
      if (!_map.hasLayer(outerLayer)) outerLayer.addTo(_map);
      if (_map.hasLayer(subLayer))    _map.removeLayer(subLayer);
    }
  }

  function setDistricts(visible) {
    districtsVisible = visible;
    if (!_map || !alwaysLayer) return;
    if (visible) {
      updateZoom();
    } else {
      clearHover();
      [alwaysLayer, outerLayer, subLayer].forEach(l => {
        if (l && _map.hasLayer(l)) _map.removeLayer(l);
      });
    }
  }

  return { init, setDistricts };
})();
