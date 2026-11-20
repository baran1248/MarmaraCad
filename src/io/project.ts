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
  if (clean.parts.length === 0) clean.parts = fallback.parts;
  if (!clean.parts.some((p) => p.id === clean.activePartId)) clean.activePartId = clean.parts[0].id;
  clean.components = clean.components.filter((c: any) => c && clean.parts.some((p) => p.id === c.partId));
  if (clean.activeComponentId && !clean.components.some((c: any) => c.id === clean.activeComponentId)) clean.activeComponentId = null;
  if (clean.activeStudyId && !clean.analyses.some((s: any) => s.id === clean.activeStudyId)) clean.activeStudyId = null;
  return clean;
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
  return part;
}

export function touchDocument(doc: ProjectDocument): void {
  touch(doc);
}

export function cloneDocument(doc: ProjectDocument): ProjectDocument {
  return JSON.parse(JSON.stringify(doc)) as ProjectDocument;
}
