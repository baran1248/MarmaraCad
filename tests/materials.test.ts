import { describe, expect, it } from "vitest";
import {
  MATERIALS,
  MATERIAL_CATEGORIES,
  materialById,
  partMaterial,
  searchMaterials,
  thermalDiffusivity,
} from "../src/analysis/materials";

/** Ansys Engineering Data-level material library regression. */

const REQUIRED_FIELDS: (keyof (typeof MATERIALS)[number])[] = [
  "E",
  "nu",
  "G",
  "yield",
  "uts",
  "density",
  "conductivity",
  "specificHeat",
  "cte",
  "metalness",
  "roughness",
];

describe("material library", () => {
  it("ships at least 45 real materials across the Ansys categories", () => {
    expect(MATERIALS.length).toBeGreaterThanOrEqual(45);
    const counts = new Map<string, number>();
    for (const material of MATERIALS) counts.set(material.category, (counts.get(material.category) ?? 0) + 1);
    expect(counts.get("Steels & Irons")).toBeGreaterThanOrEqual(12);
    expect(counts.get("Aluminum Alloys")).toBeGreaterThanOrEqual(7);
    expect(counts.get("Copper, Brass & Bronze")).toBeGreaterThanOrEqual(4);
    expect(counts.get("Titanium, Nickel & Magnesium")).toBeGreaterThanOrEqual(4);
    expect(counts.get("Polymers & Elastomers")).toBeGreaterThanOrEqual(11);
    expect(counts.get("Composites, Ceramics & Others")).toBeGreaterThanOrEqual(7);
    for (const material of MATERIALS) {
      expect(MATERIAL_CATEGORIES).toContain(material.category);
    }
  });

  it("keeps every legacy material id so saved documents still resolve", () => {
    const legacy = [
      "aisi1020",
      "steel",
      "al6061",
      "al7075",
      "stainless304",
      "titanium",
      "copper",
      "castiron",
      "abs",
      "nylon",
      "brass",
      "custom",
    ];
    for (const id of legacy) expect(MATERIALS.some((m) => m.id === id), id).toBe(true);
  });

  it("fills every mechanical, thermal and PBR field with a physical value", () => {
    for (const material of MATERIALS) {
      for (const field of REQUIRED_FIELDS) {
        const value = material[field] as number;
        expect(Number.isFinite(value), `${material.id}.${String(field)}`).toBe(true);
        expect(value, `${material.id}.${String(field)}`).toBeGreaterThan(0);
      }
      expect(material.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(material.metalness).toBeLessThanOrEqual(1);
      expect(material.roughness).toBeLessThanOrEqual(1);
      expect(material.nu).toBeLessThan(0.5);
      // G = E / 2(1 + nu): the library derives it consistently.
      expect(material.G).toBeCloseTo(material.E / (2 * (1 + material.nu)), 3);
    }
  });

  it("uses real room-temperature conductivity in W/(mm·K)", () => {
    const byId = new Map(MATERIALS.map((m) => [m.id, m]));
    expect(byId.get("copper")!.conductivity).toBeCloseTo(0.385, 4);
    expect(byId.get("al6061")!.conductivity).toBeCloseTo(0.167, 4);
    expect(byId.get("steel")!.conductivity).toBeCloseTo(0.05, 4);
    expect(byId.get("abs")!.conductivity).toBeCloseTo(0.0002, 6);
    // Metals conduct orders of magnitude better than polymers.
    expect(byId.get("copper")!.conductivity / byId.get("abs")!.conductivity).toBeGreaterThan(1000);
  });

  it("ranks copper far above ABS for the same thermal gradient", () => {
    const copper = materialById("copper");
    const abs = materialById("abs");
    // Steady 1-D conduction: q = -k dT/dx, so the flux ratio is k_copper / k_ABS.
    const ratio = copper.conductivity / abs.conductivity;
    expect(ratio).toBeGreaterThan(1900);
    // Diffusivity α = k / (ρ cp) also reflects the same ordering.
    expect(thermalDiffusivity(copper)).toBeGreaterThan(thermalDiffusivity(abs));
  });

  it("searches by English name, Turkish category and alloy id", () => {
    expect(searchMaterials("aluminum").length).toBeGreaterThanOrEqual(7);
    expect(searchMaterials("bakır").length).toBeGreaterThanOrEqual(4);
    expect(searchMaterials("polymer").length).toBeGreaterThanOrEqual(11);
    expect(searchMaterials("6061").some((m) => m.id === "al6061")).toBe(true);
    expect(searchMaterials("xx-unknown-alloy").length).toBe(0);
  });

  it("applies per-part overrides over the library values", () => {
    const base = materialById("al6061");
    const custom = partMaterial({
      materialId: "al6061",
      materialOverride: { E: 90000, conductivity: 0.2, metalness: 0.4 },
    });
    expect(custom.E).toBe(90000);
    expect(custom.conductivity).toBe(0.2);
    expect(custom.metalness).toBe(0.4);
    expect(custom.G).toBeCloseTo(90000 / (2 * (1 + base.nu)), 3);
    expect(custom.density).toBe(base.density);
    // An override keeps the library identity so the tree can show both.
    expect(custom.name).toBe(base.name);
  });

  it("falls back to the first material for unknown ids", () => {
    expect(materialById("does-not-exist").id).toBe(MATERIALS[0].id);
    expect(materialById(undefined).id).toBe(MATERIALS[0].id);
  });
});
