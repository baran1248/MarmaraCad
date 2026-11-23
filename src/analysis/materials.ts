import type { FeaMaterial } from "../model/types";

/** Ansys Engineering Data-style material library.
 *
 *  Every entry carries the full linear-elastic + thermal set the workbench
 *  consumes: E/nu/G (structural), yield/uts (safety factor), density (mass
 *  properties), conductivity (thermal study, W/(mm·K)), specific heat, CTE and
 *  the PBR triplet (color / metalness / roughness) used by the studio viewport.
 *
 *  Values are room-temperature handbook data (MatWeb / ASM / Ansys Granta
 *  ranges), rounded to engineering precision. Conductivity is converted from
 *  W/(m·K) to W/(mm·K) by dividing by 1000: copper 385 → 0.385, 6061 167 →
 *  0.167, steel 50 → 0.050, ABS 0.2 → 0.0002. */

export type MaterialCategory =
  | "Steels & Irons"
  | "Aluminum Alloys"
  | "Copper, Brass & Bronze"
  | "Titanium, Nickel & Magnesium"
  | "Polymers & Elastomers"
  | "Composites, Ceramics & Others"
  | "Custom";

export const MATERIAL_CATEGORIES: MaterialCategory[] = [
  "Steels & Irons",
  "Aluminum Alloys",
  "Copper, Brass & Bronze",
  "Titanium, Nickel & Magnesium",
  "Polymers & Elastomers",
  "Composites, Ceramics & Others",
  "Custom",
];

/** Shared PBR presets so metals look metallic and polymers look matte. */
const PBR = {
  polishedSteel: { metalness: 0.92, roughness: 0.28 },
  brushedSteel: { metalness: 0.85, roughness: 0.42 },
  castIron: { metalness: 0.72, roughness: 0.66 },
  aluminum: { metalness: 0.88, roughness: 0.34 },
  anodized: { metalness: 0.76, roughness: 0.46 },
  copper: { metalness: 0.95, roughness: 0.22 },
  brass: { metalness: 0.93, roughness: 0.26 },
  bronze: { metalness: 0.9, roughness: 0.33 },
  titanium: { metalness: 0.82, roughness: 0.38 },
  nickel: { metalness: 0.9, roughness: 0.3 },
  magnesium: { metalness: 0.7, roughness: 0.55 },
  polymer: { metalness: 0.03, roughness: 0.62 },
  glossyPolymer: { metalness: 0.05, roughness: 0.34 },
  rubber: { metalness: 0.02, roughness: 0.92 },
  composite: { metalness: 0.12, roughness: 0.55 },
  ceramic: { metalness: 0.02, roughness: 0.28 },
  concrete: { metalness: 0.01, roughness: 0.95 },
  glass: { metalness: 0.01, roughness: 0.08 },
  wood: { metalness: 0.01, roughness: 0.72 },
};

type Entry = Omit<FeaMaterial, "category"> & { category: MaterialCategory };

const steel = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
  extra: Partial<Entry> = {},
): Entry => ({ id, name, category: "Steels & Irons", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr, ...extra });

const aluminum = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
): Entry => ({ id, name, category: "Aluminum Alloys", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr });

const copperAlloy = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
): Entry => ({ id, name, category: "Copper, Brass & Bronze", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr });

const exotic = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
): Entry => ({ id, name, category: "Titanium, Nickel & Magnesium", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr });

const polymer = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
): Entry => ({ id, name, category: "Polymers & Elastomers", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr });

const other = (
  id: string,
  name: string,
  E: number,
  nu: number,
  yieldStrength: number,
  uts: number,
  density: number,
  conductivity: number,
  specificHeat: number,
  cte: number,
  color: string,
  pbr: { metalness: number; roughness: number },
): Entry => ({ id, name, category: "Composites, Ceramics & Others", E, nu, G: E / (2 * (1 + nu)), yield: yieldStrength, uts, density, conductivity, specificHeat, cte, color, ...pbr });

