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
  const _hoverFeatures = []; // { ring:[[lat,lng]], area, layer, labelTip, tier }
  let _hoveredFeature = null; // the currently brightened feature entry
  let _badlandsLabel = null;  // standalone tooltip (no polygon to bind to)
  const _tierLayers = {};     // tier name → L.geoJSON layer (for hasLayer checks)

  // Resolve a feature's name-label element (the inner .district-label span)
  // from its bound/standalone tooltip, if it's currently on the map.
  function labelElOf(f) {
    const tip = f.labelTip || f.layer?.getTooltip?.();
    return tip?.getElement?.()?.querySelector('.district-label') || null;
  }

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
    if (best === _hoveredFeature) return;
    if (_hoveredFeature) {
      _hoveredFeature.layer?.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY });
      labelElOf(_hoveredFeature)?.classList.remove('district-label-hover');
    }
    if (best) {
      best.layer?.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY_HOVER });
      best.layer?.bringToFront?.(); // mirror the 3D renderOrder bump (draw on top)
      labelElOf(best)?.classList.add('district-label-hover');
    }
    _hoveredFeature = best;
    // Info panel resolves the subdistrict under the cursor at any tier (even when
    // only district outlines are drawn), so it reports the sub like the game does.
    // Stats follow the drawn tier: district total when district outlines show,
    // subdistrict total when subdistrict outlines show.
    const cet = NCZ.leafletToCet(e.latlng.lat, e.latlng.lng);
    const statsLevel = _map.getZoom() > NCZ.DISTRICT_ZOOM_THRESHOLD ? "sub" : "district";
    NCZ.DistrictInfo?.showAt?.(cet[0], cet[1], statsLevel);
  }

  function init(map) {
    _map = map;

    map.createPane("districtPane");
    map.getPane("districtPane").style.zIndex = 460;
    // Tag the pane so its SVG paths get the 250 ms stroke-opacity transition.
    map.getPane("districtPane").classList.add("district-outline-pane");

    // Name labels live just above the outlines but BELOW the markerPane (600),
    // so pins always render on top of labels — matching the 3D view. Leaflet's
    // default tooltipPane (650) would put them above the pins. pointer-events:
    // none so the pane never intercepts map/pin interaction.
    map.createPane("districtLabelPane");
    map.getPane("districtLabelPane").style.zIndex = 465;
    map.getPane("districtLabelPane").style.pointerEvents = "none";

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
              properties: { color, name: dist.name, level: "district", ring: coords, districtId: dist.id },
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
              properties: { color, name: sub.name, level: "subdistrict", ring: coords, districtId: dist.id, subId: sub.id },
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
              const p = feature.properties;
              const level = p.level === "district" ? "district" : "subdistrict";
              // Permanent centre tooltip = the name label. Bound to the outline,
              // so it shows/hides automatically with the layer's tier gating.
              layer.bindTooltip(
                `<span class="district-label district-label-${level}" style="--label-color:${p.color}">${NCZ.escapeHtml(p.name)}</span>`,
                { permanent: true, direction: "center", className: "district-label-tooltip", interactive: false, pane: "districtLabelPane" }
              );
              _hoverFeatures.push({
                ring: p.ring,
                area: ringArea(p.ring),
                layer,
                labelTip: layer.getTooltip(),
                districtId: p.districtId || null,
                subId: p.subId || null,
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

        // Badlands has no polygon to bind a tooltip to → standalone label at the
        // hand-placed spot, shown at the district tier. Hovering its area (any
        // badlands sub ring, registered as label-only "outer" entries) emphasises
        // it, mirroring the 3D label-only hover region.
        const bl = data.districts.find(d => d.id === "badlands");
        if (bl && NCZ.BADLANDS_LABEL_CET) {
          const blPos = NCZ.cetToLeaflet(NCZ.BADLANDS_LABEL_CET[0], NCZ.BADLANDS_LABEL_CET[1]);
          const blColor = NCZ.DISTRICT_COLORS.badlands || "#ffffff";
          _badlandsLabel = L.tooltip({ permanent: true, direction: "center", className: "district-label-tooltip", interactive: false, pane: "districtLabelPane" })
            .setLatLng(blPos)
            .setContent(`<span class="district-label district-label-district" style="--label-color:${blColor}">${NCZ.escapeHtml(bl.name)}</span>`);
          for (const sub of bl.subdistricts || []) {
            if (!sub.polygon?.length) continue;
            const ring = sub.polygon.map(pt => NCZ.cetToLeaflet(pt[0], pt[1]));
            _hoverFeatures.push({ ring, area: ringArea(ring), layer: null, labelTip: _badlandsLabel, districtId: bl.id, subId: null, tier: "outer" });
          }
        }

        map.on("zoomend", updateZoom);
        map.on("mousemove", onMapMouseMove);
        map.on("mouseout", () => NCZ.DistrictInfo?.hide?.()); // cursor left the map
        if (districtsVisible) updateZoom();
      })
      .catch(err => console.error("[NCZ] Failed to load subdistricts.json:", err));
  }

  // Drop the brightened state — a feature hidden mid-hover (zoom tier swap or
  // districts toggled off) would otherwise stay bright when it re-appears.
  function clearHover() {
    if (_hoveredFeature) {
      _hoveredFeature.layer?.setStyle({ opacity: NCZ.DISTRICT_LINE_OPACITY });
      labelElOf(_hoveredFeature)?.classList.remove('district-label-hover');
    }
    _hoveredFeature = null;
    NCZ.DistrictInfo?.hide?.();
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

    // Badlands name shows at the district tier only (mirrors outerLayer).
    if (_badlandsLabel) {
      if (!zoomedIn && !_map.hasLayer(_badlandsLabel)) _badlandsLabel.addTo(_map);
      else if (zoomedIn && _map.hasLayer(_badlandsLabel)) _map.removeLayer(_badlandsLabel);
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
      if (_badlandsLabel && _map.hasLayer(_badlandsLabel)) _map.removeLayer(_badlandsLabel);
    }
  }

  return { init, setDistricts };
})();
