import { describe, expect, it } from "vitest";
import { applyVariables, evaluateExpression, makeVariable, variableValues } from "../src/model/variables";
import { createDocument } from "../src/model/defaults";

describe("evaluateExpression", () => {
  it("follows arithmetic precedence and parentheses", () => {
    expect(evaluateExpression("2 + 3 * 4", {})).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4", {})).toBe(20);
    expect(evaluateExpression("100 / 4 - 5", {})).toBe(20);
    expect(evaluateExpression("-2 * (3 + 1)", {})).toBe(-8);
    expect(evaluateExpression("  10 / 0 ", {})).toBe(0);
  });

  it("resolves names in the values table", () => {
    expect(evaluateExpression("L / 2", { L: 100 })).toBe(50);
    expect(evaluateExpression("L * W + 1", { L: 10, W: 4 })).toBe(41);
    expect(evaluateExpression("Missing + 2", {})).toBe(2);
  });
});

describe("variables in a document", () => {
  it("evaluates chained variables in declaration order", () => {
    const doc = createDocument();
    doc.variables = [makeVariable("L", "100"), makeVariable("W", "L / 2")];
    applyVariables(doc);
    expect(doc.variables.map((v) => v.value)).toEqual([100, 50]);

    doc.variables[0].expression = "160";
    applyVariables(doc);
    expect(doc.variables.map((v) => v.value)).toEqual([160, 80]);
  });

  it("re-evaluates stale stored values when asked for the table", () => {
    const doc = createDocument();
    doc.variables = [makeVariable("L", "120"), makeVariable("W", "L / 2")];
    doc.variables.forEach((v) => (v.value = 0));
    expect(variableValues(doc)).toEqual({ L: 120, W: 60 });
    expect(doc.variables.map((v) => v.value)).toEqual([120, 60]);
  });
});
