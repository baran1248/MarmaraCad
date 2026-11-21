import type { FeaMaterial } from "../model/types";

export const MATERIALS: FeaMaterial[] = [
  {
    id: "aisi1020",
    name: "AISI 1020 Steel",
    category: "Metals",
    E: 205000,
    nu: 0.29,
    yield: 295,
    density: 7870,
    color: "#94a2b0",
  },
  {
    id: "steel",
    name: "Structural Steel",
    category: "Metals",
    E: 200000,
    nu: 0.3,
    yield: 250,
    density: 7850,
    color: "#8c9aa8",
  },
  {
    id: "stainless304",
    name: "Stainless Steel 304",
    category: "Metals",
    E: 193000,
    nu: 0.29,
    yield: 215,
    density: 8000,
    color: "#a7b1b9",
  },
  {
    id: "al6061",
    name: "Aluminum 6061-T6",
    category: "Metals",
    E: 68900,
    nu: 0.33,
    yield: 276,
    density: 2700,
    color: "#c7ced4",
  },
  {
    id: "al7075",
    name: "Aluminum 7075-T6",
    category: "Metals",
    E: 71700,
    nu: 0.33,
    yield: 503,
    density: 2810,
    color: "#bcc4cb",
  },
  {
    id: "titanium",
    name: "Titanium Ti-6Al-4V",
    category: "Metals",
    E: 113800,
    nu: 0.342,
    yield: 880,
    density: 4430,
    color: "#9aa6b4",
  },
  {
    id: "copper",
    name: "Copper C11000",
    category: "Metals",
    E: 117000,
    nu: 0.34,
    yield: 70,
    density: 8940,
    color: "#c08a6a",
  },
  {
    id: "castiron",
    name: "Gray Cast Iron",
    category: "Metals",
    E: 120000,
    nu: 0.26,
    yield: 200,
    density: 7200,
    color: "#7d858c",
  },
  {
    id: "abs",
    name: "ABS Plastic",
    category: "Polymers",
    E: 2300,
    nu: 0.35,
    yield: 40,
    density: 1040,
    color: "#d8cfa8",
  },
  {
    id: "nylon",
    name: "Nylon 6/6",
    category: "Polymers",
    E: 2900,
    nu: 0.39,
    yield: 80,
    density: 1140,
    color: "#e0dcc6",
  },
  {
    id: "brass",
    name: "Brass C36000",
    category: "Metals",
    E: 97000,
    nu: 0.31,
    yield: 124,
    density: 8500,
    color: "#c9a94f",
  },
  {
    id: "custom",
    name: "Custom Material",
    category: "Custom",
    E: 200000,
    nu: 0.3,
    yield: 250,
    density: 7850,
    color: "#a0a8b0",
  },
];

export function materialById(id: string | undefined): FeaMaterial {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}

/** Effective material for a part, including per-part overrides. */
export function partMaterial(part: { materialId?: string; materialOverride?: { name?: string; E?: number; nu?: number; yield?: number; density?: number } } | undefined): FeaMaterial {
  const base = materialById(part?.materialId);
  if (!part?.materialOverride) return base;
  const o = part.materialOverride;
  return {
    ...base,
    name: o.name ?? base.name,
    E: o.E ?? base.E,
    nu: o.nu ?? base.nu,
    yield: o.yield ?? base.yield,
    density: o.density ?? base.density,
  };
}
