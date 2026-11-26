/* Semantic edge selection for AI fillet / chamfer commands.
 *
 * A model can name geometry instead of guessing indices:
 *   { preset: "outer-vertical" }
 *   { axis: "parallel-to-holes", outerOnly: true, straightOnly: true }
 * The resolver evaluates the same `TopologySummary` the model saw, so the
 * indices it applies are exactly the edges the model reasoned about. */
import type { AxisName, TopologyEdge, TopologySummary } from "./topology";

export type EdgePreset = "outer-vertical" | "outer-top" | "outer-bottom" | "holes";
export type EdgeAxisQuery = AxisName | "parallel-to-holes";

export interface EdgeSelector {
  preset?: EdgePreset;
  axis?: EdgeAxisQuery;
  outerOnly?: boolean;
  straightOnly?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface ResolvedEdgeSelection {
  indices: number[];
  reason: string;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function isPreset(value: unknown): value is EdgePreset {
  return value === "outer-vertical" || value === "outer-top" || value === "outer-bottom" || value === "holes";
}

function isAxisQuery(value: unknown): value is EdgeAxisQuery {
  return value === "x" || value === "y" || value === "z" || value === "parallel-to-holes";
}

function matchesPreset(edge: TopologyEdge, preset: EdgePreset): boolean {
  switch (preset) {
    case "outer-vertical":
      return edge.isOuterCorner;
    // MarmaraCad is Y-up: the "top" bbox plane is y-max.
    case "outer-top":
      return edge.kind === "line" && edge.planes.includes("y-max");
    case "outer-bottom":
      return edge.kind === "line" && edge.planes.includes("y-min");
    case "holes":
      return edge.onHole;
  }
}

function matchesAxis(edge: TopologyEdge, query: EdgeAxisQuery, summary: TopologySummary): boolean {
  if (edge.kind !== "line") return false;
  if (query === "parallel-to-holes") {
    const holeAxis = summary.holeAxes[0];
    return !!holeAxis && edge.axis === holeAxis;
  }
  return edge.axis === query;
}

/**
 * Resolve the `edges` field of a fillet / chamfer command.
 * Accepts "all", "selected", an index array, or a geometric selector object.
 */
export function resolveEdgeSelection(
  summary: TopologySummary,
  spec: unknown,
  selectedEdges: number[] = [],
): ResolvedEdgeSelection {
  const edges = summary.edges;
  const valid = (index: number) => Number.isInteger(index) && index >= 0 && index < edges.length;

  if (spec === undefined || spec === null || spec === "all") {
    return { indices: edges.map((e) => e.index), reason: `all ${edges.length} edge(s)` };
  }

  if (spec === "selected") {
    const indices = uniqueSorted(selectedEdges.filter((i) => Number.isFinite(i)).map((i) => Math.round(i)).filter(valid));
    return { indices, reason: indices.length ? `selected ${indices.length} edge(s)` : "selected (empty selection)" };
  }

  if (Array.isArray(spec)) {
    const indices = uniqueSorted(
      spec.map((value) => Math.round(Number(value))).filter((index) => Number.isFinite(index) && valid(index)),
    );
    return { indices, reason: `${indices.length} explicit edge index(es)` };
  }

  if (typeof spec !== "object") {
    return { indices: [], reason: "unrecognised edge selector" };
  }

  const selector = spec as EdgeSelector;
  let candidates = edges.slice();
  const applied: string[] = [];

  if (selector.preset !== undefined) {
    if (!isPreset(selector.preset)) return { indices: [], reason: `unknown preset "${String(selector.preset)}"` };
    candidates = candidates.filter((edge) => matchesPreset(edge, selector.preset as EdgePreset));
    applied.push(`preset=${selector.preset}`);
  }

  if (selector.axis !== undefined) {
    if (!isAxisQuery(selector.axis)) return { indices: [], reason: `unknown axis "${String(selector.axis)}"` };
    if (selector.axis === "parallel-to-holes" && !summary.holeAxes.length) {
      return { indices: [], reason: "parallel-to-holes requested but the body has no cylindrical holes" };
    }
    candidates = candidates.filter((edge) => matchesAxis(edge, selector.axis as EdgeAxisQuery, summary));
    applied.push(`axis=${selector.axis}`);
  }

  if (selector.outerOnly === true) {
    candidates = candidates.filter((edge) => edge.isOuterBoundary);
    applied.push("outerOnly");
  }

  if (selector.straightOnly === true) {
    candidates = candidates.filter((edge) => edge.kind === "line");
    applied.push("straightOnly");
  }

  if (typeof selector.minLength === "number" && Number.isFinite(selector.minLength)) {
    candidates = candidates.filter((edge) => edge.length >= selector.minLength!);
    applied.push(`minLength=${selector.minLength}`);
  }

  if (typeof selector.maxLength === "number" && Number.isFinite(selector.maxLength)) {
    candidates = candidates.filter((edge) => edge.length <= selector.maxLength!);
    applied.push(`maxLength=${selector.maxLength}`);
  }

  const indices = uniqueSorted(candidates.map((edge) => edge.index));
  const detail = applied.length ? applied.join(", ") : "empty selector";
  return { indices, reason: `${indices.length}/${edges.length} edge(s) · ${detail}` };
}
