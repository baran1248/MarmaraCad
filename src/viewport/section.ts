/* CPU section cut.
 *
 * The WebGPU backend cannot do shader-side clipping planes, so the cut is done
 * on the triangles. Every triangle is clipped against the section plane with
 * Sutherland–Hodgman, the resulting cut segments are stitched into loops, and
 * each loop is fanned into a cap so the section reads as a solid face. */
import type { EdgeInfo, FaceInfo, MeshData, Vec3 } from "../model/types";

export type SectionAxis = "x" | "y" | "z";

export interface SectionCut {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
}

function axisValue(p: Vec3, axis: SectionAxis): number {
  return axis === "x" ? p[0] : axis === "y" ? p[1] : p[2];
}

function axisNormal(axis: SectionAxis, flipped: boolean): Vec3 {
  const n: Vec3 = axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
  return flipped ? [-n[0], -n[1], -n[2]] : n;
}

function clipTriangle(a: Vec3, b: Vec3, c: Vec3, axis: SectionAxis, offset: number, keepSign: number): { poly: Vec3[]; cut: [Vec3, Vec3] | null } {
  const pts = [a, b, c];
  const dist = pts.map((p) => keepSign * (axisValue(p, axis) - offset));
  const out: Vec3[] = [];
  const cutHits: Vec3[] = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const di = dist[i];
    const dj = dist[j];
    if (di <= 0) out.push(pts[i]);
    if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
      const t = di / (di - dj);
      const p: Vec3 = [pts[i][0] + (pts[j][0] - pts[i][0]) * t, pts[i][1] + (pts[j][1] - pts[i][1]) * t, pts[i][2] + (pts[j][2] - pts[i][2]) * t];
      out.push(p);
      cutHits.push(p);
    }
  }
  return { poly: out, cut: cutHits.length >= 2 ? [cutHits[0], cutHits[1]] : null };
}

/** Connect unordered cut segments into closed loops (tolerance in mm). */
function buildLoops(segments: [Vec3, Vec3][], tolerance = 0.15): Vec3[][] {
  const keyOf = (p: Vec3) => `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)},${Math.round(p[2] / tolerance)}`;
  const remaining = [...segments];
  const loops: Vec3[][] = [];
  while (remaining.length > 0) {
    const first = remaining.shift()!;
    const loop = [first[0], first[1]];
    let guard = 0;
    while (remaining.length > 0 && guard++ < 4000) {
      const endKey = keyOf(loop[loop.length - 1]);
      let found = -1;
      let flip = false;
      for (let i = 0; i < remaining.length; i++) {
        if (keyOf(remaining[i][0]) === endKey) {
          found = i;
          break;
        }
        if (keyOf(remaining[i][1]) === endKey) {
          found = i;
          flip = true;
          break;
        }
      }
      if (found < 0) break;
      const seg = remaining.splice(found, 1)[0];
      loop.push(flip ? seg[0] : seg[1]);
    }
    if (loop.length >= 4) {
      const a = loop[0];
      const b = loop[loop.length - 1];
      if (keyOf(a) !== keyOf(b)) loop.push(a);
      loops.push(loop);
    }
  }
  return loops;
}

export function sectionMesh(mesh: MeshData, cut: SectionCut): MeshData {
  if (!cut.enabled) return mesh;
  const keepSign = cut.flipped ? 1 : -1;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cutSegments: [Vec3, Vec3][] = [];
  const triCount = Math.floor(mesh.positions.length / 9);

  const pushTri = (a: Vec3, b: Vec3, c: Vec3, normal?: Vec3) => {
    const n = normal ?? triNormal(a, b, c);
    const base = positions.length / 3;
    positions.push(...a, ...b, ...c);
    normals.push(...n, ...n, ...n);
    indices.push(base, base + 1, base + 2);
  };

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const a: Vec3 = [mesh.positions[o], mesh.positions[o + 1], mesh.positions[o + 2]];
    const b: Vec3 = [mesh.positions[o + 3], mesh.positions[o + 4], mesh.positions[o + 5]];
    const c: Vec3 = [mesh.positions[o + 6], mesh.positions[o + 7], mesh.positions[o + 8]];
    const r = clipTriangle(a, b, c, cut.axis, cut.offset, keepSign);
    if (r.poly.length < 3) continue;
    for (let i = 1; i < r.poly.length - 1; i++) pushTri(r.poly[0], r.poly[i], r.poly[i + 1]);
    if (r.cut) cutSegments.push(r.cut);
  }

  // Cap the cut with fan triangulation per loop.
  const capNormal = axisNormal(cut.axis, !cut.flipped);
  for (const loop of buildLoops(cutSegments)) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of loop) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const center: Vec3 = [cx / loop.length, cy / loop.length, cz / loop.length];
    for (let i = 0; i < loop.length - 1; i++) {
      const a = loop[i];
      const b = loop[i + 1];
      const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Vec3 = [center[0] - a[0], center[1] - a[1], center[2] - a[2]];
      const n: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const dot = n[0] * capNormal[0] + n[1] * capNormal[1] + n[2] * capNormal[2];
      if (dot >= 0) pushTri(a, b, center, capNormal);
      else pushTri(b, a, center, capNormal);
    }
  }

  // Clip the feature edges so wireframe/shaded-edges stay consistent.
  const edges: EdgeInfo[] = [];
  for (const edge of mesh.edges) {
    let current: Vec3[] = [];
    const flush = () => {
      if (current.length >= 2) {
        let length = 0;
        for (let i = 1; i < current.length; i++) length += Math.hypot(current[i][0] - current[i - 1][0], current[i][1] - current[i - 1][1], current[i][2] - current[i - 1][2]);
        edges.push({ index: edge.index, points: current, length, closed: false });
      }
      current = [];
    };
    for (let i = 0; i < edge.points.length - 1; i++) {
      const a = edge.points[i];
      const b = edge.points[i + 1];
      const da = keepSign * (axisValue(a, cut.axis) - cut.offset);
      const db = keepSign * (axisValue(b, cut.axis) - cut.offset);
      if (da <= 0 && db <= 0) {
        if (current.length === 0) current.push(a);
        current.push(b);
      } else if (da <= 0 && db > 0) {
        if (current.length === 0) current.push(a);
        const t = da / (da - db);
        current.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        flush();
      } else if (da > 0 && db <= 0) {
        const t = da / (da - db);
        current.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        current.push(b);
      } else {
        flush();
      }
    }
    flush();
  }

  const pos = new Float32Array(positions);
  const norm = new Float32Array(normals);
  const idx = new Uint32Array(indices);
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    min = [Math.min(min[0], pos[i]), Math.min(min[1], pos[i + 1]), Math.min(min[2], pos[i + 2])];
    max = [Math.max(max[0], pos[i]), Math.max(max[1], pos[i + 1]), Math.max(max[2], pos[i + 2])];
  }
  if (!Number.isFinite(min[0])) {
    min = mesh.bbox.min;
    max = mesh.bbox.max;
  }
  const faces: FaceInfo[] = idx.length
    ? [{ index: 0, surface: "plane", point: [0, 0, 0], normal: capNormal, triStart: 0, triCount: idx.length / 3 }]
    : [];
  return {
    positions: pos,
    normals: norm,
    indices: idx,
    triFaceIds: new Uint32Array(idx.length / 3),
    faces,
    edges,
    volume: mesh.volume,
    area: mesh.area,
    bbox: { min, max },
    shapeType: mesh.shapeType,
    warnings: mesh.warnings,
  };
}

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
