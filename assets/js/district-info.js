/**
 * NC Zoning Board — District Info Panel
 * Namespace: NCZ.DistrictInfo
 *
 * The hover info panel (top-right, under the header) — a parity nod to the
 * in-game world map's bottom-right district readout. Shows the district icon +
 * name, the subdistrict (when one is hovered), and location stats for that
 * area: count, category breakdown, share of the whole map, and how many were
 * recently updated.
 *
 * View-agnostic: both the 3D (SCHEMA) hover (setHoveredDistrict in three-scene)
 * and the 2D (SAT) hover (onMapMouseMove in overlay) drive it via show()/hide().
 *
 * Public API:
 *   NCZ.DistrictInfo.init()                 — cache DOM + load district polygons
 *   NCZ.DistrictInfo.setMods(mods)          — (re)compute per-area stats
 *   NCZ.DistrictInfo.show(districtId, subId) — populate + reveal for a hover
 *   NCZ.DistrictInfo.hide()                 — hide on hover-exit
 *
 * Depends on: constants.js (DISTRICT_COLORS, CATEGORY_STYLES), utils.js
 *   (pointInPolygon, isRecentlyUpdated, escapeHtml).
 */

NCZ.DistrictInfo = (() => {
  let _panel = null;
  const _els = {};
  let _districts = [];            // subdistricts.json districts[]
  const _districtMeta = {};       // id → { name, color }
  const _subMeta = {};            // subId → { name, districtId, color }
  let _stats = { districts: {}, subs: {}, total: 0 };
  let _ready = false;
  let _pendingMods = null;        // setMods() called before init() finished

  // Shoelace area (absolute) — smallest matching polygon wins, so a mod inside
  // both a subdistrict and its parent district is attributed to the subdistrict.
  function polyArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    }
    return Math.abs(a) / 2;
  }

  function emptyBucket() {
    return { total: 0, cat: { "new-location": 0, "location-overhaul": 0, "other": 0 }, recent: 0 };
  }

  // Resolve the most specific area for a CET [x, y] point: the smallest-area
  // subdistrict containing it (and that sub's parent district), else the
  // smallest containing district polygon. Returns { dist, sub } or null. Used
  // both to attribute mods (setMods) and to drive the panel from the cursor
  // (showAt) — independent of which outline tier is currently drawn.
  function resolveArea(pt) {
    let sub = null, subArea = Infinity, dist = null;
    for (const d of _districts) {
      for (const s of d.subdistricts || []) {
        if (s.polygon?.length && NCZ.pointInPolygon(pt, s.polygon)) {
          const a = polyArea(s.polygon);
          if (a < subArea) { subArea = a; sub = s; dist = d; }
        }
      }
    }
    if (!sub) {
      let dArea = Infinity;
      for (const d of _districts) {
        if (d.polygon?.length && NCZ.pointInPolygon(pt, d.polygon)) {
          const a = polyArea(d.polygon);
          if (a < dArea) { dArea = a; dist = d; }
        }
      }
    }
    return dist ? { dist, sub } : null;
  }

  async function init() {
    _panel = document.getElementById("district-info-panel");
    if (!_panel) return;
    _els.district  = _panel.querySelector(".di-district");
    _els.sub       = _panel.querySelector(".di-sub");
    _els.icon      = _panel.querySelector(".di-icon");
    _els.count     = _panel.querySelector(".di-count");
    _els.breakdown = _panel.querySelector(".di-breakdown");
    _els.share     = _panel.querySelector(".di-share");
    _els.recent    = _panel.querySelector(".di-recent");

    try {
      const data = await fetch("data/subdistricts.json").then(r => r.json());
      _districts = data.districts || [];
      for (const d of _districts) {
        const color = NCZ.DISTRICT_COLORS[d.id] || "#ffffff";
        _districtMeta[d.id] = { name: d.name, color };
        for (const s of d.subdistricts || []) {
          _subMeta[s.id] = { name: s.name, districtId: d.id, color };
        }
      }
      _ready = true;
      if (_pendingMods) { setMods(_pendingMods); _pendingMods = null; }
    } catch (err) {
      console.error("[NCZ] DistrictInfo: failed to load subdistricts.json", err);
    }
  }

  // Attribute every mod to its smallest containing subdistrict (and that sub's
  // parent district); mods outside all subs fall back to a containing district
  // polygon. Aggregate count / category / recently-updated per area.
  function setMods(mods) {
    if (!_ready) { _pendingMods = mods; return; }
    const dStats = {}, sStats = {};
    let total = 0;

    for (const m of mods || []) {
      const c = m.coordinates;
      if (!c || c.length < 2) continue;
      const area = resolveArea([c[0], c[1]]);
      if (!area) continue; // outside every district (e.g. open ocean) — skip
      const { dist, sub } = area;

      const catKey = (m.category in emptyBucket().cat) ? m.category : "other";
      const recent = NCZ.isRecentlyUpdated(m);
      total++;

      const ds = (dStats[dist.id] ||= emptyBucket());
      ds.total++; ds.cat[catKey]++; if (recent) ds.recent++;
      if (sub) {
        const ss = (sStats[sub.id] ||= emptyBucket());
        ss.total++; ss.cat[catKey]++; if (recent) ss.recent++;
      }
    }

    _stats = { districts: dStats, subs: sStats, total };
  }

  // Build the "8 new · 3 overhaul · 1 other" line, omitting zero categories.
  function breakdownHtml(bucket) {
    const order = ["new-location", "location-overhaul", "other"];
    const parts = [];
    for (const key of order) {
      const n = bucket.cat[key];
      if (!n) continue;
      const style = NCZ.CATEGORY_STYLES[key];
      const label = n === 1 ? style.label : `${style.label}s`; // New Locations / Overhauls / Others
      parts.push(`<span class="di-cat" style="color:${style.color}">${n} ${NCZ.escapeHtml(label)}</span>`);
    }
    return parts.join('<span class="di-dot">·</span>');
  }

  // statsLevel: "district" → stats reflect the whole district (used at the
  // district zoom tier, where the district outline is the one drawn); "sub" →
  // stats reflect the hovered subdistrict (sub tier). The district + subdistrict
  // TITLES always both show when a sub is resolved, regardless of statsLevel.
  function show(districtId, subId, statsLevel) {
    if (!_panel || !districtId) return hide();
    const dMeta = _districtMeta[districtId];
    if (!dMeta) return hide();

    _panel.style.setProperty("--di-color", dMeta.color);
    _els.district.textContent = dMeta.name;

    const sMeta = subId ? _subMeta[subId] : null;
    _els.sub.textContent = sMeta ? sMeta.name : "";
    _els.sub.style.display = sMeta ? "" : "none";

    const useSub = statsLevel !== "district" && subId && _stats.subs[subId];
    const bucket = useSub ? _stats.subs[subId] : (_stats.districts[districtId] || emptyBucket());
    const n = bucket.total;
    _els.count.textContent = `${n} ${n === 1 ? "location" : "locations"}`;
    _els.breakdown.innerHTML = n ? breakdownHtml(bucket) : "";
    _els.breakdown.style.display = n ? "" : "none";

    const pct = _stats.total ? ((n / _stats.total) * 100).toFixed(2) : "0.00";
    _els.share.textContent = n ? `${pct}% of all locations` : "";
    _els.share.style.display = n ? "" : "none";

    _els.recent.textContent = bucket.recent ? `${bucket.recent} recently updated` : "";
    _els.recent.style.display = bucket.recent ? "" : "none";

    setDistrictIcon(districtId);

    _panel.classList.add("visible");
    _panel.setAttribute("aria-hidden", "false");
  }

  // Crop the district's icon out of the atlas (district_icons.png) and scale it
  // to fit the icon box, centred. (All our badlands subdistricts are children of
  // the central Districts.Badlands in TweakDB, so badlands always uses the
  // central icon — the North/South atlas icons belong to subdistricts we don't map.)
  function setDistrictIcon(districtId) {
    const el = _els.icon;
    const atlas = NCZ.DISTRICT_ICON_ATLAS;
    if (!el || !atlas) return;

    const rect = atlas.parts[districtId];
    if (!rect) { el.style.backgroundImage = "none"; return; }

    // Box = the icon's EXACT scaled rect (no margin) so adjacent atlas icons
    // can't bleed into it — a fixed square box + centred crop would show e.g.
    // Watson's edge above City Center. Normalise by HEIGHT so every district
    // icon renders at the same height (their native slices vary in aspect);
    // width follows the icon's aspect.
    const ICON_HEIGHT = 42;
    const iw = (rect.r - rect.l) * atlas.w;
    const ih = (rect.b - rect.t) * atlas.h;
    const scale = ICON_HEIGHT / ih;

    el.style.width = `${iw * scale}px`;
    el.style.height = `${ICON_HEIGHT}px`;
    el.style.backgroundImage = `url(${atlas.src})`;
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundSize = `${atlas.w * scale}px ${atlas.h * scale}px`;
    el.style.backgroundPosition = `${-rect.l * atlas.w * scale}px ${-rect.t * atlas.h * scale}px`;
  }

  // Resolve + show from a CET cursor point — the panel always reports the most
  // specific subdistrict under the cursor, even at the district zoom tier where
  // only district outlines are drawn (matches the in-game readout).
  function showAt(cetX, cetY, statsLevel) {
    const area = resolveArea([cetX, cetY]);
    if (!area) return hide();
    show(area.dist.id, area.sub ? area.sub.id : null, statsLevel);
  }

  function hide() {
    if (!_panel) return;
    _panel.classList.remove("visible");
    _panel.setAttribute("aria-hidden", "true");
  }

  return { init, setMods, show, showAt, hide };
})();
