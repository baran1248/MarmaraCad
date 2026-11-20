import { describe, expect, it } from "vitest";
import type { Sketch } from "../src/model/types";
import { buildProfileGroups, profileSummary } from "../src/sketch/geometry";
import { solveSketch } from "../src/sketch/solver";

function rectangleSketch(): Sketch {
  const p = (id: string, x: number, y: number) => ({ id, x, y });
  return {
    id: "s1",
    name: "Sketch1",
    plane: {
      kind: "front",
      name: "Front Plane",
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      n: [0, 0, 1],
    },
    points: [p("a", 0, 0), p("b", 40, 0), p("c", 40, 20), p("d", 0, 20)],
    entities: [
      { id: "l1", kind: "line", p1: "a", p2: "b" },
      { id: "l2", kind: "line", p1: "b", p2: "c" },
      { id: "l3", kind: "line", p1: "c", p2: "d" },
      { id: "l4", kind: "line", p1: "d", p2: "a" },
    ],
    constraints: [
      { id: "h1", type: "horizontal", entity: "l1" },
      { id: "h2", type: "horizontal", entity: "l3" },
      { id: "v1", type: "vertical", entity: "l2" },
      { id: "v2", type: "vertical", entity: "l4" },
      { id: "d1", type: "distance", entity: "l1", value: 60 },
      { id: "d2", type: "distance", entity: "l2", value: 30 },
    ],
    visible: true,
  };
}

describe("sketch solver", () => {
  it("solves rectangle dimensions", () => {
    const r = solveSketch(rectangleSketch());
    expect(r.converged).toBe(true);
    const pts = new Map(r.sketch.points.map((p) => [p.id, p]));
    expect(Math.abs(pts.get("b")!.x - pts.get("a")!.x)).toBeCloseTo(60, 4);
    expect(Math.abs(pts.get("c")!.y - pts.get("b")!.y)).toBeCloseTo(30, 4);
  });

  it("keeps fixed points fixed", () => {
    const s = rectangleSketch();
    s.points[0].fixed = true;
    const r = solveSketch(s);
    expect(r.sketch.points[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("profile builder", () => {
  it("builds a closed rectangle with a hole", () => {
    const s = rectangleSketch();
    s.points.push({ id: "cc", x: 20, y: 10 });
    s.entities.push({ id: "hole", kind: "circle", center: "cc", radius: 5 });
    const solved = solveSketch(s).sketch;
    const g = buildProfileGroups(solved);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].holes).toHaveLength(1);
    const summary = profileSummary(solved);
    expect(summary.closed).toBe(true);
    expect(summary.remainingArea).toBeCloseTo(60 * 30 - Math.PI * 25, 0);
  });

  it("reports open contours", () => {
    const s = rectangleSketch();
    s.entities = s.entities.slice(0, 3);
    const summary = profileSummary(s);
    expect(summary.closed).toBe(false);
    expect(summary.warnings.length).toBeGreaterThan(0);
  });
});
