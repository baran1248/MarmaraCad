/* Global variables and equations (SolidWorks-style "Equations").
 *
 * Expressions are parsed by a tiny recursive-descent evaluator rather than
 * `eval`, so a saved project cannot execute code. Supported grammar:
 *   expr := term (("+" | "-") term)*
 *   term := factor (("*" | "/") factor)*
 *   factor := number | name | "(" expr ")" | "-" factor
 * Names resolve to other variables in declaration order. */
import type { ProjectDocument, Variable } from "./types";
import { uid } from "./defaults";
import { solveSketch } from "../sketch/solver";

export function evaluateExpression(expression: string, values: Record<string, number>): number {
  const src = expression.replace(/\s+/g, "");
  let i = 0;

  const peek = () => src[i];
  const eat = (c: string) => {
    if (src[i] === c) {
      i++;
      return true;
    }
    return false;
  };

  const parseFactor = (): number => {
    if (eat("+")) return parseFactor();
    if (eat("-")) return -parseFactor();
    if (eat("(")) {
      const v = parseExpr();
      eat(")");
      return v;
    }
    if (/[0-9.]/.test(peek() ?? "")) {
      let num = "";
      while (/[0-9.]/.test(peek() ?? "")) num += src[i++];
      return Number(num);
    }
    if (/[A-Za-z_]/.test(peek() ?? "")) {
      let name = "";
      while (/[A-Za-z0-9_]/.test(peek() ?? "")) name += src[i++];
      return values[name] ?? 0;
    }
    return 0;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      if (eat("*")) value *= parseFactor();
      else if (eat("/")) {
        const d = parseFactor();
        value = Math.abs(d) < 1e-12 ? 0 : value / d;
      } else return value;
    }
  };

  const parseExpr = (): number => {
    let value = parseTerm();
    for (;;) {
      if (eat("+")) value += parseTerm();
      else if (eat("-")) value -= parseTerm();
      else return value;
    }
  };

  const result = parseExpr();
  return Number.isFinite(result) ? result : 0;
}

/** Recompute values in declaration order and push expression values into the model. */
export function applyVariables(doc: ProjectDocument): void {
  const list = doc.variables ?? [];
  const values: Record<string, number> = {};
  for (const v of list) {
    v.value = evaluateExpression(v.expression, values);
    values[v.name] = v.value;
  }
  for (const part of doc.parts) {
    for (const sketch of part.sketches) {
      let driven = false;
      for (const c of sketch.constraints) {
        if (!c.expression) continue;
        const value = evaluateExpression(c.expression, values);
        if (value > 0) {
          c.value = value;
          driven = true;
        }
      }
      // Re-solve so the geometry follows the new driven dimension values.
      if (driven) {
        const result = solveSketch(sketch, { maxIterations: 80 });
        sketch.points = result.sketch.points;
        sketch.entities = result.sketch.entities;
        sketch.constraints = result.sketch.constraints;
      }
    }
    for (const feature of part.features) {
      if (feature.params.depthExpression) {
        const value = evaluateExpression(feature.params.depthExpression, values);
        if (value > 0) feature.params.depth = value;
      }
      if (feature.params.radiusExpression) {
        const value = evaluateExpression(feature.params.radiusExpression, values);
        if (value > 0) feature.params.radius = value;
      }
    }
  }
}

export function variableValues(doc: ProjectDocument): Record<string, number> {
  const values: Record<string, number> = {};
  for (const v of doc.variables ?? []) values[v.name] = v.value;
  return values;
}

export function makeVariable(name: string, expression: string): Variable {
  return { id: uid("var"), name, expression, value: 0 };
}

/** A short, deterministic set used by the demo templates. */
export function standardVariables(entries: [string, string][]): Variable[] {
  return entries.map(([name, expression]) => makeVariable(name, expression));
}
