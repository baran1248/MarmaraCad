/* Object snap (OSnap) engine for the 2D sketcher.
 *
 * Candidates are ranked the way SolidWorks/Fusion rank them: endpoints beat
 * intersections, intersections beat midpoints, and so on. The caller supplies a
 * pixel tolerance converted to sketch units, so snapping feels the same at any
 * zoom level. */
import type { Sketch, Vec2 } from "../model/types";

export type SnapType =
  | "endpoint"
  | "intersection"
  | "midpoint"
  | "center"
  | "origin"
  | "quadrant"
  | "perpendicular"
  | "tangent"
  | "grid";

export interface SnapCandidate {
  x: number;
  y: number;
  type: SnapType;
  label: string;
  pointId?: string;
  entityId?: string;
}

export interface SnapSettings {
  endpoint: boolean;
  midpoint: boolean;
  center: boolean;
  origin: boolean;
  quadrant: boolean;
  intersection: boolean;
  perpendicular: boolean;
  tangent: boolean;
  grid: boolean;
}

export const DEFAULT_SNAPS: SnapSettings = {
  endpoint: true,
  midpoint: true,
  center: true,
  origin: true,
  quadrant: true,
  intersection: true,
  perpendicular: true,
  tangent: true,
  grid: true,
};

const SYMBOL: Record<SnapType, string> = {
  endpoint: "□",
  intersection: "✕",
  midpoint: "△",
  center: "◎",
  origin: "⊕",
  quadrant: "◇",
  perpendicular: "⊥",
  tangent: "◠",
  grid: "·",
};

const PRIORITY: Record<SnapType, number> = {
  endpoint: 0,
  intersection: 1,
  midpoint: 2,
  center: 3,
  origin: 4,
  quadrant: 5,
  perpendicular: 6,
  tangent: 7,
  grid: 9,
};

export function snapSymbol(type: SnapType): string {
  return SYMBOL[type];
}

export function snapLabel(type: SnapType): string {
  const labels: Record<SnapType, string> = {
    endpoint: "Endpoint",
    intersection: "Intersection",
    midpoint: "Midpoint",
    center: "Center",
    origin: "Origin",
    quadrant: "Quadrant",
    perpendicular: "Perpendicular",
    tangent: "Tangent",
    grid: "Grid",
  };
  return labels[type];
}

interface Pt {
  x: number;
  y: number;
}

function lineEnds(sketch: Sketch, id: string): [Pt, Pt] | null {
  const e = sketch.entities.find((q) => q.id === id);
  if (!e || e.kind !== "line") return null;
  const a = sketch.points.find((p) => p.id === e.p1);
  const b = sketch.points.find((p) => p.id === e.p2);
  return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
}

function circleOf(sketch: Sketch, id: string): { c: Pt; r: number; arc?: boolean; start?: Pt; end?: Pt; ccw?: boolean } | null {
  const e = sketch.entities.find((q) => q.id === id);
  if (!e || e.kind === "line" || e.kind === "spline") return null;
  const c = sketch.points.find((p) => p.id === e.center);
  if (!c) return null;
  if (e.kind === "circle") return { c: { x: c.x, y: c.y }, r: e.radius };
  if (e.kind === "arc") {
    const s = sketch.points.find((p) => p.id === e.start);
    const en = sketch.points.find((p) => p.id === e.end);
    if (!s || !en) return null;
    return {
      c: { x: c.x, y: c.y },
      r: Math.hypot(s.x - c.x, s.y - c.y),
      arc: true,
      start: { x: s.x, y: s.y },
      end: { x: en.x, y: en.y },
      ccw: e.ccw,
    };
  }
  return null;
}

export function lineLineIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

export function lineCircleIntersections(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  if (A < 1e-12) return [];
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out: Pt[] = [];
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t >= -1e-6 && t <= 1 + 1e-6) out.push({ x: a.x + t * dx, y: a.y + t * dy });
  }
  return out;
}

function arcContains(c: NonNullable<ReturnType<typeof circleOf>>, p: Pt): boolean {
  if (!c.arc || !c.start || !c.end) return true;
  const a0 = Math.atan2(c.start.y - c.c.y, c.start.x - c.c.x);
  const a1 = Math.atan2(c.end.y - c.c.y, c.end.x - c.c.x);
  const ap = Math.atan2(p.y - c.c.y, p.x - c.c.x);
  let delta = a1 - a0;
  if (c.ccw) {
    while (delta <= 0) delta += Math.PI * 2;
    let dp = ap - a0;
    while (dp < 0) dp += Math.PI * 2;
    return dp <= delta + 1e-9;
  }
  while (delta >= 0) delta -= Math.PI * 2;
  let dp = ap - a0;
  while (dp > 0) dp -= Math.PI * 2;
  return dp >= delta - 1e-9;
}

