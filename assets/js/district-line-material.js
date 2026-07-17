/**
 * DistrictLineMaterial: custom TSL wide-line material for the district
 * outlines (issue #775), replacing three's Line2NodeMaterial.
 *
 * Why not Line2NodeMaterial: the r185 rewrite doesn't support real
 * transparency ("not supported, yet"; it forces NoBlending and fakes
 * semi-transparent lines by blending against viewportOpaqueMipTexture(), a
 * canvas-size copy of the opaque-only framebuffer, in-shader). For our
 * outlines that fake was the root of three bugs at once: the #771 resize
 * wedge (stale binding to the destroyed framebuffer copy), the unhovered
 * colour regression (lines composited against the opaque backdrop, ignoring
 * the roads/metro/water actually beneath them), and the alphaToCoverage
 * quantisation of faint lines.
 *
 * What this ports from upstream (r185 Line2NodeMaterial, screen-space path):
 *   - the instanced quad expansion from LineGeometry's instanceStart /
 *     instanceEnd attributes (geometry pipeline unchanged; only the
 *     material is swapped)
 *   - the reversed-depth-aware near-plane segment trim (upstream #33572,
 *     the fix this repo tracked as mrdoob#33570)
 *   - round endcaps
 *
 * What it does differently:
 *   - real alpha blending: NormalBlending + standard material.opacity, so
 *     the hover fade tween and the faint resting opacity composite against
 *     whatever is actually behind the line (r184-equivalent look)
 *   - endcap edges are fwidth-AA'd unconditionally (no alphaToCoverage, no
 *     MSAA sample-count gate; the sub-pixel-detail lesson from the terrain
 *     grid / building edges applies here too)
 *   - degenerate segments (zero NDC length after projection) are guarded
 *     in-shader: belt-and-braces alongside dedupRing()'s data hygiene, so
 *     bad ring data can never produce NaN direction rays again
 *
 * Not ported (unused by the district outlines): dashes, world units, vertex
 * colors, raycast support.
 *
 * Joint dedup (the `stencilRef` parameter): every segment is an independent
 * quad with cap extensions, so a ring self-overlaps at each corner; under
 * real alpha blending that double-blend reads as a brighter dot at partial
 * opacity. (r184 never showed it: its backdrop-premix fake made overlapping
 * writes idempotent.) Fix: per-ring stencil ref with NotEqual + Replace;
 * within a frame each ring's first fragment at a pixel stamps the ref and
 * later fragments of the SAME ring fail the test, so a ring touches each
 * pixel once. Coincident neighbour borders carry different refs and still
 * draw over each other (hover-over-faint keeps working). Rings draw at
 * renderOrder 7+, after the SeeThrough pass (renderOrder 5) has consumed
 * the scene's OCCLUDER/water stencil values, so clobbering them is safe.
 */

import * as THREE from 'three';
import {
  Fn, If, float, vec2, vec4, attribute, uv, select,
  positionGeometry, modelViewMatrix, cameraProjectionMatrix,
  materialColor, materialOpacity, materialLineWidth, mix, smoothstep,
  viewport, screenDPR,
} from 'three/tsl';

// Near-plane estimate from the projection matrix, branching on the depth
// convention: te[10] is positive under a reversed depth buffer, so its sign
// selects the formula (verbatim port of r185's trimSegmentAlpha; the r184
// version assumed the WebGL layout and returned ~-far/2 under reversed-Z,
// the rays-across-viewport bug).
const trimSegmentAlpha = Fn(({ start, end }) => {
  const a = cameraProjectionMatrix.element(2).element(2);
  const b = cameraProjectionMatrix.element(3).element(2);
  const nearEstimate = a.greaterThan(0).select(b.negate().div(a.add(1)), b.mul(-0.5).div(a));
  return nearEstimate.sub(start.z).div(end.z.sub(start.z));
}, { start: 'vec4', end: 'vec4', return: 'float' });

