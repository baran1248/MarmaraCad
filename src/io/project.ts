import type { Part, ProjectDocument, ProjectFile, WorkspaceMode } from "../model/types";
import { createDocument, touch } from "../model/defaults";

export function projectFile(doc: ProjectDocument): ProjectFile {
  return {
    format: "marmaracad",
    version: 1,
    app: "MarmaraCad",
    savedAt: new Date().toISOString(),
    document: doc,
  };
}

export function serializeProject(doc: ProjectDocument): string {
  return JSON.stringify(projectFile(doc), null, 2);
}

export function parseProject(text: string): ProjectDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file is not valid JSON.");
  }
  return normalizeDocument(raw);
}

export function normalizeDocument(raw: unknown): ProjectDocument {
  if (!raw || typeof raw !== "object") throw new Error("The project file is empty or invalid.");
  const obj = raw as any;
  const doc: any = obj.document && obj.document.parts ? obj.document : obj;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.parts)) {
    throw new Error("The file does not look like a MarmaraCad project.");
  }
  const fallback = createDocument();
  const clean: ProjectDocument = {
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name : "Untitled",
    units: "mm",
    parts: doc.parts.filter((p: any) => p && typeof p.id === "string").map((p: any) => normalizePart(p)),
    components: Array.isArray(doc.components) ? doc.components : [],
    mates: Array.isArray(doc.mates) ? doc.mates : [],
    analyses: Array.isArray(doc.analyses) ? doc.analyses : [],
    activePartId: typeof doc.activePartId === "string" ? doc.activePartId : "",
    activeComponentId: typeof doc.activeComponentId === "string" ? doc.activeComponentId : null,
    activeStudyId: typeof doc.activeStudyId === "string" ? doc.activeStudyId : null,
    mode: (["part", "assembly", "analysis"].includes(doc.mode) ? doc.mode : "part") as WorkspaceMode,
    createdAt: Number(doc.createdAt) || Date.now(),
    updatedAt: Number(doc.updatedAt) || Date.now(),
  };
  if (Array.isArray(doc.variables)) clean.variables = doc.variables;
  if (doc.language === "en" || doc.language === "tr") clean.language = doc.language;
  if (Number.isFinite(doc.exploded)) clean.exploded = clamp01(doc.exploded);
  if (clean.parts.length === 0) clean.parts = fallback.parts;
  if (!clean.parts.some((p) => p.id === clean.activePartId)) clean.activePartId = clean.parts[0].id;
  clean.components = clean.components.filter((c: any) => c && clean.parts.some((p) => p.id === c.partId));
  if (clean.activeComponentId && !clean.components.some((c: any) => c.id === clean.activeComponentId)) clean.activeComponentId = null;
  if (clean.activeStudyId && !clean.analyses.some((s: any) => s.id === clean.activeStudyId)) clean.activeStudyId = null;
  return clean;
}

/** Normalisation helpers keep optional model extensions intact across a
 *  save/load round-trip (configurations, sheet metal, reference geometry). */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizePart(p: any): Part {
  const part: Part = {
    id: String(p.id),
    name: typeof p.name === "string" && p.name ? p.name : "Part",
    color: typeof p.color === "string" ? p.color : "#8fa3b8",
    visible: p.visible !== false,
    sketches: Array.isArray(p.sketches) ? p.sketches : [],
    features: Array.isArray(p.features) ? p.features : [],
    materialId: typeof p.materialId === "string" ? p.materialId : "steel",
  };
  if (p.asset && typeof p.asset.dataBase64 === "string") part.asset = p.asset;
  if (p.meshOnly) part.meshOnly = true;
  if (p.materialOverride && typeof p.materialOverride === "object") part.materialOverride = p.materialOverride;
  if (Number.isFinite(p.rollbackIndex)) part.rollbackIndex = p.rollbackIndex;
  if (Array.isArray(p.referencePlanes)) part.referencePlanes = p.referencePlanes;
  if (Array.isArray(p.referenceAxes)) part.referenceAxes = p.referenceAxes;
  if (Number.isFinite(p.explode)) part.explode = clamp01(p.explode);
  if (p.sheetMetal && typeof p.sheetMetal === "object") {
    const sheet = p.sheetMetal;
    part.sheetMetal = {
      thickness: Number(sheet.thickness) || 2,
      radius: Number(sheet.radius) || 2,
      kFactor: Number.isFinite(sheet.kFactor) ? Math.max(0, Math.min(0.5, sheet.kFactor)) : 0.44,
      flattened: Boolean(sheet.flattened),
      flanges: Array.isArray(sheet.flanges) ? sheet.flanges : [],
    };
  }
  if (Array.isArray(p.configurations) && p.configurations.length > 0) {
    part.configurations = p.configurations
      .filter((c: any) => c && typeof c.id === "string")
      .map((c: any) => ({
        id: String(c.id),
        name: typeof c.name === "string" && c.name ? c.name : "Configuration",
        variables: c.variables && typeof c.variables === "object" ? c.variables : {},
        suppressed: Array.isArray(c.suppressed) ? c.suppressed.map(String) : [],
      }));
    if (typeof p.activeConfigurationId === "string") part.activeConfigurationId = p.activeConfigurationId;
    const configs = part.configurations;
    if (configs && !configs.some((c) => c.id === part.activeConfigurationId)) {
      part.activeConfigurationId = configs[0]?.id;
    }
  }
  return part;
}

export function touchDocument(doc: ProjectDocument): void {
  touch(doc);
}

export function cloneDocument(doc: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(doc)) as ProjectDocument;
}
