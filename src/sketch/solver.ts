import type { ArcEntity, CircleEntity, Sketch, SketchConstraint, SketchPoint } from "../model/types";

export interface SolveOptions {
  maxIterations?: number;
  pin?: { pointId: string; x: number; y: number }[];
  tolerance?: number;
}

export interface SolveResult {
  sketch: Sketch;
  converged: boolean;
  residual: number;
  iterations: number;
  conflict: string[];
}

interface VarRef {
  key: string;
  kind: "x" | "y" | "r";
  refId: string;
}

function cloneSketch(s: Sketch): Sketch {
  return {
    ...s,
    points: s.points.map((p) => ({ ...p })),
    entities: s.entities.map((e) => ({ ...e })),
    constraints: s.constraints.map((c) => ({ ...c })),
  };
}

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row) => row.slice());
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-14) return null;
    if (pivot !== col) {
      [M[pivot], M[col]] = [M[col], M[pivot]];
      [x[pivot], x[col]] = [x[col], x[pivot]];
    }
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
      x[r] -= f * x[col];
    }
  }
  const out = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = x[r];
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * out[c];
    out[r] = sum / M[r][r];
  }
  return out;
}

function arcRadius(sketch: Sketch, e: ArcEntity): number {
  const c = sketch.points.find((p) => p.id === e.center);
  const s = sketch.points.find((p) => p.id === e.start);
  if (!c || !s) return e.radius;
  return Math.hypot(s.x - c.x, s.y - c.y);
}

