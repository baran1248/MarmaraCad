import { describe, expect, it } from "vitest";
import {
  BEND_SEGMENTS,
  DEFAULT_K_FACTOR,
  bendAllowance,
  developedChain,
  developedFlangeLength,
  flatPattern,
  flatPatternDxf,
  nearestSide,
  sheetMetalRecipe,
  type FlatPattern,
} from "../src/model/sheetMetal";
import { createDocument } from "../src/model/defaults";
import type { Feature, SheetMetalFlange, Sketch } from "../src/model/types";

const flange = (overrides: Partial<SheetMetalFlange> = {}): SheetMetalFlange => ({
  id: "flange_1",
  featureId: "feat_1",
  edgeIndex: 0,
  angle: 90,
  length: 20,
  radius: 2,
  thickness: 2,
  kFactor: DEFAULT_K_FACTOR,
  ...overrides,
});

const rectangleSketch = (w: number, h: number): Sketch => ({
  id: "sk_1",
  name: "Sketch1",
  plane: {
    kind: "top",
    name: "Top",
    origin: [0, 0, 0],
    u: [1, 0, 0],
    v: [0, 0, 1],
    n: [0, 1, 0],
  },
  points: [
    { id: "p1", x: 0, y: 0 },
    { id: "p2", x: w, y: 0 },
    { id: "p3", x: w, y: h },
    { id: "p4", x: 0, y: h },
  ],
  entities: [],
  constraints: [],
  visible: true,
});

describe("bend allowance", () => {
  it("uses BA = pi/180 * theta * (R + K * t)", () => {
    const expected = (Math.PI / 180) * 90 * (2 + 0.44 * 2);
    expect(bendAllowance(90, 2, 2, 0.44)).toBeCloseTo(expected, 10);
    expect(bendAllowance(90, 2, 2)).toBeCloseTo(expected, 10);
    // 90 deg, R 2, t 2, K 0.44 -> 4.5239 mm
    expect(bendAllowance(90, 2, 2)).toBeCloseTo(4.523893, 5);
  });

  it("is linear in the angle and clamps K to [0, 0.5]", () => {
    expect(bendAllowance(180, 2, 2)).toBeCloseTo(2 * bendAllowance(90, 2, 2), 9);
    expect(bendAllowance(-90, 2, 2)).toBeCloseTo(bendAllowance(90, 2, 2), 9);
    expect(bendAllowance(90, 2, 2, 4)).toBeCloseTo(bendAllowance(90, 2, 2, 0.5), 9);
  });

  it("adds the allowance to the straight leg for developed length", () => {
    const f = flange();
    expect(developedFlangeLength(f)).toBeCloseTo(20 + bendAllowance(90, 2, 2), 9);
    expect(developedChain([10, 20], [{ angle: 90, radius: 2, thickness: 2 }])).toBeCloseTo(
      30 + bendAllowance(90, 2, 2),
      9,
    );
  });
});

describe("flat pattern", () => {
  const base = { min: { x: 0, y: 0 }, max: { x: 100, y: 60 } };

  it("unfolds a right flange by leg + bend allowance", () => {
    const f = flange({ id: "right" });
    const pattern = flatPattern(base, [{ flange: f, side: "right", from: 10, to: 50 }]);
    expect(pattern.regions).toHaveLength(2);
    expect(pattern.regions[1].role).toBe("flange");
    expect(pattern.regions[1].flangeId).toBe("right");
    const expected = 100 + 20 + bendAllowance(90, 2, 2);
    expect(pattern.bbox.max.x).toBeCloseTo(expected, 9);
    expect(pattern.bendLines).toHaveLength(1);
    expect(pattern.bendLines[0].a.x).toBeCloseTo(100, 9);
    expect(pattern.bendLines[0].a.y).toBeCloseTo(10, 9);
    expect(pattern.bendLines[0].b.y).toBeCloseTo(50, 9);
    expect(pattern.developed[0].length).toBeCloseTo(20 + bendAllowance(90, 2, 2), 9);
  });

  it("unfolds flanges on all four sides independently", () => {
    const pattern = flatPattern(base, [
      { flange: flange({ id: "r" }), side: "right", from: 0, to: 60 },
      { flange: flange({ id: "l", angle: 45 }), side: "left", from: 0, to: 60 },
      { flange: flange({ id: "t", angle: 135 }), side: "top", from: 0, to: 100 },
      { flange: flange({ id: "b" }), side: "bottom", from: 0, to: 100 },
    ]);
    expect(pattern.regions).toHaveLength(5);
    expect(pattern.bendLines).toHaveLength(4);
    expect(pattern.developed).toHaveLength(4);
    expect(pattern.bbox.min.x).toBeLessThan(0);
    expect(pattern.bbox.max.x).toBeGreaterThan(100);
    expect(pattern.bbox.min.y).toBeLessThan(0);
    expect(pattern.bbox.max.y).toBeGreaterThan(60);
  });

  it("picks the nearest blank side from an edge midpoint", () => {
    expect(nearestSide(base, { x: 100, y: 30 })).toBe("right");
    expect(nearestSide(base, { x: 0, y: 30 })).toBe("left");
    expect(nearestSide(base, { x: 50, y: 60 })).toBe("top");
    expect(nearestSide(base, { x: 50, y: 0 })).toBe("bottom");
  });
});

