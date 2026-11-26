/* Compact, model-facing summary of a body's B-Rep topology.
 *
 * The same summary drives two consumers so they can never disagree:
 *  - the JSON context sent to Gemini, which lets the model "see" faces and
 *    edges without inventing indices, and
 *  - the geometric edge selector in `edgeSelection.ts`, which turns a semantic
 *    request such as "the four outer corners parallel to the holes" into the
 *    exact edge indices of the current build. */
import type { EdgeInfo, FaceInfo, MeshData, Part, Vec3 } from "../model/types";

export type AxisName = "x" | "y" | "z";
export type EdgeAxis = AxisName | "curved";
export type EdgeKind = "line" | "circle" | "arc" | "curved";
export type BboxPlane = "x-min" | "x-max" | "y-min" | "y-max" | "z-min" | "z-max";

export interface TopologyFace {
  index: number;
  type: "planar" | "cylindrical" | "other";
  /** Planar faces only. */
  normal?: Vec3;
  /** Cylindrical faces only. */
  axis?: Vec3;
  /** Face centroid (planar) or a point on the axis (cylindrical). */
  center: Vec3;
  radius?: number;
  /** True for a concave cylinder: the surface of a hole or bore. */
  isHole: boolean;
}

export interface TopologyEdge {
  index: number;
  kind: EdgeKind;
  start?: Vec3;
  end?: Vec3;
  /** Circle / arc centre. */
  center?: Vec3;
  radius?: number;
  length: number;
  axis: EdgeAxis;
  /** The whole edge lies on at least one bbox plane. */
  isOuterBoundary: boolean;
  /** A straight edge at a bbox corner, parallel to the hole (or thinnest) axis. */
  isOuterCorner: boolean;
  /** A circular edge on the rim of a hole. */
  onHole: boolean;
  /** Bbox planes the edge lies on, e.g. ["z-max"]. */
  planes: BboxPlane[];
}

export interface TopologySummary {
  part: {
    id: string;
    name: string;
    volume: number;
    area: number;
    bbox: { min: Vec3; max: Vec3 };
    featureCount: number;
  };
  selection: { faces: number[]; edges: number[] };
  /** World axes of the holes in the body, e.g. ["z"]. */
  holeAxes: AxisName[];
  faces: TopologyFace[];
  edges: TopologyEdge[];
  truncated: boolean;
}

const MAX_FACES = 120;
const MAX_EDGES = 160;

const round = (value: number): number => Math.round(value * 1000) / 1000;
const rvec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 0];
};
const distance = (a: Vec3, b: Vec3): number => norm(sub(a, b));

const AXES: AxisName[] = ["x", "y", "z"];
const axisIndex: Record<AxisName, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

function dominantAxis(v: Vec3, min = 0.98): EdgeAxis {
  const parts = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  let best = 0;
  for (let i = 1; i < 3; i++) if (parts[i] > parts[best]) best = i;
  return parts[best] >= min ? AXES[best] : "curved";
}

interface LineFit {
  start: Vec3;
  end: Vec3;
  dir: Vec3;
  deviation: number;
  chord: number;
}

function fitLine(points: Vec3[]): LineFit | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const chord = distance(start, end);
  if (chord < 1e-6) return null;
  const dir = unit(sub(end, start));
  let deviation = 0;
  for (const point of points) {
    const rel = sub(point, start);
    const along = dot(rel, dir);
    deviation = Math.max(deviation, norm(sub(rel, scale(dir, along))));
  }
  return { start, end, dir, deviation, chord };
}

interface CircleFit {
  center: Vec3;
  radius: number;
  normal: Vec3;
}

/** Circumcircle through three points, then verify every sample sits on it. */
function fitCircle(points: Vec3[], closed: boolean): CircleFit | null {
  if (points.length < 3) return null;
  const n = points.length;
  const picks: [number, number, number][] = closed
    ? [
        [0, Math.floor(n / 3), Math.floor((2 * n) / 3)],
        [0, Math.floor(n / 4), Math.floor(n / 2)],
      ]
    : [
        [0, Math.floor(n / 2), n - 1],
        [0, Math.floor(n / 3), Math.floor((2 * n) / 3)],
      ];
  for (const [i0, i1, i2] of picks) {
    const A = points[i0];
    const B = points[i1];
    const C = points[i2];
    if (!A || !B || !C) continue;
    const ab = sub(B, A);
    const ac = sub(C, A);
    const normal = cross(ab, ac);
    const nn = dot(normal, normal);
    if (nn < 1e-10) continue;
    const center = add(
      A,
      scale(add(scale(cross(normal, ab), dot(ac, ac)), scale(cross(ac, normal), dot(ab, ab))), 1 / (2 * nn)),
    );
    const radius = distance(A, center);
    if (!Number.isFinite(radius) || radius < 1e-6) continue;
    const unitNormal = unit(normal);
    let minR = Infinity;
    let maxR = -Infinity;
    let maxPlane = 0;
    for (const point of points) {
      const r = distance(point, center);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      maxPlane = Math.max(maxPlane, Math.abs(dot(sub(point, A), unitNormal)));
    }
    const radialTol = Math.max(0.02, radius * 0.01);
    const planeTol = Math.max(0.02, radius * 0.02);
    if (maxR - minR <= radialTol && maxPlane <= planeTol) return { center, radius, normal: unitNormal };
  }
  return null;
}

