/* Sheet-metal math shared by the kernel, the UI and the tests.
 *
 * Everything is millimetre based. The bend allowance follows the DIN 6935 /
 * SolidWorks convention:
 *
 *     BA = (pi / 180) * theta * (R + K * t)
 *
 * where theta is the bend angle in degrees, R the inner bend radius, t the
 * sheet thickness and K the neutral-axis factor (0.44 by default). */
import type { Part, SheetMetalFlange, SheetMetalState, Vec2 } from "./types";

export const DEFAULT_K_FACTOR = 0.44;
export const DEFAULT_SHEET_THICKNESS = 2;
export const DEFAULT_BEND_RADIUS = 2;

/** Bend allowance in millimetres for an angle in degrees. */
export function bendAllowance(angleDeg: number, radius: number, thickness: number, kFactor = DEFAULT_K_FACTOR): number {
  const angle = Math.abs(angleDeg);
  const r = Math.max(0, radius);
  const t = Math.max(0, thickness);
  const k = Math.max(0, Math.min(0.5, kFactor));
  return (Math.PI / 180) * angle * (r + k * t);
}

/** Developed (flat) length of one flange: straight leg + bend allowance. */
export function developedFlangeLength(flange: Pick<SheetMetalFlange, "angle" | "length" | "radius" | "thickness" | "kFactor">): number {
  return Math.max(0, flange.length) + bendAllowance(flange.angle, flange.radius, flange.thickness, flange.kFactor);
}

/** Number of equal segments used to approximate a bend arc. */
export const BEND_SEGMENTS = 12;

/** Total developed length of a chain of legs joined by bends. */
export function developedChain(legs: number[], bends: { angle: number; radius: number; thickness: number; kFactor?: number }[]): number {
  const legSum = legs.reduce((sum, leg) => sum + Math.max(0, leg), 0);
  const bendSum = bends.reduce((sum, bend) => sum + bendAllowance(bend.angle, bend.radius, bend.thickness, bend.kFactor ?? DEFAULT_K_FACTOR), 0);
  return legSum + bendSum;
}

export interface FlatBendLine {
  a: Vec2;
  b: Vec2;
  angle: number;
  radius: number;
  allowance: number;
}

export interface FlatRegion {
  /** Closed polygon, counter-clockwise, in millimetres. */
  points: Vec2[];
  role: "base" | "flange";
  flangeId?: string;
}

export interface FlatPattern {
  regions: FlatRegion[];
  bendLines: FlatBendLine[];
  /** Overall blank extents. */
  bbox: { min: Vec2; max: Vec2 };
  /** Developed length of every flange (leg + BA). */
  developed: { flangeId: string; length: number; allowance: number }[];
}

/** Rectangular base outline used when the base sketch is not a rectangle. */
export function rectPoints(min: Vec2, max: Vec2): Vec2[] {
  return [
    { x: min.x, y: min.y },
    { x: max.x, y: min.y },
    { x: max.x, y: max.y },
    { x: min.x, y: max.y },
  ];
}

/**
 * Flat pattern for a rectangular blank plus edge flanges.
 * `sides` maps each flange to one of the four blank edges; the flange is
 * unfolded outwards, keeping the blank as the origin.
 */
export function flatPattern(
  base: { min: Vec2; max: Vec2 },
  flanges: { flange: SheetMetalFlange; side: "left" | "right" | "bottom" | "top"; from: number; to: number }[],
): FlatPattern {
  const regions: FlatRegion[] = [{ points: rectPoints(base.min, base.max), role: "base" }];
  const bendLines: FlatBendLine[] = [];
  const developed: FlatPattern["developed"] = [];
  let minX = base.min.x;
  let maxX = base.max.x;
  let minY = base.min.y;
  let maxY = base.max.y;

  for (const entry of flanges) {
    const { flange, side, from, to } = entry;
    const allowance = bendAllowance(flange.angle, flange.radius, flange.thickness, flange.kFactor);
    const length = Math.max(0, flange.length) + allowance;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    developed.push({ flangeId: flange.id, length, allowance });

    if (side === "right" || side === "left") {
      const baseX = side === "right" ? base.max.x : base.min.x;
      const x2 = side === "right" ? baseX + length : baseX - length;
      regions.push({
        points: rectPoints({ x: Math.min(baseX, x2), y: lo }, { x: Math.max(baseX, x2), y: hi }),
        role: "flange",
        flangeId: flange.id,
      });
      bendLines.push({ a: { x: baseX, y: lo }, b: { x: baseX, y: hi }, angle: flange.angle, radius: flange.radius, allowance });
      minX = Math.min(minX, x2);
      maxX = Math.max(maxX, x2);
    } else {
      const baseY = side === "top" ? base.max.y : base.min.y;
      const y2 = side === "top" ? baseY + length : baseY - length;
      regions.push({
        points: rectPoints({ x: lo, y: Math.min(baseY, y2) }, { x: hi, y: Math.max(baseY, y2) }),
        role: "flange",
        flangeId: flange.id,
      });
      bendLines.push({ a: { x: lo, y: baseY }, b: { x: hi, y: baseY }, angle: flange.angle, radius: flange.radius, allowance });
      minY = Math.min(minY, y2);
      maxY = Math.max(maxY, y2);
    }
  }

  return {
    regions,
    bendLines,
    bbox: { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } },
    developed,
  };
}

