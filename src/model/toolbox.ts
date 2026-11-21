/* Parametric Toolbox fasteners (M4–M12).
 *
 * Fasteners are generated as an OBJ mesh so they work even in the mesh-only
 * pipeline: hex head / hex nut / washer profiles are built analytically, which
 * keeps the geometry exact enough for mass properties and assembly work while
 * avoiding a kernel round-trip for every standard part. */
import type { Part } from "../model/types";
import { createPart } from "../model/defaults";

export interface FastenerSpec {
  kind: "bolt" | "nut" | "washer";
  size: string;
  length?: number;
}

export interface SizeSpec {
  size: string;
  d: number;
  acrossFlats: number;
  headHeight: number;
  nutHeight: number;
  washerOd: number;
  washerThickness: number;
}

/** ISO 4014 / ISO 4032 / ISO 7089 coarse dimensions (mm). */
export const METRIC_SIZES: SizeSpec[] = [
  { size: "M4", d: 4, acrossFlats: 7, headHeight: 2.8, nutHeight: 3.2, washerOd: 9, washerThickness: 0.8 },
  { size: "M5", d: 5, acrossFlats: 8, headHeight: 3.5, nutHeight: 4, washerOd: 10, washerThickness: 1 },
  { size: "M6", d: 6, acrossFlats: 10, headHeight: 4, nutHeight: 5, washerOd: 12, washerThickness: 1.6 },
  { size: "M8", d: 8, acrossFlats: 13, headHeight: 5.3, nutHeight: 6.5, washerOd: 16, washerThickness: 1.6 },
  { size: "M10", d: 10, acrossFlats: 16, headHeight: 6.4, nutHeight: 8, washerOd: 20, washerThickness: 2 },
  { size: "M12", d: 12, acrossFlats: 18, headHeight: 7.5, nutHeight: 10, washerOd: 24, washerThickness: 2.5 },
];

class ObjBuilder {
  private vertices: string[] = [];
  private faces: string[] = [];
  private count = 0;

  vertex(x: number, y: number, z: number): number {
    this.vertices.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
    this.count += 1;
    return this.count;
  }

  face(a: number, b: number, c: number): void {
    this.faces.push(`f ${a} ${b} ${c}`);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.face(a, b, c);
    this.face(a, c, d);
  }

  /** Extrude a closed 2D polygon (XY, CCW) between z=z0 and z=z1. */
  prism(poly: { x: number; y: number }[], z0: number, z1: number): void {
    const bottom: number[] = [];
    const top: number[] = [];
    let cx = 0;
    let cy = 0;
    for (const p of poly) {
      cx += p.x;
      cy += p.y;
    }
    cx /= poly.length;
    cy /= poly.length;
    const cb = this.vertex(cx, cy, z0);
    const ct = this.vertex(cx, cy, z1);
    for (const p of poly) bottom.push(this.vertex(p.x, p.y, z0));
    for (const p of poly) top.push(this.vertex(p.x, p.y, z1));
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      this.face(cb, bottom[j], bottom[i]);
      this.face(ct, top[i], top[j]);
      this.quad(bottom[i], bottom[j], top[j], top[i]);
    }
  }

  /** Cylinder along Z. */
  cylinder(radius: number, z0: number, z1: number, segments = 32): void {
    const poly: { x: number; y: number }[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      poly.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
    }
    this.prism(poly, z0, z1);
  }

  /** Hollow tube along Z (washer). */
  tube(inner: number, outer: number, z0: number, z1: number, segments = 32): void {
    const oi: number[] = [];
    const ot: number[] = [];
    const ii: number[] = [];
    const it: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      oi.push(this.vertex(Math.cos(a) * outer, Math.sin(a) * outer, z0));
      ot.push(this.vertex(Math.cos(a) * outer, Math.sin(a) * outer, z1));
      ii.push(this.vertex(Math.cos(a) * inner, Math.sin(a) * inner, z0));
      it.push(this.vertex(Math.cos(a) * inner, Math.sin(a) * inner, z1));
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(oi[i], oi[j], ot[j], ot[i]);
      this.quad(ii[j], ii[i], it[i], it[j]);
      this.quad(ii[i], ii[j], oi[j], oi[i]);
      this.quad(it[j], it[i], ot[i], ot[j]);
    }
  }

  toString(): string {
    return `# MarmaraCad Toolbox\n${this.vertices.join("\n")}\n${this.faces.join("\n")}\n`;
  }
}

function hexPoly(acrossFlats: number): { x: number; y: number }[] {
  const r = acrossFlats / Math.sqrt(3);
  const poly: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
    poly.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return poly;
}

/** Build an OBJ body for the requested fastener, oriented along +Z. */
export function fastenerObj(spec: FastenerSpec): string {
  const size = METRIC_SIZES.find((s) => s.size === spec.size) ?? METRIC_SIZES[2];
  const obj = new ObjBuilder();
  if (spec.kind === "bolt") {
    const length = Math.max(size.d * 2, spec.length ?? size.d * 4);
    obj.prism(hexPoly(size.acrossFlats), 0, size.headHeight);
    obj.cylinder(size.d / 2, -length, 0, 28);
    // Simple chamfer ring at the thread end.
    obj.cylinder(size.d * 0.42, -length - size.d * 0.08, -length, 20);
  } else if (spec.kind === "nut") {
    const outer = hexPoly(size.acrossFlats);
    // Hex ring: outer hex and inner circle share angles, six quads each side.
    const inner: { x: number; y: number }[] = [];
    const r = size.d / 2;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i / 6) * Math.PI * 2;
      inner.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    const ob = outer.map((p) => obj.vertex(p.x, p.y, 0));
    const ot = outer.map((p) => obj.vertex(p.x, p.y, size.nutHeight));
    const ib = inner.map((p) => obj.vertex(p.x, p.y, 0));
    const it = inner.map((p) => obj.vertex(p.x, p.y, size.nutHeight));
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      obj.quad(ob[i], ob[j], ib[j], ib[i]);
      obj.quad(it[i], it[j], ot[j], ot[i]);
      obj.quad(ib[i], ib[j], it[j], it[i]);
      obj.quad(ob[j], ob[i], ot[i], ot[j]);
    }
  } else {
    obj.tube(size.d / 2, size.washerOd / 2, 0, size.washerThickness, 36);
  }
  return obj.toString();
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function createFastenerPart(spec: FastenerSpec, index = 0): Part {
  const size = METRIC_SIZES.find((s) => s.size === spec.size) ?? METRIC_SIZES[2];
  const obj = fastenerObj(spec);
  const part = createPart(`${spec.size} ${spec.kind === "bolt" ? "Hex Bolt" : spec.kind === "nut" ? "Hex Nut" : "Washer"}`, index);
  part.color = spec.kind === "bolt" ? "#9aa8b6" : spec.kind === "nut" ? "#a8b4bf" : "#b8c2ca";
  part.materialId = "aisi1020";
  part.meshOnly = true;
  part.asset = {
    format: "obj",
    dataBase64: toBase64(obj),
    size: new TextEncoder().encode(obj).length,
    rev: `toolbox-${size.size}-${spec.kind}-${spec.length ?? 0}`,
    name: `${size.size}-${spec.kind}.obj`,
  };
  return part;
}
