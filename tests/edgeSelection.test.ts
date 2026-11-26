import { describe, expect, it } from "vitest";
import { resolveEdgeSelection } from "../src/ai/edgeSelection";
import type { TopologyEdge, TopologySummary } from "../src/ai/topology";

function edge(index: number, overrides: Partial<TopologyEdge> = {}): TopologyEdge {
  return {
    index,
    kind: "line",
    length: 10,
    axis: "z",
    isOuterBoundary: true,
    isOuterCorner: false,
    onHole: false,
    planes: [],
    ...overrides,
  };
}

function summary(holeAxes: ("x" | "y" | "z")[] = ["z"]): TopologySummary {
  const edges: TopologyEdge[] = [
    ...[0, 1, 2, 3].map((i) => edge(i, { axis: "z", isOuterCorner: true, planes: ["x-min", "y-min"] })),
    edge(4, { axis: "x", length: 120, planes: ["y-max"] }),
    edge(5, { axis: "y", length: 80, planes: ["y-max"] }),
    edge(6, { axis: "x", length: 120, planes: ["y-max"] }),
    edge(7, { axis: "y", length: 80, planes: ["y-max"] }),
    ...[8, 9, 10, 11, 12, 13, 14, 15].map((i) =>
      edge(i, { kind: "circle", axis: "z", onHole: true, length: 31.416, planes: ["y-max"] }),
    ),
    edge(16, { kind: "curved", axis: "curved", isOuterBoundary: false, planes: [] }),
  ];
  return {
    part: { id: "p", name: "Plate", volume: 1, area: 1, bbox: { min: [0, 0, 0], max: [120, 80, 10] }, featureCount: 1 },
    selection: { faces: [], edges: [] },
    holeAxes,
    faces: [],
    edges,
    truncated: false,
  };
}

describe("edge selector", () => {
  it("supports all, selected and explicit indices", () => {
    expect(resolveEdgeSelection(summary(), "all").indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(resolveEdgeSelection(summary(), "selected", [3, 1, 1, 99, -1]).indices).toEqual([1, 3]);
    expect(resolveEdgeSelection(summary(), [0, 3, 7, 11, 11, 42]).indices).toEqual([0, 3, 7, 11]);
    expect(resolveEdgeSelection(summary(), undefined).indices.length).toBe(17);
  });

  it("resolves the four outer corners parallel to the holes", () => {
    const resolved = resolveEdgeSelection(summary(), { axis: "parallel-to-holes", outerOnly: true, straightOnly: true });
    expect(resolved.indices).toEqual([0, 1, 2, 3]);
    expect(resolved.reason).toContain("4/17");
  });

  it("resolves presets and combines predicates", () => {
    expect(resolveEdgeSelection(summary(), { preset: "outer-vertical" }).indices).toEqual([0, 1, 2, 3]);
    expect(resolveEdgeSelection(summary(), { preset: "outer-top" }).indices).toEqual([4, 5, 6, 7]);
    expect(resolveEdgeSelection(summary(), { preset: "holes" }).indices).toEqual([8, 9, 10, 11, 12, 13, 14, 15]);
    expect(resolveEdgeSelection(summary(), { preset: "outer-top", axis: "x" }).indices).toEqual([4, 6]);
    expect(resolveEdgeSelection(summary(), { minLength: 50 }).indices).toEqual([4, 5, 6, 7]);
    expect(resolveEdgeSelection(summary(), { maxLength: 20, straightOnly: true }).indices).toEqual([0, 1, 2, 3]);
  });

  it("fails cleanly when the body has no holes", () => {
    const resolved = resolveEdgeSelection(summary([]), { axis: "parallel-to-holes" });
    expect(resolved.indices).toEqual([]);
    expect(resolved.reason).toMatch(/no cylindrical holes/i);
  });
});