/** All snap candidates near `cursor` (sketch units). */
export function snapCandidates(
  sketch: Sketch,
  cursor: Vec2,
  tolerance: number,
  settings: SnapSettings,
  options: { currentPoint?: Vec2; excludePoint?: string } = {},
): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  const near = (p: Pt) => Math.hypot(p.x - cursor.x, p.y - cursor.y) <= tolerance;
  const push = (c: SnapCandidate) => {
    if (!out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < tolerance * 0.35 && o.type === c.type)) out.push(c);
  };

  if (settings.origin && near({ x: 0, y: 0 })) {
    push({ x: 0, y: 0, type: "origin", label: snapLabel("origin") });
  }

  if (settings.endpoint) {
    for (const p of sketch.points) {
      if (p.id === options.excludePoint) continue;
      if (near(p)) push({ x: p.x, y: p.y, type: "endpoint", label: snapLabel("endpoint"), pointId: p.id });
    }
  }

  if (settings.center || settings.quadrant) {
    for (const e of sketch.entities) {
      if (e.kind === "line" || e.kind === "spline") continue;
      const c = sketch.points.find((p) => p.id === e.center);
      if (!c) continue;
      const r = e.kind === "circle" ? e.radius : Math.hypot((sketch.points.find((p) => p.id === e.start)?.x ?? 0) - c.x, (sketch.points.find((p) => p.id === e.start)?.y ?? 0) - c.y);
      if (settings.center && near(c)) push({ x: c.x, y: c.y, type: "center", label: snapLabel("center"), pointId: c.id, entityId: e.id });
      if (settings.quadrant) {
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const p = { x: c.x + dx * r, y: c.y + dy * r };
          if (near(p)) push({ x: p.x, y: p.y, type: "quadrant", label: snapLabel("quadrant"), entityId: e.id });
        }
      }
    }
  }

  if (settings.midpoint) {
    for (const e of sketch.entities) {
      if (e.kind === "line") {
        const ends = lineEnds(sketch, e.id);
        if (!ends) continue;
        const m = { x: (ends[0].x + ends[1].x) / 2, y: (ends[0].y + ends[1].y) / 2 };
        if (near(m)) push({ x: m.x, y: m.y, type: "midpoint", label: snapLabel("midpoint"), entityId: e.id });
      } else {
        const c = circleOf(sketch, e.id);
        if (!c) continue;
        const samples = 32;
        for (let i = 0; i < samples; i++) {
          const a0 = c.start ? Math.atan2(c.start.y - c.c.y, c.start.x - c.c.x) : 0;
          const a1 = c.end ? Math.atan2(c.end.y - c.c.y, c.end.x - c.c.x) : Math.PI * 2;
          const t = i / (samples - 1);
          const a = c.arc ? a0 + (a1 - a0) * t : t * Math.PI * 2;
          const p = { x: c.c.x + Math.cos(a) * c.r, y: c.c.y + Math.sin(a) * c.r };
          if (near(p) && Math.abs(t - 0.5) < 0.06) push({ x: p.x, y: p.y, type: "midpoint", label: snapLabel("midpoint"), entityId: e.id });
        }
      }
    }
  }

  if (settings.intersection) {
    const ids = sketch.entities.map((e) => e.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ea = sketch.entities.find((e) => e.id === ids[i]);
        const eb = sketch.entities.find((e) => e.id === ids[j]);
        if (!ea || !eb) continue;
        if (ea.kind === "line" && eb.kind === "line") {
          const A = lineEnds(sketch, ea.id);
          const B = lineEnds(sketch, eb.id);
          if (!A || !B) continue;
          const p = lineLineIntersection(A[0], A[1], B[0], B[1]);
          if (p && near(p)) push({ x: p.x, y: p.y, type: "intersection", label: snapLabel("intersection"), entityId: ea.id });
        } else if (ea.kind === "line" && eb.kind !== "line") {
          const A = lineEnds(sketch, ea.id);
          const c = circleOf(sketch, eb.id);
          if (!A || !c) continue;
          for (const p of lineCircleIntersections(A[0], A[1], c.c, c.r)) {
            if (near(p) && arcContains(c, p)) push({ x: p.x, y: p.y, type: "intersection", label: snapLabel("intersection"), entityId: ea.id });
          }
        } else if (eb.kind === "line" && ea.kind !== "line") {
          const B = lineEnds(sketch, eb.id);
          const c = circleOf(sketch, ea.id);
          if (!B || !c) continue;
          for (const p of lineCircleIntersections(B[0], B[1], c.c, c.r)) {
            if (near(p) && arcContains(c, p)) push({ x: p.x, y: p.y, type: "intersection", label: snapLabel("intersection"), entityId: eb.id });
          }
        }
      }
    }
  }

  // Perpendicular / tangent from the last placed point: the foot of the
  // perpendicular on each line and the tangent point on each circle.
  const from = options.currentPoint;
  if (from && (settings.perpendicular || settings.tangent)) {
    for (const e of sketch.entities) {
      if (e.kind === "line") {
        const ends = lineEnds(sketch, e.id);
        if (!ends) continue;
        const dx = ends[1].x - ends[0].x;
        const dy = ends[1].y - ends[0].y;
        const l2 = dx * dx + dy * dy;
        if (l2 < 1e-12 || !settings.perpendicular) continue;
        const t = ((from.x - ends[0].x) * dx + (from.y - ends[0].y) * dy) / l2;
        if (t < -1e-6 || t > 1 + 1e-6) continue;
        const p = { x: ends[0].x + t * dx, y: ends[0].y + t * dy };
        if (near(p)) push({ x: p.x, y: p.y, type: "perpendicular", label: snapLabel("perpendicular"), entityId: e.id });
      } else if (settings.tangent) {
        const c = circleOf(sketch, e.id);
        if (!c) continue;
        const d = Math.hypot(from.x - c.c.x, from.y - c.c.y);
        if (d <= c.r + 1e-6) continue;
        const base = Math.atan2(from.y - c.c.y, from.x - c.c.x);
        const off = Math.acos(c.r / d);
        for (const a of [base + off, base - off]) {
          const p = { x: c.c.x + Math.cos(a) * c.r, y: c.c.y + Math.sin(a) * c.r };
          if (near(p) && arcContains(c, p)) push({ x: p.x, y: p.y, type: "tangent", label: snapLabel("tangent"), entityId: e.id });
        }
      }
    }
  }

  return out;
}