export const MATERIALS: FeaMaterial[] = [
  // ------------------------------------------------------ Steels & Irons (12)
  steel("steel", "Structural Steel", 200000, 0.3, 250, 460, 7850, 0.05, 490, 1.17e-5, "#8c9aa8", PBR.brushedSteel),
  steel("aisi1018", "AISI 1018 Steel", 205000, 0.29, 370, 440, 7870, 0.051, 486, 1.17e-5, "#93a1af", PBR.brushedSteel),
  steel("aisi1020", "AISI 1020 Steel", 205000, 0.29, 295, 395, 7870, 0.051, 486, 1.17e-5, "#94a2b0", PBR.brushedSteel),
  steel("aisi1045", "AISI 1045 Steel", 205000, 0.29, 530, 625, 7850, 0.049, 486, 1.15e-5, "#8f9dad", PBR.polishedSteel),
  steel("aisi4140", "AISI 4140 Steel", 210000, 0.29, 655, 1020, 7850, 0.042, 473, 1.23e-5, "#8896a6", PBR.polishedSteel),
  steel("aisi4340", "AISI 4340 Steel", 205000, 0.29, 470, 745, 7850, 0.044, 475, 1.23e-5, "#8593a3", PBR.polishedSteel),
  steel("stainless304", "Stainless Steel 304", 193000, 0.29, 215, 505, 8000, 0.016, 500, 1.73e-5, "#a7b1b9", PBR.polishedSteel),
  steel("stainless316l", "Stainless Steel 316L", 193000, 0.27, 170, 485, 8000, 0.016, 500, 1.6e-5, "#a9b4bc", PBR.polishedSteel),
  steel("17-4ph", "17-4 PH Stainless", 196000, 0.27, 1000, 1070, 7800, 0.017, 460, 1.08e-5, "#9fa9b4", PBR.polishedSteel),
  steel("tool-d2", "Tool Steel D2", 210000, 0.3, 1500, 1800, 7700, 0.02, 460, 1.04e-5, "#7f8b98", PBR.polishedSteel),
  steel("castiron", "Gray Cast Iron", 120000, 0.26, 200, 250, 7200, 0.045, 460, 1.1e-5, "#7d858c", PBR.castIron),
  steel("ductile-iron", "Ductile Iron 65-45-12", 169000, 0.28, 310, 450, 7100, 0.036, 460, 1.12e-5, "#7a838b", PBR.castIron),

  // -------------------------------------------------- Aluminum alloys (7)
  aluminum("al1060", "Aluminum 1060-O", 69000, 0.33, 30, 70, 2705, 0.234, 900, 2.36e-5, "#d5dade", PBR.aluminum),
  aluminum("al2024", "Aluminum 2024-T3", 73100, 0.33, 345, 483, 2780, 0.121, 875, 2.32e-5, "#c2c9d0", PBR.aluminum),
  aluminum("al5052", "Aluminum 5052-H32", 70300, 0.33, 193, 228, 2680, 0.138, 880, 2.39e-5, "#cbd1d7", PBR.aluminum),
  aluminum("al6061", "Aluminum 6061-T6", 68900, 0.33, 276, 310, 2700, 0.167, 896, 2.36e-5, "#c7ced4", PBR.aluminum),
  aluminum("al6063", "Aluminum 6063-T6", 68900, 0.33, 214, 241, 2700, 0.201, 900, 2.34e-5, "#ccd3d9", PBR.anodized),
  aluminum("al7075", "Aluminum 7075-T6", 71700, 0.33, 503, 572, 2810, 0.13, 960, 2.36e-5, "#bcc4cb", PBR.aluminum),
  aluminum("a356", "Cast Aluminum A356-T6", 72400, 0.33, 207, 262, 2685, 0.151, 963, 2.15e-5, "#c5ccd2", PBR.castIron),

  // -------------------------------------------- Copper, brass & bronze (4)
  copperAlloy("copper", "Copper C11000", 117000, 0.34, 70, 220, 8940, 0.385, 385, 1.7e-5, "#c08a6a", PBR.copper),
  copperAlloy("brass", "Brass C36000", 97000, 0.31, 124, 340, 8500, 0.115, 380, 2.06e-5, "#c9a94f", PBR.brass),
  copperAlloy("phosphor-bronze", "Phosphor Bronze C510", 117000, 0.34, 310, 430, 8800, 0.084, 380, 1.8e-5, "#b08d5c", PBR.bronze),
  copperAlloy("beryllium-copper", "Beryllium Copper C17200", 131000, 0.3, 1100, 1350, 8250, 0.105, 420, 1.68e-5, "#c9a35e", PBR.bronze),

  // ------------------------------------------- Titanium, nickel & magnesium
  exotic("titanium", "Titanium Ti-6Al-4V", 113800, 0.342, 880, 950, 4430, 0.0067, 526, 8.6e-6, "#9aa6b4", PBR.titanium),
  exotic("titanium-grade2", "Titanium Grade 2", 105000, 0.37, 275, 345, 4510, 0.0164, 523, 8.6e-6, "#a3aeb9", PBR.titanium),
  exotic("inconel718", "Inconel 718", 205000, 0.29, 1034, 1240, 8190, 0.0114, 435, 1.3e-5, "#9d9f9a", PBR.nickel),
  exotic("az31b", "Magnesium AZ31B", 45000, 0.35, 200, 262, 1770, 0.096, 1000, 2.62e-5, "#c3c7c8", PBR.magnesium),

  // ------------------------------------------------ Polymers & elastomers
  polymer("abs", "ABS Plastic", 2300, 0.35, 40, 42, 1040, 0.0002, 1400, 9.0e-5, "#d8cfa8", PBR.polymer),
  polymer("pla", "PLA", 3500, 0.36, 50, 55, 1240, 0.00013, 1460, 7.5e-5, "#c9cdd3", PBR.polymer),
  polymer("petg", "PETG", 2100, 0.4, 50, 53, 1270, 0.0002, 1200, 6.0e-5, "#b9d3dd", PBR.glossyPolymer),
  polymer("nylon", "Nylon 6/6", 2900, 0.39, 80, 85, 1140, 0.00025, 1670, 8.0e-5, "#e0dcc6", PBR.polymer),
  polymer("pc", "Polycarbonate (PC)", 2380, 0.37, 62, 66, 1200, 0.0002, 1250, 6.5e-5, "#d9e0e3", PBR.glossyPolymer),
  polymer("pom", "Acetal (POM / Delrin)", 3100, 0.35, 65, 70, 1410, 0.0003, 1500, 1.1e-4, "#e2e4e0", PBR.polymer),
  polymer("peek", "PEEK", 3700, 0.38, 100, 110, 1300, 0.00025, 1340, 4.7e-5, "#cfc3a8", PBR.polymer),
  polymer("ptfe", "PTFE (Teflon)", 500, 0.46, 20, 28, 2200, 0.00025, 1050, 1.35e-4, "#eceff1", PBR.polymer),
  polymer("hdpe", "HDPE", 1100, 0.42, 26, 30, 950, 0.00048, 1900, 1.2e-4, "#e4eaec", PBR.polymer),
  polymer("silicone", "Silicone Rubber", 7, 0.49, 5, 8, 1130, 0.0002, 1460, 3.0e-4, "#c8b9b0", PBR.rubber),
  polymer("neoprene", "Neoprene Rubber", 4.5, 0.49, 3.5, 15, 1230, 0.00019, 1500, 2.2e-4, "#5c6166", PBR.rubber),

  // ------------------------------------------ Composites, ceramics & others
  other("cfrp", "Carbon Fiber Epoxy (quasi-iso)", 70000, 0.3, 600, 800, 1600, 0.007, 900, 2.0e-6, "#2f3236", PBR.composite),
  other("g10", "Fiberglass G10", 24000, 0.22, 280, 310, 1850, 0.00029, 1100, 1.6e-5, "#9aa87f", PBR.composite),
  other("alumina", "Alumina (Al2O3)", 370000, 0.22, 3000, 3500, 3900, 0.03, 880, 8.0e-6, "#e6e2d8", PBR.ceramic),
  other("sic", "Silicon Carbide", 410000, 0.19, 4000, 4500, 3210, 0.12, 750, 4.0e-6, "#4e5459", PBR.ceramic),
  other("concrete", "Concrete", 30000, 0.2, 30, 40, 2400, 0.0017, 880, 1.2e-5, "#b8b6b1", PBR.concrete),
  other("sodalime-glass", "Soda-Lime Glass", 72000, 0.22, 50, 70, 2500, 0.001, 840, 9.0e-6, "#cfe4ea", PBR.glass),
  other("birch-plywood", "Birch Plywood", 12000, 0.25, 40, 60, 680, 0.00017, 1600, 5.0e-6, "#c8a874", PBR.wood),

  // -------------------------------------------------------------- Custom
  {
    id: "custom",
    name: "Custom Material",
    category: "Custom",
    E: 200000,
    nu: 0.3,
    G: 200000 / (2 * 1.3),
    yield: 250,
    uts: 400,
    density: 7850,
    conductivity: 0.05,
    specificHeat: 490,
    cte: 1.17e-5,
    color: "#a0a8b0",
    metalness: 0.3,
    roughness: 0.5,
  },
];