// Vertex stage: expand each instanced segment into a screen-facing quad of
// `linewidth` pixels, with one-segment-length cap extensions at both ends
// (the fragment stage rounds them off).
const districtLineClipPosition = /*@__PURE__*/ Fn(() => {
  const instanceStart = attribute('instanceStart');
  const instanceEnd   = attribute('instanceEnd');

  // camera space
  const start = vec4(modelViewMatrix.mul(vec4(instanceStart, 1.0))).toVar('start');
  const end   = vec4(modelViewMatrix.mul(vec4(instanceEnd, 1.0))).toVar('end');

  const aspect = viewport.z.div(viewport.w);

  // Trim segments that cross the camera plane under perspective projection:
  // NDC math below is meaningless for endpoints behind the camera.
  const perspective = cameraProjectionMatrix.element(2).element(3).equal(-1.0);
  If(perspective, () => {
    If(start.z.lessThan(0.0).and(end.z.greaterThan(0.0)), () => {
      const alpha = trimSegmentAlpha({ start, end });
      end.assign(vec4(mix(start.xyz, end.xyz, alpha), end.w));
    }).ElseIf(end.z.lessThan(0.0).and(start.z.greaterThanEqual(0.0)), () => {
      const alpha = trimSegmentAlpha({ start: end, end: start });
      start.assign(vec4(mix(end.xyz, start.xyz, alpha), start.w));
    });
  });

  // clip → ndc
  const clipStart = cameraProjectionMatrix.mul(start);
  const clipEnd   = cameraProjectionMatrix.mul(end);
  const ndcStart  = clipStart.xyz.div(clipStart.w);
  const ndcEnd    = clipEnd.xyz.div(clipEnd.w);

  // segment direction in aspect-corrected NDC, guarded against degenerate
  // (zero-length after projection) segments instead of normalize(0,0) = NaN
  const dir = ndcEnd.xy.sub(ndcStart.xy).toVar('dir');
  dir.x.assign(dir.x.mul(aspect));
  const dirLen = dir.length().toVar('dirLen');
  dir.assign(select(dirLen.greaterThan(1e-7), dir.div(dirLen), vec2(1.0, 0.0)));

  // perpendicular offset, back to un-corrected NDC
  const offset = vec2(dir.y, dir.x.negate()).toVar('offset');
  dir.x.assign(dir.x.div(aspect));
  offset.x.assign(offset.x.div(aspect));

  // quad corner side
  offset.assign(positionGeometry.x.lessThan(0.0).select(offset.negate(), offset));

  // endcap extension along the segment direction
  If(positionGeometry.y.lessThan(0.0), () => {
    offset.assign(offset.sub(dir));
  }).ElseIf(positionGeometry.y.greaterThan(1.0), () => {
    offset.assign(offset.add(dir));
  });

  // pixels → NDC (materialLineWidth reads material.linewidth)
  offset.assign(offset.mul(materialLineWidth));
  offset.assign(offset.div(viewport.w.div(screenDPR)));

  // anchor on this vertex's segment end, offset in clip space
  const clip = vec4(positionGeometry.y.lessThan(0.5).select(clipStart, clipEnd)).toVar('clip');
  offset.assign(offset.mul(clip.w));
  return clip.add(vec4(offset, 0, 0));
})();

// Fragment coverage: 1 in the quad body; round endcaps beyond uv.y ∈ [-1, 1]
// with an fwidth-AA'd circular edge (always on: no sample-count gate).
const districtLineCoverage = /*@__PURE__*/ Fn(() => {
  const vUv = uv();
  const alpha = float(1).toVar('alpha');
  If(vUv.y.abs().greaterThan(1.0), () => {
    const a = vUv.x;
    const b = vUv.y.greaterThan(0.0).select(vUv.y.sub(1.0), vUv.y.add(1.0));
    const len2 = a.mul(a).add(b.mul(b));
    const dlen = float(len2.fwidth()).toVar('dlen');
    alpha.assign(smoothstep(dlen.oneMinus(), dlen.add(1), len2).oneMinus());
    alpha.lessThanEqual(0.0).discard();
  });
  return alpha;
})();

export class DistrictLineMaterial extends THREE.NodeMaterial {
  static get type() { return 'DistrictLineMaterial'; }

  constructor(parameters = {}) {
    super();

    this.isDistrictLineMaterial = true;

    // Properties the TSL accessors read (materialColor / materialOpacity /
    // materialLineWidth); must exist before setValues copies parameters in.
    this.color = new THREE.Color(0xffffff);
    this.linewidth = 1;

    this.lights = false;

    // Per-ring self-overlap dedup (see header). stencilRef is a plain
    // constructor parameter; pull it out before setValues (it's not a
    // standard Material property).
    const stencilRef = parameters.stencilRef;
    delete parameters.stencilRef;
    if (stencilRef !== undefined) {
      this.stencilWrite     = true;
      this.stencilRef       = stencilRef;
      this.stencilFunc      = THREE.NotEqualStencilFunc;
      this.stencilZPass     = THREE.ReplaceStencilOp;
      this.stencilFail      = THREE.KeepStencilOp;
      this.stencilZFail     = THREE.KeepStencilOp;
      this.stencilFuncMask  = 0xff;
      this.stencilWriteMask = 0xff;
    }

    // Wired once here, NOT in setup(): assigning node properties during
    // setup() dirties the material every build and forces a full pipeline
    // recompile per frame (~1 s/frame when first tried). The nodes are
    // module-level singletons shared by all instances.
    this.vertexNode  = districtLineClipPosition;
    this.colorNode   = materialColor;
    this.opacityNode = materialOpacity.mul(districtLineCoverage);

    this.setValues(parameters);
  }
}