describe("DXF export", () => {
  const base = { min: { x: 0, y: 0 }, max: { x: 100, y: 60 } };
  const pattern: FlatPattern = flatPattern(base, [
    { flange: flange({ id: "right" }), side: "right", from: 10, to: 50 },
  ]);

  it("writes a valid R12 file with outline and bend layers", () => {
    const dxf = flatPatternDxf(pattern);
    expect(dxf.startsWith("0\r\nSECTION")).toBe(true);
    expect(dxf).toContain("$ACADVER");
    expect(dxf).toContain("AC1009");
    expect(dxf).toContain("OUTLINE");
    expect(dxf).toContain("BEND");
    expect(dxf).toContain("DASHED");
    expect(dxf.trimEnd().endsWith("EOF")).toBe(true);
    const lineCount = (dxf.match(/\r\nLINE\r\n/g) ?? []).length;
    // 4 base sides + 4 flange sides + 1 bend line
    expect(lineCount).toBe(9);
    // Balanced sections.
    const sections = (dxf.match(/SECTION/g) ?? []).length;
    const ends = (dxf.match(/ENDSEC/g) ?? []).length;
    expect(sections).toBe(ends);
  });

  it("keeps the developed extents in the header", () => {
    const dxf = flatPatternDxf(pattern);
    expect(dxf).toContain("$EXTMAX");
    expect(dxf).toContain((Math.round(pattern.bbox.max.x * 10000) / 10000).toString());
  });

  it("rounds coordinates and stays pure ASCII", () => {
    const dxf = flatPatternDxf(pattern);
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(dxf)).toBe(true);
  });
});

describe("sheet metal recipe", () => {
  it("derives the blank and flange placement from the feature tree", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    part.sketches.push(rectangleSketch(120, 80));
    const feature: Feature = {
      id: "feat_base",
      type: "baseFlange",
      name: "BaseFlange1",
      sketchId: "sk_1",
      params: { sheetThickness: 3, bendRadius: 2.5, kFactor: 0.42 },
      suppressed: false,
    };
    part.features.push(feature);
    part.sheetMetal = {
      thickness: 3,
      radius: 2.5,
      kFactor: 0.42,
      flattened: false,
      flanges: [flange({ id: "f1", side: "top", from: 10, to: 70, thickness: 3, radius: 2.5, kFactor: 0.42 })],
    };
    const recipe = sheetMetalRecipe(part);
    expect(recipe).not.toBeNull();
    expect(recipe!.base.min).toEqual({ x: 0, y: 0 });
    expect(recipe!.base.max).toEqual({ x: 120, y: 80 });
    expect(recipe!.thickness).toBe(3);
    expect(recipe!.flanges).toHaveLength(1);
    expect(recipe!.flanges[0].side).toBe("top");
    const pattern = flatPattern(recipe!.base, recipe!.flanges);
    expect(pattern.bbox.max.y).toBeCloseTo(80 + 20 + bendAllowance(90, 2.5, 3, 0.42), 9);
  });

  it("returns null without a base flange", () => {
    const doc = createDocument();
    expect(sheetMetalRecipe(doc.parts[0])).toBeNull();
  });

  it("uses the default segment count for bend arcs", () => {
    expect(BEND_SEGMENTS).toBe(12);
  });
});