export function materialById(id: string | undefined): FeaMaterial {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[0];
}

/** Turkish + English synonyms so “bakır”, “paslanmaz”, “naylon” find the
 *  handbook entry whose UI name is English. Shared by the library search and
 *  the Engineering Data browser. */
export const MATERIAL_CATEGORY_WORDS: Record<string, string> = {
  "Steels & Irons": "çelik demir steel iron",
  "Aluminum Alloys": "alüminyum aluminum",
  "Copper, Brass & Bronze": "bakır pirinç bronz copper brass bronze",
  "Titanium, Nickel & Magnesium": "titanyum nikel magnezyum titanium nickel magnesium",
  "Polymers & Elastomers": "plastik polimer kauçuk polymer plastic rubber elastomer",
  "Composites, Ceramics & Others": "kompozit seramik cam ahşap beton composite ceramic glass wood concrete",
  Custom: "özel custom",
};

export const MATERIAL_NAME_WORDS: Record<string, string> = {
  abs: "akrilonitril plastik",
  nylon: "naylon poliamid",
  peek: "yüksek sıcaklık plastik",
  ptfe: "teflon",
  stainless304: "paslanmaz",
  stainless316l: "paslanmaz",
  castiron: "dökme demir",
  "ductile-iron": "sfero döküm",
  copper: "bakır",
  brass: "pirinç",
  "phosphor-bronze": "bronz",
  "beryllium-copper": "berilyum bakır",
  titanium: "titanyum",
  "titanium-grade2": "titanyum",
  inconel718: "nikel süperalaşım",
  az31b: "magnezyum",
  concrete: "beton",
  "sodalime-glass": "cam",
  "birch-plywood": "ahşap kontrplak",
  cfrp: "karbon fiber",
  g10: "cam elyaf",
  alumina: "alümina seramik",
  sic: "silisyum karbür",
};