interface EdgeShape {
  kind: EdgeKind;
  start?: Vec3;
  end?: Vec3;
  center?: Vec3;
  radius?: number;
  axis: EdgeAxis;
}

function classifyEdge(edge: EdgeInfo): EdgeShape {
  const points = edge.points;
  if (points.length < 2) return { kind: "curved", axis: "curved" };
  const line = fitLine(points);
  if (line && line.deviation <= Math.max(0.01, line.chord * 1e-4)) {
    return { kind: "line", start: line.start, end: line.end, axis: dominantAxis(line.dir) };
  }
  // The kernel always stores `closed: false`; a full circle is recognised by
  // its first and last samples coinciding.
  const closed = edge.closed || distance(points[0], points[points.length - 1]) <= Math.max(1e-3, edge.length * 1e-3);
  const circle = fitCircle(points, closed);
  if (circle) {
    return {
      kind: closed ? "circle" : "arc",
      start: closed ? undefined : points[0],
      end: closed ? undefined : points[points.length - 1],
      center: circle.center,
      radius: circle.radius,
      axis: dominantAxis(circle.normal),
    };
  }
  return { kind: "curved", axis: "curved" };
}

/** Distance from a point to the infinite line `origin + t * dir`. */
function distanceToAxis(point: Vec3, origin: Vec3, dir: Vec3): number {
  const rel = sub(point, origin);
  return norm(sub(rel, scale(dir, dot(rel, dir))));
}

/**
 * A cylinder is a hole when its triangles face the axis (concave) instead of
 * away from it (convex boss). The kernel stores an axis point and direction,
 * so the test is exact even for partial cylinders.
 */
function cylinderIsHole(mesh: MeshData, face: FaceInfo): boolean {
  if (!face.axis) return false;
  const axis = unit(face.axis);
  if (norm(axis) < 0.5) return false;
  const origin = face.point;
  let inward = 0;
  let outward = 0;
  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    if (mesh.triFaceIds[t] !== face.index) continue;
    const ia = mesh.indices[t * 3] * 3;
    const ib = mesh.indices[t * 3 + 1] * 3;
    const ic = mesh.indices[t * 3 + 2] * 3;
    const A: Vec3 = [mesh.positions[ia], mesh.positions[ia + 1], mesh.positions[ia + 2]];
    const B: Vec3 = [mesh.positions[ib], mesh.positions[ib + 1], mesh.positions[ib + 2]];
    const C: Vec3 = [mesh.positions[ic], mesh.positions[ic + 1], mesh.positions[ic + 2]];
    const centroid = scale(add(add(A, B), C), 1 / 3);
    const rel = sub(centroid, origin);
    const radial = sub(rel, scale(axis, dot(rel, axis)));
    const normal = cross(sub(B, A), sub(C, A));
    const sign = dot(radial, normal);
    if (sign < 0) inward++;
    else if (sign > 0) outward++;
  }
  return inward > outward;
}

function bboxPlanes(points: Vec3[], bbox: { min: Vec3; max: Vec3 }): BboxPlane[] {
  if (!points.length) return [];
  const diag = distance(bbox.min, bbox.max);
  const tol = Math.max(0.01, diag * 1e-4);
  const planes: BboxPlane[] = [];
  for (let i = 0; i < 3; i++) {
    if (points.every((p) => Math.abs(p[i] - bbox.min[i]) <= tol)) planes.push(`${AXES[i]}-min` as BboxPlane);
    if (points.every((p) => Math.abs(p[i] - bbox.max[i]) <= tol)) planes.push(`${AXES[i]}-max` as BboxPlane);
  }
  return planes;
}

function minExtentAxis(bbox: { min: Vec3; max: Vec3 }): AxisName {
  const extents = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
  const min = Math.min(...extents);
  // Tie-break z, then y, then x: a cube's four upright edges are the corners.
  for (const name of ["z", "y", "x"] as AxisName[]) {
    if (Math.abs(extents[axisIndex[name]] - min) <= 1e-6) return name;
  }
  return "z";
}

