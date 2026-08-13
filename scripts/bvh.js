/**
 * bvh.js: a two-level bounding volume hierarchy over the placed city.
 *
 * The city is a KIT: ~2,300 unique meshes stand in ~300,000 places per
 * district. Flattening that into one world-space triangle soup costs the
 * product of the two (tens of millions of triangles, hundreds of megabytes)
 * to re-store geometry the mesh library already holds once. So the structure
 * is the one a raytracer uses:
 *
 *   BLAS   one tree per unique MESH, built over its triangles in mesh space.
 *          Built once, shared by every placement of that mesh.
 *   TLAS   one tree over the PLACEMENTS, built over their world AABBs. A ray
 *          entering an instance is transformed into mesh space and handed to
 *          that mesh's BLAS.
 *
 * Memory is then unique-geometry plus a small record per placement, and a
 * mesh placed 4,000 times is built once.
 *
 * Both levels are binned-SAH trees in flat typed arrays. Nodes are 8 floats:
 * six for the AABB, then either (first, count) for a leaf or (left, 0) for an
 * interior node, so `count === 0` distinguishes them without a separate flag.
 *
 * Rays are (origin, direction, tMax) with direction NOT required to be unit
 * length; t is in units of the direction vector, which is what makes the
 * instance transform free (transform origin and direction, keep t).
 */
'use strict';

const NODE = 8;              // floats per node
const BINS = 12;             // SAH bins per axis
const LEAF_TRIS = 4;         // stop splitting a BLAS node at this many triangles
const LEAF_INST = 2;         // and a TLAS node at this many instances

/** Grow `box` (6 floats at `o`) to contain the point (x, y, z). */
function grow(box, o, x, y, z) {
  if (x < box[o]) box[o] = x;
  if (y < box[o + 1]) box[o + 1] = y;
  if (z < box[o + 2]) box[o + 2] = z;
  if (x > box[o + 3]) box[o + 3] = x;
  if (y > box[o + 4]) box[o + 4] = y;
  if (z > box[o + 5]) box[o + 5] = z;
}

function surfaceArea(x0, y0, z0, x1, y1, z1) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

/**
 * Build a tree over `n` items whose AABBs and centroids are supplied.
 *
 * `bounds` is 6 floats per item, `centroids` 3. The returned `order` is the
 * item permutation the leaves index into: leaves store a range of `order`,
 * never the items themselves, so an item is never copied.
 */
