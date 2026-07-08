/**
 * NC Zoning Board — In-3D Building-Zone Drawing Tool (dev only, ?zonetool)
 * ─────────────────────────────────────────────────────────────────────────
 * Authors CET zone VOLUMES (footprint polygon + height range) for the building
 * metadata/override system. Draw a footprint by clicking ground points, close
 * it, then drag the top handle up to extrude a height. Each zone carries an op
 * (merge-as-one-building / force-class / exclude / force-lit) consumed by the
 * zone engine in three-scene.js.
 *
 * WebGPU-safe by construction: handles use THREE.MeshBasicNodeMaterial, edges
 * use Line2 + THREE.Line2NodeMaterial (same as the district outlines). No
 * TransformControls — manipulations are constrained (footprint vertices move on
 * the ground plane via groundPointAt; extrude moves only vertically), so a
 * couple of raycasts replace the gizmo and dodge its unverified WebGPU path.
 *
 * Coordinate convention (matches groundPointAt / subdistricts.json / pointInPolygon):
 *   world (x, y, z)  →  CET ring vertex [cetX, cetY] = [x, -z];  height = world Y.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/webgpu/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

const OPS = ['merge', 'forceClass', 'exclude', 'forceLit'];
const CLASSES = ['tower', 'block', 'podium', 'short', 'thin', 'elongated'];
const HANDLE_R = 6;          // vertex handle sphere radius (CET)
const CLOSE_SNAP_PX = 18;    // click within this of the first handle closes the loop
const DRAG_PX = 4;           // pointer move beyond this = a drag (orbit), not a click
const SPLIT_SNAP_CET = 45;   // click within this of an edge (CET) inserts a vertex there

export function initZoneTool(ctx) {
  const { scene, camera, renderer, controls, orbitDom, groundPointAt, requestRender } = ctx;
  const dom = renderer.domElement;

  const group = new THREE.Group();
  group.name = 'zone-tool';
  scene.add(group);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const zones = [];           // saved zone objects (exported)
  let cur = null;             // in-progress zone: { verts:[Vector3 y=0], height, handles, loop, topHandle, closed, meshes }
  let mode = 'draw';          // 'draw' | 'edit'
  let drag = null;            // active drag: { kind:'vertex'|'extrude', handle, vIndex }
  let down = null;            // left pointerdown bookkeeping for click-vs-drag
  let rdown = null;           // right pointerdown bookkeeping (right-click removes a point; right-drag tilts)
  let shape = 'poly';         // 'poly' | 'circle' | 'ellipse' — active draw shape
  let shapeCentre = null;     // CET centre while awaiting the radius/corner click
  const CIRCLE_SEGMENTS = 24; // vertices in a generated circle/ellipse footprint

  // ── helpers ──────────────────────────────────────────────────────────────
  const matHandle = (hex) => new THREE.MeshBasicNodeMaterial({ color: hex, depthTest: false, transparent: true });
  function makeHandle(pos, hex = 0x00f0ff) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(HANDLE_R, 12, 8), matHandle(hex));
    m.position.copy(pos); m.renderOrder = 999; group.add(m); return m;
  }
  function makeLoop(hex = 0x00f0ff) {
    const line = new Line2(new LineGeometry(),
      new THREE.Line2NodeMaterial({ color: hex, linewidth: 3, depthTest: false, transparent: true }));
    line.renderOrder = 998;
    line.visible = false; // empty geometry → don't let it reach a draw call until setLoop() gives it points
    group.add(line); return line;
  }
  function setLoop(line, points, close) {
    if (points.length < 2) { line.visible = false; return; }
    line.visible = true;
    const pts = points.slice();
    if (close) pts.push(points[0]);
    const flat = [];
    for (const p of pts) flat.push(p.x, p.y, p.z);
    const g = new LineGeometry(); g.setPositions(flat);
    line.geometry.dispose(); line.geometry = g;
  }

  function screenToNdc(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    return ndc;
  }
  // Project a world point to screen pixels (for the close-snap test).
  function worldToScreen(p) {
    const r = dom.getBoundingClientRect();
    const v = p.clone().project(camera);
    return [(v.x * 0.5 + 0.5) * r.width + r.left, (-v.y * 0.5 + 0.5) * r.height + r.top];
  }
  // World Y under the cursor on a camera-facing vertical plane through `anchor`.
  function heightAt(clientX, clientY, anchor) {
    raycaster.setFromCamera(screenToNdc(clientX, clientY), camera);
    const n = new THREE.Vector3(camera.position.x - anchor.x, 0, camera.position.z - anchor.z).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor);
    const hit = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, hit) ? Math.max(0, hit.y) : anchor.y;
  }
  function pickHandle(clientX, clientY) {
    if (!cur) return null;
    raycaster.setFromCamera(screenToNdc(clientX, clientY), camera);
    const targets = cur.handles.concat(cur.topHandle ? [cur.topHandle] : []);
    const hit = raycaster.intersectObjects(targets, false)[0];
    return hit ? hit.object : null;
  }

  // ── zone lifecycle ─────────────────────────────────────────────────────────
  function newZone() {
    discardCurrent();
    cur = { verts: [], height: 80, handles: [], loop: makeLoop(), topHandle: null, closed: false, volume: null };
    mode = 'draw'; shape = 'poly'; shapeCentre = null;
    setStatus('Drawing — click ground points; click the first point (or Close) to finish.');
  }
  function discardCurrent() {
    if (!cur) return;
    for (const h of cur.handles) { group.remove(h); h.geometry.dispose(); h.material.dispose(); }
    if (cur.topHandle) group.remove(cur.topHandle);
    if (cur.loop) group.remove(cur.loop);
    if (cur.volume) group.remove(cur.volume);
    cur = null; drag = null;
    requestRender();
  }
  function addVertex(cet) {
    const p = new THREE.Vector3(cet[0], 0, -cet[1]); // CET [x,y] → world (x,0,-y)
    cur.verts.push(p);
    cur.handles.push(makeHandle(p));
    setLoop(cur.loop, cur.verts, false);
    requestRender();
  }
  // Start a circle/ellipse: a fresh zone whose footprint is generated from a
  // centre click + a radius/corner click (see onUp's draw branch).
  function startShape(kind) {
    newZone(); shape = kind; shapeCentre = null;
    setStatus(`${kind[0].toUpperCase() + kind.slice(1)} — click the CENTRE.`);
  }
  // Generate an N-gon ellipse footprint (rx===ry ⇒ circle) and close it.
  function genEllipse(cx, cy, rx, ry) {
    rx = Math.max(rx, 1); ry = Math.max(ry, 1);
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
      const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
      const ex = cx + rx * Math.cos(a), ey = cy + ry * Math.sin(a);
      const p = new THREE.Vector3(ex, 0, -ey); // CET [x,y] → world (x,0,-y)
      cur.verts.push(p); cur.handles.push(makeHandle(p));
    }
    setLoop(cur.loop, cur.verts, false);
    closeLoop();
  }

  function closeLoop() {
    if (!cur || cur.verts.length < 3) { setStatus('Need at least 3 points to close.'); return; }
    cur.closed = true; mode = 'edit';
    setLoop(cur.loop, cur.verts, true);
    // top extrude handle at footprint centroid, raised to current height
    const c = centroid(cur.verts);
    cur.topHandle = makeHandle(new THREE.Vector3(c.x, cur.height, c.z), 0xffb300);
    rebuildVolume();
    setStatus('Drag the amber top handle UP to set height. Drag cyan points to adjust. Then Add Zone.');
    requestRender();
  }
  function centroid(verts) {
    const c = new THREE.Vector3();
    for (const v of verts) c.add(v); c.multiplyScalar(1 / verts.length); return c;
  }
  // Wireframe box: bottom loop, top loop, vertical edges.
  function rebuildVolume() {
    if (cur.volume) { group.remove(cur.volume); cur.volume.traverse((o) => o.geometry?.dispose?.()); }
    const v = new THREE.Group();
    const top = cur.verts.map((p) => new THREE.Vector3(p.x, cur.height, p.z));
    const topLine = makeLoop(0xffb300); setLoop(topLine, top, true); v.add(topLine);
    for (let i = 0; i < cur.verts.length; i++) {
      const e = makeLoop(0xffb300);
      setLoop(e, [cur.verts[i], top[i]], false); v.add(e);
    }
    group.add(v); cur.volume = v;
    if (cur.topHandle) { const c = centroid(cur.verts); cur.topHandle.position.set(c.x, cur.height, c.z); }
  }

  function addZone() {
    if (!cur || !cur.closed) { setStatus('Close the footprint first.'); return; }
    const footprint = cur.verts.map((p) => [round(p.x), round(-p.z)]); // world → CET [x,y]
    const z = { name: nameInput.value || `zone-${zones.length + 1}`, op: opSelect.value, footprint, minZ: 0, maxZ: round(cur.height) };
    if (z.op === 'forceClass') z.forceClass = classSelect.value;
    if (z.op === 'forceLit') z.density = parseFloat(densInput.value) || 1;
    // Keep the loop + volume as the zone's persistent (faint) visual; drop the
    // interactive vertex/top handles. _loop/_volume let delete/edit find them later.
    z._loop = cur.loop; z._volume = cur.volume;
    z._loop.material.color.set(0x335577);
    z._volume?.traverse((o) => o.material?.color?.set?.(0x335577));
    removeHandles(cur);
    cur = null;
    zones.push(z);
    refreshList(); saveLocal();
    setStatus(`Added "${z.name}" (${z.op}). ${zones.length} zone(s). Apply ⟳ to re-segment.`);
    newZone();
  }
  // Remove a zone's interactive handles (vertex spheres + top handle), keep edges.
  function removeHandles(o) {
    for (const h of o.handles) { group.remove(h); h.geometry.dispose(); h.material.dispose(); }
    o.handles = [];
    if (o.topHandle) { group.remove(o.topHandle); o.topHandle.geometry.dispose(); o.topHandle.material.dispose(); o.topHandle = null; }
  }
  function removeVisual(z) {
    if (z._loop) { group.remove(z._loop); z._loop.geometry.dispose(); z._loop.material.dispose(); }
    if (z._volume) { group.remove(z._volume); z._volume.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
  }
  function deleteZone(i) {
    removeVisual(zones[i]);
    zones.splice(i, 1);
    refreshList(); saveLocal(); requestRender();
    setStatus(`Deleted. ${zones.length} zone(s).`);
  }
  // Load a saved zone back as the editable current zone (rename via the Name field).
  function editZone(i) {
    const z = zones[i];
    removeVisual(z); zones.splice(i, 1);
    discardCurrent();
    cur = {
      verts: z.footprint.map(([cx, cy]) => new THREE.Vector3(cx, 0, -cy)),
      height: z.maxZ, handles: [], loop: makeLoop(), topHandle: null, closed: true, volume: null,
    };
    cur.verts.forEach((p) => cur.handles.push(makeHandle(p)));
    setLoop(cur.loop, cur.verts, true);
    const c = centroid(cur.verts);
    cur.topHandle = makeHandle(new THREE.Vector3(c.x, cur.height, c.z), 0xffb300);
    rebuildVolume();
    mode = 'edit';
    nameInput.value = z.name; opSelect.value = z.op; syncOpRows();
    if (z.forceClass) classSelect.value = z.forceClass;
    if (z.density != null) densInput.value = z.density;
    refreshList(); saveLocal();
    setStatus(`Editing "${z.name}" — adjust points/height, then Add Zone to re-save.`);
    requestRender();
  }
  // Insert a vertex on the nearest edge to a CET click (edit mode). Returns true if split.
  function trySplitEdge(cet) {
    if (!cur || !cur.closed) return false;
    const n = cur.verts.length;
    let best = { d: Infinity, idx: -1, px: 0, py: 0 };
    for (let i = 0; i < n; i++) {
      const a = cur.verts[i], b = cur.verts[(i + 1) % n];
      const ax = a.x, ay = -a.z, bx = b.x, by = -b.z;       // CET endpoints
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
      let t = ((cet[0] - ax) * dx + (cet[1] - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(cet[0] - px, cet[1] - py);
      if (d < best.d) best = { d, idx: i, px, py };
    }
    if (best.d > SPLIT_SNAP_CET) return false;
    const p = new THREE.Vector3(best.px, 0, -best.py);
    cur.verts.splice(best.idx + 1, 0, p);
    cur.handles.splice(best.idx + 1, 0, makeHandle(p));
    setLoop(cur.loop, cur.verts, true);
    rebuildVolume();
    setStatus(`Split edge — vertex inserted (${cur.verts.length} pts).`);
    requestRender();
    return true;
  }
  // ── persistence: localStorage (working layer) + file import/export ─────────
  function serialize() {
    return zones.map((z) => ({
      name: z.name, op: z.op, footprint: z.footprint, minZ: z.minZ, maxZ: z.maxZ,
      ...(z.forceClass ? { forceClass: z.forceClass } : {}),
      ...(z.density != null ? { density: z.density } : {}),
    }));
  }
  function saveLocal() {
    try { localStorage.setItem(NCZ.ZONES_KEY, JSON.stringify({ zones: serialize() })); } catch (e) { console.warn('[NCZ] zone save failed', e); }
  }
  function exportZones() {
    const json = JSON.stringify({ zones: serialize() }, null, 2);
    navigator.clipboard?.writeText(json).catch(() => {});
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'building-zones.json'; a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`Exported ${zones.length} zone(s) → building-zones.json (also copied to clipboard).`);
  }
  function importZones(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = JSON.parse(reader.result);
        const arr = Array.isArray(j?.zones) ? j.zones : (Array.isArray(j) ? j : null);
        if (!arr) throw new Error('no zones array');
        clearAll();
        for (const z of arr) addExisting(z);
        saveLocal();
        setStatus(`Imported ${arr.length} zone(s). Apply ⟳ to re-segment.`);
      } catch (e) { setStatus(`Import failed: ${e.message}`); }
    };
    reader.readAsText(file);
  }
  function clearAll() {
    discardCurrent();
    for (const z of zones) removeVisual(z);
    zones.length = 0; refreshList(); requestRender();
  }
  // Build a saved zone's faint persistent visual (no handles) and register it.
  function addExisting(z) {
    const verts = z.footprint.map(([cx, cy]) => new THREE.Vector3(cx, 0, -cy));
    const loop = makeLoop(0x335577); setLoop(loop, verts, true);
    const vol = new THREE.Group();
    const top = verts.map((p) => new THREE.Vector3(p.x, z.maxZ ?? 80, p.z));
    const tl = makeLoop(0x335577); setLoop(tl, top, true); vol.add(tl);
    for (let i = 0; i < verts.length; i++) { const e = makeLoop(0x335577); setLoop(e, [verts[i], top[i]], false); vol.add(e); }
    group.add(vol);
    z._loop = loop; z._volume = vol;
    zones.push(z);
  }
  async function loadExisting() {
    let arr = null;
    try { const ls = localStorage.getItem(NCZ.ZONES_KEY); if (ls) arr = JSON.parse(ls).zones; } catch (e) {}
    if (!arr) { try { const d = await fetch('data/building-zones.json').then((r) => r.ok ? r.json() : null); arr = d?.zones; } catch (e) {} }
    if (Array.isArray(arr) && arr.length) { for (const z of arr) addExisting(z); refreshList(); requestRender(); }
  }
  const round = (n) => Math.round(n * 10) / 10;

  // ── pointer interaction (capture phase, consume only when we act) ──────────
  // Remove the footprint vertex under the cursor (right-click). Works in draw or
  // edit mode; never removes the extrude handle, and won't drop a closed loop
  // below 3 points.
  function removeVertexAt(clientX, clientY) {
    if (!cur) return;
    raycaster.setFromCamera(screenToNdc(clientX, clientY), camera);
    const hit = raycaster.intersectObjects(cur.handles, false)[0];
    if (!hit) return;
    const idx = cur.handles.indexOf(hit.object);
    if (idx < 0) return;
    const min = cur.closed ? 3 : 1;
    if (cur.verts.length <= min) { setStatus(`Can't remove — needs at least ${min} point(s).`); return; }
    const h = cur.handles.splice(idx, 1)[0];
    group.remove(h); h.geometry.dispose(); h.material.dispose();
    cur.verts.splice(idx, 1);
    setLoop(cur.loop, cur.verts, cur.closed);
    if (cur.closed) rebuildVolume();
    setStatus(`Removed point (${cur.verts.length} left).`);
    requestRender();
  }

  function onDown(e) {
    if (e.button === 2) { rdown = { x: e.clientX, y: e.clientY, moved: false }; return; } // right: maybe remove a point (or tilt if dragged)
    if (e.button !== 0) return;
    // Handles are draggable only in EDIT mode (after the loop is closed). In DRAW
    // mode every click is a ground click — clicking the first point CLOSES the
    // loop (via the screen-distance snap in onUp), so we must not start a drag here.
    if (mode === 'edit') {
      const h = pickHandle(e.clientX, e.clientY);
      if (h) {
        e.stopPropagation(); e.preventDefault();
        controls.enabled = false;
        if (h === cur.topHandle) drag = { kind: 'extrude', handle: h };
        else drag = { kind: 'vertex', handle: h, vIndex: cur.handles.indexOf(h) };
        return;
      }
    }
    down = { x: e.clientX, y: e.clientY, moved: false };
  }
  function onMove(e) {
    if (drag) {
      e.stopPropagation();
      if (drag.kind === 'extrude') {
        cur.height = round(heightAt(e.clientX, e.clientY, centroid(cur.verts)));
        rebuildVolume();
      } else {
        const cet = groundPointAt(e.clientX, e.clientY);
        if (cet) {
          const p = cur.verts[drag.vIndex];
          p.set(cet[0], 0, -cet[1]);
          drag.handle.position.copy(p);
          setLoop(cur.loop, cur.verts, cur.closed);
          if (cur.closed) rebuildVolume();
        }
      }
      requestRender();
      return;
    }
    if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) down.moved = true;
    if (rdown && !rdown.moved && Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) > DRAG_PX) rdown.moved = true;
  }
  function onUp(e) {
    if (e.button === 2) { // right-click (no drag) removes a point; right-drag was a camera tilt
      if (rdown && !rdown.moved) removeVertexAt(e.clientX, e.clientY);
      rdown = null;
      return;
    }
    if (drag) { drag = null; controls.enabled = true; requestRender(); return; }
    if (!down) return;
    const wasClick = !down.moved;
    down = null;
    if (!wasClick || !cur) return;
    if (mode === 'draw') {
      // circle/ellipse: first click sets the centre, second the radius/corner
      if (shape !== 'poly') {
        const cet = groundPointAt(e.clientX, e.clientY);
        if (!cet) return;
        if (!shapeCentre) {
          shapeCentre = cet;
          setStatus(shape === 'circle' ? 'Click the EDGE (radius).' : 'Click a CORNER (x/y radius).');
          return;
        }
        const dx = Math.abs(cet[0] - shapeCentre[0]), dy = Math.abs(cet[1] - shapeCentre[1]);
        if (shape === 'circle') { const R = Math.hypot(dx, dy); genEllipse(shapeCentre[0], shapeCentre[1], R, R); }
        else { genEllipse(shapeCentre[0], shapeCentre[1], dx, dy); }
        shape = 'poly'; shapeCentre = null;
        return;
      }
      // polygon: close if near the first handle, else add a vertex
      if (cur.verts.length >= 3) {
        const [sx, sy] = worldToScreen(cur.verts[0]);
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < CLOSE_SNAP_PX) { closeLoop(); return; }
      }
      const cet = groundPointAt(e.clientX, e.clientY);
      if (cet) addVertex(cet);
    } else if (mode === 'edit' && cur.closed) {
      // click on an edge (not a handle — handles are consumed in onDown) → split it
      const cet = groundPointAt(e.clientX, e.clientY);
      if (cet) trySplitEdge(cet);
    }
  }

  orbitDom.addEventListener('pointerdown', onDown, true);
  orbitDom.addEventListener('pointermove', onMove, true);
  orbitDom.addEventListener('pointerup', onUp, true);
  orbitDom.addEventListener('contextmenu', (e) => e.preventDefault()); // no OS menu on right-click (we use it to remove points)

  // ── HUD ────────────────────────────────────────────────────────────────────
  const hud = document.createElement('div');
  hud.id = 'zone-tool-hud';
  hud.innerHTML = `
    <div class="zt-title">ZONE TOOL</div>
    <div class="zt-row"><label>Name <input id="zt-name" placeholder="kujira"></label></div>
    <div class="zt-row"><label>Op <select id="zt-op">${OPS.map((o) => `<option>${o}</option>`).join('')}</select></label></div>
    <div class="zt-row" id="zt-class-row"><label>Class <select id="zt-class">${CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></label></div>
    <div class="zt-row" id="zt-dens-row"><label>Density <input id="zt-dens" type="number" value="1" step="0.1" style="width:48px"></label></div>
    <div class="zt-btns">
      <button id="zt-new">New</button>
      <button id="zt-circle">Circle</button>
      <button id="zt-ellipse">Ellipse</button>
    </div>
    <div class="zt-btns">
      <button id="zt-close">Close loop</button>
      <button id="zt-undo">Undo pt</button>
      <button id="zt-add">Add zone</button>
    </div>
    <div class="zt-btns">
      <button id="zt-apply" title="Save to localStorage and reload so the engine re-segments with these zones">Apply ⟳</button>
      <button id="zt-export">Export</button>
      <button id="zt-import">Import</button>
    </div>
    <input id="zt-file" type="file" accept="application/json" style="display:none">
    <div class="zt-btns"><button id="zt-clear" title="Remove all zones (clears localStorage working set)">Clear all</button></div>
    <div class="zt-list" id="zt-list"></div>
    <div class="zt-status" id="zt-status"></div>`;
  document.body.appendChild(hud);
  injectStyles();

  const nameInput = hud.querySelector('#zt-name');
  const opSelect = hud.querySelector('#zt-op');
  const classSelect = hud.querySelector('#zt-class');
  const densInput = hud.querySelector('#zt-dens');
  const listEl = hud.querySelector('#zt-list');
  const statusEl = hud.querySelector('#zt-status');
  const setStatus = (t) => { statusEl.textContent = t; };
  function syncOpRows() {
    hud.querySelector('#zt-class-row').style.display = opSelect.value === 'forceClass' ? '' : 'none';
    hud.querySelector('#zt-dens-row').style.display = opSelect.value === 'forceLit' ? '' : 'none';
  }
  function refreshList() {
    listEl.innerHTML = zones.map((z, i) => `<div class="zt-zone">`
      + `<span class="zt-zname" title="${z.name} · ${z.op}${z.forceClass ? ':' + z.forceClass : ''} · h${z.maxZ} · ${z.footprint.length}pt">${i + 1}. ${z.name} · ${z.op}${z.forceClass ? ':' + z.forceClass : ''}</span>`
      + `<button class="zt-edit" data-i="${i}" title="Edit / rename">✎</button>`
      + `<button class="zt-del" data-i="${i}" title="Delete">×</button>`
      + `</div>`).join('');
  }
  listEl.addEventListener('click', (e) => {
    const ed = e.target.closest('.zt-edit'); const del = e.target.closest('.zt-del');
    if (ed) editZone(Number(ed.dataset.i));
    else if (del) deleteZone(Number(del.dataset.i));
  });
  opSelect.addEventListener('change', syncOpRows);
  hud.querySelector('#zt-new').addEventListener('click', newZone);
  hud.querySelector('#zt-circle').addEventListener('click', () => startShape('circle'));
  hud.querySelector('#zt-ellipse').addEventListener('click', () => startShape('ellipse'));
  hud.querySelector('#zt-close').addEventListener('click', closeLoop);
  hud.querySelector('#zt-add').addEventListener('click', addZone);
  hud.querySelector('#zt-export').addEventListener('click', exportZones);
  hud.querySelector('#zt-apply').addEventListener('click', () => { saveLocal(); location.reload(); });
  hud.querySelector('#zt-import').addEventListener('click', () => hud.querySelector('#zt-file').click());
  hud.querySelector('#zt-file').addEventListener('change', (e) => { if (e.target.files[0]) importZones(e.target.files[0]); e.target.value = ''; });
  hud.querySelector('#zt-clear').addEventListener('click', () => { clearAll(); saveLocal(); setStatus('Cleared all zones.'); });
  hud.querySelector('#zt-undo').addEventListener('click', () => {
    if (!cur || cur.closed || !cur.verts.length) return;
    cur.verts.pop(); const h = cur.handles.pop(); group.remove(h); h.geometry.dispose();
    setLoop(cur.loop, cur.verts, false); requestRender();
  });
  // keep clicks/drags inside the HUD from reaching the canvas/OrbitControls
  hud.addEventListener('pointerdown', (e) => e.stopPropagation());

  // Drag the panel by its title bar.
  makeDraggable(hud, hud.querySelector('.zt-title'));

  syncOpRows();
  loadExisting();   // show any saved zones (localStorage working set, else repo baseline)
  newZone();
  console.log('[NCZ] zone-tool active — draw footprints, extrude, export. window.NCZ.__zones for the array.');
  window.NCZ.__zones = zones;
  window.NCZ.__zoneTool = { get cur() { return cur; }, group, zones, groundPointAt, camera, dom };
}

// Drag `el` by `handle` (its title bar). Uses pointer capture so the drag
// survives the cursor leaving the small handle.
function makeDraggable(el, handle) {
  let ox = 0, oy = 0, dragging = false;
  handle.style.cursor = 'move';
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    const r = el.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    el.style.left = `${e.clientX - ox}px`;
    el.style.top = `${e.clientY - oy}px`;
    el.style.right = 'auto';
  });
  handle.addEventListener('pointerup', (e) => { dragging = false; handle.releasePointerCapture(e.pointerId); });
}

function injectStyles() {
  if (document.getElementById('zone-tool-style')) return;
  const s = document.createElement('style');
  s.id = 'zone-tool-style';
  s.textContent = `
    #zone-tool-hud { position:absolute; top:80px; left:332px; z-index:2000; width:200px;
      background:rgba(10,25,47,0.92); border:1px solid var(--secondary,#00f0ff); padding:10px;
      font-family:var(--font-body,sans-serif); color:var(--white,#e6f1ff); font-size:12px; }
    #zone-tool-hud .zt-title { font-family:var(--font-heading,sans-serif); letter-spacing:0.08em;
      color:var(--secondary,#00f0ff); margin-bottom:8px; }
    #zone-tool-hud .zt-row { margin:4px 0; }
    #zone-tool-hud label { display:flex; gap:6px; align-items:center; justify-content:space-between; }
    #zone-tool-hud input, #zone-tool-hud select { background:#0a192f; color:#e6f1ff;
      border:1px solid var(--secondary-20,#1e6e7a); padding:2px 4px; font-size:12px; }
    #zone-tool-hud .zt-btns { display:flex; gap:4px; margin-top:6px; }
    #zone-tool-hud button { flex:1; background:transparent; border:1px solid var(--secondary,#00f0ff);
      color:var(--secondary,#00f0ff); padding:4px 2px; cursor:pointer; font-size:11px; }
    #zone-tool-hud button:hover { background:var(--secondary,#00f0ff); color:#0a192f; }
    #zone-tool-hud .zt-list { margin-top:8px; max-height:160px; overflow:auto; }
    #zone-tool-hud .zt-zone { display:flex; align-items:center; gap:4px; padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.08); font-size:11px; }
    #zone-tool-hud .zt-zname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #zone-tool-hud .zt-zone button { flex:0 0 auto; padding:0 5px; min-width:0; line-height:1.4; }
    #zone-tool-hud .zt-del { border-color:#ff5555; color:#ff5555; }
    #zone-tool-hud .zt-del:hover { background:#ff5555; color:#0a192f; }
    #zone-tool-hud .zt-status { margin-top:8px; color:var(--tertiary,#ffb300); font-size:11px; line-height:1.3; }`;
  document.head.appendChild(s);
}