function validIndices(list: number[] | undefined, count: number): number[] {
  if (!list?.length) return [];
  const out = new Set<number>();
  for (const value of list) {
    const index = Math.round(Number(value));
    if (Number.isFinite(index) && index >= 0 && index < count) out.add(index);
  }
  return [...out].sort((a, b) => a - b);
}

export interface TopologySelection {
  faces?: number[];
  edges?: number[];
}

/** Build the compact topology summary for one body. */
export function summarizeTopology(mesh: MeshData, part?: Part, selection?: TopologySelection): TopologySummary {
  const bbox = { min: rvec(mesh.bbox.min), max: rvec(mesh.bbox.max) };
  const holeFaces: FaceInfo[] = [];
  const faceList: TopologyFace[] = [];
  const faceLimit = Math.min(mesh.faces.length, MAX_FACES);

  for (const face of mesh.faces) {
    const isHole = face.surface === "cylinder" ? cylinderIsHole(mesh, face) : false;
    if (isHole) holeFaces.push(face);
    if (face.index >= faceLimit) continue;
    faceList.push({
      index: face.index,
      type: face.surface === "plane" ? "planar" : face.surface === "cylinder" ? "cylindrical" : "other",
      normal: face.surface === "plane" ? rvec(unit(face.normal)) : undefined,
      axis: face.surface === "cylinder" && face.axis ? rvec(unit(face.axis)) : undefined,
      center: rvec(face.point),
      radius: face.radius !== undefined ? round(face.radius) : undefined,
      isHole,
    });
  }

  const holeAxes: AxisName[] = [];
  for (const face of holeFaces) {
    if (!face.axis) continue;
    const axis = dominantAxis(unit(face.axis));
    if (axis !== "curved" && !holeAxes.includes(axis)) holeAxes.push(axis);
  }
  const verticalAxis: AxisName = holeAxes[0] ?? minExtentAxis(bbox);

  const edgeList: TopologyEdge[] = [];
  const edgeLimit = Math.min(mesh.edges.length, MAX_EDGES);
  for (const edge of mesh.edges) {
    if (edge.index >= edgeLimit) continue;
    const shape = classifyEdge(edge);
    const planes = bboxPlanes(edge.points, mesh.bbox);
    const isOuterBoundary = planes.length > 0;
    let isOuterCorner = false;
    if (shape.kind === "line" && shape.axis === verticalAxis && shape.start && shape.end) {
      const own = axisIndex[verticalAxis];
      const mid = scale(add(shape.start, shape.end), 0.5);
      const diag = distance(mesh.bbox.min, mesh.bbox.max);
      const tol = Math.max(0.01, diag * 1e-4);
      const atExtreme = (i: number) => Math.abs(mid[i] - mesh.bbox.min[i]) <= tol || Math.abs(mid[i] - mesh.bbox.max[i]) <= tol;
      isOuterCorner = [0, 1, 2].filter((i) => i !== own).every(atExtreme);
    }
    let onHole = false;
    if ((shape.kind === "circle" || shape.kind === "arc") && shape.center && shape.radius !== undefined) {
      for (const face of holeFaces) {
        if (!face.axis || face.radius === undefined) continue;
        const axis = unit(face.axis);
        const radial = distanceToAxis(shape.center, face.point, axis);
        const radiusTol = Math.max(0.05, face.radius * 0.02);
        const axisTol = Math.max(0.5, face.radius * 0.1);
        if (radial <= axisTol && Math.abs(shape.radius - face.radius) <= radiusTol) {
          onHole = true;
          break;
        }
      }
    }
    edgeList.push({
      index: edge.index,
      kind: shape.kind,
      start: shape.start ? rvec(shape.start) : undefined,
      end: shape.end ? rvec(shape.end) : undefined,
      center: shape.center ? rvec(shape.center) : undefined,
      radius: shape.radius !== undefined ? round(shape.radius) : undefined,
      length: round(edge.length),
      axis: shape.axis,
      isOuterBoundary,
      isOuterCorner,
      onHole,
      planes,
    });
  }

  return {
    part: {
      id: part?.id ?? "active",
      name: part?.name ?? "Active part",
      volume: round(mesh.volume),
      area: round(mesh.area),
      bbox,
      featureCount: part?.features.length ?? 0,
    },
    selection: {
      faces: validIndices(selection?.faces, mesh.faces.length),
      edges: validIndices(selection?.edges, mesh.edges.length),
    },
    holeAxes,
    faces: faceList,
    edges: edgeList,
    truncated: mesh.faces.length > MAX_FACES || mesh.edges.length > MAX_EDGES,
  };
}