export function solveSketch(input: Sketch, options: SolveOptions = {}): SolveResult {
  const sketch = cloneSketch(input);
  const maxIterations = options.maxIterations ?? 60;
  const tol = options.tolerance ?? 1e-7;
  const pins = new Map((options.pin ?? []).map((p) => [p.pointId, p]));
  const pointById = new Map(sketch.points.map((p) => [p.id, p]));
  const entityById = new Map(sketch.entities.map((e) => [e.id, e]));

  const vars: VarRef[] = [];
  const varIndex = new Map<string, number>();
  const addVar = (v: VarRef) => {
    varIndex.set(v.key, vars.length);
    vars.push(v);
  };

  for (const p of sketch.points) {
    if (p.fixed || pins.has(p.id)) continue;
    addVar({ key: `p:${p.id}:x`, kind: "x", refId: p.id });
    addVar({ key: `p:${p.id}:y`, kind: "y", refId: p.id });
  }
  for (const e of sketch.entities) {
    if (e.kind === "circle" || e.kind === "arc") {
      addVar({ key: `r:${e.id}`, kind: "r", refId: e.id });
    }
  }
  if (vars.length === 0) {
    return { sketch, converged: true, residual: 0, iterations: 0, conflict: [] };
  }

  const x0 = new Float64Array(vars.length);
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    if (v.kind === "x") x0[i] = pointById.get(v.refId)?.x ?? 0;
    else if (v.kind === "y") x0[i] = pointById.get(v.refId)?.y ?? 0;
    else {
      const e = entityById.get(v.refId);
      x0[i] = e && e.kind !== "line" ? (e.kind === "circle" ? e.radius : arcRadius(sketch, e)) : 1;
    }
  }

  const get = (x: Float64Array, id: string, axis: "x" | "y"): number => {
    const pin = pins.get(id);
    if (pin) return axis === "x" ? pin.x : pin.y;
    const p = pointById.get(id);
    if (p?.fixed) return axis === "x" ? p.x : p.y;
    const idx = varIndex.get(`p:${id}:${axis}`);
    return idx === undefined ? (axis === "x" ? p?.x ?? 0 : p?.y ?? 0) : x[idx];
  };
  const getR = (x: Float64Array, id: string): number => {
    const idx = varIndex.get(`r:${id}`);
    if (idx !== undefined) return x[idx];
    const e = entityById.get(id);
    return e && e.kind !== "line" ? (e.kind === "circle" ? e.radius : arcRadius(sketch, e)) : 1;
  };

  const residuals: Array<(x: Float64Array) => number> = [];
  const add = (fn: (x: Float64Array) => number, weight = 1) => residuals.push((x) => fn(x) * weight);

  const endpointsOfLine = (id: string): [string, string] | null => {
    const e = entityById.get(id);
    if (!e || e.kind !== "line") return null;
    return [e.p1, e.p2];
  };

  for (const c of sketch.constraints) {
    if (c.type === "horizontal" || c.type === "vertical") {
      const ids = c.entity ? endpointsOfLine(c.entity) : c.a && c.b ? [c.a, c.b] : null;
      if (!ids) continue;
      add((x) => (c.type === "horizontal" ? get(x, ids[1], "y") - get(x, ids[0], "y") : get(x, ids[1], "x") - get(x, ids[0], "x")), 1.5);
    } else if (c.type === "coincident") {
      if (!c.a || !c.b) continue;
      add((x) => get(x, c.b!, "x") - get(x, c.a!, "x"), 2);
      add((x) => get(x, c.b!, "y") - get(x, c.a!, "y"), 2);
    } else if (c.type === "distance") {
      const value = c.value ?? 0;
      if (c.entity) {
        const ids = endpointsOfLine(c.entity);
        if (!ids) continue;
        add((x) => Math.hypot(get(x, ids[1], "x") - get(x, ids[0], "x"), get(x, ids[1], "y") - get(x, ids[0], "y")) - value, 3);
      } else if (c.a && c.b) {
        add((x) => Math.hypot(get(x, c.b!, "x") - get(x, c.a!, "x"), get(x, c.b!, "y") - get(x, c.a!, "y")) - value, 3);
      }
    } else if (c.type === "radius") {
      if (!c.entity) continue;
      add((x) => getR(x, c.entity!) - (c.value ?? 0), 3);
    } else if (c.type === "equal") {
      if (!c.a || !c.b) continue;
      const ea = entityById.get(c.a);
      const eb = entityById.get(c.b);
      if (ea?.kind === "line" && eb?.kind === "line") {
        const la = endpointsOfLine(ea.id)!;
        const lb = endpointsOfLine(eb.id)!;
        add(
          (x) =>
            Math.hypot(get(x, la[1], "x") - get(x, la[0], "x"), get(x, la[1], "y") - get(x, la[0], "y")) -
            Math.hypot(get(x, lb[1], "x") - get(x, lb[0], "x"), get(x, lb[1], "y") - get(x, lb[0], "y")),
          2,
        );
      } else {
        add((x) => getR(x, c.a!) - getR(x, c.b!), 2);
      }
    } else if (c.type === "perpendicular") {
      const la = c.a ? endpointsOfLine(c.a) : null;
      const lb = c.b ? endpointsOfLine(c.b) : null;
      if (!la || !lb) continue;
      add((x) => {
        const ax = get(x, la[1], "x") - get(x, la[0], "x");
        const ay = get(x, la[1], "y") - get(x, la[0], "y");
        const bx = get(x, lb[1], "x") - get(x, lb[0], "x");
        const by = get(x, lb[1], "y") - get(x, lb[0], "y");
        const na = Math.hypot(ax, ay) || 1;
        const nb = Math.hypot(bx, by) || 1;
        return (ax * bx + ay * by) / (na * nb);
      }, 2);
    } else if (c.type === "angle") {
      const ids = c.entity ? endpointsOfLine(c.entity) : null;
      if (!ids) continue;
      const target = ((c.value ?? 0) * Math.PI) / 180;
      add((x) => {
        const ang = Math.atan2(get(x, ids[1], "y") - get(x, ids[0], "y"), get(x, ids[1], "x") - get(x, ids[0], "x"));
        let diff = ang - target;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        return diff;
      }, 1.5);
    } else if (c.type === "tangent") {
      const lineIds = c.a ? endpointsOfLine(c.a) : null;
      if (!lineIds || !c.entity) continue;
      add((x) => {
        const ax = get(x, lineIds[0], "x");
        const ay = get(x, lineIds[0], "y");
        const bx = get(x, lineIds[1], "x");
        const by = get(x, lineIds[1], "y");
        const e = entityById.get(c.entity!);
        const centerId = e && e.kind !== "line" ? e.center : "";
        const cx = get(x, centerId, "x");
        const cy = get(x, centerId, "y");
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1e-9;
        const dist = Math.abs(dx * (cy - ay) - dy * (cx - ax)) / len;
        return dist - getR(x, c.entity!);
      }, 2);
    } else if (c.type === "fix") {
      if (!c.a) continue;
      const p = pointById.get(c.a);
      if (!p || p.fixed) continue;
      add((x) => get(x, c.a!, "x") - p.x, 4);
      add((x) => get(x, c.a!, "y") - p.y, 4);
    }
  }

  for (const e of sketch.entities) {
    if (e.kind !== "arc") continue;
    add((x) => Math.hypot(get(x, e.start, "x") - get(x, e.center, "x"), get(x, e.start, "y") - get(x, e.center, "y")) - getR(x, e.id), 2.5);
    add((x) => Math.hypot(get(x, e.end, "x") - get(x, e.center, "x"), get(x, e.end, "y") - get(x, e.center, "y")) - getR(x, e.id), 2.5);
  }

  // Gentle regularization keeps under-constrained geometry near where the user drew it.
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    const target = x0[i];
    add((x) => (x[i] - target) * 0.004 * (v.kind === "r" ? 2 : 1));
  }

  const evaluate = (x: Float64Array): Float64Array => {
    const out = new Float64Array(residuals.length);
    for (let i = 0; i < residuals.length; i++) out[i] = residuals[i](x);
    return out;
  };
  const costOf = (r: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < r.length; i++) s += r[i] * r[i];
    return s;
  };

  let x = x0.slice();
  let r = evaluate(x);
  let cost = costOf(r);
  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;

  // Tolerances scale with the model so a 200 mm profile is not judged by the same
  // absolute error as a 2 mm one.
  let lengthScale = 1;
  for (const p of sketch.points) lengthScale = Math.max(lengthScale, Math.abs(p.x), Math.abs(p.y));
  const satisfied = (c: number) => c <= 1e-12 * lengthScale * lengthScale;

  if (satisfied(cost)) {
    // Already consistent (e.g. a freshly drawn rectangle): nothing to iterate.
    x = x0.slice();
    converged = true;
  }

  for (let iter = 0; iter < maxIterations && !converged; iter++) {
    iterations = iter + 1;
    const m = r.length;
    const n = x.length;
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-5 * (1 + Math.abs(x[j]));
      const old = x[j];
      x[j] = old + h;
      const rp = evaluate(x);
      x[j] = old - h;
      const rm = evaluate(x);
      x[j] = old;
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * h);
    }
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      const ri = r[i];
      for (let a = 0; a < n; a++) {
        const ja = J[i][a];
        if (ja === 0) continue;
        b[a] -= ja * ri;
        for (let c = a; c < n; c++) A[a][c] += ja * J[i][c];
      }
    }
    for (let a = 0; a < n; a++) for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    for (let a = 0; a < n; a++) A[a][a] += lambda * (1 + Math.abs(A[a][a]));

    const dx = solveLinear(A, b);
    if (!dx) {
      lambda *= 8;
      if (lambda > 1e12 || satisfied(cost)) break;
      continue;
    }
    const tryX = x.slice();
    for (let i = 0; i < n; i++) tryX[i] += dx[i];
    const tryR = evaluate(tryX);
    const tryCost = costOf(tryR);
    if (tryCost < cost) {
      x = tryX;
      r = tryR;
      const improvement = cost - tryCost;
      cost = tryCost;
      lambda = Math.max(1e-10, lambda * 0.4);
      let maxStep = 0;
      for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(dx[i]));
      if (maxStep < tol || satisfied(cost)) {
        converged = true;
        break;
      }
      if (improvement < 1e-14) {
        converged = true;
        break;
      }
    } else {
      // A rejected step at an already-consistent state is convergence, not failure.
      if (satisfied(cost)) {
        converged = true;
        break;
      }
      lambda *= 6;
      if (lambda > 1e12) break;
    }
  }

  for (let i = 0; i < vars.length; i++) {
    const v = vars[i];
    if (v.kind === "x") {
      const p = pointById.get(v.refId);
      if (p) p.x = x[i];
    } else if (v.kind === "y") {
      const p = pointById.get(v.refId);
      if (p) p.y = x[i];
    } else {
      const e = entityById.get(v.refId);
      const val = Math.max(0.01, Math.abs(x[i]));
      if (e?.kind === "circle") e.radius = val;
      else if (e?.kind === "arc") {
        e.radius = val;
        const c = pointById.get(e.center);
        const s = pointById.get(e.start);
        const en = pointById.get(e.end);
        if (c && s) {
          const ang = Math.atan2(s.y - c.y, s.x - c.x);
          s.x = c.x + Math.cos(ang) * val;
          s.y = c.y + Math.sin(ang) * val;
        }
        if (c && en) {
          const ang = Math.atan2(en.y - c.y, en.x - c.x);
          en.x = c.x + Math.cos(ang) * val;
          en.y = c.y + Math.sin(ang) * val;
        }
      }
    }
  }

  const conflict: string[] = [];
  for (const c of sketch.constraints) {
    if (c.type === "distance" || c.type === "radius") {
      if ((c.value ?? 0) <= 0) conflict.push("Dimensions must be greater than zero.");
    }
  }
  if (cost > 1e-6 * lengthScale * lengthScale) conflict.push("The sketch constraints are over-defined or inconsistent.");

  return { sketch, converged, residual: Math.sqrt(cost), iterations, conflict };
}

