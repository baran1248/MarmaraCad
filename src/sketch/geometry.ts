import type { ArcEntity, CircleEntity, Sketch, SketchPlane, Vec2, Vec3 } from "../model/types";

export interface LoopSegmentLine {
  kind: "line";
  a: Vec2;
  b: Vec2;
}
export interface LoopSegmentPolyline {
  kind: "polyline";
  points: Vec2[];
}
export interface LoopSegmentCircle {
  kind: "circle";
  center: Vec2;
  radius: number;
}
export type LoopSegment = LoopSegmentLine | LoopSegmentPolyline | LoopSegmentCircle;

export interface ProfileLoop {
  id: string;
  points: Vec2[];
  segments: LoopSegment[];
  entityIds: string[];
  area: number;
  circleOnly: boolean;
}

export interface ProfileGroup {
  outer: ProfileLoop;
  holes: ProfileLoop[];
}

export interface LoopExtraction {
  loops: ProfileLoop[];
  openChains: Vec2[][];
  warnings: string[];
}

export function planePoint(plane: SketchPlane, p: Vec2): Vec3 {
  return [
    plane.origin[0] + plane.u[0] * p.x + plane.v[0] * p.y,
    plane.origin[1] + plane.u[1] * p.x + plane.v[1] * p.y,
    plane.origin[2] + plane.u[2] * p.x + plane.v[2] * p.y,
  ];
}

export function worldToPlane(plane: SketchPlane, p: Vec3): Vec2 {
  const dx = p[0] - plane.origin[0];
  const dy = p[1] - plane.origin[1];
  const dz = p[2] - plane.origin[2];
  return {
    x: dx * plane.u[0] + dy * plane.u[1] + dz * plane.u[2],
    y: dx * plane.v[0] + dy * plane.v[1] + dz * plane.v[2],
  };
}

export function pointMap(sketch: Sketch): Map<string, { x: number; y: number; fixed?: boolean }> {
  return new Map(sketch.points.map((p) => [p.id, p]));
}

export function circleCenter(sketch: Sketch, e: CircleEntity): Vec2 {
  const p = sketch.points.find((q) => q.id === e.center);
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

export function arcCenter(sketch: Sketch, e: ArcEntity): Vec2 {
  const p = sketch.points.find((q) => q.id === e.center);
  return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
}

export function entityRadius(sketch: Sketch, e: CircleEntity | ArcEntity): number {
  if (e.kind === "circle") return e.radius;
  const c = arcCenter(sketch, e);
  const s = sketch.points.find((q) => q.id === e.start);
  return s ? Math.hypot(s.x - c.x, s.y - c.y) : e.radius;
}

export function sampleArc(center: Vec2, start: Vec2, end: Vec2, ccw: boolean): Vec2[] {
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (r < 1e-9) return [start, end];
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  let delta = a1 - a0;
  if (ccw) {
    while (delta <= 1e-9) delta += Math.PI * 2;
  } else {
    while (delta >= -1e-9) delta -= Math.PI * 2;
  }
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (delta * i) / steps;
    out.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
  }
  return out;
}

/** Catmull-Rom interpolation through control points, the sketch Spline tool.
 *  The curve is sampled densely enough that extrusions, sweeps and drawings see
 *  a smooth contour while the editable control points stay in the sketch. */
export function sampleSpline(control: Vec2[], segments = 16): Vec2[] {
  if (control.length < 2) return control.map((p) => ({ ...p }));
  if (control.length === 2) {
    const out: Vec2[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      out.push({ x: control[0].x + (control[1].x - control[0].x) * t, y: control[0].y + (control[1].y - control[0].y) * t });
    }
    return out;
  }
  const out: Vec2[] = [];
  const at = (i: number) => control[Math.max(0, Math.min(control.length - 1, i))];
  for (let i = 0; i < control.length - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...control[control.length - 1] });
  return out;
}

export function sampleCircle(center: Vec2, radius: number): Vec2[] {
  const steps = 72;
  const out: Vec2[] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  return out;
}