/** True when every whitespace-separated word of `needle` appears in the
 *  material's name, category, id or synonym list. */
export function matchesMaterialQuery(material: FeaMaterial, needle: string): boolean {
  const haystack = [
    material.name,
    material.category,
    material.id,
    MATERIAL_CATEGORY_WORDS[material.category] ?? "",
    MATERIAL_NAME_WORDS[material.id] ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase("tr");
  return needle
    .trim()
    .toLocaleLowerCase("tr")
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Alpha-numeric search across the name, category, id and synonyms. */
export function searchMaterials(query: string, category?: string): FeaMaterial[] {
  const needle = query.trim();
  return MATERIALS.filter((material) => {
    if (category && category !== "All" && material.category !== category) return false;
    if (!needle) return true;
    return matchesMaterialQuery(material, needle);
  });
}

/** Effective material for a part, including per-part overrides. */
export function partMaterial(
  part:
    | {
        materialId?: string;
        materialOverride?: {
          name?: string;
          E?: number;
          nu?: number;
          G?: number;
          yield?: number;
          uts?: number;
          density?: number;
          conductivity?: number;
          specificHeat?: number;
          cte?: number;
          color?: string;
          metalness?: number;
          roughness?: number;
        };
      }
    | undefined,
): FeaMaterial {
  const base = materialById(part?.materialId);
  if (!part?.materialOverride) return base;
  const o = part.materialOverride;
  return {
    ...base,
    name: o.name ?? base.name,
    E: o.E ?? base.E,
    nu: o.nu ?? base.nu,
    G: o.G ?? (o.E !== undefined ? o.E / (2 * (1 + (o.nu ?? base.nu))) : base.G),
    yield: o.yield ?? base.yield,
    uts: o.uts ?? base.uts,
    density: o.density ?? base.density,
    conductivity: o.conductivity ?? base.conductivity,
    specificHeat: o.specificHeat ?? base.specificHeat,
    cte: o.cte ?? base.cte,
    color: o.color ?? base.color,
    metalness: o.metalness ?? base.metalness,
    roughness: o.roughness ?? base.roughness,
  };
}

/** Thermal diffusivity α = k / (ρ · cp) in mm²/s (k in W/(mm·K), ρ kg/m³, cp J/(kg·K)). */
export function thermalDiffusivity(material: FeaMaterial): number {
  return material.conductivity / (material.density * material.specificHeat * 1e-9);
}