function buildTree(n, bounds, centroids, leafSize) {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  // Worst case for a binary tree over n leaves of size >= 1 is 2n - 1 nodes.
  const nodes = new Float32Array(Math.max(1, 2 * n) * NODE);
  let nodeCount = 1;

  const nodeBounds = (node, first, count) => {
    const o = node * NODE;
    nodes[o] = nodes[o + 1] = nodes[o + 2] = Infinity;
    nodes[o + 3] = nodes[o + 4] = nodes[o + 5] = -Infinity;
    for (let i = first; i < first + count; i++) {
      const b = order[i] * 6;
      grow(nodes, o, bounds[b], bounds[b + 1], bounds[b + 2]);
      grow(nodes, o, bounds[b + 3], bounds[b + 4], bounds[b + 5]);
    }
  };

  // An explicit stack: a city block recurses deeper than the JS call stack
  // likes, and a blown stack here would look like a corrupt tree.
  const stack = [[0, 0, n]];
  nodeBounds(0, 0, n);

  const binBox = new Float32Array(BINS * 6);
  const binCount = new Int32Array(BINS);

  while (stack.length) {
    const [node, first, count] = stack.pop();
    const o = node * NODE;

    if (count <= leafSize) { nodes[o + 6] = first; nodes[o + 7] = count; continue; }

    // Split along the axis with the widest spread of CENTROIDS, not of the
    // bounds: a few long thin triangles otherwise dictate every split.
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = first; i < first + count; i++) {
      const c = order[i] * 3;
      if (centroids[c] < cx0) cx0 = centroids[c];
      if (centroids[c] > cx1) cx1 = centroids[c];
      if (centroids[c + 1] < cy0) cy0 = centroids[c + 1];
      if (centroids[c + 1] > cy1) cy1 = centroids[c + 1];
      if (centroids[c + 2] < cz0) cz0 = centroids[c + 2];
      if (centroids[c + 2] > cz1) cz1 = centroids[c + 2];
    }
    const ext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
    let axis = 0;
    if (ext[1] > ext[axis]) axis = 1;
    if (ext[2] > ext[axis]) axis = 2;
    const lo = [cx0, cy0, cz0][axis], hi = [cx1, cy1, cz1][axis];
    if (!(hi > lo)) { nodes[o + 6] = first; nodes[o + 7] = count; continue; }

    // Bin by centroid, then score every split plane by surface area heuristic.
    binCount.fill(0);
    for (let b = 0; b < BINS; b++) {
      binBox[b * 6] = binBox[b * 6 + 1] = binBox[b * 6 + 2] = Infinity;
      binBox[b * 6 + 3] = binBox[b * 6 + 4] = binBox[b * 6 + 5] = -Infinity;
    }
    const scale = BINS / (hi - lo);
    for (let i = first; i < first + count; i++) {
      const item = order[i];
      let b = ((centroids[item * 3 + axis] - lo) * scale) | 0;
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      binCount[b]++;
      const bb = item * 6;
      grow(binBox, b * 6, bounds[bb], bounds[bb + 1], bounds[bb + 2]);
      grow(binBox, b * 6, bounds[bb + 3], bounds[bb + 4], bounds[bb + 5]);
    }

    // Sweep from both ends so each candidate plane knows the cost of both sides.
    const leftArea = new Float32Array(BINS), rightArea = new Float32Array(BINS);
    const leftN = new Int32Array(BINS), rightN = new Int32Array(BINS);
    let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity, acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += binCount[b];
      if (binCount[b]) {
        ax0 = Math.min(ax0, binBox[b * 6]); ay0 = Math.min(ay0, binBox[b * 6 + 1]); az0 = Math.min(az0, binBox[b * 6 + 2]);
        ax1 = Math.max(ax1, binBox[b * 6 + 3]); ay1 = Math.max(ay1, binBox[b * 6 + 4]); az1 = Math.max(az1, binBox[b * 6 + 5]);
      }
      leftN[b] = acc; leftArea[b] = surfaceArea(ax0, ay0, az0, ax1, ay1, az1);
    }
    ax0 = ay0 = az0 = Infinity; ax1 = ay1 = az1 = -Infinity; acc = 0;
    for (let b = BINS - 1; b >= 0; b--) {
      acc += binCount[b];
      if (binCount[b]) {
        ax0 = Math.min(ax0, binBox[b * 6]); ay0 = Math.min(ay0, binBox[b * 6 + 1]); az0 = Math.min(az0, binBox[b * 6 + 2]);
        ax1 = Math.max(ax1, binBox[b * 6 + 3]); ay1 = Math.max(ay1, binBox[b * 6 + 4]); az1 = Math.max(az1, binBox[b * 6 + 5]);
      }
      rightN[b] = acc; rightArea[b] = surfaceArea(ax0, ay0, az0, ax1, ay1, az1);
    }

    let bestCost = Infinity, bestSplit = -1;
    for (let b = 0; b < BINS - 1; b++) {
      if (!leftN[b] || !rightN[b + 1]) continue;
      const cost = leftArea[b] * leftN[b] + rightArea[b + 1] * rightN[b + 1];
      if (cost < bestCost) { bestCost = cost; bestSplit = b; }
    }
    if (bestSplit < 0) { nodes[o + 6] = first; nodes[o + 7] = count; continue; }

    // Partition `order` in place around the chosen plane.
    let i = first, j = first + count - 1;
    while (i <= j) {
      const item = order[i];
      let b = ((centroids[item * 3 + axis] - lo) * scale) | 0;
      if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      if (b <= bestSplit) i++;
      else { order[i] = order[j]; order[j] = item; j--; }
    }
    const leftCount = i - first;
    if (leftCount === 0 || leftCount === count) { nodes[o + 6] = first; nodes[o + 7] = count; continue; }

    const left = nodeCount;
    nodeCount += 2;
    nodes[o + 6] = left; nodes[o + 7] = 0;
    nodeBounds(left, first, leftCount);
    nodeBounds(left + 1, i, count - leftCount);
    stack.push([left, first, leftCount], [left + 1, i, count - leftCount]);
  }

  return { nodes: nodes.subarray(0, nodeCount * NODE), order, nodeCount };
}

/** Slab test. Returns the near t, or Infinity when the ray misses. */
function hitBox(nodes, o, ox, oy, oz, idx, idy, idz, tMax) {
  const tx0 = (nodes[o] - ox) * idx, tx1 = (nodes[o + 3] - ox) * idx;
  let tmin = Math.min(tx0, tx1), tmax = Math.max(tx0, tx1);
  const ty0 = (nodes[o + 1] - oy) * idy, ty1 = (nodes[o + 4] - oy) * idy;
  tmin = Math.max(tmin, Math.min(ty0, ty1)); tmax = Math.min(tmax, Math.max(ty0, ty1));
  const tz0 = (nodes[o + 2] - oz) * idz, tz1 = (nodes[o + 5] - oz) * idz;
  tmin = Math.max(tmin, Math.min(tz0, tz1)); tmax = Math.min(tmax, Math.max(tz0, tz1));
  return (tmax >= Math.max(tmin, 0) && tmin < tMax) ? Math.max(tmin, 0) : Infinity;
}