export function addConstraint(sketch: Sketch, constraint: Omit<SketchConstraint, "id">, id: string): void {
  sketch.constraints.push({ ...constraint, id });
}

export function dimensionValue(sketch: Sketch, pointA?: string, pointB?: string, entityId?: string): number {
  const pm = new Map(sketch.points.map((p) => [p.id, p]));
  if (entityId) {
    const e = sketch.entities.find((q) => q.id === entityId);
    if (e?.kind === "line") {
      const a = pm.get(e.p1);
      const b = pm.get(e.p2);
      if (a && b) return Math.hypot(b.x - a.x, b.y - a.y);
    }
    if (e?.kind === "circle") return e.radius;
    if (e?.kind === "arc") return arcRadius(sketch, e);
  }
  if (pointA && pointB) {
    const a = pm.get(pointA);
    const b = pm.get(pointB);
    if (a && b) return Math.hypot(b.x - a.x, b.y - a.y);
  }
  return 0;
}

export function applyPin(sketch: Sketch, pointId: string, x: number, y: number): Sketch {
  const copy = cloneSketch(sketch);
  const p = copy.points.find((q) => q.id === pointId);
  if (p) {
    p.x = x;
    p.y = y;
  }
  return copy;
}

export function removePoint(sketch: Sketch, pointId: string): void {
  sketch.points = sketch.points.filter((p) => p.id !== pointId);
  sketch.entities = sketch.entities.filter((e) => {
    if (e.kind === "line") return e.p1 !== pointId && e.p2 !== pointId;
    if (e.kind === "circle") return e.center !== pointId;
    return e.center !== pointId && e.start !== pointId && e.end !== pointId;
  });
}

export type SketchPointRef = SketchPoint;
export type CircleEntityRef = CircleEntity;