function signedArea(points: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function reverseLoop(loop: ProfileLoop): ProfileLoop {
  const points = [...loop.points].reverse();
  const segments: LoopSegment[] = [...loop.segments].reverse().map((seg) => {
    if (seg.kind === "line") return { kind: "line", a: seg.b, b: seg.a };
    if (seg.kind === "polyline") return { kind: "polyline", points: [...seg.points].reverse() };
    return seg;
  });
  return { ...loop, points, segments, area: -loop.area };
}

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

interface RawLoop {
  points: Vec2[];
  segments: LoopSegment[];
  entityIds: string[];
  circleOnly: boolean;
}

export function extractLoops(sketch: Sketch, tolerance = 1e-6): LoopExtraction {
  const points = pointMap(sketch);
  const warnings: string[] = [];
  const loops: ProfileLoop[] = [];
  const openChains: Vec2[][] = [];
  const used = new Set<string>();

  // Standalone circles
  for (const e of sketch.entities) {
    if (e.kind !== "circle") continue;
    const c = points.get(e.center);
    if (!c) continue;
    const pts = sampleCircle({ x: c.x, y: c.y }, Math.max(1e-4, e.radius));
    loops.push({
      id: e.id,
      points: pts,
      segments: [{ kind: "circle", center: { x: c.x, y: c.y }, radius: Math.max(1e-4, e.radius) }],
      entityIds: [e.id],
      area: Math.PI * e.radius * e.radius,
      circleOnly: true,
    });
    used.add(e.id);
  }

  const adj = new Map<string, string[]>();
  const endpoints = (e: Sketch["entities"][number]): [string, string] | null => {
    if (e.kind === "line") return [e.p1, e.p2];
    if (e.kind === "arc") return [e.start, e.end];
    if (e.kind === "spline") return e.points.length >= 2 ? [e.points[0], e.points[e.points.length - 1]] : null;
    return null;
  };
  for (const e of sketch.entities) {
    if (e.kind === "circle") continue;
    const ends = endpoints(e);
    if (!ends) continue;
    for (const id of ends) {
      if (!adj.has(id)) adj.set(id, []);
      adj.get(id)!.push(e.id);
    }
  }

  for (const e of sketch.entities) {
    if (e.kind === "circle" || used.has(e.id)) continue;
    const ends = endpoints(e);
    if (!ends) continue;
    const startId = ends[0];
    let curId = ends[1];
    const entityIds: string[] = [e.id];
    const ordered: Array<{ entityId: string; forward: boolean }> = [];
    const firstEntity = sketch.entities.find((x) => x.id === e.id)!;
    ordered.push({ entityId: e.id, forward: true });
    used.add(e.id);
    let closed = startId === curId;
    let guard = 0;
    while (!closed && guard++ < sketch.entities.length + 2) {
      const cands = (adj.get(curId) ?? []).filter((id) => !used.has(id));
      if (cands.length === 0) break;
      const nextId = cands[0];
      const next = sketch.entities.find((x) => x.id === nextId);
      if (!next || next.kind === "circle") break;
      const nextEnds = endpoints(next);
      if (!nextEnds) break;
      const [nextStart, nextEnd] = nextEnds;
      const forward = nextStart === curId;
      used.add(nextId);
      entityIds.push(nextId);
      ordered.push({ entityId: nextId, forward });
      curId = forward ? nextEnd : nextStart;
      closed = curId === startId;
    }
    if (!closed) {
      const pts: Vec2[] = [];
      for (const { entityId, forward } of ordered) {
        const ent = sketch.entities.find((x) => x.id === entityId)!;
        if (ent.kind === "line") {
          const p = points.get(forward ? ent.p1 : ent.p2);
          if (p) pts.push({ x: p.x, y: p.y });
        } else if (ent.kind === "arc") {
          const c = points.get(ent.center);
          const s = points.get(forward ? ent.start : ent.end);
          const end = points.get(forward ? ent.end : ent.start);
          if (c && s && end) pts.push(...sampleArc({ x: c.x, y: c.y }, { x: s.x, y: s.y }, { x: end.x, y: end.y }, forward ? ent.ccw : !ent.ccw));
        } else if (ent.kind === "spline") {
          const ctrl = ent.points.map((id) => points.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
          const spline = sampleSpline(ctrl);
          if (!forward) spline.reverse();
          pts.push(...spline);
        }
      }
      openChains.push(pts);
      continue;
    }

    const segs: LoopSegment[] = [];
    const pts: Vec2[] = [];
    for (const { entityId, forward } of ordered) {
      const ent = sketch.entities.find((x) => x.id === entityId)!;
      if (ent.kind === "line") {
        const p1 = points.get(ent.p1);
        const p2 = points.get(ent.p2);
        if (!p1 || !p2) continue;
        const a = forward ? p1 : p2;
        const b = forward ? p2 : p1;
        const av = { x: a.x, y: a.y };
        const bv = { x: b.x, y: b.y };
        segs.push({ kind: "line", a: av, b: bv });
        if (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - av.x, pts[pts.length - 1].y - av.y) > tolerance) pts.push(av);
        pts.push(bv);
      } else if (ent.kind === "arc") {
        const c = points.get(ent.center);
        const s = points.get(forward ? ent.start : ent.end);
        const en = points.get(forward ? ent.end : ent.start);
        if (!c || !s || !en) continue;
        const segPts = sampleArc({ x: c.x, y: c.y }, { x: s.x, y: s.y }, { x: en.x, y: en.y }, forward ? ent.ccw : !ent.ccw);
        segs.push({ kind: "polyline", points: segPts });
        for (const sp of segPts) {
          if (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - sp.x, pts[pts.length - 1].y - sp.y) > tolerance) pts.push(sp);
        }
      } else if (ent.kind === "spline") {
        const ctrl = ent.points.map((id) => points.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
        let segPts = sampleSpline(ctrl);
        if (!forward) segPts = [...segPts].reverse();
        segs.push({ kind: "polyline", points: segPts });
        for (const sp of segPts) {
          if (pts.length === 0 || Math.hypot(pts[pts.length - 1].x - sp.x, pts[pts.length - 1].y - sp.y) > tolerance) pts.push(sp);
        }
      }
    }
    // Remove closing duplicate
    if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < tolerance) pts.pop();
    if (pts.length < 3) {
      warnings.push("Sketch contains a degenerate contour.");
      continue;
    }
    if (Math.abs(signedArea(pts)) < 0.01) {
      warnings.push("Sketch contains a zero-area contour.");
      continue;
    }
    loops.push({
      id: entityIds.join("+"),
      points: pts,
      segments: segs,
      entityIds,
      area: signedArea(pts),
      circleOnly: false,
    });
    void firstEntity;
  }

  if (openChains.length) {
    warnings.push(`${openChains.length} open contour${openChains.length > 1 ? "s" : ""} detected. Close the profile to create a solid.`);
  }
  return { loops, openChains, warnings };
}