/**
 * A BLAS: one mesh's triangles, in mesh space.
 *
 * `tris` is the 9-floats-per-triangle soup glb_lib.meshTriangles returns.
 */
class MeshBvh {
  constructor(tris) {
    this.tris = tris;
    const n = tris.length / 9;
    const bounds = new Float32Array(n * 6);
    const centroids = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = i * 9, b = i * 6, c = i * 3;
      bounds[b] = bounds[b + 1] = bounds[b + 2] = Infinity;
      bounds[b + 3] = bounds[b + 4] = bounds[b + 5] = -Infinity;
      for (let v = 0; v < 3; v++) grow(bounds, b, tris[t + v * 3], tris[t + v * 3 + 1], tris[t + v * 3 + 2]);
      centroids[c] = (tris[t] + tris[t + 3] + tris[t + 6]) / 3;
      centroids[c + 1] = (tris[t + 1] + tris[t + 4] + tris[t + 7]) / 3;
      centroids[c + 2] = (tris[t + 2] + tris[t + 5] + tris[t + 8]) / 3;
    }
    const built = buildTree(n, bounds, centroids, LEAF_TRIS);
    this.nodes = built.nodes;
    this.order = built.order;
    this.bounds = [bounds, centroids];   // kept only for debugging; see trimBounds()
    this.rootBox = built.nodeCount ? Array.from(this.nodes.subarray(0, 6)) : [0, 0, 0, 0, 0, 0];
  }

  /** Drop the per-triangle build scratch once every instance is placed. */
  trimBounds() { this.bounds = null; }

  /**
   * First hit along the ray, or Infinity.
   *
   * Moller-Trumbore, two-sided: a kit panel is a single-sided quad and its
   * winding is not something to bet an occlusion test on.
   *
   * `tMin` ignores anything nearer than that along the ray. Kit panels butt
   * against each other, so a ray leaving a facade immediately meets whatever
   * is bolted to it and every direction reads blocked. Moving the origin off
   * the surface instead is what a first attempt did, and it pushed the origin
   * clean through any panel thinner than the offset: 0.18 m panels were cut
   * 207 times out of 207 while the 0.60 m version beside them survived.
   */
  hit(ox, oy, oz, dx, dy, dz, tMax, tMin = 1e-6) {
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
    const { nodes, order, tris } = this;
    let best = tMax;
    const stack = this._stack || (this._stack = new Int32Array(64));
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp], o = node * NODE;
      if (hitBox(nodes, o, ox, oy, oz, idx, idy, idz, best) === Infinity) continue;
      const count = nodes[o + 7];
      if (count === 0) {
        const left = nodes[o + 6];
        if (sp + 2 >= stack.length) continue;      // depth guard; a miss beats a crash
        stack[sp++] = left; stack[sp++] = left + 1;
        continue;
      }
      const first = nodes[o + 6];
      for (let i = first; i < first + count; i++) {
        const t = order[i] * 9;
        const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
        const e1x = tris[t + 3] - ax, e1y = tris[t + 4] - ay, e1z = tris[t + 5] - az;
        const e2x = tris[t + 6] - ax, e2y = tris[t + 7] - ay, e2z = tris[t + 8] - az;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-12 && det < 1e-12) continue;
        const inv = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (hit > tMin && hit < best) best = hit;
      }
    }
    return best;
  }
}

/**
 * A TLAS: placements, each pointing at a BLAS and carrying its transform.
 *
 * The transform is stored as its INVERSE (rotation transposed, scale
 * reciprocated, translation folded in) because a ray only ever travels the
 * world-to-mesh direction. Storing the forward transform would mean inverting
 * it per ray per instance.
 */
class SceneBvh {
  constructor() {
    this.instances = [];   // { blas, inv: Float64Array(12), scaleMin }
    this.built = null;
  }

