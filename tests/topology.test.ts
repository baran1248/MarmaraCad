import { describe, expect, it } from "vitest";
import { summarizeTopology } from "../src/ai/topology";
import type { EdgeInfo, FaceInfo, MeshData, Vec3 } from "../src/model/types";

/** Build a cylindrical face's triangles with inward-facing normals (a hole). */
function cylinderHole(faceIndex: number, cx: number, cy: number, radius: number, z0: number, z1: number, segments = 32) {
  const positions: number[] = [];
  const indices: number[] = [];
  const triFaceIds: number[] = [];
  const push = (a: Vec3, b: Vec3, c: Vec3) => {
    const base = positions.length / 3;
    positions.push(...a, ...b, ...c);
    indices.push(base, base + 1, base + 2);
    triFaceIds.push(faceIndex);
  };
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p = (angle: number, z: number): Vec3 => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle), z];
    push(p(a0, z0), p(a0, z1), p(a1, z1));
    push(p(a0, z0), p(a1, z1), p(a1, z0));
  }
  return { positions, indices, triFaceIds };
}

function line(points: Vec3[]): EdgeInfo {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return { index: 0, points, length, closed: false };
}

function circle(cx: number, cy: number, cz: number, radius: number, segments = 32): EdgeInfo {
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), cz]);
  }
  return { index: 0, points, length: 2 * Math.PI * radius, closed: false };
}

function plateWithHole(): MeshData {
  const bbox = { min: [0, 0, 0] as Vec3, max: [120, 80, 10] as Vec3 };
  const hole = cylinderHole(1, 30, 30, 5, 0, 10);
  const faces: FaceInfo[] = [
    { index: 0, surface: "plane", point: [60, 40, 10], normal: [0, 0, 1], triStart: 0, triCount: 0 },
    { index: 1, surface: "cylinder", point: [30, 30, 5], normal: [-1, 0, 0], axis: [0, 0, 1], radius: 5, triStart: 0, triCount: 64 },
  ];
  const edges: EdgeInfo[] = [
    line([[0, 0, 0], [0, 0, 10]]),
    line([[120, 0, 0], [120, 0, 10]]),
    line([[120, 80, 0], [120, 80, 10]]),
    line([[0, 80, 0], [0, 80, 10]]),
    line([[0, 0, 10], [120, 0, 10]]),
    line([[120, 0, 10], [120, 80, 10]]),
    line([[120, 80, 10], [0, 80, 10]]),
    line([[0, 80, 10], [0, 0, 10]]),
    circle(30, 30, 10, 5),
  ].map((edge, index) => ({ ...edge, index }));
  return {
    positions: new Float32Array(hole.positions),
    normals: new Float32Array(hole.positions.length),
    indices: new Uint32Array(hole.indices),
    triFaceIds: new Uint32Array(hole.triFaceIds),
    faces,
    edges,
    volume: 95_000,
    area: 30_000,
    bbox,
    shapeType: "solid",
    warnings: [],
  };
}

describe("topology summary", () => {
  it("finds the hole axis, the hole face and the four outer corner edges", () => {
    const summary = summarizeTopology(plateWithHole());
    expect(summary.holeAxes).toEqual(["z"]);
    expect(summary.faces[1]).toMatchObject({ type: "cylindrical", isHole: true, radius: 5 });
    const corners = summary.edges.filter((edge) => edge.isOuterCorner).map((edge) => edge.index);
    expect(corners).toEqual([0, 1, 2, 3]);
    // The top perimeter lies on the outer bbox but is not a corner edge.
    for (const index of [4, 5, 6, 7]) {
      expect(summary.edges[index]).toMatchObject({ kind: "line", isOuterBoundary: true, isOuterCorner: false });
      expect(summary.edges[index].planes).toContain("z-max");
    }
    expect(summary.edges[8]).toMatchObject({ kind: "circle", onHole: true, radius: 5 });
    expect(summary.edges[8].axis).toBe("z");
    expect(summary.truncated).toBe(false);
  });

  it("classifies open arcs and free-form curves", () => {
    const mesh = plateWithHole();
    const arc: Vec3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * (Math.PI / 2);
      arc.push([5 * Math.cos(a), 5 * Math.sin(a), 0]);
    }
    const curved: Vec3[] = [
      [0, 0, 0],
      [2, 3, 0],
      [5, 1, 0],
      [9, 6, 0],
    ];
    mesh.edges.push({ ...line(arc), index: 9 }, { ...line(curved), index: 10 });
    const summary = summarizeTopology(mesh);
    expect(summary.edges[9].kind).toBe("arc");
    expect(summary.edges[9].radius).toBeCloseTo(5, 2);
    expect(summary.edges[10].kind).toBe("curved");
    expect(summary.edges[10].axis).toBe("curved");
  });

  it("sanitises the selected face and edge indices", () => {
    const summary = summarizeTopology(plateWithHole(), undefined, { faces: [1, 1, 99, -2], edges: [3, 3, 100] });
    expect(summary.selection).toEqual({ faces: [1], edges: [3] });
  });
});