/** Side of a rectangular blank that an edge midpoint sits closest to. */
export function nearestSide(base: { min: Vec2; max: Vec2 }, point: Vec2): "left" | "right" | "bottom" | "top" {
  const distances = {
    left: Math.abs(point.x - base.min.x),
    right: Math.abs(point.x - base.max.x),
    bottom: Math.abs(point.y - base.min.y),
    top: Math.abs(point.y - base.max.y),
  };
  return (Object.keys(distances) as (keyof typeof distances)[]).sort((a, b) => distances[a] - distances[b])[0];
}

/** True when a sheet-metal body has at least one flange recipe. */
export function hasSheetMetal(part: { sheetMetal?: SheetMetalState }): boolean {
  return Boolean(part.sheetMetal && part.sheetMetal.flanges.length > 0);
}

export interface SheetMetalRecipe {
  /** Base blank rectangle in the base sketch's 2-D frame. */
  base: { min: Vec2; max: Vec2 };
  flanges: { flange: SheetMetalFlange; side: "left" | "right" | "bottom" | "top"; from: number; to: number }[];
  thickness: number;
  planeIndex: number;
}

/** Build the shared base blank + flange recipe straight from the feature tree.
 *  Used by the kernel (flat body), the UI (DXF, bend lines) and the tests. */
export function sheetMetalRecipe(part: Pick<Part, "sketches" | "features" | "sheetMetal">): SheetMetalRecipe | null {
  const baseFeature = part.features.find((f) => f.type === "baseFlange");
  if (!baseFeature) return null;
  const bySketchId = baseFeature.sketchId ? part.sketches.find((s) => s.id === baseFeature.sketchId) : undefined;
  const sketch = bySketchId ?? part.sketches.find((s) => s.points.length > 0);
  if (!sketch || sketch.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of sketch.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return null;
  const thickness = Number(baseFeature.params.sheetThickness ?? part.sheetMetal?.thickness ?? DEFAULT_SHEET_THICKNESS);
  const baseRect = { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  const flanges = (part.sheetMetal?.flanges ?? [])
    .filter((flange) => flange.side)
    .map((flange) => ({
      flange,
      side: flange.side ?? nearestSide(baseRect, { x: flange.from ?? minX, y: flange.to ?? minY }),
      from: flange.from ?? minX,
      to: flange.to ?? maxX,
    }));
  return { base: baseRect, flanges, thickness, planeIndex: 0 };
}

/** Minimal but valid AutoCAD R12 DXF containing the blank outline and the
 *  dashed bend lines. Opens in any DXF viewer (R12 LINE entities, no
 *  proprietary objects). */
export function flatPatternDxf(pattern: FlatPattern, options: { name?: string } = {}): string {
  const r4 = (v: number): string => (Math.round(v * 10000) / 10000).toString();
  const lines: string[] = [];
  const push = (...values: (string | number)[]) => lines.push(...values.map(String));
  push("0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "4", "9", "$EXTMIN");
  push("10", r4(pattern.bbox.min.x), "20", r4(pattern.bbox.min.y), "30", "0");
  push("9", "$EXTMAX", "10", r4(pattern.bbox.max.x), "20", r4(pattern.bbox.max.y), "30", "0");
  push("0", "ENDSEC");
  push("0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LTYPE", "70", "2");
  push("0", "LTYPE", "2", "CONTINUOUS", "70", "64", "3", "Solid line", "72", "65", "73", "0", "40", "0.0");
  push("0", "LTYPE", "2", "DASHED", "70", "64", "3", "Bend line", "72", "65", "73", "2", "40", "4.0", "49", "2.5", "49", "-1.5");
  push("0", "ENDTAB");
  push("0", "TABLE", "2", "LAYER", "70", "2");
  push("0", "LAYER", "2", "OUTLINE", "70", "0", "62", "7", "6", "CONTINUOUS");
  push("0", "LAYER", "2", "BEND", "70", "0", "62", "1", "6", "DASHED");
  push("0", "ENDTAB", "0", "ENDSEC");
  push("0", "SECTION", "2", "ENTITIES");
  const line = (layer: string, a: Vec2, b: Vec2) => {
    push("0", "LINE", "8", layer, "10", r4(a.x), "20", r4(a.y), "30", "0", "11", r4(b.x), "21", r4(b.y), "31", "0");
  };
  for (const region of pattern.regions) {
    if (region.points.length < 2) continue;
    for (let i = 0; i < region.points.length; i++) {
      line("OUTLINE", region.points[i], region.points[(i + 1) % region.points.length]);
    }
  }
  for (const bend of pattern.bendLines) line("BEND", bend.a, bend.b);
  push("0", "ENDSEC", "0", "EOF");
  void options.name;
  return lines.join("\r\n") + "\r\n";
}