  /**
   * @param blas   MeshBvh shared by every placement of this mesh
   * @param pos    world position [x, y, z]
   * @param quat   rotation [x, y, z, w]
   * @param scale  [sx, sy, sz]
   * @param tag    caller's payload, returned by hits and enumerations
   */
  add(blas, pos, quat, scale, tag) {
    const [qx, qy, qz, qw] = quat;
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
    const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
    const [sx, sy, sz] = scale;

    // World -> mesh: undo translation, undo rotation (transpose), undo scale.
    const inv = new Float64Array(12);
    inv[0] = m00 / sx; inv[1] = m10 / sx; inv[2] = m20 / sx;
    inv[4] = m01 / sy; inv[5] = m11 / sy; inv[6] = m21 / sy;
    inv[8] = m02 / sz; inv[9] = m12 / sz; inv[10] = m22 / sz;
    inv[3] = -(inv[0] * pos[0] + inv[1] * pos[1] + inv[2] * pos[2]);
    inv[7] = -(inv[4] * pos[0] + inv[5] * pos[1] + inv[6] * pos[2]);
    inv[11] = -(inv[8] * pos[0] + inv[9] * pos[1] + inv[10] * pos[2]);

    // World AABB from the mesh's root box under the forward transform.
    const rb = blas.rootBox;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const lx = (c & 1 ? rb[3] : rb[0]) * sx;
      const ly = (c & 2 ? rb[4] : rb[1]) * sy;
      const lz = (c & 4 ? rb[5] : rb[2]) * sz;
      const wx = pos[0] + m00 * lx + m01 * ly + m02 * lz;
      const wy = pos[1] + m10 * lx + m11 * ly + m12 * lz;
      const wz = pos[2] + m20 * lx + m21 * ly + m22 * lz;
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
      if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    this.instances.push({ blas, inv, tag, box: [x0, y0, z0, x1, y1, z1] });
    this.built = null;
    return this.instances.length - 1;
  }

  build() {
    const n = this.instances.length;
    const bounds = new Float32Array(n * 6);
    const centroids = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const b = this.instances[i].box;
      bounds.set(b, i * 6);
      centroids[i * 3] = (b[0] + b[3]) / 2;
      centroids[i * 3 + 1] = (b[1] + b[4]) / 2;
      centroids[i * 3 + 2] = (b[2] + b[5]) / 2;
    }
    this.built = buildTree(n, bounds, centroids, LEAF_INST);
    return this;
  }

  /**
   * First hit along a world-space ray.
   *
   * `skip` is an instance index the ray ignores, so a surface can cast from
   * itself without immediately hitting itself. `tMin` ignores every instance's
   * geometry nearer than that along the ray, which is what handles the
   * NEIGHBOURING placement a kit panel is bolted to.
   * @returns {{t: number, instance: number}} t is Infinity when nothing is hit.
   */
  hit(ox, oy, oz, dx, dy, dz, tMax, skip = -1, tMin = 1e-6) {
    if (!this.built) this.build();
    const { nodes, order } = this.built;
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
    let best = tMax, hitInst = -1;
    const stack = this._stack || (this._stack = new Int32Array(128));
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp], o = node * NODE;
      if (hitBox(nodes, o, ox, oy, oz, idx, idy, idz, best) === Infinity) continue;
      const count = nodes[o + 7];
      if (count === 0) {
        const left = nodes[o + 6];
        if (sp + 2 >= stack.length) continue;
        stack[sp++] = left; stack[sp++] = left + 1;
        continue;
      }
      const first = nodes[o + 6];
      for (let i = first; i < first + count; i++) {
        const ii = order[i];
        if (ii === skip) continue;
        const inst = this.instances[ii], m = inst.inv;
        const lox = m[0] * ox + m[1] * oy + m[2] * oz + m[3];
        const loy = m[4] * ox + m[5] * oy + m[6] * oz + m[7];
        const loz = m[8] * ox + m[9] * oy + m[10] * oz + m[11];
        const ldx = m[0] * dx + m[1] * dy + m[2] * dz;
        const ldy = m[4] * dx + m[5] * dy + m[6] * dz;
        const ldz = m[8] * dx + m[9] * dy + m[10] * dz;
        // t is in units of the direction vector, and the transform scales
        // origin and direction alike, so it carries across unchanged.
        const t = inst.blas.hit(lox, loy, loz, ldx, ldy, ldz, best, tMin);
        if (t < best) { best = t; hitInst = ii; }
      }
    }
    return { t: best, instance: hitInst };
  }

  /** True when anything blocks the segment. Cheaper than hit(): stops early. */
  occluded(ox, oy, oz, dx, dy, dz, tMax, skip = -1, tMin = 1e-6) {
    return this.hit(ox, oy, oz, dx, dy, dz, tMax, skip, tMin).t < tMax;
  }
}

module.exports = { MeshBvh, SceneBvh, buildTree, NODE };