export function buildProfileGroups(sketch: Sketch): { groups: ProfileGroup[]; warnings: string[]; openChains: Vec2[][] } {
  const extraction = extractLoops(sketch);
  const loops = extraction.loops.map((l) => {
    const area = signedArea(l.points);
    let oriented = { ...l, area };
    if (area < 0) oriented = reverseLoop(oriented);
    return oriented;
  });
  loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
  const used = new Set<string>();
  const groups: ProfileGroup[] = [];
  for (const loop of loops) {
    if (used.has(loop.id)) continue;
    const probe = loop.points[0];
    let parent: ProfileLoop | null = null;
    for (const other of loops) {
      if (other.id === loop.id) continue;
      if (Math.abs(other.area) <= Math.abs(loop.area) + 1e-6) continue;
      if (pointInPolygon(probe, other.points)) {
        if (!parent || Math.abs(other.area) < Math.abs(parent.area)) parent = other;
      }
    }
    if (parent) continue; // handled as a hole of its parent
    const holes: ProfileLoop[] = [];
    for (const other of loops) {
      if (other.id === loop.id || used.has(other.id)) continue;
      if (Math.abs(other.area) >= Math.abs(loop.area) - 1e-6) continue;
      if (pointInPolygon(other.points[0], loop.points)) {
        holes.push(reverseLoop(other));
        used.add(other.id);
      }
    }
    used.add(loop.id);
    groups.push({ outer: loop, holes });
  }
  return { groups, warnings: extraction.warnings, openChains: extraction.openChains };
}

export function profileSummary(sketch: Sketch): { closed: boolean; area: number; remainingArea: number; warnings: string[] } {
  const { groups, warnings } = buildProfileGroups(sketch);
  const closed = groups.length > 0;
  const area = groups.reduce((sum, g) => sum + Math.abs(g.outer.area), 0);
  const remainingArea = groups.reduce(
    (sum, g) => sum + Math.abs(g.outer.area) - g.holes.reduce((h, x) => h + Math.abs(x.area), 0),
    0,
  );
  return { closed, area, remainingArea, warnings };
}

export function dimensionLabel(sketch: Sketch, constraintId: string): { x: number; y: number; text: string; kind: string } | null {
  const c = sketch.constraints.find((q) => q.id === constraintId);
  if (!c) return null;
  const pm = pointMap(sketch);
  if (c.type === "distance") {
    if (c.entity) {
      const e = sketch.entities.find((q) => q.id === c.entity);
      if (e?.kind === "line") {
        const a = pm.get(e.p1);
        const b = pm.get(e.p2);
        if (!a || !b) return null;
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${(c.value ?? 0).toFixed(1)}`, kind: "length" };
      }
    }
    if (c.a && c.b) {
      const a = pm.get(c.a);
      const b = pm.get(c.b);
      if (!a || !b) return null;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, text: `${(c.value ?? Math.hypot(b.x - a.x, b.y - a.y)).toFixed(1)}`, kind: "distance" };
    }
  }
  if (c.type === "radius" && c.entity) {
    const e = sketch.entities.find((q) => q.id === c.entity);
    if (!e || e.kind === "line" || e.kind === "spline") return null;
    const ctr = pm.get(e.center);
    if (!ctr) return null;
    const r = entityRadius(sketch, e);
    return { x: ctr.x, y: ctr.y + r, text: `R${(c.value ?? r).toFixed(1)}`, kind: "radius" };
  }
  return null;
}
