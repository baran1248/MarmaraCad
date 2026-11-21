/* Sketch definition state, the way SolidWorks reports it.
 *
 * The solver is a least-squares fit, not a symbolic solver, so the degrees of
 * freedom are estimated from the number of free variables and independent
 * constraint equations. That is accurate for the constraint set this sketcher
 * supports (horizontal/vertical/coincident/distance/radius/equal/tangent/fix/
 * perpendicular/angle) and it gives the student the same three states they see
 * in SolidWorks: under defined, fully defined, over defined. */
import type { Sketch } from "../model/types";

export type SketchDefinition = "empty" | "under" | "full" | "over";

export interface SketchStatus {
  state: SketchDefinition;
  dof: number;
  freePoints: number;
  equations: number;
  label: string;
  detail: string;
}

/** Number of scalar equations a constraint removes. */
export function constraintEquations(type: string): number {
  switch (type) {
    case "horizontal":
    case "vertical":
    case "distance":
    case "radius":
    case "angle":
      return 1;
    case "coincident":
    case "perpendicular":
      return 2;
    case "tangent":
      return 1;
    case "equal":
      return 1;
    case "fix":
      return 2;
    default:
      return 1;
  }
}

export function sketchStatus(sketch: Sketch, solved: boolean, conflict: boolean): SketchStatus {
  if (sketch.points.length === 0) {
    return { state: "empty", dof: 0, freePoints: 0, equations: 0, label: "Empty sketch", detail: "Draw geometry to begin." };
  }
  let variables = 0;
  let freePoints = 0;
  for (const p of sketch.points) {
    if (p.fixed) continue;
    freePoints++;
    variables += 2;
  }
  variables += sketch.entities.filter((e) => e.kind === "circle" || e.kind === "arc").length;
  let equations = 0;
  for (const c of sketch.constraints) equations += constraintEquations(c.type);
  // Arc endpoints are tied to the centre/radius by the solver; count those as
  // implicit equations so an arc does not read as three free points.
  equations += sketch.entities.filter((e) => e.kind === "arc").length * 2;

  const dof = Math.max(0, variables - equations);
  if (conflict || !solved) {
    return {
      state: "over",
      dof,
      freePoints,
      equations,
      label: "Over defined",
      detail: conflict ? "Conflicting or redundant relations — remove the yellow/red one." : "The solver could not satisfy every relation.",
    };
  }
  if (dof === 0) {
    return { state: "full", dof: 0, freePoints, equations, label: "Fully defined", detail: "All geometry is located by dimensions and relations." };
  }
  const plural = dof === 1 ? "degree" : "degrees";
  return {
    state: "under",
    dof,
    freePoints,
    equations,
    label: "Under defined",
    detail: `${dof} ${plural} of freedom — add dimensions or relations (blue geometry).`,
  };
}

export const SKETCH_COLORS = {
  under: 0x1565c0,
  full: 0x1b2430,
  over: 0xd08a12,
  overSevere: 0xd0342c,
  construction: 0x8a97a3,
} as const;
