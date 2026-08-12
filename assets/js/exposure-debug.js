/**
 * NC Zoning Board: camera-reachability visualiser (dev only, ?exposure)
 * ─────────────────────────────────────────────────────────────────────────
 * scripts/exposure.js decides, per placement, whether a ray from its surface
 * can reach open sky inside the cone the map's OrbitControls allows (dead
 * top-down to CAMERA_MAX_TILT). It says 44.5% of placed geometry across the
 * three rebuilt districts is unreachable by any camera the map permits.
 *
 * That is a large claim resting on a ray test, so this view exists to falsify
 * it rather than illustrate it. Hidden placements draw RED, and any red pixel
 * on screen is a placement the test called unreachable while the camera is
 * reaching it. An empty screen is the verdict holding.
 *
 * WHAT OCCLUDES THE RED IS THE POINT. The building cloud cannot do that job:
 * it is a merged voxel hull with holes in it, so red shows through gaps that
 * do not exist in the game. In `hidden` mode the VISIBLE placements are
 * therefore drawn as opaque depth-writing occluders, which is the same
 * population the ray test used as occluders. The test and the picture then
 * disagree only where the test is wrong.
 *
 * Keys: X cycles hidden -> visible -> both -> off.
 *
 * Coordinate convention (matches the DDS decode in three-scene.js):
 *   CET (x, y, z)        -> world (x, z, -y)
 *   CET quat (x, y, z, w)-> world (x, z, -y, w)
 *   CET half-extents     -> world full extents (hx*2, hz*2, hy*2)
 */
import * as THREE from 'three';

const MODES = ['hidden', 'visible', 'both', 'off'];
const COLOR_HIDDEN   = new THREE.Color(0xff2d3a);
const COLOR_VISIBLE  = new THREE.Color(0x2de0ff);
const COLOR_OCCLUDER = new THREE.Color(0x14273f);   // near the scene ground, so red reads against it

export async function initExposureDebug(ctx) {
  const { scene, requestRender, districts } = ctx;

  const group = new THREE.Group();
  group.name = 'exposure-debug';
  scene.add(group);

  const dummy = new THREE.Object3D();
  const built = [];   // { name, hidden: InstancedMesh, visible: InstancedMesh }

  for (const meta of districts) {
    const base = `data/exposure-boxes-${meta.name}`;
    let head;
    try {
      const r = await fetch(`${base}.json`);
      if (!r.ok) continue;
      head = await r.json();
    } catch { continue; }

    const buf = await fetch(`${base}.bin`).then((r) => r.arrayBuffer());
    const n = head.count;
    // Ten floats of geometry per box, then one verdict byte per box. The
    // float view must start at byte 0 and the byte view after it, so a short
    // or truncated file shows up as a length mismatch here rather than as
    // silently misdrawn boxes.
    if (buf.byteLength < n * 41) {
      console.error(`[NCZ] exposure: ${meta.name} is ${buf.byteLength} bytes, expected ${n * 41}`);
      continue;
    }
    const geo = new Float32Array(buf, 0, n * 10);
    const ver = new Uint8Array(buf, n * 40, n);

    // One InstancedMesh per verdict, so toggling is a visibility flag rather
    // than a rebuild, and so the two never share a draw call.
    const counts = { 1: 0, 2: 0 };
    for (let i = 0; i < n; i++) counts[ver[i]]++;

    const make = (count, mat) => {
      if (!count) return null;
      const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, count);
      m.frustumCulled = false;
      m.renderOrder = 900;
      return m;
    };
    const hidden = make(counts[2], new THREE.MeshBasicNodeMaterial({
      color: COLOR_HIDDEN, transparent: true, opacity: 0.85, depthWrite: false,
    }));
    // Two materials for one mesh: the shell that hides the red, and the cyan
    // used when the visible set is what is being looked at.
    const occluderMat = new THREE.MeshBasicNodeMaterial({ color: COLOR_OCCLUDER });
    const visibleMat = new THREE.MeshBasicNodeMaterial({
      color: COLOR_VISIBLE, transparent: true, opacity: 0.45, depthWrite: false,
    });
    const visible = make(counts[1], occluderMat);
    if (visible) { visible.renderOrder = 0; visible.userData.mats = { occluderMat, visibleMat }; }

    let hi = 0, vi = 0;
    for (let i = 0; i < n; i++) {
      const g = i * 10;
      dummy.position.set(geo[g], geo[g + 2], -geo[g + 1]);
      dummy.quaternion.set(geo[g + 6], geo[g + 8], -geo[g + 7], geo[g + 9]);
      // A degenerate axis draws as a zero-area sliver that z-fights everything
      // behind it; a 5 cm floor keeps a decal-thin placement visible as a card.
      dummy.scale.set(
        Math.max(0.05, geo[g + 3] * 2),
        Math.max(0.05, geo[g + 5] * 2),
        Math.max(0.05, geo[g + 4] * 2),
      );
      dummy.updateMatrix();
      if (ver[i] === 2) hidden.setMatrixAt(hi++, dummy.matrix);
      else visible.setMatrixAt(vi++, dummy.matrix);
    }
    if (hidden) { hidden.instanceMatrix.needsUpdate = true; group.add(hidden); }
    if (visible) { visible.instanceMatrix.needsUpdate = true; group.add(visible); }
    built.push({ name: meta.name, hidden, visible, counts });
    console.log(`[NCZ] exposure ${meta.name}: ${counts[2].toLocaleString()} hidden, ${counts[1].toLocaleString()} visible`);
  }

  if (!built.length) {
    console.warn('[NCZ] exposure: no data/exposure-boxes-*.bin for the districts on screen. ' +
                 'Run: node scripts/exposure.js <district> && node scripts/exposure_debug.js');
    return null;
  }

  let mode = 0;
  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9999;font:12px/1.5 monospace;' +
    'background:rgba(10,25,47,.85);color:#00f0ff;border:1px solid #00f0ff;border-radius:4px;padding:6px 10px;pointer-events:none';
  document.body.appendChild(status);

  function apply() {
    const m = MODES[mode];
    for (const d of built) {
      if (d.hidden) d.hidden.visible = (m === 'hidden' || m === 'both');
      if (d.visible) {
        // In `hidden` mode the visible set stays on screen as the occluding
        // shell. Turning it off there would make every buried placement show
        // through and the check would pass nothing.
        d.visible.visible = (m !== 'off');
        const mats = d.visible.userData.mats;
        d.visible.material = (m === 'hidden') ? mats.occluderMat : mats.visibleMat;
        d.visible.renderOrder = (m === 'hidden') ? 0 : 900;
      }
    }
    const totals = built.reduce((a, d) => ({ h: a.h + d.counts[2], v: a.v + d.counts[1] }), { h: 0, v: 0 });
    const pct = (100 * totals.h / Math.max(1, totals.h + totals.v)).toFixed(1);
    status.textContent = `exposure: ${m}  (X to cycle)   ` +
      `hidden ${totals.h.toLocaleString()} (${pct}%)   visible ${totals.v.toLocaleString()}` +
      `${m === 'hidden' ? '   (any red you can see is a false negative)' : ''}`;
    requestRender();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'x' && e.key !== 'X') return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    mode = (mode + 1) % MODES.length;
    apply();
  });

  apply();
  return { group, built, setMode: (m) => { mode = Math.max(0, MODES.indexOf(m)); apply(); } };
}