/** Best candidate under the cursor, or a grid-snapped fallback. */
export function bestSnap(
  sketch: Sketch,
  cursor: Vec2,
  tolerance: number,
  settings: SnapSettings,
  gridStep: number,
  options: { currentPoint?: Vec2; excludePoint?: string } = {},
): SnapCandidate {
  const candidates = snapCandidates(sketch, cursor, tolerance, settings, options).filter(
    (c) => c.type !== "grid" || settings.grid,
  );
  candidates.sort((a, b) => {
    const da = Math.hypot(a.x - cursor.x, a.y - cursor.y);
    const db = Math.hypot(b.x - cursor.x, b.y - cursor.y);
    if (Math.abs(da - db) > tolerance * 0.28) return da - db;
    return PRIORITY[a.type] - PRIORITY[b.type];
  });
  if (candidates.length > 0) return candidates[0];
  return {
    x: Math.round(cursor.x / gridStep) * gridStep,
    y: Math.round(cursor.y / gridStep) * gridStep,
    type: "grid",
    label: snapLabel("grid"),
  };
}

/** Alignment guides: sketch points that share the cursor's x or y within tol. */
export function alignmentGuides(
  sketch: Sketch,
  cursor: Vec2,
  tolerance: number,
  excludePoint?: string,
): { axis: "h" | "v"; at: number; from: Vec2 }[] {
  const out: { axis: "h" | "v"; at: number; from: Vec2 }[] = [];
  for (const p of sketch.points) {
    if (p.id === excludePoint) continue;
    const dp = { x: p.x, y: p.y };
    if (Math.abs(cursor.y - p.y) <= tolerance && out.length < 2 && Math.abs(cursor.x - p.x) > tolerance * 1.5) {
      if (!out.some((g) => g.axis === "h" && Math.abs(g.at - p.y) < 1e-6)) out.push({ axis: "h", at: p.y, from: dp });
    }
    if (Math.abs(cursor.x - p.x) <= tolerance && out.length < 2 && Math.abs(cursor.y - p.y) > tolerance * 1.5) {
      if (!out.some((g) => g.axis === "v" && Math.abs(g.at - p.x) < 1e-6)) out.push({ axis: "v", at: p.x, from: dp });
    }
  }
  return out;
}
