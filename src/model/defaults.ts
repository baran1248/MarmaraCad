import type { Part, ProjectDocument, Sketch, SketchPlane, Vec3 } from "./types";

export const APP_NAME = "MarmaraCad";
export const APP_VERSION = "1.0.0";
export const PROJECT_FORMAT = "marmaracad";
export const UNIT = "mm";

export const PART_COLORS = [
  "#8fa3b8",
  "#c0a878",
  "#8fb49b",
  "#a99bbd",
  "#b9908a",
  "#7fa5b5",
  "#b7b27d",
];

export function basePlane(kind: "front" | "top" | "right"): SketchPlane {
  switch (kind) {
    case "front":
      return {
        kind: "front",
        name: "Front Plane",
        origin: [0, 0, 0],
        u: [1, 0, 0],
        v: [0, 1, 0],
        n: [0, 0, 1],
      };
    case "top":
      return {
        kind: "top",
        name: "Top Plane",
        origin: [0, 0, 0],
        u: [1, 0, 0],
        v: [0, 0, -1],
        n: [0, 1, 0],
      };
    case "right":
      return {
        kind: "right",
        name: "Right Plane",
        origin: [0, 0, 0],
        u: [0, 0, -1],
        v: [0, 1, 0],
        n: [1, 0, 0],
      };
  }
}

export function planeFromFace(
  point: Vec3,
  normal: Vec3,
  label = "Face Plane",
  faceIndex?: number,
  componentId?: string,
): SketchPlane {
  const n = normalize(normal);
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, n));
  const v = normalize(cross(n, u));
  return {
    kind: "face",
    name: label,
    origin: [point[0], point[1], point[2]],
    u,
    v,
    n,
    faceIndex,
    componentId,
  };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

let counter = 0;
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 100000;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 7)
      : Math.random().toString(36).slice(2, 9);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function createPart(name = "Part1", colorIndex = 0): Part {
  return {
    id: uid("part"),
    name,
    color: PART_COLORS[colorIndex % PART_COLORS.length],
    visible: true,
    sketches: [],
    features: [],
    materialId: undefined,
  };
}

export function createDocument(): ProjectDocument {
  const part = createPart("Part1");
  const now = Date.now();
  return {
    name: "Untitled",
    units: "mm",
    parts: [part],
    components: [],
    mates: [],
    analyses: [],
    activePartId: part.id,
    activeComponentId: null,
    activeStudyId: null,
    mode: "part",
    createdAt: now,
    updatedAt: now,
  };
}

export function nextSketchName(sketches: Sketch[]): string {
  let i = 1;
  while (sketches.some((s) => s.name === `Sketch${i}`)) i++;
  return `Sketch${i}`;
}

export function nextFeatureName(type: string, features: { type: string; name: string }[]): string {
  const base: Record<string, string> = {
    extrude: "Boss-Extrude",
    cut: "Cut-Extrude",
    revolve: "Revolve",
    fillet: "Fillet",
    chamfer: "Chamfer",
    shell: "Shell",
    mirror: "Mirror",
    pattern: "LPattern",
    sweep: "Sweep",
    loft: "Loft",
    circularPattern: "CPattern",
    hole: "Hole",
    draft: "Draft",
    rib: "Rib",
    helix: "Helix",
    imported: "Imported Body",
  };
  const prefix = base[type] ?? type;
  let i = 1;
  while (features.some((f) => f.name === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export function touch(doc: ProjectDocument): void {
  doc.updatedAt = Date.now();
}
