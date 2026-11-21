import "./ui/styles.css";
import * as THREE from "three";
import type {
  AnalysisLoad,
  AnalysisStudy,
  Component,
  Feature,
  FeaNodeResult,
  Mate,
  MeshData,
  Part,
  ProjectDocument,
  Sketch,
  SketchPlane,
  Vec3,
  WorkspaceMode,
} from "./model/types";
import {
  basePlane,
  createDocument,
  createPart,
  nextFeatureName,
  nextSketchName,
  planeFromFace,
  touch,
  uid,
} from "./model/defaults";
import { Shell } from "./ui/Shell";
import {
  Viewport,
  type BoxSelection,
  type DisplayStyle,
  type EdgePick,
  type FacePick,
  type PickFilter,
  type SceneBody,
  type SectionState,
  type VertexPick,
  type ViewName,
} from "./viewport/Viewport";
import { SketchEditor, type SketchTool } from "./sketch/SketchEditor";
import { profileSummary } from "./sketch/geometry";
import { dimensionValue } from "./sketch/solver";
import { cadClient } from "./kernel/CadClient";
import { cloneDocument, parseProject, serializeProject } from "./io/project";
import { addRecent, clearAll, listRecent, loadAutosave, saveAutosave, type RecentEntry } from "./io/storage";
import { meshMass, parseOBJ, parseSTL, writeOBJ, writeSTL } from "./io/meshio";
import { transformMeshData } from "./viewport/geometry";
import { sectionMesh } from "./viewport/section";
import { componentMatrix, matrixArray } from "./viewport/math";
import { faceRefFromPick, solveMates } from "./assembly/mates";
import { MATERIALS, materialById, partMaterial } from "./analysis/materials";
import { applyVariables, evaluateExpression, makeVariable, standardVariables, variableValues } from "./model/variables";
import { createFastenerPart, METRIC_SIZES } from "./model/toolbox";
import { buildDrawingSvg, downloadDrawingPdf } from "./drawing/technicalDrawing";
import { Assistant, type AiCommand } from "./ui/Assistant";
import { alertDialog, confirmDialog, openModal, promptNumber, toast } from "./ui/Modal";
import { icon } from "./ui/icons";
import { materialOptions, type SketchInfo } from "./ui/FeatureTree";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  clamp,
  downloadBytes,
  downloadText,
  escapeHtml,
  fileExtension,
  fmt,
  hashBuffer,
  safeFilename,
} from "./utils/misc";
import { FeaClient } from "./fea/FeaClient";
import type { FeaLoadSpec } from "./fea/solver";
import { ResultView, type ResultDisplay, type ResultMode } from "./fea/ResultView";
import { createBestRenderer, type RendererChoice } from "./viewport/renderer";
import { clearKernelCache, kernelCacheSize } from "./kernel/wasmCache";

type Selection = { kind: string; id: string };
type PickMods = { ctrl: boolean; shift: boolean; additive: boolean };

interface ActiveCommand {
  kind: string;
  onFace?: (pick: FacePick, mods: PickMods) => void;
  onEdge?: (pick: EdgePick, mods: PickMods) => void;
  onVertex?: (pick: VertexPick, mods: PickMods) => void;
  cancel?: () => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pmHead(iconName: string, title: string, sub: string, okTitle = "OK", cancel = true): string {
  return `<div class="pm-head">
    <span class="pm-icon">${icon(iconName)}</span>
    <div class="pm-title">${title}<span class="pm-sub">${sub}</span></div>
    <div class="pm-actions">
      ${cancel ? `<button class="pm-icon-btn cancel" data-pm-cancel title="Cancel">${icon("x")}</button>` : ""}
      <button class="pm-icon-btn" data-pm-ok title="${okTitle}">${icon("check")}</button>
    </div>
  </div>`;
}

function pmSection(title: string, iconName: string, body: string): string {
  return `<div class="pm-section">
    <div class="pm-section-head">${icon(iconName)} ${title}</div>
    <div class="pm-section-body">${body}</div>
  </div>`;
}

function pmField(label: string, control: string): string {
  return `<div class="field"><label>${label}</label>${control}</div>`;
}

function numInput(id: string, value: number, unit = "", min?: number, step = "any"): string {
  return `<div class="input-wrap"><input id="${id}" type="number" step="${step}" value="${value}" ${
    min !== undefined ? `min="${min}"` : ""
  } />${unit ? `<span class="unit">${unit}</span>` : ""}</div>`;
}

function readNumber(root: ParentNode, id: string, fallback = 0): number {
  const el = root.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) return fallback;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : fallback;
}

function readText(root: ParentNode, id: string, fallback = ""): string {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
  return el ? el.value : fallback;
}

function readChecked(root: ParentNode, id: string): boolean {
  return root.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? false;
}

function formatMass(volumeMm3: number, densityKgM3: number): string {
  const grams = volumeMm3 * densityKgM3 * 1e-6;
  if (grams >= 1000) return `${fmt(grams / 1000, 3)} kg`;
  return `${fmt(grams, 1)} g`;
}

function componentName(doc: ProjectDocument, componentId: string | null): string {
  if (!componentId) return "Part body";
  return doc.components.find((c) => c.id === componentId)?.name ?? "Component";
}

export class App {
  private doc: ProjectDocument;
  private shell: Shell;
  private viewport: Viewport;
  private editor: SketchEditor;
  private fea = new FeaClient();
  private resultView: ResultView;
  private graphics: RendererChoice;

  private meshes = new Map<string, MeshData>();
  private undos: ProjectDocument[] = [];
  private redos: ProjectDocument[] = [];
  private selection: Selection | null = null;
  private selectedFace: FacePick | null = null;
  private selFaces: FacePick[] = [];
  private selEdges: EdgePick[] = [];
  private selVertices: VertexPick[] = [];
  private pickMods: PickMods = { ctrl: false, shift: false, additive: false };
  private sectionState: SectionState = { enabled: false, axis: "z", offset: 0, flipped: false };
  private navScheme: "cad" | "legacy" = "cad";
  private language: "en" | "tr" = "en";
  private assistant: Assistant;
  private measurePicks: { kind: "face" | "edge" | "vertex"; label: string; point: Vec3; normal?: Vec3; length?: number }[] = [];
  private lastPointer = { x: 0, y: 0 };
  private expanded = new Set<string>(["origin"]);
  private planesVisible = false;
  private displayStyle: DisplayStyle = "shaded-edges";
  private quality = 0.12;
  private command: ActiveCommand | null = null;
  private panelRoot: HTMLElement | null = null;
  private sketchStartDoc: ProjectDocument | null = null;
  private activeResult: ResultMode | null = null;
  private resultScale = 1;
  private toolbarMode: ResultMode | null = null;
  private feaResults = new Map<string, FeaNodeResult>();
  private rebuildToken = 0;
  private autosaveTimer = 0;
  private bootMs = 0;

  constructor(root: HTMLElement, graphics: RendererChoice) {
    this.doc = createDocument();
    this.graphics = graphics;
    this.shell = new Shell(root);
    this.viewport = new Viewport(this.shell.viewHost, graphics.renderer, graphics.backend);
    this.resultView = new ResultView(this.viewport);

    this.editor = new SketchEditor(this.viewport, {
      onChange: (sketch) => this.onSketchChanged(sketch),
      onToolChange: (tool) => this.onSketchTool(tool),
      onCursor: (p) => {
        this.shell.setCursor(p ? `x ${p.x.toFixed(2)}   y ${p.y.toFixed(2)}` : null);
      },
      onSelection: (points, entities) => {
        this.shell.setSelection(points || entities ? `${points} point(s) · ${entities} entity(ies)` : null);
        this.updateSketchPanelInfo();
      },
      onRequestDimensionEdit: (id) => {
        void this.editDimension(id);
      },
      notify: (message, kind) => toast(message, kind === "warn" ? "warn" : kind === "error" ? "error" : "info"),
      onStatus: (status) => this.shell.setSketchStatus(status.state === "empty" ? null : `${status.label} · ${status.dof} DOF`, status.state),
      onConvertPick: (clientX, clientY) => {
        const plane = this.editor.sketch?.plane;
        const pick = this.viewport.raycastEdgeAt(clientX, clientY);
        if (!plane || !pick) return null;
        return pick.edge.points.map((p) => {
          const d: Vec3 = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
          return { x: d[0] * plane.u[0] + d[1] * plane.u[1] + d[2] * plane.u[2], y: d[0] * plane.v[0] + d[1] * plane.v[1] + d[2] * plane.v[2] };
        });
      },
    });

    this.assistant = new Assistant(this.shell.aiPanelEl, {
      onCommands: (commands, message) => void this.applyAiCommands(commands, message),
      onStatus: (text) => this.shell.setStatus(text),
    });

    this.bindShell();
    this.bindViewport();
    this.bindKeys();

    this.shell.setDocument(this.doc);
    this.shell.setMode("part");
    this.shell.setCommandTab("features");
    this.shell.setUndoRedo(false, false);
    this.shell.setDisplayState(this.displayStyle, this.planesVisible);
    this.refreshTree();
    this.updateMassCard();
  }

  // ------------------------------------------------------------------ boot

  async start(): Promise<void> {
    const boot = document.getElementById("boot");
    const status = document.getElementById("boot-status");
    const pct = document.getElementById("boot-pct");
    const bar = document.querySelector<HTMLElement>(".boot-bar");
    const setBoot = (text: string, percent?: number) => {
      if (status) status.textContent = text;
      if (pct && percent !== undefined) pct.textContent = `${Math.round(percent)}%`;
      if (bar && percent !== undefined) {
        bar.classList.add("determinate");
        bar.style.setProperty("--boot-pct", `${Math.max(2, Math.min(100, percent))}%`);
      }
    };

    try {
      setBoot("Loading the OCCT WASM geometry kernel…", 12);
      const bootMs = await cadClient().ready((phase, percent) => {
        // Map kernel progress into the 6–60 % range of the boot bar.
        setBoot(phase, Math.max(6, Math.min(60, percent)));
      });
      this.bootMs = bootMs;
      const cached = cadClient().kernelFromCache;
      setBoot(`Kernel ${cached ? "restored from cache" : "ready"} in ${(bootMs / 1000).toFixed(1)} s — restoring workspace…`, 62);

      const saved = await loadAutosave();
      if (saved && saved.doc.parts.length > 0) {
        this.doc = saved.doc;
        this.shell.setDocument(this.doc);
        this.shell.setMode(this.doc.mode);
        this.shell.setStatus("Restored autosaved session");
        toast(`Restored autosave from ${new Date(saved.savedAt).toLocaleString()}`, "info");
      }

      setBoot("Building the model…", 78);
      this.shell.setDocument(this.doc);
      this.shell.setMode(this.doc.mode);
      this.language = this.doc.language ?? "en";
      this.shell.applyLanguage(this.language);
      this.shell.commandManager.setLanguage(this.language);
      this.shell.setLanguageButton(this.language);
      this.shell.setPickFilter("all");
      this.viewport.setPickFilter("all");
      this.shell.setCommandTab(this.doc.mode === "assembly" ? "assembly" : this.doc.mode === "analysis" ? "analysis" : "features");
      this.refreshTree();
      this.updateMassCard();
      await this.rebuild();

      setBoot("Ready", 100);
      boot?.classList.add("hidden");
      window.setTimeout(() => boot?.remove(), 700);
      this.shell.setStatus("Ready · select a plane and start a sketch");
      this.shell.setUndoRedo(false, false);
      this.shell.setViewCubeSynced(this.viewport.camera);
      window.addEventListener("beforeunload", () => {
        void saveAutosave(this.doc);
      });
      (window as unknown as { __marmaracad?: unknown }).__marmaracad = {
        doc: () => this.doc,
        meshes: () => this.meshes,
        app: this,
        assistant: this.assistant,
        selections: () => ({ faces: this.selFaces, edges: this.selEdges, vertices: this.selVertices }),
        renderer: () => this.graphics.backend,
        kernel: () => ({
          bootMs: this.bootMs,
          fromCache: cadClient().kernelFromCache,
          bytes: cadClient().kernelBytes,
        }),
      };
    } catch (error) {
      setBoot(`Startup failed: ${messageOf(error)}`, 100);
      const bar = document.querySelector<HTMLElement>(".boot-bar");
      if (bar) bar.style.display = "none";
      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.textContent = "Reload";
      btn.style.marginTop = "18px";
      btn.addEventListener("click", () => window.location.reload());
      document.querySelector(".boot")?.appendChild(btn);
    }
  }

  // -------------------------------------------------------------- plumbing

  private bindShell(): void {
    this.shell.onCommand = (action) => void this.runAction(action);
    this.shell.onMenuAction = (action) => void this.runAction(action);
    this.shell.onModeChange = (mode) => this.setMode(mode);
    this.shell.onView = (name) => this.viewport.setView(name);
    this.shell.onDisplayStyle = (style) => this.setDisplayStyle(style);
    this.shell.onPlanesToggle = (visible) => this.setPlanes(visible);
    this.shell.onZoomFit = () => this.viewport.zoomFit();
    this.shell.onUndo = () => this.undo();
    this.shell.onRedo = () => this.redo();
    this.shell.onSave = () => void this.saveProject(false);
    this.shell.onSnapStep = (step) => this.editor.setSnapStep(step);
    this.shell.onMeshQuality = (quality) => {
      this.quality = quality;
      void this.rebuild();
    };
    this.shell.onTreeSelect = (kind, id, additive) => this.treeSelect(kind, id, additive);
    this.shell.onTreeToggle = (kind, id) => this.treeToggle(kind, id);
    this.shell.onTreeOpen = (kind, id) => void this.treeOpen(kind, id);
    this.shell.onTreeContext = (kind, id, x, y) => this.treeContext(kind, id, x, y);
    this.shell.onTreeAction = (action, kind, id) => void this.runTreeAction(action, kind, id);
    this.shell.onPickFilter = (filter) => this.setPickFilter(filter as PickFilter);
    this.shell.onSnapToggle = (on) => {
      this.editor.snaps = on
        ? { endpoint: true, midpoint: true, center: true, origin: true, quadrant: true, intersection: true, perpendicular: true, tangent: true, grid: true }
        : { endpoint: false, midpoint: false, center: false, origin: false, quadrant: false, intersection: false, perpendicular: false, tangent: false, grid: false };
      this.shell.setStatus(on ? "Object snap on" : "Object snap off · free cursor");
    };
    this.shell.onSnapSettings = (settings) => this.editor.setSnapSettings(settings);
    this.shell.onAssistantToggle = () => this.assistant.toggle();
    this.shell.onLanguageToggle = () => this.toggleLanguage();
    this.shell.onShortcut = (action) => void this.runAction(action);
    this.shell.onNavScheme = (scheme) => {
      this.navScheme = scheme;
      this.viewport.setNavScheme(scheme);
      toast(scheme === "cad" ? "SolidWorks / Fusion mouse scheme active." : "Legacy mouse scheme active (left-drag orbits).", "info");
    };
    this.viewport.onCameraChange = () => this.shell.setViewCubeSynced(this.viewport.camera);
  }

  private bindViewport(): void {
    this.viewport.onPickFace = (pick) => this.handleFacePick(pick);
    this.viewport.onPickEdge = (pick) => this.handleEdgePick(pick);
    this.viewport.onPickVertex = (pick) => this.handleVertexPick(pick);
    this.viewport.onBoxSelect = (selection) => this.applyBoxSelection(selection);
    this.viewport.onContextPick = (x, y, pick) => this.openViewportContext(x, y, pick);
    this.viewport.onPickFilterChanged = (filter) => this.shell.setPickFilter(filter);
    this.viewport.onHoverFace = () => undefined;
    this.viewport.onHoverEdge = () => undefined;
    // Capture modifier state before the viewport consumes the pointer event.
    document.addEventListener(
      "pointerdown",
      (event) => {
        this.pickMods = {
          ctrl: event.ctrlKey || event.metaKey,
          shift: event.shiftKey,
          additive: event.ctrlKey || event.metaKey || event.shiftKey,
        };
      },
      true,
    );
    this.viewport.container.addEventListener("contextmenu", (event) => {
      // The viewport opens its own context menu; keep the browser menu away.
      event.preventDefault();
    });
    this.viewport.container.addEventListener("pointermove", (event) => {
      this.lastPointer = { x: event.clientX, y: event.clientY };
    });
  }

  private bindKeys(): void {
    document.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      if (event.key === "Escape") {
        this.shell.hideContextMenu();
        this.shell.hideShortcutBar();
        this.shell.hideViewSelector();
        if (this.editor.isActive) {
          if (this.editor.cancel()) return;
          // Nothing to cancel: Esc backs out of an empty sketch, but never
          // discards a sketch that already has geometry.
          const sketch = this.editor.sketch;
          if (sketch && sketch.entities.length === 0 && sketch.points.length === 0) {
            this.cancelSketch();
            return;
          }
          this.editor.setTool("select");
          return;
        }
        if (this.command) this.cancelCommand();
        this.shell.closeMenu();
        return;
      }
      if (typing) return;
      if (event.key === " " && !this.editor.isActive) {
        event.preventDefault();
        this.shell.toggleViewSelector();
        return;
      }
      if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        this.showShortcuts();
        return;
      }
      if (event.key === "Enter" && this.command && this.panelRoot) {
        event.preventDefault();
        this.panelRoot.querySelector<HTMLElement>("[data-pm-ok]")?.click();
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key === "8") {
        event.preventDefault();
        this.normalToSelected();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "y") {
        event.preventDefault();
        this.redo();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void this.saveProject(false);
        return;
      }
      if (ctrl && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void this.openProject();
        return;
      }
      if (ctrl && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void this.newDocument();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (this.editor.isActive) {
          this.editor.deleteSelection();
          this.updateSketchPanelInfo();
        } else {
          void this.deleteSelected();
        }
        return;
      }
      if (event.key === "F2") {
        event.preventDefault();
        void this.renameSelected();
        return;
      }
      if (event.key.toLowerCase() === "f") {
        if (!this.editor.isActive) {
          event.preventDefault();
          this.viewport.zoomFit();
        }
        return;
      }
      if (event.key.toLowerCase() === "n" && !ctrl) {
        event.preventDefault();
        this.normalToSelected();
        return;
      }
      if (event.key.toLowerCase() === "s" && !ctrl && !this.editor.isActive) {
        event.preventDefault();
        this.openShortcutBar();
        return;
      }
      if (this.editor.isActive) {
        const map: Record<string, SketchTool> = {
          l: "line",
          r: "rectangle",
          c: "circle",
          a: "arc",
          d: "dimension",
          s: "select",
          t: "trim",
          o: "offset",
          x: "convert",
        };
        const tool = map[event.key.toLowerCase()];
        if (tool) this.setSketchTool(tool);
      }
    });
  }

  // ---------------------------------------------------------------- history

  private capture(): ProjectDocument {
    return cloneDocument(this.doc);
  }

  private commit(before: ProjectDocument): void {
    this.undos.push(before);
    if (this.undos.length > 60) this.undos.shift();
    this.redos.length = 0;
    this.shell.setUndoRedo(true, false);
    this.markStaleStudies(before);
    this.touchDocument();
  }

  /** Geometry or material edits keep solved results on screen but flag them stale. */
  private markStaleStudies(before: ProjectDocument): void {
    const signature = (doc: ProjectDocument) =>
      JSON.stringify({
        parts: doc.parts.map((p) => ({
          id: p.id,
          material: p.materialId,
          override: p.materialOverride,
          sketches: p.sketches.map((s) => ({ p: s.points, e: s.entities, c: s.constraints })),
          features: p.features.map((f) => ({ t: f.type, p: f.params, s: f.suppressed })),
          rollback: p.rollbackIndex,
        })),
        studies: doc.analyses.map((s) => ({
          id: s.id,
          part: s.partId,
          material: s.materialId,
          mesh: s.meshSize,
          supports: s.supports,
          loads: s.loads,
        })),
      });
    if (signature(before) === signature(this.doc)) return;
    for (const study of this.doc.analyses) {
      if (study.status === "solved") {
        study.stale = true;
        this.feaResults.delete(study.id);
        if (this.doc.activeStudyId === study.id) {
          this.activeResult = null;
          this.resultView.clear();
          this.shell.showColorbar(null);
          this.shell.showResultToolbar(null);
        }
      }
    }
  }

  private touchDocument(): void {
    touch(this.doc);
    this.scheduleAutosave();
    this.shell.setDocument(this.doc);
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = 0;
      void saveAutosave(this.doc);
    }, 1200);
  }

  private undo(): void {
    if (this.editor.isActive) {
      toast("Finish or cancel the sketch before undoing.", "warn");
      return;
    }
    const prev = this.undos.pop();
    if (!prev) return;
    if (this.doc.mode === "assembly") this.feaResults.clear();
    this.redos.push(cloneDocument(this.doc));
    this.doc = prev;
    this.shell.setUndoRedo(this.undos.length > 0, this.redos.length > 0);
    this.applyDocumentState({ history: true, clearResults: false });
  }

  private redo(): void {
    if (this.editor.isActive) {
      toast("Finish or cancel the sketch before redoing.", "warn");
      return;
    }
    const next = this.redos.pop();
    if (!next) return;
    this.undos.push(cloneDocument(this.doc));
    this.doc = next;
    this.shell.setUndoRedo(this.undos.length > 0, this.redos.length > 0);
    this.applyDocumentState({ history: true, clearResults: false });
  }

  // -------------------------------------------------------------- document

  private applyDocumentState(options: { history: boolean; clearResults: boolean }): void {
    if (this.editor.isActive) this.editor.end();
    if (this.command?.cancel) {
      try {
        this.command.cancel();
      } catch {
        /* command teardown is best-effort */
      }
    }
    this.command = null;
    this.sketchStartDoc = null;
    this.selection = null;
    this.selectedFace = null;
    this.selFaces = [];
    this.selEdges = [];
    this.selVertices = [];
    this.sectionState = { ...this.sectionState, enabled: false };
    this.toolbarMode = null;
    this.activeResult = null;
    this.shell.setSketching(false);
    this.shell.setSketchStatus(null);
    this.shell.setActiveCommand(null);
    this.shell.setHint(null);
    this.shell.hideConfirmationCorner();
    this.viewport.setPickFilter("all");
    this.shell.setPickFilter("all");
    this.viewport.setSelectedFaces([]);
    this.viewport.setSelectedEdges([]);
    this.viewport.setSelectedVertices([]);

    if (options.clearResults) this.feaResults.clear();
    if (!options.history) {
      this.undos = [];
      this.redos = [];
      this.shell.setUndoRedo(false, false);
    }
    if (!this.doc.parts.some((p) => p.id === this.doc.activePartId) && this.doc.parts[0]) {
      this.doc.activePartId = this.doc.parts[0].id;
    }
    if (this.doc.activeStudyId && !this.doc.analyses.some((s) => s.id === this.doc.activeStudyId)) {
      this.doc.activeStudyId = this.doc.analyses[0]?.id ?? null;
    }

    this.shell.setDocument(this.doc);
    this.shell.setMode(this.doc.mode);
    this.language = this.doc.language ?? this.language;
    this.shell.applyLanguage(this.language);
    this.shell.commandManager.setLanguage(this.language);
    this.shell.setCommandTab(this.doc.mode === "assembly" ? "assembly" : this.doc.mode === "analysis" ? "analysis" : "features");
    this.shell.setDisplayState(this.displayStyle, this.planesVisible);
    this.viewport.setPlanesVisible(this.planesVisible);
    this.refreshTree();
    this.updateMassCard();
    this.touchDocument();
    void this.rebuild();
  }

  private async newDocument(): Promise<void> {
    const ok = await confirmDialog("New Document", "Start a new, empty MarmaraCad document? The current model will be replaced.", "New Document");
    if (!ok) return;
    this.doc = createDocument();
    this.applyDocumentState({ history: false, clearResults: true });
    this.shell.setStatus("New document ready");
  }

  private async openProject(): Promise<void> {
    const files = await this.pickFiles(".json,.mcad,application/json");
    if (!files.length) return;
    try {
      const text = await files[0].text();
      const doc = parseProject(text);
      this.applyDocument(doc);
      void addRecent(doc);
      toast(`Opened “${doc.name}”.`, "success");
    } catch (error) {
      await alertDialog("Open Project", `<p>${escapeHtml(messageOf(error))}</p>`, "alert-triangle");
    }
  }

  private applyDocument(doc: ProjectDocument): void {
    this.doc = doc;
    this.applyDocumentState({ history: false, clearResults: true });
  }

  private async saveProject(saveAs: boolean): Promise<void> {
    if (saveAs || this.doc.name === "Untitled") {
      const name = await this.promptText("Save Project", "Document name", this.doc.name === "Untitled" ? "My Part" : this.doc.name);
      if (!name) return;
      this.doc.name = name;
      this.shell.setDocument(this.doc);
      this.refreshTree();
    }
    touch(this.doc);
    const text = serializeProject(this.doc);
    downloadText(text, `${safeFilename(this.doc.name)}.mcad.json`, "application/json");
    await saveAutosave(this.doc);
    await addRecent(this.doc);
    this.shell.setStatus(`Saved ${this.doc.name}.mcad.json`);
    toast("Project saved to your downloads.", "success");
  }

  private async promptText(title: string, label: string, value: string): Promise<string | null> {
    const body = document.createElement("div");
    body.className = "prompt-body";
    body.innerHTML = `<label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:5px;">${escapeHtml(label)}</label>
      <input id="prompt-name" type="text" value="${escapeHtml(value)}" style="width:100%;height:34px;" />`;
    const result = await openModal({
      title,
      icon: "pencil",
      body,
      width: 420,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "OK", value: "ok", kind: "primary" },
      ],
      onMount: () => {
        /* the input is read back from the body after the modal closes */
      },
    });
    const text = body.querySelector<HTMLInputElement>("#prompt-name")?.value.trim();
    if (result !== "ok" || !text) return null;
    return text;
  }

  // ---------------------------------------------------------------- rebuild

  private activePart(): Part | undefined {
    return this.doc.parts.find((p) => p.id === this.doc.activePartId) ?? this.doc.parts[0];
  }

  /** Study material with per-part overrides applied. */
  private materialForStudy(study: AnalysisStudy | undefined): ReturnType<typeof partMaterial> {
    const part = study ? this.doc.parts.find((p) => p.id === study.partId) : undefined;
    return part ? partMaterial(part) : materialById(study?.materialId);
  }

  private activeStudy(): AnalysisStudy | undefined {
    return this.doc.analyses.find((s) => s.id === this.doc.activeStudyId) ?? this.doc.analyses[0];
  }

  private meshForPart(partId: string): MeshData | undefined {
    const direct = this.meshes.get(partId);
    if (direct) return direct;
    const part = this.doc.parts.find((p) => p.id === partId);
    if (part?.meshOnly) return this.loadLocalMesh(part);
    return undefined;
  }

  private loadLocalMesh(part: Part): MeshData | undefined {
    const existing = this.meshes.get(part.id);
    if (existing) return existing;
    if (!part.asset) return undefined;
    try {
      const buffer = base64ToArrayBuffer(part.asset.dataBase64);
      const mesh =
        part.asset.format === "stl"
          ? parseSTL(buffer)
          : part.asset.format === "obj"
            ? parseOBJ(new TextDecoder().decode(buffer))
            : null;
      if (!mesh) return undefined;
      this.meshes.set(part.id, mesh);
      return mesh;
    } catch {
      return undefined;
    }
  }

  private async rebuild(): Promise<void> {
    const token = ++this.rebuildToken;
    const partIds = new Set(this.doc.parts.map((p) => p.id));
    for (const key of [...this.meshes.keys()]) if (!partIds.has(key)) this.meshes.delete(key);

    for (const part of this.doc.parts) {
      if (part.meshOnly || part.asset?.format === "stl" || part.asset?.format === "obj") this.loadLocalMesh(part);
      for (const feature of part.features) feature.error = undefined;
    }

    const cadParts = this.doc.parts
      .filter((part) => !part.meshOnly && part.asset?.format !== "stl" && part.asset?.format !== "obj")
      .map((part) => ({
        id: part.id,
        sketches: part.sketches,
        features: part.features,
        assetBase64: part.asset?.dataBase64,
        assetFormat: part.asset?.format,
        assetRev: part.asset?.rev,
        rollbackIndex: part.rollbackIndex,
      }));
    if (cadParts.length === 0) {
      this.refreshScene();
      this.refreshTree();
      this.updateMassCard();
      return;
    }

    this.shell.setBusy(true);
    try {
      const result = await cadClient().rebuild(cadParts, this.quality);
      if (token !== this.rebuildToken) return;
      for (const part of this.doc.parts) {
        const mesh = result.parts[part.id];
        if (mesh) this.meshes.set(part.id, mesh);
      }
      const messages: string[] = [];
      for (const part of this.doc.parts) {
        const errors = result.errors[part.id];
        if (!errors) continue;
        for (const [key, message] of Object.entries(errors)) {
          const feature = part.features.find((f) => f.id === key);
          if (feature) feature.error = String(message);
          messages.push(`${part.name}: ${String(message)}`);
        }
      }
      if (messages.length) toast(messages[0], "warn", 6000);
      this.refreshScene();
      this.shell.setStatus(`Rebuilt in ${result.kernelMs} ms · ${this.viewport.bodyCount} body(ies)`);
      this.refreshTree();
      this.updateMassCard();
    } catch (error) {
      if (token === this.rebuildToken) {
        this.shell.setStatus(`Rebuild failed: ${messageOf(error)}`);
        toast(messageOf(error), "error", 7000);
      }
    } finally {
      if (token === this.rebuildToken) this.shell.setBusy(false);
    }
  }

  private refreshScene(): void {
    const bodies: SceneBody[] = [];
    const activePart = this.activePart();
    // The section cut is done on the CPU (Sutherland–Hodgman + capped loops) so
    // it behaves the same on the WebGL2 and WebGPU backends. Picking is disabled
    // while the cut is active, so rebuilding the topology here is safe.
    const cut = this.sectionState;
    const sectionActive = cut.enabled && this.doc.mode !== "analysis" && !this.editor?.isActive;
    const cutMesh = (mesh: MeshData): MeshData =>
      sectionActive ? sectionMesh(mesh, { enabled: true, axis: cut.axis, offset: cut.offset, flipped: cut.flipped }) : mesh;
    if (this.doc.mode === "assembly") {
      for (const component of this.doc.components) {
        const part = this.doc.parts.find((p) => p.id === component.partId);
        if (!part) continue;
        const mesh = this.meshForPart(part.id);
        if (!mesh || mesh.positions.length === 0) continue;
        let bodyMesh = mesh;
        let position = component.position;
        let rotation = component.rotation;
        if (sectionActive) {
          // Cut in world space, then place the already-transformed body at the origin.
          bodyMesh = cutMesh(transformMeshData(mesh, componentMatrix(component.position, component.rotation)));
          position = [0, 0, 0];
          rotation = [0, 0, 0];
        }
        bodies.push({
          partId: part.id,
          componentId: component.id,
          mesh: bodyMesh,
          color: component.color ?? part.color,
          visible: component.visible && part.visible,
          position,
          rotation,
        });
      }
    } else if (activePart) {
      const mesh = this.meshForPart(activePart.id);
      if (mesh && mesh.positions.length > 0) {
        bodies.push({
          partId: activePart.id,
          componentId: null,
          mesh: cutMesh(mesh),
          color: activePart.color,
          visible: activePart.visible && !this.resultIsVisible(),
          position: [0, 0, 0],
          rotation: [0, 0, 0],
        });
      }
    }
    this.viewport.setBodies(bodies);
    this.viewport.setSectionState(this.sectionState);
    this.viewport.setActiveComponent(this.doc.mode === "assembly" ? this.doc.activeComponentId : null);
    if (this.doc.mode === "analysis") this.syncResultView();
    else {
      this.resultView.clear();
      this.shell.showColorbar(null);
      this.shell.showResultToolbar(null);
      this.toolbarMode = null;
    }
  }

  private resultIsVisible(): boolean {
    if (this.doc.mode !== "analysis" || !this.activeResult) return false;
    const study = this.activeStudy();
    return !!study && this.feaResults.has(study.id);
  }

  private updateMassCard(): void {
    if (this.doc.mode === "assembly") {
      let volume = 0;
      let area = 0;
      let grams = 0;
      let count = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const component of this.doc.components) {
        if (!component.visible) continue;
        const part = this.doc.parts.find((p) => p.id === component.partId);
        const mesh = part ? this.meshForPart(part.id) : undefined;
        if (!part || !mesh || mesh.positions.length === 0) continue;
        volume += mesh.volume;
        area += mesh.area;
        grams += mesh.volume * (part.materialId ? partMaterial(part).density : 0) * 1e-6;
        const centroid = meshMass(mesh).centroid;
        cx += centroid[0] * mesh.volume;
        cy += centroid[1] * mesh.volume;
        cz += centroid[2] * mesh.volume;
        count++;
      }
      if (count === 0) {
        this.shell.setMassRows([{ label: "Volume", value: "—" }, { label: "Mass", value: "—" }, { label: "Area", value: "—" }]);
        return;
      }
      this.shell.setMassRows([
        { label: "Volume", value: `${fmt(volume, 0)} mm³` },
        { label: "Mass", value: grams >= 1000 ? `${fmt(grams / 1000, 3)} kg` : `${fmt(grams, 1)} g` },
        { label: "Area", value: `${fmt(area, 0)} mm²` },
        { label: "CoM X", value: `${fmt(cx / volume, 2)} mm` },
        { label: "CoM Y", value: `${fmt(cy / volume, 2)} mm` },
        { label: "CoM Z", value: `${fmt(cz / volume, 2)} mm` },
        { label: "Components", value: `${count} visible` },
      ]);
      return;
    }
    const part = this.activePart();
    const mesh = part ? this.meshForPart(part.id) : undefined;
    if (!part || !mesh || mesh.positions.length === 0) {
      this.shell.setMassRows([{ label: "Volume", value: "—" }, { label: "Mass", value: "—" }, { label: "Area", value: "—" }]);
      return;
    }
    const material = part.materialId ? partMaterial(part) : undefined;
    const centroid = meshMass(mesh).centroid;
    this.shell.setMassRows([
      { label: "Volume", value: `${fmt(mesh.volume, 0)} mm³` },
      { label: "Mass", value: material ? formatMass(mesh.volume, material.density) : "no material" },
      { label: "Area", value: `${fmt(mesh.area, 0)} mm²` },
      { label: "CoM X", value: `${fmt(centroid[0], 2)} mm` },
      { label: "CoM Y", value: `${fmt(centroid[1], 2)} mm` },
      { label: "CoM Z", value: `${fmt(centroid[2], 2)} mm` },
    ]);
  }

  private sketchInfoMap(): Record<string, SketchInfo> {
    const info: Record<string, SketchInfo> = {};
    for (const part of this.doc.parts) {
      for (const sketch of part.sketches) {
        const summary = profileSummary(sketch);
        info[sketch.id] = {
          closed: summary.closed,
          area: summary.remainingArea || summary.area,
          warnings: summary.warnings,
        };
      }
    }
    return info;
  }

  private selectionKey(): string | null {
    return this.selection ? `${this.selection.kind}:${this.selection.id}` : null;
  }

  private refreshTree(): void {
    this.shell.setTreeContext({
      doc: this.doc,
      mode: this.doc.mode,
      selection: this.selectionKey(),
      expanded: this.expanded,
      planesVisible: this.planesVisible,
      sketchInfo: this.sketchInfoMap(),
      activeResult: this.activeResult,
    });
  }

  private setSelection(kind: string, id: string): void {
    this.selection = { kind, id };
    this.refreshTree();
  }

  private setMode(mode: WorkspaceMode): void {
    if (this.editor.isActive) {
      toast("Finish the sketch before switching workspaces.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    this.doc.mode = mode;
    if (mode === "analysis") {
      const study = this.activeStudy();
      if (study) this.doc.activePartId = study.partId;
    }
    this.shell.setMode(mode);
    this.shell.setCommandTab(mode === "assembly" ? "assembly" : mode === "analysis" ? "analysis" : "features");
    this.shell.setDocument(this.doc);
    this.refreshScene();
    this.refreshTree();
    this.touchDocument();
  }

  private setDisplayStyle(style: DisplayStyle): void {
    this.displayStyle = style;
    this.viewport.setDisplayStyle(style);
    this.shell.setDisplayState(style, this.planesVisible);
  }

  private setPlanes(visible: boolean): void {
    this.planesVisible = visible;
    this.viewport.setPlanesVisible(visible);
    this.shell.setDisplayState(this.displayStyle, visible);
    this.refreshTree();
  }

  private sketchDirty = false;

  // ------------------------------------------------------------ tree events

  private treeSelect(kind: string, id: string, _additive: boolean): void {
    if (kind === "plane") {
      this.setSelection(kind, id);
      if (!this.planesVisible) this.setPlanes(true);
      this.shell.setStatus(`${id[0].toUpperCase() + id.slice(1)} Plane selected · click New Sketch`);
      return;
    }
    if (kind === "part") {
      this.doc.activePartId = id;
      this.setSelection(kind, id);
      this.shell.setDocument(this.doc);
      this.refreshScene();
      this.updateMassCard();
      return;
    }
    if (kind === "component") {
      this.doc.activeComponentId = id;
      this.setSelection(kind, id);
      this.viewport.setActiveComponent(id);
      this.refreshScene();
      this.shell.setStatus(`${this.doc.components.find((c) => c.id === id)?.name ?? "Component"} selected`);
      return;
    }
    this.setSelection(kind, id);
    if (kind === "study" || kind === "study-material" || kind === "study-mesh") {
      const study = this.doc.analyses.find((s) => s.id === id);
      if (study) {
        this.doc.activeStudyId = study.id;
        this.doc.activePartId = study.partId;
      }
    }
  }

  private treeToggle(kind: string, id: string): void {
    if (kind === "sketch") {
      const part = this.doc.parts.find((p) => p.sketches.some((s) => s.id === id));
      const sketch = part?.sketches.find((s) => s.id === id);
      if (!sketch) return;
      sketch.visible = !sketch.visible;
      this.refreshTree();
      this.touchDocument();
      return;
    }
    if (kind === "part") {
      const part = this.doc.parts.find((p) => p.id === id);
      if (!part) return;
      part.visible = !part.visible;
      this.refreshScene();
      this.refreshTree();
      this.touchDocument();
      return;
    }
    if (kind === "component") {
      const component = this.doc.components.find((c) => c.id === id);
      if (!component) return;
      component.visible = !component.visible;
      this.refreshScene();
      this.refreshTree();
      this.touchDocument();
    }
  }

  private async treeOpen(kind: string, id: string): Promise<void> {
    if (kind === "plane") {
      this.startSketch(basePlane(id as "front" | "top" | "right"));
      return;
    }
    if (kind === "sketch") {
      const sketch = this.doc.parts.flatMap((p) => p.sketches).find((s) => s.id === id);
      if (sketch) this.beginExistingSketch(sketch);
      return;
    }
    if (kind === "feature") {
      const feature = this.doc.parts.flatMap((p) => p.features).find((f) => f.id === id);
      if (feature) this.editFeature(feature);
      return;
    }
    if (kind === "component") {
      this.openTransform(id);
      return;
    }
    if (kind === "study" || kind === "study-material" || kind === "study-mesh" || kind === "study-geometry") {
      const study = this.doc.analyses.find((s) => s.id === id);
      if (study) {
        this.doc.activeStudyId = study.id;
        this.doc.activePartId = study.partId;
        this.openStudyPanel();
      }
      return;
    }
    if (kind === "result") {
      this.showResult(id as ResultMode);
      return;
    }
    if (kind === "mate") {
      const mate = this.doc.mates.find((m) => m.id === id);
      if (mate) this.openMate(mate.type, mate);
      return;
    }
    if (kind === "load") {
      const study = this.activeStudy();
      const load = study?.loads.find((l) => l.id === id);
      if (study && load) void this.editLoad(study, load);
    }
  }

  private treeContext(kind: string, id: string, x: number, y: number): void {
    const items: { label: string; icon: string; run: () => void; danger?: boolean }[] = [];
    if (kind === "plane") {
      items.push({ label: "New Sketch on This Plane", icon: "drafting-compass", run: () => void this.treeOpen(kind, id) });
    }
    if (kind === "sketch") {
      items.push({ label: "Edit Sketch", icon: "pencil", run: () => void this.treeOpen(kind, id) });
      items.push({ label: "Rename…", icon: "pencil", run: () => void this.renameSelected() });
      items.push({ label: "Delete Sketch", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "feature") {
      items.push({ label: "Edit Feature", icon: "pencil", run: () => void this.treeOpen(kind, id) });
      items.push({ label: "Rename…", icon: "pencil", run: () => void this.renameSelected() });
      items.push({ label: "Delete Feature", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "part") {
      items.push({ label: "Edit Material…", icon: "layers", run: () => this.openMaterialDialog(id) });
      items.push({ label: "Clear Rollback", icon: "refresh-cw", run: () => void this.runTreeAction("rollback-clear", "part", id) });
      items.push({ label: "Rename…", icon: "pencil", run: () => void this.renameSelected() });
      items.push({ label: "Delete Part", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "component") {
      items.push({ label: "Transform…", icon: "move-3d", run: () => this.openTransform(id) });
      items.push({ label: "Fix / Float", icon: "lock", run: () => this.toggleFixed(id) });
      items.push({ label: "Rename…", icon: "pencil", run: () => void this.renameSelected() });
      items.push({ label: "Delete Component", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "mate") {
      items.push({ label: "Rename…", icon: "pencil", run: () => void this.renameSelected() });
      items.push({ label: "Delete Mate", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "study") {
      items.push({ label: "Open Study", icon: "activity", run: () => this.openStudyPanel() });
      items.push({ label: "Delete Study", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (kind === "load" || kind === "support") {
      items.push({ label: "Delete", icon: "trash-2", run: () => void this.deleteSelected(), danger: true });
    }
    if (items.length === 0) {
      items.push({ label: "Insert Component", icon: "plus", run: () => this.insertComponent() });
      items.push({ label: "New Study", icon: "activity", run: () => void this.newStudy() });
    }
    this.contextMenu(items, x, y);
  }

  private async runTreeAction(action: string, kind?: string, id?: string): Promise<void> {
    if (action === "twist") {
      const key = id ?? "";
      const normalized =
        key.startsWith("study-loads:")
          ? `loads:${key.slice("study-loads:".length)}`
          : key.startsWith("study-solution:")
            ? `solution:${key.slice("study-solution:".length)}`
            : key === "parts-folder"
              ? "parts"
              : key === "components-folder"
                ? "components"
                : key === "mates-folder"
                  ? "mates"
                  : key;
      if (this.expanded.has(normalized)) this.expanded.delete(normalized);
      else this.expanded.add(normalized);
      this.refreshTree();
      return;
    }
    if (action === "new-sketch") {
      await this.newSketchCommand();
      return;
    }
    if (action === "sample") {
      await this.loadSample();
      return;
    }
    if (action === "insert-component") {
      await this.insertComponent();
      return;
    }
    if (action === "mate") {
      this.openMate("coincident");
      return;
    }
    if (action === "resolve-mates") {
      this.resolveMates();
      return;
    }
    if (action === "mesh") {
      void this.meshStudy();
      return;
    }
    if (action === "solve") {
      void this.solveStudy();
      return;
    }
    if (action === "new-study") {
      await this.newStudy();
      return;
    }
    if (action === "edit-material") {
      this.openMaterialDialog(id);
      return;
    }
    if (action === "rollback") {
      const [partId, featureId] = (id ?? "").split("|");
      const part = this.doc.parts.find((p) => p.id === partId);
      const index = part?.features.findIndex((f) => f.id === featureId) ?? -1;
      if (part && index >= 0) {
        const before = this.capture();
        part.rollbackIndex = index + 1;
        this.commit(before);
        this.refreshTree();
        void this.rebuild();
        toast(`Rolled back after ${part.features[index].name}.`, "info");
      }
      return;
    }
    if (action === "rollback-clear") {
      const part = this.doc.parts.find((p) => p.id === id) ?? this.activePart();
      if (part?.rollbackIndex !== undefined) {
        const before = this.capture();
        part.rollbackIndex = undefined;
        this.commit(before);
        this.refreshTree();
        void this.rebuild();
      }
      return;
    }
    if (action === "delete") {
      await this.deleteSelected();
      return;
    }
    void this.runAction(action, kind, id);
  }

  // ----------------------------------------------------------- view picking

  private handleFacePick(pick: FacePick | null): void {
    if (this.command?.onFace) {
      if (pick) this.command.onFace(pick, this.pickMods);
      return;
    }
    if (!pick) {
      if (!this.pickMods.additive) this.clearSelection();
      return;
    }
    if (this.pickMods.additive) {
      const i = this.selFaces.findIndex((f) => f.componentId === pick.componentId && f.faceIndex === pick.faceIndex);
      if (i >= 0) this.selFaces.splice(i, 1);
      else this.selFaces.push(pick);
    } else {
      this.selFaces = [pick];
      this.selEdges = [];
      this.selVertices = [];
    }
    this.selectedFace = this.selFaces[this.selFaces.length - 1] ?? null;
    this.syncSelection();
  }

  private handleEdgePick(pick: EdgePick | null): void {
    if (this.command?.onEdge) {
      if (pick) this.command.onEdge(pick, this.pickMods);
      return;
    }
    if (!pick) {
      if (!this.pickMods.additive) this.clearSelection();
      return;
    }
    if (this.pickMods.additive) {
      const i = this.selEdges.findIndex((e) => e.componentId === pick.componentId && e.edgeIndex === pick.edgeIndex);
      if (i >= 0) this.selEdges.splice(i, 1);
      else this.selEdges.push(pick);
    } else {
      this.selEdges = [pick];
      this.selFaces = [];
      this.selVertices = [];
    }
    this.syncSelection();
  }

  private handleVertexPick(pick: VertexPick | null): void {
    if (this.command?.onVertex) {
      if (pick) this.command.onVertex(pick, this.pickMods);
      return;
    }
    if (!pick) {
      if (!this.pickMods.additive) this.clearSelection();
      return;
    }
    if (this.pickMods.additive) {
      const key = pick.point.map((v) => Math.round(v * 100)).join(",");
      const i = this.selVertices.findIndex((v) => v.point.map((q) => Math.round(q * 100)).join(",") === key);
      if (i >= 0) this.selVertices.splice(i, 1);
      else this.selVertices.push(pick);
    } else {
      this.selVertices = [pick];
      this.selFaces = [];
      this.selEdges = [];
    }
    this.syncSelection();
  }

  private clearSelection(): void {
    this.selectedFace = null;
    this.selFaces = [];
    this.selEdges = [];
    this.selVertices = [];
    this.viewport.setSelectedFaces([]);
    this.viewport.setSelectedEdges([]);
    this.viewport.setSelectedVertices([]);
    this.shell.setSelection(null);
    this.shell.setStatus("Ready");
  }

  private syncSelection(): void {
    this.viewport.setSelectedFaces(this.selFaces.map((p) => ({ componentId: p.componentId, faceIndex: p.faceIndex })));
    this.viewport.setSelectedEdges(this.selEdges.map((p) => ({ componentId: p.componentId, edgeIndex: p.edgeIndex })));
    this.viewport.setSelectedVertices(this.selVertices.map((p) => ({ componentId: p.componentId, point: p.point })));
    const labels: string[] = [];
    if (this.selFaces.length === 1) {
      const f = this.selFaces[0];
      labels.push(`Face ${f.faceIndex + 1} · ${f.face.surface}`);
    } else if (this.selFaces.length > 1) labels.push(`${this.selFaces.length} faces`);
    if (this.selEdges.length === 1) {
      const e = this.selEdges[0];
      labels.push(`Edge ${e.edgeIndex + 1} · ${fmt(e.edge.length, 2)} mm`);
    } else if (this.selEdges.length > 1) {
      const total = this.selEdges.reduce((sum, e) => sum + e.edge.length, 0);
      labels.push(`${this.selEdges.length} edges · ${fmt(total, 1)} mm`);
    }
    if (this.selVertices.length === 1) labels.push(`Vertex (${this.selVertices[0].point.map((v) => fmt(v, 1)).join(", ")})`);
    else if (this.selVertices.length > 1) labels.push(`${this.selVertices.length} vertices`);
    this.shell.setSelection(labels.length ? labels.join("  ·  ") : null);
    this.shell.setStatus(
      labels.length
        ? `${labels.join(" · ")} selected${this.selFaces.length + this.selEdges.length + this.selVertices.length > 1 ? " · Ctrl/Shift+click to add or remove" : ""}`
        : "Ready",
    );
  }

  private applyBoxSelection(selection: BoxSelection): void {
    const filter = this.viewport.getPickFilter();
    const additive = this.pickMods.additive;
    const faces = filter === "face" || filter === "all" ? selection.faces : [];
    const edges = filter === "edge" ? selection.edges : [];
    const vertices = filter === "vertex" ? selection.vertices : [];
    if (!additive) {
      this.selFaces = [];
      this.selEdges = [];
      this.selVertices = [];
    }
    const faceKeys = new Set(this.selFaces.map((f) => `${f.componentId}:${f.faceIndex}`));
    for (const f of faces) {
      const key = `${f.componentId}:${f.faceIndex}`;
      if (!faceKeys.has(key)) {
        faceKeys.add(key);
        this.selFaces.push(f);
      }
    }
    const edgeKeys = new Set(this.selEdges.map((e) => `${e.componentId}:${e.edgeIndex}`));
    for (const e of edges) {
      const key = `${e.componentId}:${e.edgeIndex}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        this.selEdges.push(e);
      }
    }
    const vKeys = new Set(this.selVertices.map((v) => v.point.map((q) => Math.round(q * 100)).join(",")));
    for (const v of vertices) {
      const key = v.point.map((q) => Math.round(q * 100)).join(",");
      if (!vKeys.has(key)) {
        vKeys.add(key);
        this.selVertices.push(v);
      }
    }
    this.syncSelection();
    this.shell.setStatus(
      `${selection.crossing ? "Crossing" : "Window"} selection · ${this.selFaces.length + this.selEdges.length + this.selVertices.length} object(s)`,
    );
  }

  private setPickFilter(filter: PickFilter): void {
    this.viewport.setPickFilter(filter);
    this.shell.setPickFilter(filter);
    if (filter === "edge") this.shell.setHint("Edge filter active · drag a window or Ctrl+click edges");
    else if (filter === "vertex") this.shell.setHint("Vertex filter active · Ctrl+click to collect vertices");
    else if (filter === "face") this.shell.setHint("Face filter active · Ctrl+click to collect faces");
    else this.shell.setHint(null);
  }

  private openViewportContext(x: number, y: number, pick: { face?: FacePick; edge?: EdgePick; vertex?: VertexPick }): void {
    const items: { label: string; icon?: string; run: () => void; danger?: boolean }[] = [];
    if (pick.edge) {
      const edge = pick.edge;
      items.push({
        label: "Select Loop",
        icon: "refresh-cw",
        run: () => {
          const loop = this.viewport.edgeLoop(edge, false);
          this.selEdges = loop;
          this.syncSelection();
          toast(`${loop.length} edge(s) in the loop.`, "info");
        },
      });
      items.push({
        label: "Select Tangency",
        icon: "link",
        run: () => {
          const loop = this.viewport.edgeLoop(edge, true);
          this.selEdges = loop;
          this.syncSelection();
          toast(`${loop.length} tangent edge(s).`, "info");
        },
      });
      items.push({
        label: "Measure Edge",
        icon: "ruler",
        run: () => {
          this.selEdges = [edge];
          this.syncSelection();
          this.openMeasure();
        },
      });
    } else if (pick.face) {
      const face = pick.face;
      items.push({
        label: "Sketch on Face",
        icon: "drafting-compass",
        run: () => {
          this.selFaces = [face];
          this.selectedFace = face;
          this.syncSelection();
          void this.newSketchCommand();
        },
      });
      items.push({
        label: "Normal To",
        icon: "camera",
        run: () => {
          this.selFaces = [face];
          this.selectedFace = face;
          this.syncSelection();
          this.viewport.normalTo(face.face.point, face.face.normal);
        },
      });
      items.push({
        label: "Measure Face",
        icon: "ruler",
        run: () => {
          this.selFaces = [face];
          this.selectedFace = face;
          this.syncSelection();
          this.openMeasure();
        },
      });
    } else if (pick.vertex) {
      const vertex = pick.vertex;
      items.push({
        label: "Measure Vertex",
        icon: "ruler",
        run: () => {
          this.selVertices = [vertex];
          this.syncSelection();
          this.openMeasure();
        },
      });
    }
    if (items.length) items.push({ label: "—", run: () => undefined });
    const pickedPartId = pick.face?.partId ?? pick.edge?.partId ?? pick.vertex?.partId;
    const pickedComponentId = pick.face?.componentId ?? pick.edge?.componentId ?? pick.vertex?.componentId;
    items.push({
      label: "Hide / Show",
      icon: "eye",
      run: () => {
        const before = this.capture();
        if (pickedComponentId) {
          const component = this.doc.components.find((c) => c.id === pickedComponentId);
          if (component) component.visible = !component.visible;
        } else if (pickedPartId) {
          const part = this.doc.parts.find((p) => p.id === pickedPartId);
          if (part) part.visible = !part.visible;
        }
        this.commit(before);
        this.refreshScene();
        this.refreshTree();
        toast("Visibility toggled.", "info");
      },
    });
    const selected = this.selection;
    if (selected) {
      items.push({
        label: `Edit ${selected.kind}`,
        icon: "pencil",
        run: () => void this.treeOpen(selected.kind, selected.id),
      });
      items.push({
        label: `Delete ${selected.kind}`,
        icon: "trash-2",
        danger: true,
        run: () => void this.deleteSelected(),
      });
    }
    items.push({
      label: "Zoom Fit",
      icon: "maximize",
      run: () => this.viewport.zoomFit(),
    });
    items.push({
      label: "Isometric",
      icon: "box",
      run: () => this.viewport.setView("iso"),
    });
    items.push({
      label: "Section View",
      icon: "scan",
      run: () => this.openSection(),
    });
    items.push({
      label: "Clear Selection",
      icon: "x",
      run: () => this.clearSelection(),
    });
    const viewArea = this.shell.root.querySelector<HTMLElement>(".view-area");
    const rect = viewArea?.getBoundingClientRect();
    this.shell.showContextMenu(
      Math.min(x - (rect?.left ?? 0), (rect?.width ?? 400) - 210),
      Math.min(y - (rect?.top ?? 0), (rect?.height ?? 300) - 240),
      items.filter((item) => item.label !== "—"),
    );
  }

  private normalToSelected(): void {
    const face = this.selFaces[this.selFaces.length - 1] ?? this.selectedFace;
    if (face) {
      this.viewport.normalTo(face.face.point, face.face.normal);
      this.shell.setStatus(`Normal to face ${face.faceIndex + 1}`);
      return;
    }
    this.viewport.setView("front");
    this.shell.setStatus("Normal to front plane");
  }

  private openShortcutBar(): void {
    const x = this.lastPointer.x || window.innerWidth / 2;
    const y = this.lastPointer.y || window.innerHeight / 2;
    const items = this.editor.isActive
      ? [
          { action: "tool-line", label: "Line", icon: "pencil" },
          { action: "tool-rectangle", label: "Rectangle", icon: "rectangle-horizontal" },
          { action: "tool-circle", label: "Circle", icon: "circle" },
          { action: "tool-arc", label: "3-Pt Arc", icon: "circle-dot" },
          { action: "tool-dimension", label: "Dimension", icon: "ruler" },
          { action: "tool-trim", label: "Trim", icon: "split" },
          { action: "sketch-offset", label: "Offset", icon: "arrow-right-left" },
          { action: "tool-convert", label: "Convert", icon: "waypoints" },
          { action: "sketch-construction", label: "Construction", icon: "ruler" },
          { action: "exit-sketch", label: "Exit Sketch", icon: "check" },
        ]
      : [
          { action: "new-sketch", label: "New Sketch", icon: "drafting-compass" },
          { action: "extrude-boss", label: "Extrude", icon: "square" },
          { action: "fillet", label: "Fillet", icon: "circle" },
          { action: "shell", label: "Shell", icon: "box" },
          { action: "measure", label: "Measure", icon: "ruler" },
          { action: "section-view", label: "Section", icon: "scan" },
          { action: "make-drawing", label: "Drawing", icon: "file-down" },
          { action: "material-library", label: "Material", icon: "layers" },
          { action: "equations", label: "Equations", icon: "equal" },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize" },
        ];
    this.shell.showShortcutBar(x, y, items);
  }

  private toggleLanguage(): void {
    this.language = this.language === "en" ? "tr" : "en";
    this.doc.language = this.language;
    this.shell.setLanguageButton(this.language);
    this.shell.applyLanguage(this.language);
    this.shell.commandManager.setLanguage(this.language);
    this.refreshTree();
    this.touchDocument();
    toast(this.language === "tr" ? "Arayüz dili: Türkçe" : "Interface language: English", "info");
  }

  // ---------------------------------------------------------------- measure

  private openMeasure(): void {
    if (this.command) this.cancelCommand();
    // Seed from the current selection.
    this.measurePicks = [
      ...this.selEdges.map((e) => ({ kind: "edge" as const, label: `Edge ${e.edgeIndex + 1}`, point: e.edge.points[0] ?? [0, 0, 0], length: e.edge.length })),
      ...this.selFaces.map((f) => ({ kind: "face" as const, label: `Face ${f.faceIndex + 1}`, point: f.face.point, normal: f.face.normal })),
      ...this.selVertices.map((v) => ({ kind: "vertex" as const, label: "Vertex", point: v.point })),
    ];
    const addPick = (p: (typeof this.measurePicks)[number]) => {
      if (this.measurePicks.length >= 2) this.measurePicks.shift();
      this.measurePicks.push(p);
      render();
    };
    this.command = {
      kind: "measure",
      onEdge: (pick, mods) => {
        if (mods.additive && this.measurePicks.some((p) => p.kind === "edge" && p.label === `Edge ${pick.edgeIndex + 1}`)) {
          this.measurePicks = this.measurePicks.filter((p) => p.label !== `Edge ${pick.edgeIndex + 1}`);
          render();
          return;
        }
        addPick({ kind: "edge", label: `Edge ${pick.edgeIndex + 1}`, point: pick.edge.points[0] ?? [0, 0, 0], length: pick.edge.length });
      },
      onFace: (pick, mods) => {
        if (mods.additive && this.measurePicks.some((p) => p.kind === "face" && p.label === `Face ${pick.faceIndex + 1}`)) {
          this.measurePicks = this.measurePicks.filter((p) => p.label !== `Face ${pick.faceIndex + 1}`);
          render();
          return;
        }
        addPick({ kind: "face", label: `Face ${pick.faceIndex + 1}`, point: pick.face.point, normal: pick.face.normal });
      },
      onVertex: (pick, mods) => {
        if (mods.additive) {
          this.measurePicks = this.measurePicks.filter((p) => p.point !== pick.point);
          render();
          return;
        }
        addPick({ kind: "vertex", label: "Vertex", point: pick.point });
      },
    };
    const render = () => {
      const host = this.panelRoot?.querySelector<HTMLElement>("#pm-measure");
      if (host) host.innerHTML = this.measureHtml();
      this.shell.setSelection(this.measurePicks.map((p) => `${p.label} ${p.length !== undefined ? fmt(p.length, 2) + " mm" : ""}`).join(" · ") || null);
      this.showMeasureReadout();
    };
    this.viewport.setPickFilter("all");
    this.shell.setPickFilter("all");
    this.shell.setHint("Measure: click edges, faces or vertices. A second pick computes the distance/angle.");
    this.showPanel({
      icon: "ruler",
      title: "Measure",
      sub: "Distance · angle · length",
      okTitle: "Done",
      body: pmSection("Selections", "ruler", `<div id="pm-measure">${this.measureHtml()}</div><div class="hint" style="margin-top:6px">Ctrl+click a listed item to remove it. Edge length, face-to-face distance/angle and point-to-point distance are supported.</div>`),
      onMount: () => {
        render();
      },
      onOk: () => {
        this.shell.measureEl.classList.remove("visible");
        this.finishCommand();
      },
      onCancel: () => {
        this.shell.measureEl.classList.remove("visible");
        this.cancelCommand();
      },
    });
    this.showMeasureReadout();
  }

  private measureHtml(): string {
    const picks = this.measurePicks;
    if (picks.length === 0) return `<div class="hint">Nothing selected yet.</div>`;
    const rows = picks.map(
      (p, i) =>
        `<div class="measure-row"><span>${escapeHtml(p.label)}</span><span class="diff">${
          p.kind === "edge" ? `${fmt(p.length ?? 0, 2)} mm` : p.kind === "face" ? "planar" : `(${p.point.map((v) => fmt(v, 1)).join(", ")})`
        }</span><button class="x" data-measure-remove="${i}">${icon("x")}</button></div>`,
    );
    let result = "";
    if (picks.length === 2) {
      const [a, b] = picks;
      if (a.kind === "vertex" && b.kind === "vertex") {
        result = `Distance <b>${fmt(Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1], a.point[2] - b.point[2]), 3)} mm</b>`;
      } else if (a.kind === "face" && b.kind === "face" && a.normal && b.normal) {
        const dx = b.point[0] - a.point[0];
        const dy = b.point[1] - a.point[1];
        const dz = b.point[2] - a.point[2];
        const dist = Math.abs(dx * a.normal[0] + dy * a.normal[1] + dz * a.normal[2]);
        const dot = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
        const angle = (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot)))) * 180) / Math.PI;
        result = `Distance <b>${fmt(dist, 3)} mm</b> · Angle <b>${fmt(angle, 2)}°</b>`;
      } else if (a.kind === "edge" && b.kind === "edge") {
        const dist = Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1], a.point[2] - b.point[2]);
        result = `Midpoint distance <b>${fmt(dist, 3)} mm</b>`;
      } else {
        result = `Distance <b>${fmt(Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1], a.point[2] - b.point[2]), 3)} mm</b>`;
      }
    } else if (picks.length === 1) {
      result = picks[0].kind === "edge" ? `Length <b>${fmt(picks[0].length ?? 0, 3)} mm</b>` : picks[0].kind === "face" ? `Surface <b>${picks[0].normal ? "planar" : "face"}</b>` : `Point <b>(${picks[0].point.map((v) => fmt(v, 2)).join(", ")})</b>`;
    }
    const html = rows.join("") + (result ? `<div class="measure-row" style="border-top:1px solid #ccd9e5;margin-top:4px;padding-top:6px"><span>Result</span><span class="val">${result}</span></div>` : "");
    window.setTimeout(() => {
      this.panelRoot?.querySelectorAll<HTMLElement>("[data-measure-remove]").forEach((button) => {
        button.onclick = () => {
          this.measurePicks.splice(Number(button.dataset.measureRemove), 1);
          const host = this.panelRoot?.querySelector<HTMLElement>("#pm-measure");
          if (host) host.innerHTML = this.measureHtml();
          this.showMeasureReadout();
        };
      });
    }, 0);
    return html;
  }

  private showMeasureReadout(): void {
    const el = this.shell.measureEl;
    if (this.measurePicks.length === 2) {
      el.innerHTML = this.measureHtml().match(/Result<\/span><span class="val">([\s\S]*?)<\/span>/)?.[1] ?? "";
      el.classList.toggle("visible", el.innerHTML.length > 0);
    } else if (this.measurePicks.length === 1 && this.measurePicks[0].kind === "edge") {
      el.innerHTML = `Edge length <b>${fmt(this.measurePicks[0].length ?? 0, 3)} mm</b>`;
      el.classList.add("visible");
    } else {
      el.classList.remove("visible");
      el.innerHTML = "";
    }
  }

  // ---------------------------------------------------------------- section

  private openSection(): void {
    const part = this.activePart();
    const mesh = part ? this.meshForPart(part.id) : undefined;
    if (!mesh) {
      toast("Create a body before using Section View.", "warn");
      return;
    }
    const bbox = mesh.bbox;
    const axisRange = (axis: "x" | "y" | "z") => {
      const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      return { min: bbox.min[i], max: bbox.max[i] };
    };
    const state = { ...this.sectionState };
    let slider: HTMLInputElement | null = null;
    let rangeEl: HTMLElement | null = null;
    const sync = () => {
      this.sectionState = { ...state };
      this.shell.measureEl.classList.remove("visible");
      this.viewport.setSelectedFaces([]);
      this.viewport.setSelectedEdges([]);
      this.viewport.setSelectedVertices([]);
      this.viewport.setPickFilter(state.enabled ? "none" : this.viewport.getPickFilter());
      this.refreshScene();
      if (slider && rangeEl) rangeEl.textContent = `${state.axis.toUpperCase()} = ${fmt(state.offset, 2)} mm`;
    };
    const body =
      pmSection(
        "Section Settings",
        "scan",
        `<label class="check-row"><input type="checkbox" id="pm-section-enabled" ${state.enabled ? "checked" : ""} /> Enable section view</label>
        ${pmField("Axis", `<select id="pm-section-axis"><option value="x" ${state.axis === "x" ? "selected" : ""}>X</option><option value="y" ${state.axis === "y" ? "selected" : ""}>Y</option><option value="z" ${state.axis === "z" ? "selected" : ""}>Z</option></select>`)}
        <div class="field"><label>Offset <span class="section-legend" id="pm-section-offset-label"></span></label><input class="section-slider" id="pm-section-offset" type="range" min="-100" max="100" step="0.1" value="0" /></div>
        <label class="check-row"><input type="checkbox" id="pm-section-flip" ${state.flipped ? "checked" : ""} /> Flip side</label>`,
      ) +
      `<div class="hint">The cut is a live triangle-clipped section with capped faces. Picking is disabled while the section is active.</div>`;
    this.showPanel({
      icon: "scan",
      title: "Section View",
      sub: `${state.axis.toUpperCase()} plane`,
      body,
      onMount: (root) => {
        const axisSel = root.querySelector<HTMLSelectElement>("#pm-section-axis");
        const enabled = root.querySelector<HTMLInputElement>("#pm-section-enabled");
        const flip = root.querySelector<HTMLInputElement>("#pm-section-flip");
        slider = root.querySelector<HTMLInputElement>("#pm-section-offset");
        rangeEl = root.querySelector<HTMLElement>("#pm-section-offset-label");
        const updateRange = () => {
          if (!slider) return;
          const r = axisRange(state.axis);
          const pad = Math.max(1, (r.max - r.min) * 0.12);
          slider.min = String(r.min - pad);
          slider.max = String(r.max + pad);
          slider.value = String((r.min + r.max) / 2);
          state.offset = (r.min + r.max) / 2;
        };
        updateRange();
        sync();
        enabled?.addEventListener("change", () => {
          state.enabled = enabled.checked;
          state.offset = Number(slider?.value ?? 0);
          sync();
        });
        axisSel?.addEventListener("change", () => {
          state.axis = axisSel.value as "x" | "y" | "z";
          updateRange();
          state.enabled = true;
          if (enabled) enabled.checked = true;
          sync();
        });
        slider?.addEventListener("input", () => {
          state.offset = Number(slider?.value ?? 0);
          sync();
        });
        flip?.addEventListener("change", () => {
          state.flipped = flip.checked;
          sync();
        });
      },
      onOk: () => {
        this.sectionState = { ...state };
        this.refreshScene();
        this.finishCommand();
        if (state.enabled) {
          this.viewport.setPickFilter("none");
          this.shell.setPickFilter("none");
          toast("Section view active — reopen Section View to change or turn it off.", "info");
        } else {
          this.setPickFilter("all");
          toast("Section view closed.", "info");
        }
      },
      onCancel: () => {
        this.sectionState = { enabled: false, axis: this.sectionState.axis, offset: this.sectionState.offset, flipped: this.sectionState.flipped };
        this.refreshScene();
        this.setPickFilter("all");
        this.cancelCommand();
      },
    });
  }

  // --------------------------------------------------------------- drawing

  private async makeDrawing(): Promise<void> {
    const part = this.activePart();
    const mesh = part ? this.meshForPart(part.id) : undefined;
    if (!part || !mesh) {
      toast("Create a part before generating a drawing.", "warn");
      return;
    }
    const materialName = part.materialId ? partMaterial(part).name : "Material <not specified>";
    const svg = buildDrawingSvg(mesh, {
      partName: part.name,
      material: materialName,
      scale: "1:1",
      units: "mm",
      document: this.doc.name,
    });
    const body = document.createElement("div");
    body.innerHTML = `<div class="drawing-preview">${svg}</div>
      <div class="hint" style="margin-top:8px">A4 landscape · 3 orthographic views + isometric · overall width/height dimensions · title block (part, material, scale, units).</div>`;
    const result = await openModal({
      title: "Technical Drawing",
      icon: "file-down",
      body,
      width: 840,
      actions: [
        { label: "Close", value: "close", kind: "plain" },
        { label: "Download SVG", value: "svg", kind: "plain" },
        { label: "Download PDF", value: "pdf", kind: "primary" },
      ],
    });
    if (result === "svg") {
      downloadText(svg, `${safeFilename(part.name)}.svg`, "image/svg+xml");
      toast("Drawing exported as SVG.", "success");
    } else if (result === "pdf") {
      try {
        await downloadDrawingPdf(svg, `${part.name}-drawing.pdf`);
        toast("Drawing exported as PDF.", "success");
      } catch (error) {
        toast(`PDF export failed: ${messageOf(error)}`, "error");
      }
    }
  }

  // ---------------------------------------------------------- interference

  private runInterference(): void {
    if (this.doc.components.length < 2) {
      toast("Interference detection needs at least two components.", "warn");
      return;
    }
    const entries = this.doc.components
      .map((c) => {
        const part = this.doc.parts.find((p) => p.id === c.partId);
        const mesh = part ? this.meshForPart(part.id) : undefined;
        if (!part || !mesh) return null;
        return { component: c, part, mesh: transformMeshData(mesh, componentMatrix(c.position, c.rotation)) };
      })
      .filter((e): e is NonNullable<typeof e> => !!e);
    const results: { a: string; b: string; volume: number; points: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const A = entries[i];
        const B = entries[j];
        const minA = A.mesh.bbox.min;
        const maxA = A.mesh.bbox.max;
        const minB = B.mesh.bbox.min;
        const maxB = B.mesh.bbox.max;
        const lo: Vec3 = [Math.max(minA[0], minB[0]), Math.max(minA[1], minB[1]), Math.max(minA[2], minB[2])];
        const hi: Vec3 = [Math.min(maxA[0], maxB[0]), Math.min(maxA[1], maxB[1]), Math.min(maxA[2], maxB[2])];
        if (hi[0] <= lo[0] || hi[1] <= lo[1] || hi[2] <= lo[2]) continue;
        // Sampling step: fine enough to see thin walls and small bosses, but
        // capped so a large assembly pair stays within a bounded sample count.
        // (A step keyed only to the longest extent missed 2 mm shell walls.)
        const extents: Vec3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
        const volume = extents[0] * extents[1] * extents[2];
        const step = Math.max(
          0.4,
          Math.min(1.5, Math.min(extents[0], extents[1], extents[2]) / 3),
          Math.cbrt(volume / 120000),
        );
        let inside = 0;
        for (let x = lo[0] + step / 2; x < hi[0]; x += step) {
          for (let y = lo[1] + step / 2; y < hi[1]; y += step) {
            for (let z = lo[2] + step / 2; z < hi[2]; z += step) {
              const p: Vec3 = [x, y, z];
              if (pointInMesh(p, A.mesh) && pointInMesh(p, B.mesh)) inside++;
            }
          }
        }
        if (inside > 0) results.push({ a: A.component.name, b: B.component.name, volume: inside * step ** 3, points: inside });
      }
    }
    const body = results.length
      ? `<div class="study-stats">
          ${results.map((r) => `<span>${escapeHtml(r.a)} ↔ ${escapeHtml(r.b)}</span><span style="color:#b03a2e;font-weight:600">interference · ≈ ${fmt(r.volume, 1)} mm³</span>`).join("")}
        </div><div class="hint" style="margin-top:8px">Sampled at ~${fmt(1, 1)} mm grid resolution. Move one component (Assembly → Transform) to clear the overlap.</div>`
      : `<p style="color:#2e7d5b"><b>No interference detected.</b></p><p>All pairwise component volumes are disjoint at the sampling resolution.</p>`;
    void openModal({
      title: "Interference Detection",
      icon: "boxes",
      body,
      width: 520,
      actions: [{ label: "Close", value: "close", kind: "primary" }],
    });
  }

  // --------------------------------------------------------------- toolbox

  private async openToolbox(kind: "bolt" | "nut" | "washer"): Promise<void> {
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="field"><label>Size</label><select id="tb-size">${METRIC_SIZES.map((s) => `<option value="${s.size}">${s.size} · across flats ${s.acrossFlats} mm</option>`).join("")}</select></div>
      ${kind === "bolt" ? `<div class="field"><label>Length</label><div class="input-wrap"><input id="tb-length" type="number" min="4" step="1" value="20" /><span class="unit">mm</span></div></div>` : ""}
      <label class="check-row"><input type="checkbox" id="tb-assembly" ${this.doc.mode === "assembly" ? "checked" : ""} /> Add as an assembly component</label>
      <div class="hint">ISO 4014 hex bolt, ISO 4032 hex nut and ISO 7089 washer. AISI 1020 steel.</div>`;
    const result = await openModal({
      title: kind === "bolt" ? "Toolbox · Hex Bolt" : kind === "nut" ? "Toolbox · Hex Nut" : "Toolbox · Washer",
      icon: "wrench",
      body,
      width: 430,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Create", value: "create", kind: "primary" },
      ],
    });
    if (result !== "create") return;
    const sizeEl = body.querySelector<HTMLSelectElement>("#tb-size");
    const lengthEl = body.querySelector<HTMLInputElement>("#tb-length");
    const addEl = body.querySelector<HTMLInputElement>("#tb-assembly");
    const size = sizeEl?.value ?? "M6";
    const length = lengthEl ? Number(lengthEl.value) || 20 : undefined;
    const before = this.capture();
    const part = createFastenerPart({ kind, size, length }, this.doc.parts.length);
    const index = this.doc.parts.length;
    this.doc.parts.push(part);
    this.doc.activePartId = part.id;
    if (this.doc.mode === "assembly" && addEl?.checked) {
      const comp: Component = {
        id: uid("comp"),
        name: `${part.name}${index}`,
        partId: part.id,
        position: [index * 18, 0, 0],
        rotation: [0, 0, 0],
        visible: true,
        fixed: false,
      };
      this.doc.components.push(comp);
      this.doc.activeComponentId = comp.id;
      this.solveMatesAndRefresh();
    }
    this.commit(before);
    this.refreshTree();
    await this.rebuild();
    this.updateMassCard();
    toast(`${part.name} created.`, "success");
  }

  private solveMatesAndRefresh(): void {
    if (this.doc.mates.length) solveMates(this.doc);
    this.refreshScene();
  }

  // ------------------------------------------------------------- equations

  private openEquations(): void {
    const body = document.createElement("div");
    const render = () => {
      const vars = this.doc.variables ?? [];
      body.innerHTML = `
        <div class="eq-list">
          ${
            vars
              .map(
                (v) => `<div class="eq-row">
                  <code>${escapeHtml(v.name)}</code><span>=</span>
                  <input class="eq-input" data-var-expr="${escapeHtml(v.id)}" value="${escapeHtml(v.expression)}" spellcheck="false" />
                  <span class="eq-value" data-var-value="${escapeHtml(v.id)}">${fmt(v.value, 3)} mm</span>
                  <button class="eq-del" data-var-del="${escapeHtml(v.id)}" title="Delete variable">×</button>
                </div>`,
              )
              .join("") || `<div class="hint" style="padding:4px 0">No variables yet.</div>`
          }
        </div>
        <div class="eq-add-row">
          <div class="field"><label>Name</label><input id="eq-name" placeholder="L" /></div>
          <div class="field"><label>Expression</label><input id="eq-expr" placeholder="100 or L / 2" /></div>
          <button class="btn" id="eq-add">${icon("plus")} Add Variable</button>
        </div>
        <div class="hint" style="margin-top:8px">Dimensions can use these names: double-click a dimension and type <code>L</code> or <code>W</code>. Expressions are evaluated in declaration order (MMGS / NMM · mm).</div>`;
      const refreshValues = () => {
        const values: Record<string, number> = {};
        for (const v of this.doc.variables ?? []) {
          v.value = evaluateExpression(v.expression, values);
          values[v.name] = v.value;
          const cell = body.querySelector<HTMLElement>(`[data-var-value="${v.id}"]`);
          if (cell) cell.textContent = `${fmt(v.value, 3)} mm`;
        }
      };
      body.querySelectorAll<HTMLInputElement>("[data-var-expr]").forEach((input) => {
        input.addEventListener("input", () => {
          const variable = (this.doc.variables ?? []).find((v) => v.id === input.dataset.varExpr);
          if (!variable) return;
          variable.expression = input.value;
          refreshValues();
        });
      });
      body.querySelectorAll<HTMLElement>("[data-var-del]").forEach((button) => {
        button.addEventListener("click", () => {
          const before = this.capture();
          this.doc.variables = (this.doc.variables ?? []).filter((v) => v.id !== button.dataset.varDel);
          applyVariables(this.doc);
          this.commit(before);
          this.refreshTree();
          render();
        });
      });
      body.querySelector("#eq-add")?.addEventListener("click", () => {
        const name = body.querySelector<HTMLInputElement>("#eq-name")?.value.trim();
        const expr = body.querySelector<HTMLInputElement>("#eq-expr")?.value.trim();
        if (!name || !expr) {
          toast("Enter a variable name and an expression.", "warn");
          return;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          toast("Variable names must start with a letter or underscore.", "warn");
          return;
        }
        const existing = (this.doc.variables ?? []).find((v) => v.name === name);
        const before = this.capture();
        if (existing) existing.expression = expr;
        else {
          if (!this.doc.variables) this.doc.variables = [];
          this.doc.variables.push(makeVariable(name, expr));
        }
        applyVariables(this.doc);
        this.commit(before);
        this.refreshTree();
        render();
        toast(`${name} = ${expr} ${existing ? "updated" : "added"}.`, "success");
      });
    };
    render();
    void openModal({
      title: "Equations / Variables",
      icon: "equal",
      body,
      width: 560,
      actions: [
        { label: "Close", value: "close", kind: "plain" },
        { label: "Apply", value: "apply", kind: "primary" },
      ],
    }).then((result) => {
      if (result === "apply") {
        const before = this.capture();
        applyVariables(this.doc);
        this.commit(before);
        this.refreshTree();
        this.updateMassCard();
        void this.rebuild();
        const values = variableValues(this.doc);
        const text = Object.entries(values).map(([k, v]) => `${k}=${fmt(v, 2)}`).join(", ");
        toast(`Variables applied${text ? `: ${text}` : " (none defined)"}.`, "success");
      }
    });
  }

  // ------------------------------------------------------------- AI bridge

  private async applyAiCommands(commands: AiCommand[], message: string): Promise<void> {
    if (this.command) this.cancelCommand();
    const before = this.capture();
    let applied = 0;
    for (const command of commands) {
      try {
        const ok = await this.applyAiCommand(command);
        if (ok) applied++;
      } catch (error) {
        toast(`AI command "${command.action}" failed: ${messageOf(error)}`, "warn", 6000);
      }
    }
    if (applied > 0) {
      this.commit(before);
      this.refreshTree();
      this.updateMassCard();
      await this.rebuild();
      this.touchDocument();
    }
    toast(`AI: ${applied}/${commands.length} command(s) applied. ${message}`, applied ? "success" : "info", 6500);
  }

  private async applyAiCommand(command: AiCommand): Promise<boolean> {
    const params = command.params ?? {};
    const num = (key: string, fallback = 0) => {
      const value = Number(params[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    const text = (key: string, fallback = "") => String(params[key] ?? fallback);
    const active = this.activePart();
    switch (command.action) {
      case "box":
        this.createBoxPart(num("length", 80), num("width", 40), num("height", 20));
        return true;
      case "cylinder":
        this.createCylinderPart(num("diameter", 30), num("height", 40));
        return true;
      case "extrude": {
        if (!active) return false;
        const sketch = active.sketches.find((s) => s.name === text("sketch") || s.id === text("sketch")) ?? this.defaultSketchForFeature(active);
        if (!sketch) return false;
        active.features.push({
          id: uid("feat"),
          type: "extrude",
          name: nextFeatureName("extrude", active.features),
          sketchId: sketch.id,
          params: { depth: Math.max(0.1, num("depth", 10)), direction: params.direction === -1 ? -1 : 1, operation: "join" },
        });
        return true;
      }
      case "fillet":
      case "chamfer": {
        if (!active) return false;
        const mesh = this.meshForPart(active.id);
        if (!mesh) return false;
        const indices = text("edges") === "all" || !params.edges ? mesh.edges.map((e) => e.index) : (params.edges as number[]);
        active.features.push({
          id: uid("feat"),
          type: command.action,
          name: nextFeatureName(command.action, active.features),
          params: command.action === "fillet" ? { radius: Math.max(0.01, num("radius", 2)), edgeIndices: indices } : { distance: Math.max(0.01, num("distance", 1)), edgeIndices: indices },
        });
        return true;
      }
      case "shell":
        if (!active) return false;
        active.features.push({ id: uid("feat"), type: "shell", name: nextFeatureName("shell", active.features), params: { thickness: Math.max(0.05, num("thickness", 2)) } });
        return true;
      case "material": {
        const id = text("id", "aisi1020");
        if (!MATERIALS.some((m) => m.id === id)) return false;
        this.assignMaterial(id);
        return true;
      }
      case "variable": {
        if (!this.doc.variables) this.doc.variables = [];
        this.doc.variables.push(makeVariable(text("name", "L"), text("expression", "100")));
        applyVariables(this.doc);
        return true;
      }
      case "variable-normal": {
        this.doc.variables = standardVariables((params.variables as [string, string][]) ?? []);
        applyVariables(this.doc);
        return true;
      }
      case "measure":
        this.openMeasure();
        return true;
      case "view": {
        const name = text("name", "iso") as ViewName;
        this.viewport.setView(["front", "back", "top", "bottom", "right", "left", "iso"].includes(name) ? name : "iso");
        return true;
      }
      case "section":
        this.sectionState = { enabled: true, axis: (text("axis", "z") as "x" | "y" | "z"), offset: num("offset", 0), flipped: params.flipped === true };
        this.refreshScene();
        return true;
      case "drawing":
        await this.makeDrawing();
        return true;
      case "fea":
        this.setupFeaFromAi(params);
        return true;
      case "action":
        await this.runAction(text("name"));
        return true;
      default:
        return false;
    }
  }

  private createBoxPart(length: number, width: number, height: number): Part | null {
    const part = createPart(`Box ${this.doc.parts.length + 1}`, this.doc.parts.length);
    const plane = basePlane("top");
    const sketch: Sketch = { id: uid("sk"), name: "Sketch1", plane, points: [], entities: [], constraints: [], visible: false };
    const x = Math.max(1, length) / 2;
    const z = Math.max(1, width) / 2;
    const pts: [number, number][] = [
      [-x, -z],
      [x, -z],
      [x, z],
      [-x, z],
    ];
    for (const [a, b] of pts) sketch.points.push({ id: uid("pt"), x: a, y: b });
    for (let i = 0; i < 4; i++) sketch.entities.push({ id: uid("ln"), kind: "line", p1: sketch.points[i].id, p2: sketch.points[(i + 1) % 4].id });
    part.sketches.push(sketch);
    part.features.push({ id: uid("feat"), type: "extrude", name: "Boss-Extrude1", sketchId: sketch.id, params: { depth: Math.max(0.2, height), direction: 1, operation: "new" } });
    this.doc.parts.push(part);
    this.doc.activePartId = part.id;
    this.selection = { kind: "feature", id: part.features[0].id };
    return part;
  }

  private createCylinderPart(diameter: number, height: number): Part | null {
    const part = createPart(`Cylinder ${this.doc.parts.length + 1}`, this.doc.parts.length);
    const plane = basePlane("top");
    const sketch: Sketch = { id: uid("sk"), name: "Sketch1", plane, points: [], entities: [], constraints: [], visible: false };
    const center = { id: uid("pt"), x: 0, y: 0 };
    sketch.points.push(center);
    sketch.entities.push({ id: uid("ci"), kind: "circle", center: center.id, radius: Math.max(0.5, diameter / 2) });
    sketch.constraints.push({ id: uid("c"), type: "radius", entity: sketch.entities[0].id, value: Math.max(0.5, diameter / 2) });
    part.sketches.push(sketch);
    part.features.push({ id: uid("feat"), type: "extrude", name: "Boss-Extrude1", sketchId: sketch.id, params: { depth: Math.max(0.2, height), direction: 1, operation: "new" } });
    this.doc.parts.push(part);
    this.doc.activePartId = part.id;
    return part;
  }

  private assignMaterial(id: string): void {
    const part = this.activePart();
    if (!part) return;
    part.materialId = id;
    part.materialOverride = undefined;
    for (const study of this.doc.analyses) if (study.partId === part.id) {
      study.materialId = id;
      study.stale = study.status === "solved";
    }
    this.updateMassCard();
    this.refreshTree();
  }

  private setupFeaFromAi(params: Record<string, unknown>): void {
    const part = this.activePart();
    if (!part) return;
    if (this.doc.mode !== "analysis") {
      this.doc.mode = "analysis";
      this.shell.setMode("analysis");
      this.shell.setCommandTab("analysis");
    }
    let study = this.doc.analyses.find((s) => s.partId === part.id);
    if (!study) {
      study = {
        id: uid("study"),
        name: `Static ${this.doc.analyses.length + 1}`,
        partId: part.id,
        materialId: part.materialId ?? "aisi1020",
        meshSize: Number(params.meshSize) || Math.max(0.5, Math.round((part ? this.meshForPart(part.id)?.bbox.max[0] ?? 80 : 80) / 20)),
        supports: [],
        loads: [],
        status: "draft",
      };
      this.doc.analyses.push(study);
      this.doc.activeStudyId = study.id;
    }
    if (typeof params.material === "string" && MATERIALS.some((m) => m.id === params.material)) study.materialId = params.material;
    this.refreshTree();
    this.openStudyPanel();
  }

  private cancelCommand(): void {
    const command = this.command;
    this.command = null;
    if (command?.cancel) {
      try {
        command.cancel();
      } catch {
        /* ignore teardown errors */
      }
    }
    if (!this.editor.isActive) {
      this.viewport.setPickFilter("all");
      this.viewport.setSelectedFaces([]);
      this.viewport.setSelectedEdges([]);
      this.viewport.setSelectedVertices([]);
    }
    this.shell.hideConfirmationCorner();
    this.shell.setActiveCommand(null);
    this.shell.setHint(null);
    this.panelRoot = null;
    this.shell.clearProperty();
    this.shell.showTree();
  }

  private finishCommand(): void {
    this.command = null;
    this.panelRoot = null;
    this.viewport.setPickFilter("all");
    this.viewport.setSelectedFaces([]);
    this.viewport.setSelectedEdges([]);
    this.viewport.setSelectedVertices([]);
    this.shell.hideConfirmationCorner();
    this.shell.setActiveCommand(null);
    this.shell.setHint(null);
    this.shell.clearProperty();
    this.shell.showTree();
  }

  private showPanel(options: {
    icon: string;
    title: string;
    sub: string;
    body: string;
    okTitle?: string;
    cancel?: boolean;
    onOk?: () => void;
    onCancel?: () => void;
    onMount?: (root: HTMLElement) => void;
  }): HTMLElement {
    const root = this.shell.showProperty(
      pmHead(options.icon, options.title, options.sub, options.okTitle ?? "OK", options.cancel !== false) +
        `<div class="pm-body">${options.body}</div>`,
    );
    this.panelRoot = root;
    root.querySelector("[data-pm-ok]")?.addEventListener("click", () => {
      if (options.onOk) options.onOk();
      else this.cancelCommand();
    });
    root.querySelector("[data-pm-cancel]")?.addEventListener("click", () => {
      if (options.onCancel) options.onCancel();
      else this.cancelCommand();
    });
    options.onMount?.(root);
    this.shell.showConfirmationCorner(
      () => root.querySelector<HTMLElement>("[data-pm-ok]")?.click(),
      () => root.querySelector<HTMLElement>("[data-pm-cancel]")?.click(),
    );
    return root;
  }

  // --------------------------------------------------------------- sketching

  private async newSketchCommand(): Promise<void> {
    if (this.editor.isActive) {
      toast("Finish the current sketch first.", "warn");
      return;
    }
    if (this.doc.mode !== "part") this.setMode("part");
    const part = this.activePart();
    if (!part) {
      toast("This document has no part to sketch on.", "warn");
      return;
    }
    if (this.selection?.kind === "plane") {
      this.startSketch(basePlane(this.selection.id as "front" | "top" | "right"));
      return;
    }
    if (this.selectedFace && this.selectedFace.face.surface === "plane") {
      this.startSketch(
        planeFromFace(
          this.selectedFace.face.point,
          this.selectedFace.face.normal,
          `${part.name} face ${this.selectedFace.faceIndex + 1}`,
          this.selectedFace.faceIndex,
        ),
      );
      return;
    }
    this.openPlanePicker();
  }

  private openPlanePicker(): void {
    if (this.command) this.cancelCommand();
    const part = this.activePart();
    this.command = {
      kind: "plane-pick",
      onFace: (pick) => {
        if (pick.face.surface !== "plane") {
          toast("Choose a planar face for the sketch.", "warn");
          return;
        }
        this.startSketch(
          planeFromFace(pick.face.point, pick.face.normal, `${part?.name ?? "Part"} face ${pick.faceIndex + 1}`, pick.faceIndex),
        );
      },
    };
    this.viewport.setPickFilter("face");
    this.shell.setHint("Pick a planar face in the viewport, or choose one of the base planes below.");
    this.showPanel({
      icon: "drafting-compass",
      title: "New Sketch",
      sub: "Select a plane",
      body:
        pmSection(
          "Base Planes",
          "frame",
          `<div class="plane-grid">
            <button class="plane-card" data-plane-kind="front"><span class="swatch" style="background:#7faed4"></span><span>Front Plane</span>${icon("chevron-right")}</button>
            <button class="plane-card top" data-plane-kind="top"><span class="swatch"></span><span>Top Plane</span>${icon("chevron-right")}</button>
            <button class="plane-card right" data-plane-kind="right"><span class="swatch"></span><span>Right Plane</span>${icon("chevron-right")}</button>
          </div>`,
        ) +
        pmSection(
          "Face",
          "box",
          `<div class="hint">A planar face of the active body can also be used as the sketch plane. The sketch grid will lie on that face.</div>`,
        ),
      onMount: (root) => {
        root.querySelectorAll<HTMLElement>("[data-plane-kind]").forEach((button) => {
          button.addEventListener("click", () => {
            const kind = button.dataset.planeKind as "front" | "top" | "right";
            this.startSketch(basePlane(kind));
          });
        });
      },
    });
  }

  private startSketch(plane: SketchPlane): void {
    if (this.editor.isActive) {
      toast("Finish the current sketch first.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    const part = this.activePart();
    if (!part) return;
    const before = this.capture();
    const sketch: Sketch = {
      id: uid("sk"),
      name: nextSketchName(part.sketches),
      plane,
      points: [],
      entities: [],
      constraints: [],
      visible: false,
    };
    part.sketches.push(sketch);
    this.sketchStartDoc = before;
    this.sketchDirty = false;
    this.beginSketchInternal(sketch);
    this.shell.setStatus(`Editing ${sketch.name} on ${plane.name}`);
  }

  private beginExistingSketch(sketch: Sketch): void {
    if (this.editor.isActive) {
      toast("Finish the current sketch first.", "warn");
      return;
    }
    this.sketchStartDoc = this.capture();
    this.sketchDirty = false;
    this.beginSketchInternal(sketch);
    this.shell.setStatus(`Editing ${sketch.name}`);
  }

  private beginSketchInternal(sketch: Sketch): void {
    this.cancelCommand();
    this.selection = { kind: "sketch", id: sketch.id };
    this.viewport.setPickFilter("none");
    this.viewport.setSelectedFaces([]);
    this.editor.begin(sketch);
    this.shell.setSketching(true);
    this.shell.setCommandTab("sketch");
    this.command = { kind: "sketch", cancel: () => this.cancelSketch() };
    this.showSketchPanel();
    this.onSketchTool(this.editor.tool);
    this.refreshTree();
    this.scheduleAutosave();
  }

  private showSketchPanel(): void {
    const sketch = this.editor.sketch;
    if (!sketch) return;
    const toolButton = (tool: SketchTool, label: string, iconName: string) =>
      `<button class="opt-btn" data-sketch-tool="${tool}">${icon(iconName)} ${label}</button>`;
    const relButton = (rel: string, label: string, iconName: string) =>
      `<button class="opt-btn" data-sketch-rel="${rel}">${icon(iconName)} ${label}</button>`;
    this.showPanel({
      icon: "drafting-compass",
      title: sketch.name,
      sub: `Sketch · ${sketch.plane.name}`,
      okTitle: "Finish sketch",
      body:
        pmSection(
          "Tools",
          "pencil",
          `<div class="inline-options">
            ${toolButton("select", "Select", "mouse-pointer-2")}
            ${toolButton("line", "Line", "pencil")}
            ${toolButton("rectangle", "Rectangle", "rectangle-horizontal")}
            ${toolButton("circle", "Circle", "circle")}
            ${toolButton("arc", "3-Pt Arc", "circle-dot")}
            ${toolButton("dimension", "Dimension", "ruler")}
          </div>`,
        ) +
        pmSection(
          "Relations",
          "link",
          `<div class="inline-options">
            ${relButton("horizontal", "Horizontal", "move-horizontal")}
            ${relButton("vertical", "Vertical", "move-vertical")}
            ${relButton("coincident", "Coincident", "link")}
            ${relButton("tangent", "Tangent", "magnet")}
            ${relButton("equal", "Equal", "equal")}
            ${relButton("fix", "Fix", "lock")}
          </div>
          <div class="hint">Select points or entities first, then apply a relation. Drag points to reshape; double-click a dimension to type a new value.</div>`,
        ) +
        pmSection("Profile", "scan", `<div id="pm-sketch-profile" class="hint">—</div><div id="pm-sketch-selection" class="hint"></div>`) +
        pmSection(
          "Modify",
          "trash-2",
          `<div class="inline-options">
            <button class="opt-btn" data-sketch-action="delete">${icon("trash-2")} Delete</button>
            <button class="opt-btn" data-sketch-action="fit">${icon("focus")} Fit</button>
          </div>`,
        ),
      onOk: () => this.finishSketch(),
      onCancel: () => this.cancelSketch(),
      onMount: (root) => {
        root.querySelectorAll<HTMLElement>("[data-sketch-tool]").forEach((button) => {
          button.addEventListener("click", () => this.setSketchTool(button.dataset.sketchTool as SketchTool));
        });
        root.querySelectorAll<HTMLElement>("[data-sketch-rel]").forEach((button) => {
          button.addEventListener("click", () => {
            const ok = this.editor.applyConstraint(button.dataset.sketchRel as "horizontal");
            if (ok) {
              this.sketchDirty = true;
              this.refreshTree();
              this.updateSketchPanelInfo();
              this.scheduleAutosave();
            }
          });
        });
        root.querySelectorAll<HTMLElement>("[data-sketch-action]").forEach((button) => {
          button.addEventListener("click", () => {
            if (button.dataset.sketchAction === "delete") {
              if (this.editor.deleteSelection()) {
                this.sketchDirty = true;
                this.updateSketchPanelInfo();
                this.refreshTree();
              }
            } else {
              this.editor.fit();
            }
          });
        });
        this.updateSketchPanelInfo();
      },
    });
  }

  private updateSketchPanelInfo(): void {
    if (!this.panelRoot || !this.editor.sketch) return;
    const sketch = this.editor.sketch;
    const summary = profileSummary(sketch);
    const profile = this.panelRoot.querySelector<HTMLElement>("#pm-sketch-profile");
    if (profile) {
      profile.innerHTML = summary.closed
        ? `${icon("check-circle-2")} Closed profile · ${fmt(summary.remainingArea, 1)} mm²`
        : `${icon("alert-triangle")} Open profile — close the contour before creating a feature.`;
    }
    const selection = this.panelRoot.querySelector<HTMLElement>("#pm-sketch-selection");
    if (selection) {
      selection.textContent = `${sketch.entities.length} entities · ${sketch.points.length} points · ${sketch.constraints.length} relations`;
    }
  }

  private onSketchChanged(sketch: Sketch): void {
    this.sketchDirty = true;
    const part = this.doc.parts.find((p) => p.sketches.some((s) => s.id === sketch.id));
    if (part) {
      const index = part.sketches.findIndex((s) => s.id === sketch.id);
      if (index >= 0) part.sketches[index] = sketch;
    }
    this.updateSketchPanelInfo();
    this.refreshTree();
    this.scheduleAutosave();
  }

  private onSketchTool(tool: SketchTool): void {
    const hints: Record<SketchTool, string> = {
      select: "Select points or entities. Drag a point to move it. Double-click a dimension to edit its value.",
      line: "Line: click the start and end points. Keep chaining lines; press Esc to stop.",
      rectangle: "Rectangle: click two opposite corners. Horizontal and vertical relations are added automatically.",
      circle: "Circle: click the centre, then drag or click to set the radius.",
      arc: "3-point arc: click the start point, the end point, then a point on the arc.",
      dimension: "Smart Dimension: click a line, then place the dimension. Double-click the label to change it.",
      trim: "Trim: click the part of an entity to cut away between its intersections.",
      offset: "Offset Entities: select entities, then choose Offset and enter the distance.",
      convert: "Convert Entities: click a 3D edge to project it into the active sketch.",
    };
    this.shell.setHint(hints[tool]);
    this.shell.setActiveCommand(`tool-${tool}`);
    this.panelRoot?.querySelectorAll<HTMLElement>("[data-sketch-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.sketchTool === tool);
    });
  }

  private setSketchTool(tool: SketchTool): void {
    this.editor.setTool(tool);
  }

  private async editDimension(constraintId: string): Promise<void> {
    const sketch = this.editor.sketch;
    if (!sketch) return;
    const constraint = sketch.constraints.find((c) => c.id === constraintId);
    if (!constraint || (constraint.type !== "distance" && constraint.type !== "radius")) return;
    const current = constraint.value ?? dimensionValue(sketch, constraint.a, constraint.b, constraint.entity);
    const values = variableValues(this.doc);
    const variableHint =
      Object.entries(values)
        .map(([name, value]) => `${name}=${fmt(value, 2)}`)
        .join(", ") || "none yet (Tools → Equations / Variables)";
    const body = document.createElement("div");
    body.innerHTML = `
      <label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:5px;">${constraint.type === "radius" ? "Radius" : "Length"} or expression</label>
      <input id="dim-value" type="text" value="${escapeHtml(constraint.expression ?? String(Math.max(0.01, current)))}" style="font-family:var(--mono);font-size:15px;height:34px;width:100%" />
      <div class="hint" id="dim-preview" style="margin-top:8px;"></div>
      <div class="hint">Variables: ${escapeHtml(variableHint)}. Try <code>L</code>, <code>L / 2</code> or <code>40 + 5</code>.</div>`;
    const input = body.querySelector<HTMLInputElement>("#dim-value");
    const preview = body.querySelector<HTMLElement>("#dim-preview");
    const update = () => {
      if (!input || !preview) return;
      const text = input.value.trim();
      const numeric = Number(text);
      const value = Number.isFinite(numeric) ? numeric : evaluateExpression(text, values);
      preview.textContent = Number.isFinite(value) && value > 0 ? `= ${fmt(value, 3)} mm${constraint.expression ? " (driven by a variable)" : ""}` : "Enter a positive number or a valid expression.";
    };
    input?.addEventListener("input", update);
    update();
    const result = await openModal({
      title: constraint.type === "radius" ? "Edit Radius" : "Edit Dimension",
      icon: "ruler",
      body,
      width: 420,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "OK", value: "ok", kind: "primary" },
      ],
    });
    if (result !== "ok") return;
    const text = (input?.value ?? "").trim();
    if (!text) return;
    const numeric = Number(text);
    const value = Number.isFinite(numeric) ? numeric : evaluateExpression(text, values);
    if (!Number.isFinite(value) || value <= 0) {
      toast("Enter a positive number or a valid expression.", "warn");
      return;
    }
    constraint.expression = Number.isFinite(numeric) ? undefined : text;
    this.editor.setDimensionValue(constraintId, value);
    this.sketchDirty = true;
    this.updateSketchPanelInfo();
    this.refreshTree();
    this.scheduleAutosave();
  }

  private finishSketch(): void {
    if (!this.editor.isActive) return;
    const sketch = this.editor.sketch;
    const start = this.sketchStartDoc;
    const dirty = this.sketchDirty;
    const part = sketch ? this.doc.parts.find((p) => p.sketches.some((s) => s.id === sketch.id)) : undefined;
    this.editor.end();
    this.shell.setSketching(false);
    this.shell.setSketchStatus(null);
    this.shell.setActiveCommand(null);
    this.shell.setCursor(null);
    this.shell.setSelection(null);
    this.command = null;
    this.sketchStartDoc = null;
    this.sketchDirty = false;
    this.shell.setHint(null);
    this.panelRoot = null;
    this.shell.clearProperty();
    this.shell.showTree();

    if (sketch && part && sketch.entities.length === 0 && sketch.constraints.length === 0) {
      part.sketches = part.sketches.filter((s) => s.id !== sketch.id);
      this.selection = null;
    } else if (sketch) {
      this.selection = { kind: "sketch", id: sketch.id };
    }
    if (start && dirty) this.commit(start);

    this.viewport.setPickFilter("face");
    this.refreshTree();
    this.scheduleAutosave();
    if (sketch && part?.features.some((f) => f.sketchId === sketch.id)) void this.rebuild();
    if (sketch && part && part.sketches.some((s) => s.id === sketch.id)) {
      this.shell.setStatus(`${sketch.name} saved · ${sketch.entities.length} entities · ${sketch.constraints.length} relations`);
      toast(`${sketch.name} saved. Use Extruded Boss to add material.`, "success");
    } else {
      this.shell.setStatus("Sketch discarded");
    }
  }

  private cancelSketch(): void {
    if (!this.editor.isActive) return;
    const start = this.sketchStartDoc;
    this.editor.end();
    this.shell.setSketching(false);
    this.shell.setSketchStatus(null);
    this.shell.setActiveCommand(null);
    this.shell.setCursor(null);
    this.shell.setSelection(null);
    this.shell.setHint(null);
    this.command = null;
    this.sketchStartDoc = null;
    this.sketchDirty = false;
    this.panelRoot = null;
    this.selection = null;
    if (start) this.doc = cloneDocument(start);
    this.shell.clearProperty();
    this.shell.showTree();
    this.viewport.setPickFilter("all");
    this.refreshTree();
    this.touchDocument();
    toast("Sketch changes discarded.", "info");
  }

  // --------------------------------------------------------------- features

  private defaultSketchForFeature(part: Part): Sketch | undefined {
    if (this.selection?.kind === "sketch") {
      const selected = part.sketches.find((s) => s.id === this.selection?.id);
      if (selected) return selected;
    }
    for (let i = part.sketches.length - 1; i >= 0; i--) {
      if (profileSummary(part.sketches[i]).closed) return part.sketches[i];
    }
    return part.sketches[part.sketches.length - 1];
  }

  private openExtrude(type: "extrude" | "cut", existing?: Feature): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to create part features.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part) return;
    const sketch = existing ? part.sketches.find((s) => s.id === existing.sketchId) : this.defaultSketchForFeature(part);
    if (!sketch) {
      void alertDialog("Extruded Boss", "<p>Create a closed sketch first, then run the feature again.</p>", "drafting-compass");
      return;
    }
    if (this.command) this.cancelCommand();
    const params = existing?.params ?? {};
    const depth = Math.abs(params.depth ?? 10);
    const direction = params.direction ?? 1;
    const symmetric = params.symmetric ?? false;
    const operation = params.operation ?? (type === "cut" ? "cut" : "join");
    const isCut = type === "cut";
    const sketchOptions = part.sketches
      .map((s) => {
        const closed = profileSummary(s).closed;
        return `<option value="${s.id}" ${s.id === sketch.id ? "selected" : ""}>${escapeHtml(s.name)}${closed ? "" : " — open"}</option>`;
      })
      .join("");
    this.command = { kind: type };
    this.showPanel({
      icon: isCut ? "circle-off" : "square",
      title: existing ? `Edit ${existing.name}` : isCut ? "Extruded Cut" : "Extruded Boss",
      sub: existing ? existing.name : "Boss / Base",
      body:
        pmSection(
          "Profile",
          "drafting-compass",
          pmField("Sketch", `<select id="pm-feature-sketch">${sketchOptions}</select>`) +
            `<div class="hint" id="pm-profile-hint">—</div>`,
        ) +
        pmSection(
          "Direction 1",
          "move-3d",
          pmField("Depth", numInput("pm-depth", depth, "mm", 0.01)) +
            pmField(
              "Direction",
              `<select id="pm-direction"><option value="1" ${direction === 1 ? "selected" : ""}>Normal to sketch</option><option value="-1" ${direction === -1 ? "selected" : ""}>Reverse</option></select>`,
            ) +
            `<label class="check-row"><input type="checkbox" id="pm-symmetric" ${symmetric ? "checked" : ""} /> Mid-plane (symmetric)</label>`,
        ) +
        pmSection(
          "Operation",
          "layers",
          isCut
            ? `<div class="hint">Removes material from the existing body.</div>`
            : pmField(
                "Result",
                `<select id="pm-operation"><option value="join" ${operation !== "new" ? "selected" : ""}>Join with body</option><option value="new" ${operation === "new" ? "selected" : ""}>New body</option></select>`,
              ),
        ) +
        `<div class="hint">The profile must be closed. Holes inside the outer loop are preserved automatically.</div>`,
      onMount: (root) => {
        const update = () => {
          const id = readText(root, "pm-feature-sketch", sketch.id);
          const current = part.sketches.find((s) => s.id === id);
          const hint = root.querySelector<HTMLElement>("#pm-profile-hint");
          if (!current || !hint) return;
          const summary = profileSummary(current);
          hint.innerHTML = summary.closed
            ? `${icon("check-circle-2")} Closed profile · ${fmt(summary.remainingArea, 1)} mm²`
            : `${icon("alert-triangle")} Open profile — extrude will fail. Close the contour first.`;
        };
        update();
        root.querySelector<HTMLSelectElement>("#pm-feature-sketch")?.addEventListener("change", update);
      },
      onOk: () => {
        const sketchId = readText(this.panelRoot ?? document, "pm-feature-sketch", sketch.id);
        const selectedSketch = part.sketches.find((s) => s.id === sketchId);
        if (!selectedSketch || !profileSummary(selectedSketch).closed) {
          toast("Select a sketch with a closed profile.", "warn");
          return;
        }
        const featureParams = {
          depth: Math.max(0.01, readNumber(this.panelRoot ?? document, "pm-depth", depth)),
          direction: Number(readText(this.panelRoot ?? document, "pm-direction", "1")) === -1 ? (-1 as const) : (1 as const),
          symmetric: readChecked(this.panelRoot ?? document, "pm-symmetric"),
          operation: isCut ? ("cut" as const) : (readText(this.panelRoot ?? document, "pm-operation", "join") as "join" | "new"),
        };
        const before = this.capture();
        if (existing) {
          existing.sketchId = sketchId;
          existing.params = { ...existing.params, ...featureParams };
        } else {
          const feature: Feature = {
            id: uid("feat"),
            type,
            name: nextFeatureName(type, part.features),
            sketchId,
            params: featureParams,
          };
          part.features.push(feature);
          this.selection = { kind: "feature", id: feature.id };
        }
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
      },
    });
  }

  private openRevolve(existing?: Feature): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to create part features.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part) return;
    const sketch = existing ? part.sketches.find((s) => s.id === existing.sketchId) : this.defaultSketchForFeature(part);
    if (!sketch) {
      void alertDialog("Revolve", "<p>Create a closed sketch and a centreline first, then run Revolve.</p>", "rotate-3d");
      return;
    }
    if (this.command) this.cancelCommand();
    const params = existing?.params ?? {};
    const angle = params.angle ?? 360;
    const axisMode = params.axisMode ?? "v";
    const axisEntityId = params.axisEntityId ?? null;
    const lineOptions = sketch.entities
      .filter((e) => e.kind === "line")
      .map((e) => `<option value="${e.id}" ${axisEntityId === e.id ? "selected" : ""}>Sketch line ${e.id.slice(-3)}</option>`)
      .join("");
    this.command = { kind: "revolve" };
    this.showPanel({
      icon: "rotate-3d",
      title: existing ? `Edit ${existing.name}` : "Revolve",
      sub: existing ? existing.name : "Revolved boss / cut",
      body:
        pmSection(
          "Profile",
          "drafting-compass",
          pmField(
            "Sketch",
            `<select id="pm-feature-sketch">${part.sketches
              .map((s) => `<option value="${s.id}" ${s.id === sketch.id ? "selected" : ""}>${escapeHtml(s.name)}</option>`)
              .join("")}</select>`,
          ),
        ) +
        pmSection(
          "Axis",
          "axis-3d",
          pmField(
            "Revolve around",
            `<select id="pm-axis-mode">
              <option value="v" ${axisMode === "v" ? "selected" : ""}>Sketch vertical axis</option>
              <option value="u" ${axisMode === "u" ? "selected" : ""}>Sketch horizontal axis</option>
              ${lineOptions ? `<option value="entity" ${axisMode === "entity" ? "selected" : ""}>Sketch line…</option>` : ""}
            </select>`,
          ) +
            (lineOptions ? pmField("Axis line", `<select id="pm-axis-entity">${lineOptions}</select>`) : ""),
        ) +
        pmSection(
          "Direction 1",
          "rotate-3d",
          pmField("Angle", numInput("pm-angle", angle, "°", 0.1)) +
            pmField(
              "Operation",
              `<select id="pm-revolve-op"><option value="join" ${params.operation !== "cut" && params.operation !== "new" ? "selected" : ""}>Join with body</option><option value="new" ${params.operation === "new" ? "selected" : ""}>New body</option><option value="cut" ${params.operation === "cut" ? "selected" : ""}>Cut</option></select>`,
            ),
        ) +
        `<div class="hint">360° produces a full revolution. The profile must not cross the axis.</div>`,
      onOk: () => {
        const root = this.panelRoot ?? document;
        const sketchId = readText(root, "pm-feature-sketch", sketch.id);
        const selectedSketch = part.sketches.find((s) => s.id === sketchId);
        if (!selectedSketch) return;
        const mode = readText(root, "pm-axis-mode", "v") as "u" | "v" | "entity";
        const featureParams = {
          angle: clamp(readNumber(root, "pm-angle", 360), 0.1, 360),
          axisMode: mode,
          axisEntityId: mode === "entity" ? readText(root, "pm-axis-entity", "") || null : null,
          operation: readText(root, "pm-revolve-op", "join") as "join" | "new" | "cut",
        };
        const before = this.capture();
        if (existing) {
          existing.sketchId = sketchId;
          existing.params = { ...existing.params, ...featureParams };
        } else {
          const feature: Feature = {
            id: uid("feat"),
            type: "revolve",
            name: nextFeatureName("revolve", part.features),
            sketchId,
            params: featureParams,
          };
          part.features.push(feature);
          this.selection = { kind: "feature", id: feature.id };
        }
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
      },
    });
  }

  private openFillet(type: "fillet" | "chamfer", existing?: Feature): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to modify the part.", "warn");
      return;
    }
    const part = this.activePart();
    const mesh = part ? this.meshForPart(part.id) : undefined;
    if (!part || !mesh || mesh.positions.length === 0) {
      toast("Create a body before adding a fillet or chamfer.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    const picked = new Set<number>(existing?.params.edgeIndices ?? this.selEdges.map((e) => e.edgeIndex));
    const isFillet = type === "fillet";
    const size = isFillet ? Math.abs(existing?.params.radius ?? 2) : Math.abs(existing?.params.distance ?? 1);
    this.command = {
      kind: type,
      onEdge: (pick) => {
        if (pick.componentId) return;
        if (picked.has(pick.edgeIndex)) picked.delete(pick.edgeIndex);
        else picked.add(pick.edgeIndex);
        renderChips();
        this.shell.setStatus(`${picked.size} edge(s) selected`);
      },
    };
    const renderChips = () => {
      const host = this.panelRoot?.querySelector<HTMLElement>("#pm-edge-chips");
      if (host) {
        host.innerHTML = picked.size
          ? [...picked]
              .sort((a, b) => a - b)
              .map((index) => `<button class="chip" data-edge-chip="${index}">Edge ${index + 1} ${icon("x")}</button>`)
              .join("")
          : `<span class="hint">No edges selected yet — click edges in the viewport.</span>`;
      }
      this.viewport.setSelectedEdges([...picked].map((edgeIndex) => ({ componentId: null, edgeIndex })));
      this.shell.setSelection(picked.size ? `${picked.size} edge(s) selected` : null);
    };
    this.viewport.setPickFilter("edge");
    this.shell.setHint(`Click edges in the viewport to ${existing ? "edit" : "add"} the ${isFillet ? "fillet" : "chamfer"}.`);
        this.showPanel({
      icon: isFillet ? "circle" : "triangle",
      title: existing ? `Edit ${existing.name}` : isFillet ? "Fillet" : "Chamfer",
      sub: `${picked.size} edge(s)`,
      body:
        pmSection("Selected Edges", "circle-dot", `<div class="chip-row" id="pm-edge-chips"></div>`) +
        pmSection(
          "Parameters",
          isFillet ? "circle" : "triangle",
          pmField(isFillet ? "Radius" : "Distance", numInput(isFillet ? "pm-fillet-radius" : "pm-chamfer-distance", size, "mm", 0.01)) +
            `<div class="hint">${isFillet ? "A constant-radius fillet is applied to every selected edge." : "A constant-distance chamfer is applied to every selected edge."} Edge order follows the current body topology.</div>`,
        ),
      onMount: (root) => {
        renderChips();
        root.querySelector<HTMLElement>("#pm-edge-chips")?.addEventListener("click", (event) => {
          const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-edge-chip]");
          if (!chip) return;
          picked.delete(Number(chip.dataset.edgeChip));
          renderChips();
        });
      },
      onOk: () => {
        if (picked.size === 0) {
          toast("Select at least one edge.", "warn");
          return;
        }
        const root = this.panelRoot ?? document;
        const value = Math.max(0.01, readNumber(root, isFillet ? "pm-fillet-radius" : "pm-chamfer-distance", size));
        const before = this.capture();
        const featureParams = isFillet ? { radius: value, edgeIndices: [...picked] } : { distance: value, edgeIndices: [...picked] };
        if (existing) {
          existing.params = { ...existing.params, ...featureParams };
        } else {
          const feature: Feature = {
            id: uid("feat"),
            type,
            name: nextFeatureName(type, part.features),
            params: featureParams,
          };
          part.features.push(feature);
          this.selection = { kind: "feature", id: feature.id };
        }
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
        toast(`${isFillet ? "Fillet" : "Chamfer"} applied to ${picked.size} edge(s).`, "success");
      },
    });
  }

  private openShell(): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to modify the part.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part || !this.meshForPart(part.id)) {
      toast("Create a body before shelling it.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    this.showPanel({
      icon: "box",
      title: "Shell",
      sub: "Constant wall thickness",
      body:
        pmSection("Parameters", "box", pmField("Thickness", numInput("pm-shell-thickness", 2, "mm", 0.05)) + `<div class="hint">The +Y-facing face is removed, producing an open enclosure. Wall thickness is applied on all remaining sides.</div>`),
      onOk: () => {
        const root = this.panelRoot ?? document;
        const value = Math.max(0.05, readNumber(root, "pm-shell-thickness", 2));
        const before = this.capture();
        part.features.push({
          id: uid("feat"),
          type: "shell",
          name: nextFeatureName("shell", part.features),
          params: { thickness: value },
        });
        part.rollbackIndex = undefined;
        this.selection = { kind: "feature", id: part.features[part.features.length - 1].id };
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
        toast(`Shell ${fmt(value, 2)} mm applied.`, "success");
      },
    });
  }

  private openMirror(): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to modify the part.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part || !this.meshForPart(part.id)) {
      toast("Create a body before mirroring it.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    this.showPanel({
      icon: "arrow-right-left",
      title: "Mirror",
      sub: "Mirror the body about a base plane",
      body: pmSection(
        "Parameters",
        "frame",
        pmField(
          "Mirror plane",
          `<select id="pm-mirror-plane"><option value="right">Right Plane (YZ)</option><option value="front">Front Plane (XY)</option><option value="top">Top Plane (XZ)</option></select>`,
        ) + `<div class="hint">The mirrored copy is fused to the original body.</div>`,
      ),
      onOk: () => {
        const root = this.panelRoot ?? document;
        const mirrorPlane = readText(root, "pm-mirror-plane", "right") as "front" | "top" | "right";
        const before = this.capture();
        part.features.push({
          id: uid("feat"),
          type: "mirror",
          name: nextFeatureName("mirror", part.features),
          params: { mirrorPlane },
        });
        part.rollbackIndex = undefined;
        this.selection = { kind: "feature", id: part.features[part.features.length - 1].id };
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
        toast(`Mirror about the ${mirrorPlane} plane applied.`, "success");
      },
    });
  }

  private openPattern(): void {
    if (this.doc.mode !== "part") {
      toast("Switch to Part mode to modify the part.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part || !this.meshForPart(part.id)) {
      toast("Create a body before patterning it.", "warn");
      return;
    }
    if (this.command) this.cancelCommand();
    this.showPanel({
      icon: "layout-grid",
      title: "Linear Pattern",
      sub: "Repeat the body along an axis",
      body: pmSection(
        "Parameters",
        "layout-grid",
        pmField("Axis", `<select id="pm-pattern-axis"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select>`) +
          pmField("Count", numInput("pm-pattern-count", 2, "", 2)) +
          pmField("Spacing", numInput("pm-pattern-spacing", 20, "mm", 0.01)) +
          `<div class="hint">Copies are fused into the same body, so the result is a single solid.</div>`,
      ),
      onOk: () => {
        const root = this.panelRoot ?? document;
        const patternAxis = readText(root, "pm-pattern-axis", "x") as "x" | "y" | "z";
        const patternCount = Math.max(2, Math.round(readNumber(root, "pm-pattern-count", 2)));
        const patternSpacing = Math.max(0.01, readNumber(root, "pm-pattern-spacing", 20));
        const before = this.capture();
        part.features.push({
          id: uid("feat"),
          type: "pattern",
          name: nextFeatureName("pattern", part.features),
          params: { patternAxis, patternCount, patternSpacing },
        });
        part.rollbackIndex = undefined;
        this.selection = { kind: "feature", id: part.features[part.features.length - 1].id };
        this.commit(before);
        this.finishCommand();
        this.refreshTree();
        void this.rebuild();
        toast(`Linear pattern ${patternCount} × ${fmt(patternSpacing, 1)} mm applied.`, "success");
      },
    });
  }

  private editFeature(feature: Feature): void {
    if (this.editor.isActive) {
      toast("Finish the sketch first.", "warn");
      return;
    }
    if (feature.type === "extrude" || feature.type === "cut") this.openExtrude(feature.type, feature);
    else if (feature.type === "revolve") this.openRevolve(feature);
    else if (feature.type === "fillet" || feature.type === "chamfer") this.openFillet(feature.type, feature);
    else if (feature.type === "imported") {
      void alertDialog("Imported Body", "<p>Imported STEP/IGES bodies keep their original geometry. Delete the body and import a new file to change it.</p>", "file-box");
    }
  }

  // --------------------------------------------------------------- assembly

  private async insertComponent(): Promise<void> {
    if (this.editor.isActive) {
      toast("Finish the sketch before creating an assembly.", "warn");
      return;
    }
    if (this.doc.parts.length === 0) {
      toast("Create a part first, then insert it into the assembly.", "warn");
      return;
    }
    let partSelect: HTMLSelectElement | null = null;
    let qtyInput: HTMLInputElement | null = null;
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="field"><label>Part</label><select id="insert-part">${this.doc.parts
        .map((part) => `<option value="${part.id}">${escapeHtml(part.name)}</option>`)
        .join("")}</select></div>
      <div class="field"><label>Quantity</label><div class="input-wrap"><input id="insert-qty" type="number" value="1" min="1" max="10" /></div></div>
      <div class="hint">New components are placed beside each other. The first component is fixed; use Mates to position the rest.</div>
    `;
    const result = await openModal({
      title: "Insert Component",
      icon: "component",
      body,
      width: 430,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Insert", value: "ok", kind: "primary" },
      ],
      onMount: (root) => {
        partSelect = root.querySelector<HTMLSelectElement>("#insert-part");
        qtyInput = root.querySelector<HTMLInputElement>("#insert-qty");
      },
    });
    if (result !== "ok") return;
    const insertedPartId = body.querySelector<HTMLSelectElement>("#insert-part")?.value;
    const insertedQty = body.querySelector<HTMLInputElement>("#insert-qty")?.value;
    const part = this.doc.parts.find((p) => p.id === insertedPartId);
    if (!part) return;
    const quantity = clamp(Math.round(Number(insertedQty) || 1), 1, 10);
    const mesh = this.meshForPart(part.id);
    const width = mesh ? Math.max(10, mesh.bbox.max[0] - mesh.bbox.min[0]) : 100;
    const before = this.capture();
    let lastId = "";
    for (let i = 0; i < quantity; i++) {
      let suffix = 1;
      while (this.doc.components.some((c) => c.name === `${part.name}${suffix}`)) suffix++;
      const component: Component = {
        id: uid("cmp"),
        partId: part.id,
        name: `${part.name}${suffix}`,
        position: [this.doc.components.length * (width + 18), 0, 0],
        rotation: [0, 0, 0],
        visible: true,
        fixed: this.doc.components.length === 0,
      };
      this.doc.components.push(component);
      lastId = component.id;
    }
    this.doc.mode = "assembly";
    this.doc.activeComponentId = lastId;
    this.commit(before);
    this.shell.setMode("assembly");
    this.shell.setCommandTab("assembly");
    this.shell.setDocument(this.doc);
    this.refreshScene();
    this.refreshTree();
    this.updateMassCard();
    this.shell.setStatus(`${quantity} component(s) inserted · add mates to position them`);
    toast(`${part.name} inserted into the assembly.`, "success");
  }

  private openTransform(componentId: string): void {
    const component = this.doc.components.find((c) => c.id === componentId);
    if (!component) return;
    if (this.command) this.cancelCommand();
    const original = { position: [...component.position] as Vec3, rotation: [...component.rotation] as Vec3 };
    const before = this.capture();
    const apply = (root: HTMLElement) => {
      component.position = [
        readNumber(root, "pm-tx", component.position[0]),
        readNumber(root, "pm-ty", component.position[1]),
        readNumber(root, "pm-tz", component.position[2]),
      ];
      component.rotation = [
        readNumber(root, "pm-rx", component.rotation[0]),
        readNumber(root, "pm-ry", component.rotation[1]),
        readNumber(root, "pm-rz", component.rotation[2]),
      ];
      component.fixed = readChecked(root, "pm-fixed");
      this.refreshScene();
    };
    const vecField = (label: string, axis: string, value: number) =>
      `<div class="field"><label>${label}</label><div class="input-wrap"><input id="pm-t${axis}" type="number" step="0.5" value="${value}" /></div></div>`;
    const rotField = (label: string, axis: string, value: number) =>
      `<div class="field"><label>${label}</label><div class="input-wrap"><input id="pm-r${axis}" type="number" step="1" value="${value}" /><span class="unit">°</span></div></div>`;
    this.command = { kind: "transform" };
    this.showPanel({
      icon: "move-3d",
      title: "Component Transform",
      sub: component.name,
      body:
        pmSection(
          "Position",
          "axis-3d",
          `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
            ${vecField("X", "x", component.position[0])}${vecField("Y", "y", component.position[1])}${vecField("Z", "z", component.position[2])}
          </div>`,
        ) +
        pmSection(
          "Rotation",
          "rotate-3d",
          `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
            ${rotField("X", "x", component.rotation[0])}${rotField("Y", "y", component.rotation[1])}${rotField("Z", "z", component.rotation[2])}
          </div>
          <label class="check-row" style="margin-top:8px"><input type="checkbox" id="pm-fixed" ${component.fixed ? "checked" : ""} /> Fixed in space</label>`,
        ) +
        `<div class="hint">Values update the assembly live. Rotation order is XYZ, in degrees.</div>`,
      onMount: (root) => {
        root.querySelectorAll<HTMLInputElement>("input[type=number]").forEach((input) => {
          input.addEventListener("input", () => apply(root));
        });
        root.querySelector<HTMLInputElement>("#pm-fixed")?.addEventListener("change", () => apply(root));
      },
      onOk: () => {
        if (this.panelRoot) apply(this.panelRoot);
        const changed =
          component.position[0] !== original.position[0] ||
          component.position[1] !== original.position[1] ||
          component.position[2] !== original.position[2] ||
          component.rotation[0] !== original.rotation[0] ||
          component.rotation[1] !== original.rotation[1] ||
          component.rotation[2] !== original.rotation[2];
        if (changed) this.commit(before);
        else this.touchDocument();
        this.finishCommand();
        this.refreshTree();
      },
      onCancel: () => {
        component.position = original.position;
        component.rotation = original.rotation;
        this.refreshScene();
        this.finishCommand();
        this.refreshTree();
      },
    });
  }

  private toggleFixed(componentId: string): void {
    const component = this.doc.components.find((c) => c.id === componentId);
    if (!component) return;
    const before = this.capture();
    component.fixed = !component.fixed;
    this.commit(before);
    this.refreshTree();
    toast(`${component.name} is now ${component.fixed ? "fixed" : "floating"}.`, "info");
  }

  private resolveMates(): void {
    if (this.doc.mates.length === 0) {
      toast("There are no mates to resolve.", "info");
      return;
    }
    const before = this.capture();
    const report = solveMates(this.doc);
    if (report.changed) this.commit(before);
    else this.scheduleAutosave();
    this.refreshScene();
    this.refreshTree();
    toast(report.errors ? `${report.errors} mate(s) could not be resolved.` : "All mates are satisfied.", report.errors ? "warn" : "success");
  }

  private openMate(type: Mate["type"], existing?: Mate): void {
    if (this.editor.isActive) {
      toast("Finish the sketch first.", "warn");
      return;
    }
    if (this.doc.components.length < 2) {
      toast("Insert at least two components before adding a mate.", "warn");
      return;
    }
    if (this.doc.mode !== "assembly") {
      this.doc.mode = "assembly";
      this.shell.setMode("assembly");
      this.shell.setCommandTab("assembly");
      this.shell.setDocument(this.doc);
      this.refreshScene();
      this.refreshTree();
    }
    if (this.command) this.cancelCommand();
    // Seed from a Ctrl+click multi-selection: two faces on different components
    // open the panel with both picks ready (SolidWorks' "Mate" with a preselection).
    const picks: FacePick[] = [];
    if (!existing) {
      for (const face of this.selFaces) {
        if (!face.componentId) continue;
        if (picks.some((p) => p.componentId === face.componentId)) continue;
        picks.push(face);
        if (picks.length === 2) break;
      }
      // The preselection is consumed here; the panel owns the picks from now on.
      this.selFaces = [];
      this.selectedFace = null;
    }
    if (existing) {
      const a = this.doc.components.find((c) => c.id === existing.a.componentId);
      const b = this.doc.components.find((c) => c.id === existing.b.componentId);
      if (!a || !b) {
        toast("A component used by this mate no longer exists.", "warn");
        return;
      }
    }
    const renderPicks = () => {
      const host = this.panelRoot?.querySelector<HTMLElement>("#pm-mate-picks");
      if (!host) return;
      if (existing) {
        host.innerHTML = [existing.a, existing.b]
          .map((ref) => {
            const name = componentName(this.doc, ref.componentId);
            return `<div class="selection-item">${icon("square")}<span>${escapeHtml(name)} · Face ${ref.faceIndex + 1}</span></div>`;
          })
          .join("");
        return;
      }
      host.innerHTML = picks.length
        ? picks
            .map(
              (pick, index) =>
                `<div class="selection-item">${icon("square")}<span>${escapeHtml(componentName(this.doc, pick.componentId))} · Face ${pick.faceIndex + 1}</span><button class="x" data-mate-remove="${index}" title="Remove">${icon("x")}</button></div>`,
            )
            .join("")
        : `<div class="hint">No faces selected. Click one face on each component.</div>`;
      this.viewport.setSelectedFaces(picks.map((p) => ({ componentId: p.componentId, faceIndex: p.faceIndex })));
    };
    const refreshDistance = () => {
      const root = this.panelRoot;
      if (!root) return;
      const kind = readText(root, "pm-mate-type", type);
      const row = root.querySelector<HTMLElement>("#pm-mate-distance-row");
      if (row) row.style.display = kind === "distance" ? "" : "none";
    };
    this.command = {
      kind: "mate",
      onFace: (pick) => {
        if (!pick.componentId) {
          toast("Pick a face on an inserted component.", "warn");
          return;
        }
        if (picks.length === 1 && picks[0].componentId === pick.componentId) {
          toast("Pick the second face on a different component.", "warn");
          return;
        }
        if (picks.length >= 2) {
          toast("Two faces are already selected. Remove one to change the selection.", "info");
          return;
        }
        picks.push(pick);
        renderPicks();
        refreshDistance();
        this.shell.setStatus(`${picks.length}/2 faces selected`);
      },
    };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    this.shell.setHint("Pick a face on the first component, then a face on the second component.");
    this.showPanel({
      icon: "link",
      title: existing ? `Edit ${existing.name}` : "Mate",
      sub: existing ? existing.name : "Coincident / Concentric / Distance",
      body:
        pmSection(
          "Mate Selections",
          "link",
          `<div class="selection-list" id="pm-mate-picks"></div>
          <div class="hint" style="margin-top:6px">${existing ? "The selected faces are fixed. Remove and recreate the mate to pick different faces." : "Faces are stored in component space so the mate keeps working after transforms."}</div>`,
        ) +
        pmSection(
          "Standard Mates",
          "target",
          pmField(
            "Type",
            `<select id="pm-mate-type">
              <option value="coincident" ${type === "coincident" ? "selected" : ""}>Coincident — faces touch</option>
              <option value="concentric" ${type === "concentric" ? "selected" : ""}>Concentric — axes align</option>
              <option value="distance" ${type === "distance" ? "selected" : ""}>Distance — offset faces</option>
            </select>`,
          ) +
            `<div id="pm-mate-distance-row">${pmField("Distance", numInput("pm-mate-distance", existing?.distance ?? 10, "mm"))}</div>
            <label class="check-row"><input type="checkbox" id="pm-mate-flip" ${existing?.flipped ? "checked" : ""} /> Flip alignment</label>`,
        ),
      onMount: (root) => {
        renderPicks();
        refreshDistance();
        root.querySelector<HTMLElement>("#pm-mate-picks")?.addEventListener("click", (event) => {
          const button = (event.target as HTMLElement).closest<HTMLElement>("[data-mate-remove]");
          if (!button) return;
          picks.splice(Number(button.dataset.mateRemove), 1);
          renderPicks();
        });
        root.querySelector<HTMLSelectElement>("#pm-mate-type")?.addEventListener("change", refreshDistance);
      },
      onOk: () => {
        const root = this.panelRoot ?? document;
        const mateType = readText(root, "pm-mate-type", type) as Mate["type"];
        const distance = Math.abs(readNumber(root, "pm-mate-distance", existing?.distance ?? 10));
        const flipped = readChecked(root, "pm-mate-flip");
        const before = this.capture();
        if (existing) {
          existing.type = mateType;
          existing.distance = mateType === "distance" ? distance : undefined;
          existing.flipped = flipped;
        } else {
          if (picks.length < 2) {
            toast("Select two faces to create the mate.", "warn");
            return;
          }
          const componentA = this.doc.components.find((c) => c.id === picks[0].componentId);
          const componentB = this.doc.components.find((c) => c.id === picks[1].componentId);
          if (!componentA || !componentB) return;
          const label = mateType === "concentric" ? "Concentric" : mateType === "distance" ? "Distance" : "Coincident";
          let suffix = 1;
          while (this.doc.mates.some((m) => m.name === `${label}${suffix}`)) suffix++;
          const mate: Mate = {
            id: uid("mate"),
            type: mateType,
            name: `${label}${suffix}`,
            a: faceRefFromPick(componentA, picks[0].faceIndex, picks[0].face.surface, picks[0].face.point, picks[0].face.normal, picks[0].face.axis, picks[0].face.radius),
            b: faceRefFromPick(componentB, picks[1].faceIndex, picks[1].face.surface, picks[1].face.point, picks[1].face.normal, picks[1].face.axis, picks[1].face.radius),
            distance: mateType === "distance" ? distance : undefined,
            flipped,
          };
          this.doc.mates.push(mate);
          this.selection = { kind: "mate", id: mate.id };
        }
        const report = solveMates(this.doc);
        this.commit(before);
        this.finishCommand();
        this.refreshScene();
        this.refreshTree();
        if (report.errors) toast(`${report.errors} mate(s) could not be resolved.`, "warn");
        else toast("Mate solved.", "success");
      },
    });
  }

  // -------------------------------------------------------------------- FEA

  private createStudy(part: Part): AnalysisStudy {
    let suffix = 1;
    while (this.doc.analyses.some((s) => s.name === `Static Study ${suffix}`)) suffix++;
    let meshSize = 4;
    const mesh = this.meshForPart(part.id);
    if (mesh && mesh.positions.length > 0) {
      const diagonal = Math.hypot(
        mesh.bbox.max[0] - mesh.bbox.min[0],
        mesh.bbox.max[1] - mesh.bbox.min[1],
        mesh.bbox.max[2] - mesh.bbox.min[2],
      );
      meshSize = clamp(Math.round((diagonal / 26) * 2) / 2, 0.5, 20);
    }
    return {
      id: uid("study"),
      name: `Static Study ${suffix}`,
      partId: part.id,
      materialId: part.materialId ?? "steel",
      meshSize,
      supports: [],
      loads: [],
      status: "draft",
    };
  }

  private async newStudy(): Promise<void> {
    if (this.editor.isActive) {
      toast("Finish the sketch first.", "warn");
      return;
    }
    const part = this.activePart();
    if (!part) {
      toast("Create a part before starting an analysis.", "warn");
      return;
    }
    const before = this.capture();
    const study = this.createStudy(part);
    this.doc.analyses.push(study);
    this.doc.activeStudyId = study.id;
    this.doc.activePartId = part.id;
    this.doc.mode = "analysis";
    this.commit(before);
    this.shell.setMode("analysis");
    this.shell.setCommandTab("analysis");
    this.shell.setDocument(this.doc);
    this.refreshScene();
    this.refreshTree();
    this.shell.setStatus(`${study.name} created · assign material, mesh and boundary conditions`);
    this.openStudyPanel();
  }

  private refreshPickLists(study: AnalysisStudy): void {
    const root = this.panelRoot;
    if (!root) return;
    const supportHost = root.querySelector<HTMLElement>("#pm-support-list");
    if (supportHost) {
      supportHost.innerHTML = study.supports.length
        ? study.supports
            .map(
              (support) =>
                `<div class="selection-item">${icon("anchor")}<span>Fixed support · Face ${support.faceIndex + 1}</span><button class="x" data-remove-support="${support.id}" title="Remove">${icon("x")}</button></div>`,
            )
            .join("")
        : `<div class="hint">No supports yet.</div>`;
    }
    const loadHost = root.querySelector<HTMLElement>("#pm-load-list");
    if (loadHost) {
      loadHost.innerHTML = study.loads.length
        ? study.loads
            .map(
              (load) =>
                `<div class="selection-item">${icon(load.type === "pressure" ? "gauge" : "arrow-down-to-line")}<span>${load.type === "pressure" ? `${fmt(load.magnitude, 2)} MPa` : `${fmt(load.magnitude, 1)} N`} · Face ${load.faceIndex + 1}</span><button class="x" data-remove-load="${load.id}" title="Remove">${icon("x")}</button></div>`,
            )
            .join("")
        : `<div class="hint">No loads yet.</div>`;
    }
  }

  private bindPickListRemoval(study: AnalysisStudy): void {
    const root = this.panelRoot;
    if (!root) return;
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const supportButton = target.closest<HTMLElement>("[data-remove-support]");
      const loadButton = target.closest<HTMLElement>("[data-remove-load]");
      if (!supportButton && !loadButton) return;
      const before = this.capture();
      if (supportButton) study.supports = study.supports.filter((s) => s.id !== supportButton.dataset.removeSupport);
      else if (loadButton) study.loads = study.loads.filter((l) => l.id !== loadButton.dataset.removeLoad);
      this.invalidateStudy(study);
      this.commit(before);
      this.refreshTree();
      this.refreshScene();
      this.refreshPickLists(study);
    });
  }

  private invalidateStudy(study: AnalysisStudy): void {
    this.feaResults.delete(study.id);
    study.status = "draft";
    study.error = undefined;
    study.meshStats = undefined;
    if (this.doc.activeStudyId === study.id) {
      this.activeResult = null;
      this.toolbarMode = null;
      this.resultView.clear();
      this.shell.showColorbar(null);
      this.shell.showResultToolbar(null);
    }
  }

  private openStudyPanel(): void {
    let study = this.activeStudy();
    if (!study) {
      void this.newStudy();
      return;
    }
    const studyPartId = study.partId;
    const part = this.doc.parts.find((p) => p.id === studyPartId) ?? this.activePart();
    if (!part) return;
    if (this.command) this.cancelCommand();
    this.doc.activeStudyId = study.id;
    this.doc.activePartId = study.partId;
    this.doc.mode = "analysis";
    this.shell.setMode("analysis");
    this.shell.setCommandTab("analysis");
    this.shell.setDocument(this.doc);
    this.refreshScene();
    this.refreshTree();

    study = this.activeStudy() ?? study;
    const material = this.materialForStudy(study);
    const mesh = this.meshForPart(study.partId);
    const result = this.feaResults.get(study.id);
    const triangleCount = mesh ? Math.round(mesh.indices.length / 3) : 0;
    const statusLabel = study.status === "solved" ? "SOLVED" : study.status === "meshed" ? "MESHED" : study.status === "failed" ? "FAILED" : "SETUP";
    const stats = study.meshStats
      ? `<div class="study-stats"><span>Nodes</span><span>${study.meshStats.nodes.toLocaleString()}</span><span>Elements</span><span>${study.meshStats.elements.toLocaleString()}</span></div>`
      : `<div class="hint">Mesh not generated. A finer size gives more accurate stress but takes longer.</div>`;
    const resultStats = result
      ? `<div class="study-stats">
          <span>Max deformation</span><span>${result.maxDisplacement.toExponential(3)} mm</span>
          <span>Max von Mises</span><span>${fmt(result.maxStress, 2)} MPa</span>
          <span>Safety factor</span><span>${Number.isFinite(result.safetyFactor) ? fmt(result.safetyFactor, 2) : "∞"}</span>
          <span>DOFs</span><span>${result.dofs.toLocaleString()}</span>
          <span>Iterations</span><span>${result.iterations}${result.converged ? "" : " (not converged)"}</span>
          <span>Solve time</span><span>${(result.solveMs / 1000).toFixed(2)} s</span>
        </div>`
      : "";
    this.command = { kind: "study" };
    this.showPanel({
      icon: "activity",
      title: study.name,
      sub: `Static Structural · ${statusLabel}`,
      okTitle: "Done",
      cancel: false,
      body:
        pmSection(
          "Geometry",
          "box",
          `<div class="study-stats"><span>Part</span><span>${escapeHtml(part.name)}</span><span>Surface</span><span>${triangleCount.toLocaleString()} triangles</span></div>`,
        ) +
        pmSection(
          "Materials",
          "layers",
          pmField("Assignment", `<select id="pm-study-material">${materialOptions(study.materialId)}</select>`) +
            `<div class="study-stats">
              <span>Young's modulus</span><span>${material.E >= 1000 ? `${fmt(material.E / 1000, 1)} GPa` : `${fmt(material.E, 0)} MPa`}</span>
              <span>Poisson's ratio</span><span>${material.nu}</span>
              <span>Yield strength</span><span>${fmt(material.yield, 1)} MPa</span>
              <span>Density</span><span>${fmt(material.density, 0)} kg/m³</span>
            </div>`,
        ) +
        pmSection(
          "Mesh",
          "grid-3x3",
          pmField("Element size", numInput("pm-study-mesh", study.meshSize, "mm", 0.2)) +
            stats +
            `<div class="inline-options" style="margin-top:8px"><button class="opt-btn" data-study-action="mesh">${icon("grid-3x3")} Generate Mesh</button></div>`,
        ) +
        pmSection(
          "Boundary Conditions",
          "anchor",
          `<div class="inline-options">
            <button class="opt-btn" data-study-action="support">${icon("anchor")} Fixed Support</button>
            <button class="opt-btn" data-study-action="force">${icon("arrow-down-to-line")} Force</button>
            <button class="opt-btn" data-study-action="pressure">${icon("gauge")} Pressure</button>
          </div>
          <div class="selection-list" id="pm-load-list" style="margin-top:8px"></div>
          <div class="inline-options" style="margin-top:8px"><button class="opt-btn" data-study-action="clear-loads">${icon("trash-2")} Clear All</button></div>`,
        ) +
        pmSection(
          "Solution",
          "play",
          `<div class="inline-options">
            <button class="opt-btn active" data-study-action="solve">${icon("play")} Solve Static</button>
            <button class="opt-btn" data-study-action="clear">${icon("refresh-cw")} Clear Results</button>
          </div>
          ${resultStats}`,
        ) +
        `<div class="hint">Unit system: <b>MMGS / NMM</b> (mm, N, MPa). The solver uses 8-node hexahedra with a Jacobi-preconditioned conjugate-gradient iteration.</div>`,
      onMount: (root) => {
        this.refreshPickLists(study);
        this.bindPickListRemoval(study);
        root.querySelector<HTMLSelectElement>("#pm-study-material")?.addEventListener("change", (event) => {
          const next = (event.target as HTMLSelectElement).value;
          const before = this.capture();
          study.materialId = next;
          part.materialId = next;
          this.invalidateStudy(study);
          this.commit(before);
          this.refreshTree();
          this.refreshScene();
          this.openStudyPanel();
        });
        root.querySelector<HTMLInputElement>("#pm-study-mesh")?.addEventListener("change", (event) => {
          const value = clamp(Number((event.target as HTMLInputElement).value) || study.meshSize, 0.2, 50);
          const before = this.capture();
          study.meshSize = value;
          this.invalidateStudy(study);
          this.commit(before);
          this.refreshTree();
          this.openStudyPanel();
        });
        root.querySelectorAll<HTMLElement>("[data-study-action]").forEach((button) => {
          button.addEventListener("click", () => {
            const action = button.dataset.studyAction;
            if (action === "mesh") void this.meshStudy();
            else if (action === "solve") void this.solveStudy();
            else if (action === "clear") this.clearStudyResults(study);
            else if (action === "support") this.openSupportPick();
            else if (action === "force") this.openForcePick();
            else if (action === "pressure") this.openPressurePick();
            else if (action === "clear-loads") {
              const before = this.capture();
              study.supports = [];
              study.loads = [];
              this.invalidateStudy(study);
              this.commit(before);
              this.refreshTree();
              this.refreshScene();
              this.openStudyPanel();
            }
          });
        });
      },
      onOk: () => this.finishCommand(),
    });
  }

  private openSupportPick(): void {
    const study = this.activeStudy();
    if (!study) return;
    if (this.command) this.cancelCommand();
    const addSupport = (pick: FacePick) => {
      if (pick.partId !== study.partId) {
        toast("Pick a face on the study part.", "warn");
        return;
      }
      if (study.supports.some((s) => s.faceIndex === pick.faceIndex)) {
        toast("This face already has a fixed support.", "info");
        return;
      }
      const before = this.capture();
      study.supports.push({
        id: uid("sup"),
        faceIndex: pick.faceIndex,
        face: { faceIndex: pick.faceIndex, surface: pick.face.surface, point: pick.face.point, normal: pick.face.normal },
      });
      this.invalidateStudy(study);
      this.commit(before);
      this.refreshTree();
      this.refreshScene();
      this.refreshPickLists(study);
      this.shell.setStatus(`Fixed support added · face ${pick.faceIndex + 1}`);
    };
    this.command = { kind: "support-pick", onFace: addSupport };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    // A Ctrl+click face selection made before the command becomes the support set,
    // and is consumed so the next command starts from an empty selection.
    const preselected = this.selFaces.filter((f) => f.partId === study.partId);
    this.selFaces = [];
    this.selectedFace = null;
    for (const pick of preselected) addSupport(pick);
    this.shell.setHint("Click faces to add fixed supports. Press Esc or Done when finished.");
    this.showPanel({
      icon: "anchor",
      title: "Fixed Support",
      sub: "Select faces",
      okTitle: "Done",
      cancel: false,
      body:
        pmSection(
          "Selected Faces",
          "anchor",
          `<div class="selection-list" id="pm-support-list"></div>
          <div class="hint" style="margin-top:6px">All three translational degrees of freedom of the nodes on these faces are locked.</div>`,
        ),
      onMount: () => {
        this.refreshPickLists(study);
        this.bindPickListRemoval(study);
      },
      onOk: () => this.finishCommand(),
    });
  }

  private openForcePick(): void {
    const study = this.activeStudy();
    if (!study) return;
    if (this.command) this.cancelCommand();
    const addFaces = (faces: FacePick[]) => {
      const valid = faces.filter((f) => f.partId === study.partId);
      if (valid.length) void this.openForceDialog(study, valid);
    };
    this.command = {
      kind: "force-pick",
      onFace: (pick, mods) => {
        if (pick.partId !== study.partId) {
          toast("Pick a face on the study part.", "warn");
          return;
        }
        if (mods?.additive) {
          // Ctrl+click collects faces, then the Apply Force button loads them all.
          const exists = this.selFaces.some((f) => f.faceIndex === pick.faceIndex && f.partId === pick.partId);
          this.selFaces = exists
            ? this.selFaces.filter((f) => !(f.faceIndex === pick.faceIndex && f.partId === pick.partId))
            : [...this.selFaces, pick];
          this.viewport.setSelectedFaces(this.selFaces.map((f) => ({ componentId: f.componentId, faceIndex: f.faceIndex })));
          const button = this.panelRoot?.querySelector<HTMLButtonElement>('[data-force-apply="pending"]');
          if (button) button.disabled = this.selFaces.length === 0;
          this.shell.setStatus(`${this.selFaces.length} face(s) queued for the force`);
          return;
        }
        void this.openForceDialog(study, pick);
      },
    };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    const preselected = this.selFaces.filter((f) => f.partId === study.partId);
    this.shell.setHint(
      preselected.length
        ? `${preselected.length} face(s) selected — click Apply Force, or Ctrl+click to change the set.`
        : "Click a face to apply a force, or Ctrl+click several faces and press Apply Force. Esc when finished.",
    );
    this.showPanel({
      icon: "arrow-down-to-line",
      title: "Force",
      sub: "Select faces",
      okTitle: "Done",
      cancel: false,
      body:
        pmSection(
          "Applied Loads",
          "arrow-down-to-line",
          `<div class="inline-options"><button class="opt-btn" data-force-apply="pending" ${preselected.length ? "" : "disabled"}>${icon("check")} Apply Force</button></div>
          <div class="selection-list" id="pm-load-list" style="margin-top:8px"></div>
          <div class="hint" style="margin-top:6px">A force is distributed evenly over the nodes of every selected face.</div>`,
        ),
      onMount: () => {
        this.refreshPickLists(study);
        this.bindPickListRemoval(study);
        this.panelRoot?.querySelector<HTMLElement>("[data-force-apply]")?.addEventListener("click", () => {
          const faces = this.selFaces.slice();
          if (faces.length === 0) {
            toast("Ctrl+click one or more faces first.", "info");
            return;
          }
          this.selFaces = [];
          this.viewport.setSelectedFaces([]);
          addFaces(faces);
        });
      },
      onOk: () => this.finishCommand(),
    });
  }

  private openPressurePick(): void {
    const study = this.activeStudy();
    if (!study) return;
    if (this.command) this.cancelCommand();
    this.command = {
      kind: "pressure-pick",
      onFace: (pick) => {
        if (pick.partId !== study.partId) {
          toast("Pick a face on the study part.", "warn");
          return;
        }
        void this.openPressureDialog(study, pick);
      },
    };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    this.shell.setHint("Click a face to apply pressure. Press Esc or Done when finished.");
    this.showPanel({
      icon: "gauge",
      title: "Pressure",
      sub: "Select faces",
      okTitle: "Done",
      cancel: false,
      body:
        pmSection(
          "Applied Loads",
          "gauge",
          `<div class="selection-list" id="pm-load-list"></div>
          <div class="hint" style="margin-top:6px">Pressure acts along the face normal and produces consistent nodal loads on the boundary triangles.</div>`,
        ),
      onMount: () => {
        this.refreshPickLists(study);
        this.bindPickListRemoval(study);
      },
      onOk: () => this.finishCommand(),
    });
  }

  private async openForceDialog(study: AnalysisStudy, pick: FacePick | FacePick[]): Promise<void> {
    const picks = Array.isArray(pick) ? pick : [pick];
    const first = picks[0];
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="field"><label>Magnitude</label><div class="input-wrap"><input id="force-mag" type="number" step="10" value="1000" min="0.001" /><span class="unit">N</span></div></div>
      <div class="field"><label>Direction</label><select id="force-dir">
        <option value="normal">Opposite face normal (push)</option>
        <option value="along">Along face normal (pull)</option>
        <option value="down">Global −Y</option>
        <option value="zdown">Global −Z</option>
        <option value="x">Global +X</option>
      </select></div>
      <div class="hint">${picks.length === 1 ? `Face ${first.faceIndex + 1} · ${escapeHtml(first.face.surface)}` : `${picks.length} faces (Ctrl+click selection) · shared magnitude`}</div>
    `;
    let magnitudeInput: HTMLInputElement | null = null;
    let directionSelect: HTMLSelectElement | null = null;
    const result = await openModal({
      title: picks.length > 1 ? `Force — ${picks.length} faces` : "Force",
      icon: "arrow-down-to-line",
      body,
      width: 420,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Apply", value: "ok", kind: "primary" },
      ],
    });
    void magnitudeInput;
    void directionSelect;
    if (result !== "ok") return;
    const magnitudeEl = body.querySelector<HTMLInputElement>("#force-mag");
    const directionEl = body.querySelector<HTMLSelectElement>("#force-dir");
    if (!magnitudeEl || !directionEl) return;
    const magnitude = Math.max(0.001, Number(magnitudeEl.value) || 1000);
    const before = this.capture();
    for (const p of picks) {
      const n = p.face.normal;
      const direction: Vec3 =
        directionEl.value === "normal"
          ? [-n[0], -n[1], -n[2]]
          : directionEl.value === "along"
            ? [n[0], n[1], n[2]]
            : directionEl.value === "down"
              ? [0, -1, 0]
              : directionEl.value === "zdown"
                ? [0, 0, -1]
                : [1, 0, 0];
      const load: AnalysisLoad = {
        id: uid("load"),
        type: "force",
        faceIndex: p.faceIndex,
        face: { faceIndex: p.faceIndex, surface: p.face.surface, point: p.face.point, normal: p.face.normal },
        magnitude,
        direction,
        label: `Force ${fmt(magnitude, 0)} N`,
      };
      study.loads.push(load);
    }
    this.invalidateStudy(study);
    this.commit(before);
    this.refreshTree();
    this.refreshScene();
    this.refreshPickLists(study);
    toast(
      picks.length === 1
        ? `Force ${fmt(magnitude, 0)} N added on face ${first.faceIndex + 1}.`
        : `Force ${fmt(magnitude, 0)} N added on ${picks.length} faces.`,
      "success",
    );
  }

  private async openPressureDialog(study: AnalysisStudy, pick: FacePick): Promise<void> {
    const value = await promptNumber({
      title: "Pressure",
      label: `Pressure on face ${pick.faceIndex + 1}`,
      value: 1,
      unit: "MPa",
      min: 0.0001,
      step: 0.1,
    });
    if (value === null) return;
    const before = this.capture();
    study.loads.push({
      id: uid("load"),
      type: "pressure",
      faceIndex: pick.faceIndex,
      face: { faceIndex: pick.faceIndex, surface: pick.face.surface, point: pick.face.point, normal: pick.face.normal },
      magnitude: value,
      direction: [...pick.face.normal] as Vec3,
      label: `Pressure ${fmt(value, 2)} MPa`,
    });
    this.invalidateStudy(study);
    this.commit(before);
    this.refreshTree();
    this.refreshScene();
    this.refreshPickLists(study);
    toast(`Pressure ${fmt(value, 2)} MPa added on face ${pick.faceIndex + 1}.`, "success");
  }

  private async editLoad(study: AnalysisStudy, load: AnalysisLoad): Promise<void> {
    const value = await promptNumber({
      title: load.type === "pressure" ? "Edit Pressure" : "Edit Force",
      label: "Magnitude",
      value: load.magnitude,
      unit: load.type === "pressure" ? "MPa" : "N",
      min: 0.0001,
      step: load.type === "pressure" ? 0.1 : 10,
    });
    if (value === null) return;
    const before = this.capture();
    load.magnitude = value;
    if (load.type === "force") load.label = `Force ${fmt(value, 0)} N`;
    else load.label = `Pressure ${fmt(value, 2)} MPa`;
    this.invalidateStudy(study);
    this.commit(before);
    this.refreshTree();
    this.openStudyPanel();
  }

  private async meshStudy(): Promise<void> {
    const study = this.activeStudy();
    if (!study) return;
    if (this.fea.isBusy) {
      toast("The FEA solver is already running.", "warn");
      return;
    }
    const mesh = this.meshForPart(study.partId);
    if (!mesh || mesh.positions.length === 0) {
      toast("The study part has no surface mesh. Rebuild the model first.", "warn");
      return;
    }
    this.shell.setKernel("FEA meshing", "busy");
    this.shell.setStatus("Generating hexahedral mesh…");
    try {
      const stats = await this.fea.mesh(
        { positions: mesh.positions, indices: mesh.indices, meshSize: study.meshSize },
        (phase, percent) => {
          this.shell.setKernel(`FEA ${Math.round(percent)}%`, "busy");
          this.shell.setStatus(`${phase}… ${Math.round(percent)}%`);
        },
      );
      study.meshStats = { nodes: stats.nodes, elements: stats.elements };
      study.status = "meshed";
      study.error = undefined;
      this.refreshTree();
      toast(`Mesh ready · ${stats.nodes.toLocaleString()} nodes · ${stats.elements.toLocaleString()} elements`, "success", 6000);
      this.openStudyPanel();
    } catch (error) {
      study.status = "failed";
      study.error = messageOf(error);
      this.refreshTree();
      toast(messageOf(error), "error", 7000);
      this.openStudyPanel();
    } finally {
      this.shell.setKernel("OCCT ready");
      this.shell.setStatus("Ready");
    }
  }

  private async solveStudy(): Promise<void> {
    const study = this.activeStudy();
    if (!study) return;
    if (this.fea.isBusy) {
      toast("The FEA solver is already running.", "warn");
      return;
    }
    if (study.supports.length === 0) {
      toast("Add at least one Fixed Support before solving.", "warn");
      return;
    }
    if (study.loads.length === 0) {
      toast("Add at least one Force or Pressure before solving.", "warn");
      return;
    }
    const mesh = this.meshForPart(study.partId);
    if (!mesh || mesh.positions.length === 0) {
      toast("The study part has no surface mesh. Rebuild the model first.", "warn");
      return;
    }
    const material = this.materialForStudy(study);
    const loads: FeaLoadSpec[] = study.loads.map((load) => ({
      type: load.type,
      faceIndex: load.faceIndex,
      magnitude: load.magnitude,
      direction: load.direction,
    }));
    this.shell.setKernel("FEA 0%", "busy");
    this.shell.setStatus("Meshing and solving…");
    try {
      const outcome = await this.fea.solve(
        {
          material: { E: material.E, nu: material.nu, yield: material.yield },
          positions: mesh.positions,
          indices: mesh.indices,
          triFaceIds: mesh.triFaceIds,
          supportFaces: study.supports.map((support) => support.faceIndex),
          loads,
          meshSize: study.meshSize,
        },
        (phase, percent) => {
          this.shell.setKernel(`FEA ${Math.round(percent)}%`, "busy");
          this.shell.setStatus(`${phase}… ${Math.round(percent)}%`);
        },
      );
      this.feaResults.set(study.id, outcome.result);
      study.status = "solved";
      study.stale = false;
      study.meshStats = { nodes: outcome.nodes, elements: outcome.elements };
      study.error = undefined;
      this.resultScale = 1;
      this.activeResult = "stress";
      this.toolbarMode = null;
      this.refreshScene();
      this.showResult("stress");
      this.viewport.zoomFit(false);
      this.refreshTree();
      toast(
        `Solved in ${(outcome.result.solveMs / 1000).toFixed(2)} s · max ${fmt(outcome.result.maxStress, 2)} MPa · SF ${Number.isFinite(outcome.result.safetyFactor) ? fmt(outcome.result.safetyFactor, 2) : "∞"}`,
        "success",
        8000,
      );
      this.openStudyPanel();
    } catch (error) {
      study.status = "failed";
      study.error = messageOf(error);
      this.refreshTree();
      toast(messageOf(error), "error", 8000);
      this.openStudyPanel();
    } finally {
      this.shell.setKernel("OCCT ready");
      this.shell.setStatus("Ready");
    }
  }

  private clearStudyResults(study: AnalysisStudy): void {
    this.feaResults.delete(study.id);
    study.status = study.meshStats ? "meshed" : "draft";
    study.error = undefined;
    this.activeResult = null;
    this.toolbarMode = null;
    this.resultView.clear();
    this.shell.showColorbar(null);
    this.shell.showResultToolbar(null);
    this.refreshScene();
    this.refreshTree();
    this.openStudyPanel();
    toast("Results cleared.", "info");
  }

  private showResult(mode: ResultMode): void {
    const study = this.activeStudy();
    if (!study) return;
    if (this.doc.mode !== "analysis") {
      this.doc.mode = "analysis";
      this.doc.activePartId = study.partId;
      this.shell.setMode("analysis");
      this.shell.setCommandTab("analysis");
      this.shell.setDocument(this.doc);
      this.refreshScene();
      this.refreshTree();
    }
    const result = this.feaResults.get(study.id);
    if (!result) {
      toast("Solve the study before viewing results.", "warn");
      return;
    }
    this.activeResult = mode;
    this.resultView.setResult(result, this.materialForStudy(study).yield);
    const display = this.renderResultUi(mode);
    if (!display) return;
    this.shell.showResultToolbar(this.resultToolbarHtml(mode));
    this.bindResultToolbar();
    this.toolbarMode = mode;
    this.refreshTree();
  }

  private renderResultUi(mode: ResultMode): ResultDisplay | null {
    const study = this.activeStudy();
    const result = study ? this.feaResults.get(study.id) : undefined;
    if (!result) return null;
    const display = this.resultView.show(mode, this.resultScale);
    if (!display) return null;
    this.shell.showColorbar({
      title: display.title,
      min: display.min,
      max: display.max,
      unit: display.unit,
      gradient: display.gradient,
    });
    this.shell.setStatus(`Result · ${display.title} · ${display.summary}`);
    return display;
  }

  private resultToolbarHtml(mode: ResultMode): string {
    const btn = (value: ResultMode, label: string, iconName: string) =>
      `<button class="mini-btn ${mode === value ? "active" : ""}" data-result-mode="${value}">${icon(iconName)} ${label}</button>`;
    return `
      <div class="rt-group">
        <span class="rt-label">Deform scale</span>
        <input id="rt-scale" type="range" min="20" max="400" step="10" value="${Math.round(this.resultScale * 100)}" />
        <span class="rt-value" id="rt-scale-value">${this.resultScale.toFixed(1)}×</span>
      </div>
      <div class="rt-group">
        ${btn("deformation", "Deformation", "activity")}
        ${btn("stress", "von Mises", "flame")}
        ${btn("safety", "Safety", "gauge")}
      </div>
      <div class="rt-group">
        <button class="mini-btn" data-result-body>${icon("box")} Show Body</button>
      </div>
    `;
  }

  private bindResultToolbar(): void {
    const host = this.shell.resultToolbarEl;
    host.querySelector<HTMLInputElement>("#rt-scale")?.addEventListener("input", (event) => {
      this.resultScale = Math.max(0.2, Number((event.target as HTMLInputElement).value) / 100);
      const valueEl = host.querySelector<HTMLElement>("#rt-scale-value");
      if (valueEl) valueEl.textContent = `${this.resultScale.toFixed(1)}×`;
      if (this.activeResult) this.renderResultUi(this.activeResult);
    });
    host.querySelectorAll<HTMLElement>("[data-result-mode]").forEach((button) => {
      button.addEventListener("click", () => this.showResult(button.dataset.resultMode as ResultMode));
    });
    host.querySelector<HTMLElement>("[data-result-body]")?.addEventListener("click", () => this.hideResult());
  }

  private hideResult(): void {
    this.activeResult = null;
    this.toolbarMode = null;
    this.resultView.clear();
    this.shell.showColorbar(null);
    this.shell.showResultToolbar(null);
    this.refreshScene();
    this.refreshTree();
  }

  private syncResultView(): void {
    const study = this.activeStudy();
    const result = study ? this.feaResults.get(study.id) : undefined;
    if (!study || !result || !this.activeResult) {
      this.resultView.clear();
      this.shell.showColorbar(null);
      this.shell.showResultToolbar(null);
      this.toolbarMode = null;
      return;
    }
    const yieldStrength = this.materialForStudy(study).yield;
    this.resultView.setResult(result, yieldStrength);
    this.renderResultUi(this.activeResult);
    if (this.toolbarMode !== this.activeResult) {
      this.shell.showResultToolbar(this.resultToolbarHtml(this.activeResult));
      this.bindResultToolbar();
      this.toolbarMode = this.activeResult;
    }
  }

  // --------------------------------------------------------------- file I/O

  private pickFiles(accept: string): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept;
      input.style.display = "none";
      document.body.appendChild(input);
      let done = false;
      const finish = (files: File[]) => {
        if (done) return;
        done = true;
        input.remove();
        resolve(files);
      };
      input.addEventListener(
        "change",
        () => {
          finish(input.files ? Array.from(input.files) : []);
        },
        { once: true },
      );
      window.addEventListener(
        "focus",
        () => {
          window.setTimeout(() => finish(input.files ? Array.from(input.files) : []), 600);
        },
        { once: true },
      );
      input.click();
    });
  }

  private async importCad(): Promise<void> {
    if (this.editor.isActive) {
      toast("Finish the sketch before importing.", "warn");
      return;
    }
    const files = await this.pickFiles(".step,.stp,.iges,.igs,model/step");
    if (!files.length) return;
    const file = files[0];
    const extension = fileExtension(file.name);
    const format: "step" | "iges" = extension === "step" || extension === "stp" ? "step" : "iges";
    const buffer = await file.arrayBuffer();
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 48) || "Imported Body";
    const before = this.capture();
    const part = createPart(name, this.doc.parts.length);
    part.asset = {
      name: file.name,
      format,
      dataBase64: arrayBufferToBase64(buffer),
      size: buffer.byteLength,
      rev: hashBuffer(buffer),
    };
    this.doc.parts.push(part);
    this.doc.activePartId = part.id;
    this.doc.mode = "part";
    this.selection = { kind: "part", id: part.id };
    this.commit(before);
    this.shell.setMode("part");
    this.shell.setCommandTab("features");
    this.shell.setDocument(this.doc);
    this.refreshTree();
    this.updateMassCard();
    this.shell.setStatus(`Importing ${file.name}…`);
    await this.rebuild();
    if (this.meshes.get(part.id)?.positions.length) {
      toast(`${file.name} imported as a ${format.toUpperCase()} body.`, "success");
      this.shell.setStatus(`${file.name} imported · ${fmt(this.meshes.get(part.id)?.volume ?? 0, 0)} mm³`);
    } else {
      toast("The file was added but the kernel could not produce a solid. Check the file units and contents.", "warn", 7000);
    }
  }

  private async importMeshFile(): Promise<void> {
    if (this.editor.isActive) {
      toast("Finish the sketch before importing.", "warn");
      return;
    }
    const files = await this.pickFiles(".stl,.obj,model/stl");
    if (!files.length) return;
    const file = files[0];
    const extension = fileExtension(file.name);
    const format: "stl" | "obj" = extension === "obj" ? "obj" : "stl";
    try {
      const buffer = await file.arrayBuffer();
      const mesh = format === "stl" ? parseSTL(buffer) : parseOBJ(new TextDecoder().decode(buffer));
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 48) || "Mesh Body";
      const before = this.capture();
      const part = createPart(name, this.doc.parts.length);
      part.meshOnly = true;
      part.asset = {
        name: file.name,
        format,
        dataBase64: arrayBufferToBase64(buffer),
        size: buffer.byteLength,
        rev: hashBuffer(buffer),
      };
      this.meshes.set(part.id, mesh);
      this.doc.parts.push(part);
      this.doc.activePartId = part.id;
      this.doc.mode = "part";
      this.selection = { kind: "part", id: part.id };
      this.commit(before);
      this.shell.setMode("part");
      this.shell.setCommandTab("features");
      this.shell.setDocument(this.doc);
      this.refreshScene();
      this.refreshTree();
      this.updateMassCard();
      this.shell.setStatus(`${file.name} imported · mesh-only body`);
      toast(`${file.name} imported as a mesh body (${Math.round(mesh.indices.length / 3).toLocaleString()} triangles).`, "success");
    } catch (error) {
      await alertDialog("Import Mesh", `<p>${escapeHtml(messageOf(error))}</p>`, "alert-triangle");
    }
  }

  private async exportCad(format: "step" | "iges"): Promise<void> {
    const targets: { partId: string; matrix?: number[] }[] = [];
    if (this.doc.mode === "assembly") {
      for (const component of this.doc.components) {
        if (!component.visible) continue;
        const part = this.doc.parts.find((p) => p.id === component.partId);
        if (!part || part.meshOnly) continue;
        targets.push({ partId: part.id, matrix: matrixArray(componentMatrix(component.position, component.rotation)) });
      }
    } else {
      const part = this.activePart();
      if (part && !part.meshOnly) targets.push({ partId: part.id });
    }
    if (targets.length === 0) {
      toast("There is no B-Rep body to export. Mesh-only bodies can be exported as STL or OBJ.", "warn");
      return;
    }
    const filename = `${safeFilename(this.doc.name)}.${format === "step" ? "step" : "igs"}`;
    this.shell.setKernel("Exporting", "busy");
    this.shell.setStatus(`Writing ${format.toUpperCase()}…`);
    try {
      const bytes = await cadClient().exportCAD(format, targets, filename);
      downloadBytes(bytes, filename, "application/octet-stream");
      toast(`${format.toUpperCase()} exported (${Math.round(bytes.byteLength / 1024)} KB).`, "success");
      this.shell.setStatus(`${filename} exported`);
    } catch (error) {
      toast(messageOf(error), "error", 7000);
    } finally {
      this.shell.setKernel("OCCT ready");
    }
  }

  private exportMesh(format: "stl" | "obj"): void {
    const entries: { name: string; mesh: MeshData }[] = [];
    if (this.doc.mode === "assembly") {
      for (const component of this.doc.components) {
        if (!component.visible) continue;
        const part = this.doc.parts.find((p) => p.id === component.partId);
        const mesh = part ? this.meshForPart(part.id) : undefined;
        if (!part || !mesh) continue;
        entries.push({
          name: component.name,
          mesh: transformMeshData(mesh, componentMatrix(component.position, component.rotation)),
        });
      }
    } else {
      const part = this.activePart();
      const mesh = part ? this.meshForPart(part.id) : undefined;
      if (part && mesh) entries.push({ name: part.name, mesh });
    }
    if (entries.length === 0) {
      toast("There is no visible body to export.", "warn");
      return;
    }
    const filename = `${safeFilename(this.doc.name)}.${format}`;
    if (format === "stl") downloadBytes(writeSTL(entries), filename, "model/stl");
    else downloadText(writeOBJ(entries), filename, "text/plain");
    this.shell.setStatus(`${filename} exported`);
    toast(`${format.toUpperCase()} exported (${entries.length} body(ies)).`, "success");
  }

  // ------------------------------------------------------------------ sample

  private async loadSample(): Promise<void> {
    const current = this.doc.parts[0];
    const hasWork = this.doc.parts.some((p) => p.features.length > 0 || p.sketches.length > 0) || this.doc.components.length > 0;
    if (hasWork) {
      const ok = await confirmDialog("Load Sample", "Replace the current document with the Mounting Plate sample?", "Load Sample");
      if (!ok) return;
    }
    if (this.editor.isActive) this.editor.end();
    const doc = createDocument();
    doc.name = "Mounting Plate";
    const part = doc.parts[0];
    part.name = "Mounting Plate";
    part.materialId = "steel";

    const point = (sketch: Sketch, x: number, y: number, fixed = false) => {
      const id = uid("pt");
      sketch.points.push({ id, x, y, fixed });
      return id;
    };
    const line = (sketch: Sketch, a: string, b: string) => {
      const id = uid("ln");
      sketch.entities.push({ id, kind: "line", p1: a, p2: b });
      return id;
    };
    const circle = (sketch: Sketch, x: number, y: number, radius: number) => {
      const center = point(sketch, x, y);
      const id = uid("ci");
      sketch.entities.push({ id, kind: "circle", center, radius });
      return id;
    };

    const plate = basePlane("top");
    const sketch1: Sketch = {
      id: uid("sk"),
      name: "Sketch1",
      plane: plate,
      points: [],
      entities: [],
      constraints: [],
      visible: false,
    };
    const p1 = point(sketch1, -60, -40);
    const p2 = point(sketch1, 60, -40);
    const p3 = point(sketch1, 60, 40);
    const p4 = point(sketch1, -60, 40);
    line(sketch1, p1, p2);
    line(sketch1, p2, p3);
    line(sketch1, p3, p4);
    line(sketch1, p4, p1);
    for (const [x, y] of [
      [-48, -30],
      [48, -30],
      [48, 30],
      [-48, 30],
    ] as [number, number][]) {
      circle(sketch1, x, y, 4.5);
    }
    part.sketches.push(sketch1);
    part.features.push({
      id: uid("feat"),
      type: "extrude",
      name: "Boss-Extrude1",
      sketchId: sketch1.id,
      params: { depth: 10, direction: 1, symmetric: false, operation: "new" },
    });

    const bossPlane: SketchPlane = {
      kind: "face",
      name: "Top face",
      origin: [0, 10, 0],
      u: [1, 0, 0],
      v: [0, 0, -1],
      n: [0, 1, 0],
      faceIndex: 0,
    };
    const sketch2: Sketch = {
      id: uid("sk"),
      name: "Sketch2",
      plane: bossPlane,
      points: [],
      entities: [],
      constraints: [],
      visible: false,
    };
    circle(sketch2, 0, 0, 22);
    part.sketches.push(sketch2);
    part.features.push({
      id: uid("feat"),
      type: "extrude",
      name: "Boss-Extrude2",
      sketchId: sketch2.id,
      params: { depth: 6, direction: 1, symmetric: false, operation: "join" },
    });

    const holePlane: SketchPlane = {
      kind: "face",
      name: "Boss top face",
      origin: [0, 16, 0],
      u: [1, 0, 0],
      v: [0, 0, -1],
      n: [0, 1, 0],
      faceIndex: 0,
    };
    const sketch3: Sketch = {
      id: uid("sk"),
      name: "Sketch3",
      plane: holePlane,
      points: [],
      entities: [],
      constraints: [],
      visible: false,
    };
    circle(sketch3, 0, 0, 9);
    part.sketches.push(sketch3);
    part.features.push({
      id: uid("feat"),
      type: "cut",
      name: "Cut-Extrude1",
      sketchId: sketch3.id,
      params: { depth: 24, direction: -1, symmetric: false, operation: "cut" },
    });

    doc.activePartId = part.id;
    this.doc = doc;
    this.applyDocumentState({ history: false, clearResults: true });
    this.selection = { kind: "part", id: part.id };
    this.refreshTree();
    this.viewport.zoomFit(false);
    this.shell.setStatus("Sample loaded · Mounting Plate (120 × 80 × 16 mm)");
    toast("Mounting Plate sample loaded.", "success");
    void current;
  }

  // ------------------------------------------------------------- edit tools

  private async renameSelected(): Promise<void> {
    const selection = this.selection;
    if (!selection) {
      toast("Select an item in the FeatureManager first.", "info");
      return;
    }
    let current = "";
    if (selection.kind === "part") current = this.doc.parts.find((p) => p.id === selection.id)?.name ?? "";
    else if (selection.kind === "sketch") current = this.doc.parts.flatMap((p) => p.sketches).find((s) => s.id === selection.id)?.name ?? "";
    else if (selection.kind === "feature") current = this.doc.parts.flatMap((p) => p.features).find((f) => f.id === selection.id)?.name ?? "";
    else if (selection.kind === "component") current = this.doc.components.find((c) => c.id === selection.id)?.name ?? "";
    else if (selection.kind === "mate") current = this.doc.mates.find((m) => m.id === selection.id)?.name ?? "";
    else if (selection.kind === "study") current = this.doc.analyses.find((s) => s.id === selection.id)?.name ?? "";
    if (!current) {
      toast("This item cannot be renamed.", "info");
      return;
    }
    const name = await this.promptText("Rename", "Name", current);
    if (!name || name === current) return;
    const before = this.capture();
    if (selection.kind === "part") {
      const part = this.doc.parts.find((p) => p.id === selection.id);
      if (part) part.name = name;
    } else if (selection.kind === "sketch") {
      const sketch = this.doc.parts.flatMap((p) => p.sketches).find((s) => s.id === selection.id);
      if (sketch) sketch.name = name;
    } else if (selection.kind === "feature") {
      const feature = this.doc.parts.flatMap((p) => p.features).find((f) => f.id === selection.id);
      if (feature) feature.name = name;
    } else if (selection.kind === "component") {
      const component = this.doc.components.find((c) => c.id === selection.id);
      if (component) component.name = name;
    } else if (selection.kind === "mate") {
      const mate = this.doc.mates.find((m) => m.id === selection.id);
      if (mate) mate.name = name;
    } else if (selection.kind === "study") {
      const study = this.doc.analyses.find((s) => s.id === selection.id);
      if (study) study.name = name;
    }
    this.commit(before);
    this.shell.setDocument(this.doc);
    this.refreshTree();
  }

  private async deleteSelected(): Promise<void> {
    const selection = this.selection;
    if (!selection) {
      toast("Select an item to delete.", "info");
      return;
    }
    const before = this.capture();
    let rebuild = false;
    if (selection.kind === "sketch") {
      const part = this.doc.parts.find((p) => p.sketches.some((s) => s.id === selection.id));
      if (!part) return;
      const sketch = part.sketches.find((s) => s.id === selection.id);
      if (!sketch) return;
      const ok = await confirmDialog("Delete Sketch", `Delete <b>${escapeHtml(sketch.name)}</b>? Features that use it will report an error.`);
      if (!ok) return;
      part.sketches = part.sketches.filter((s) => s.id !== selection.id);
      this.selection = null;
      rebuild = true;
    } else if (selection.kind === "feature") {
      const part = this.doc.parts.find((p) => p.features.some((f) => f.id === selection.id));
      const feature = part?.features.find((f) => f.id === selection.id);
      if (!part || !feature) return;
      const ok = await confirmDialog("Delete Feature", `Delete <b>${escapeHtml(feature.name)}</b>?`);
      if (!ok) return;
      part.features = part.features.filter((f) => f.id !== selection.id);
      this.selection = null;
      rebuild = true;
    } else if (selection.kind === "component") {
      const component = this.doc.components.find((c) => c.id === selection.id);
      if (!component) return;
      const ok = await confirmDialog("Delete Component", `Delete <b>${escapeHtml(component.name)}</b> and its mates?`);
      if (!ok) return;
      this.doc.components = this.doc.components.filter((c) => c.id !== selection.id);
      this.doc.mates = this.doc.mates.filter((m) => m.a.componentId !== selection.id && m.b.componentId !== selection.id);
      if (this.doc.activeComponentId === selection.id) this.doc.activeComponentId = null;
      this.selection = null;
    } else if (selection.kind === "mate") {
      const mate = this.doc.mates.find((m) => m.id === selection.id);
      if (!mate) return;
      const ok = await confirmDialog("Delete Mate", `Delete <b>${escapeHtml(mate.name)}</b>?`);
      if (!ok) return;
      this.doc.mates = this.doc.mates.filter((m) => m.id !== selection.id);
      this.selection = null;
    } else if (selection.kind === "part") {
      if (this.doc.parts.length <= 1) {
        toast("The document must keep at least one part.", "warn");
        return;
      }
      const part = this.doc.parts.find((p) => p.id === selection.id);
      if (!part) return;
      const ok = await confirmDialog("Delete Part", `Delete <b>${escapeHtml(part.name)}</b>, its components and analyses?`);
      if (!ok) return;
      const componentIds = this.doc.components.filter((c) => c.partId === part.id).map((c) => c.id);
      this.doc.parts = this.doc.parts.filter((p) => p.id !== part.id);
      this.doc.components = this.doc.components.filter((c) => c.partId !== part.id);
      this.doc.mates = this.doc.mates.filter((m) => !componentIds.includes(m.a.componentId) && !componentIds.includes(m.b.componentId));
      this.doc.analyses = this.doc.analyses.filter((s) => s.partId !== part.id);
      this.doc.activePartId = this.doc.parts[0]?.id ?? "";
      this.doc.activeComponentId = null;
      this.selection = null;
      rebuild = true;
    } else if (selection.kind === "study") {
      const study = this.doc.analyses.find((s) => s.id === selection.id);
      if (!study) return;
      const ok = await confirmDialog("Delete Study", `Delete <b>${escapeHtml(study.name)}</b> and its results?`);
      if (!ok) return;
      this.doc.analyses = this.doc.analyses.filter((s) => s.id !== selection.id);
      this.feaResults.delete(selection.id);
      this.doc.activeStudyId = this.doc.analyses[0]?.id ?? null;
      this.activeResult = null;
      this.resultView.clear();
      this.shell.showColorbar(null);
      this.shell.showResultToolbar(null);
      this.selection = null;
      this.refreshScene();
    } else if (selection.kind === "support" || selection.kind === "load") {
      const study = this.activeStudy();
      if (!study) return;
      study.supports = study.supports.filter((s) => s.id !== selection.id);
      study.loads = study.loads.filter((l) => l.id !== selection.id);
      this.invalidateStudy(study);
      this.selection = null;
      this.refreshScene();
    } else {
      toast("This item cannot be deleted.", "info");
      return;
    }
    this.commit(before);
    this.refreshTree();
    this.updateMassCard();
    this.shell.setDocument(this.doc);
    if (rebuild) await this.rebuild();
    else this.scheduleAutosave();
    this.shell.setStatus("Item deleted");
  }

  private toggleSuppress(): void {
    const selection = this.selection;
    if (!selection || selection.kind !== "feature") return;
    const feature = this.doc.parts.flatMap((p) => p.features).find((f) => f.id === selection.id);
    if (!feature) return;
    const before = this.capture();
    feature.suppressed = !feature.suppressed;
    this.commit(before);
    this.refreshTree();
    void this.rebuild();
  }

  // ---------------------------------------------------------------- dialogs

  private massProperties(): void {
    const body = document.createElement("div");
    if (this.doc.mode === "assembly" && this.doc.components.length > 0) {
      let volume = 0;
      let mass = 0;
      let area = 0;
      let rows = "";
      for (const component of this.doc.components) {
        const part = this.doc.parts.find((p) => p.id === component.partId);
        const mesh = part ? this.meshForPart(part.id) : undefined;
        if (!part || !mesh) continue;
        const material = partMaterial(part);
        const componentMass = mesh.volume * material.density * 1e-9;
        volume += mesh.volume;
        mass += componentMass;
        area += mesh.area;
        rows += `<span>${escapeHtml(component.name)}</span><span>${fmt(componentMass * 1000, 1)} g</span>`;
      }
      body.innerHTML = `<div class="study-stats">
        <span>Components</span><span>${this.doc.components.length}</span>
        <span>Total volume</span><span>${fmt(volume, 0)} mm³</span>
        <span>Total mass</span><span>${fmt(mass, 4)} kg</span>
        <span>Total area</span><span>${fmt(area, 0)} mm²</span>
        ${rows}
      </div>`;
    } else {
      const part = this.activePart();
      const mesh = part ? this.meshForPart(part.id) : undefined;
      if (!part || !mesh) {
        toast("There is no body to measure.", "warn");
        return;
      }
      const material = part.materialId ? partMaterial(part) : undefined;
      const mass = mesh.volume * (material?.density ?? 0) * 1e-9;
      const centroid = meshMass(mesh).centroid;
      const size: Vec3 = [
        mesh.bbox.max[0] - mesh.bbox.min[0],
        mesh.bbox.max[1] - mesh.bbox.min[1],
        mesh.bbox.max[2] - mesh.bbox.min[2],
      ];
      body.innerHTML = `<div class="study-stats">
        <span>Part</span><span>${escapeHtml(part.name)}</span>
        <span>Material</span><span>${material ? escapeHtml(material.name) : "Material &lt;not specified&gt;"}</span>
        <span>Volume</span><span>${fmt(mesh.volume, 2)} mm³</span>
        <span>Mass</span><span>${material ? `${fmt(mass, 5)} kg (${fmt(mass * 1000, 1)} g)` : "— assign a material"}</span>
        <span>Surface area</span><span>${fmt(mesh.area, 2)} mm²</span>
        <span>Bounding box</span><span>${fmt(size[0], 2)} × ${fmt(size[1], 2)} × ${fmt(size[2], 2)} mm</span>
        <span>Center of mass X</span><span>${fmt(centroid[0], 2)} mm</span>
        <span>Center of mass Y</span><span>${fmt(centroid[1], 2)} mm</span>
        <span>Center of mass Z</span><span>${fmt(centroid[2], 2)} mm</span>
        <span>Density</span><span>${material ? `${fmt(material.density, 0)} kg/m³` : "—"}</span>
        <span>Triangles</span><span>${Math.round(mesh.indices.length / 3).toLocaleString()}</span>
      </div>`;
    }
    void openModal({
      title: "Mass Properties",
      icon: "gauge",
      body,
      width: 500,
      actions: [{ label: "Close", value: "close", kind: "primary" }],
    });
  }

  private openMaterialDialog(partId?: string): void {
    const part = this.doc.parts.find((p) => p.id === partId) ?? this.activePart();
    if (!part) return;
    const current = partMaterial(part);
    const isCustom = part.materialId === "custom";
    const body = document.createElement("div");
    body.innerHTML = `
      <div class="material-edit-preview">
        <span class="swatch" id="mat-swatch" style="background:${current.color}"></span>
        <div style="flex:1"><div style="font-weight:600" id="mat-preview-name">${escapeHtml(current.name)}</div>
        <div class="hint" id="mat-preview-props">${escapeHtml(part.name)} · effective material</div></div>
      </div>
      <div class="field"><label>Library material</label>
        <select id="mat-select">${MATERIALS.map((m) => `<option value="${m.id}" ${m.id === (part.materialId ?? "") ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</select>
      </div>
      <div class="edit-material-grid">
        <div class="field"><label>Name</label><input id="mat-name" value="${escapeHtml(current.name)}" /></div>
        <div class="field"><label>Density ρ (kg/m³)</label><input id="mat-density" type="number" step="10" value="${current.density}" /></div>
        <div class="field"><label>Young's modulus E (MPa)</label><input id="mat-E" type="number" step="1000" value="${current.E}" /></div>
        <div class="field"><label>Poisson ν</label><input id="mat-nu" type="number" step="0.01" value="${current.nu}" /></div>
        <div class="field"><label>Yield strength σy (MPa)</label><input id="mat-yield" type="number" step="1" value="${current.yield}" /></div>
        <div class="field"><label>&nbsp;</label><button class="btn" id="mat-custom">Custom values</button></div>
      </div>
      <div class="hint">Density drives mass properties; E, ν and σy drive the static study. Editing values stores a per-part override.</div>`;
    let dirty = false;
    const fields = () => ({
      name: body.querySelector<HTMLInputElement>("#mat-name")?.value.trim() || "Custom Material",
      density: Number(body.querySelector<HTMLInputElement>("#mat-density")?.value) || 7850,
      E: Number(body.querySelector<HTMLInputElement>("#mat-E")?.value) || 200000,
      nu: Number(body.querySelector<HTMLInputElement>("#mat-nu")?.value) || 0.3,
      yield: Number(body.querySelector<HTMLInputElement>("#mat-yield")?.value) || 250,
    });
    const syncPreview = () => {
      const f = fields();
      const sw = body.querySelector<HTMLElement>("#mat-swatch");
      const name = body.querySelector<HTMLElement>("#mat-preview-name");
      const props = body.querySelector<HTMLElement>("#mat-preview-props");
      const lib = MATERIALS.find((m) => m.id === body.querySelector<HTMLSelectElement>("#mat-select")?.value);
      if (sw && lib) sw.style.background = lib.color;
      if (name) name.textContent = f.name;
      if (props) props.textContent = `E ${fmt(f.E, 0)} MPa · ν ${fmt(f.nu, 2)} · σy ${fmt(f.yield, 0)} MPa · ρ ${fmt(f.density, 0)} kg/m³`;
    };
    body.querySelector("#mat-select")?.addEventListener("change", () => {
      const id = body.querySelector<HTMLSelectElement>("#mat-select")?.value ?? "steel";
      const m = MATERIALS.find((q) => q.id === id);
      if (!m) return;
      const set = (sel: string, value: number | string) => {
        const el = body.querySelector<HTMLInputElement>(sel);
        if (el) el.value = String(value);
      };
      set("#mat-name", m.name);
      set("#mat-density", m.density);
      set("#mat-E", m.E);
      set("#mat-nu", m.nu);
      set("#mat-yield", m.yield);
      dirty = false;
      syncPreview();
    });
    body.querySelector("#mat-custom")?.addEventListener("click", () => {
      const sel = body.querySelector<HTMLSelectElement>("#mat-select");
      if (sel) sel.value = "custom";
      const nameInput = body.querySelector<HTMLInputElement>("#mat-name");
      if (nameInput && nameInput.value === current.name) nameInput.value = "Custom Alloy";
      dirty = true;
      syncPreview();
    });
    body.querySelectorAll<HTMLInputElement>("input").forEach((input) => input.addEventListener("input", () => {
      dirty = true;
      syncPreview();
    }));
    void openModal({
      title: "Edit Material",
      icon: "layers",
      body,
      width: 560,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Apply", value: "apply", kind: "primary" },
      ],
    }).then((result) => {
      if (result !== "apply") return;
      const before = this.capture();
      const selected = body.querySelector<HTMLSelectElement>("#mat-select")?.value ?? "custom";
      if (selected === "custom" || dirty) {
        const f = fields();
        part.materialId = "custom";
        part.materialOverride = f;
      } else {
        part.materialId = selected;
        part.materialOverride = undefined;
      }
      for (const study of this.doc.analyses) {
        if (study.partId !== part.id) continue;
        study.materialId = part.materialId;
        study.stale = study.status === "solved" || study.status === "meshed";
      }
      this.commit(before);
      this.updateMassCard();
      this.refreshTree();
      this.updateMassCard();
      toast(`Material for ${part.name}: ${partMaterial(part).name}.`, "success");
    });
  }

  private async openTemplates(): Promise<void> {
    const body = document.createElement("div");
    body.innerHTML = `<div class="template-grid">
      <button class="template-card" data-template="beam"><b>Cantilever Beam</b><span>120 × 20 × 12 mm beam, AISI 1020, static study ready for a tip load.</span></button>
      <button class="template-card" data-template="bracket"><b>L-Bracket</b><span>60 × 40 × 30 mm angle bracket with 8 mm walls and a 30 mm extrusion.</span></button>
      <button class="template-card" data-template="box-lid"><b>Box + Lid Assembly</b><span>60 × 40 × 30 mm shelled enclosure with a 64 × 44 mm lid component.</span></button>
      <button class="template-card" data-template="blank"><b>Blank Part</b><span>Empty document with a single part and no material assigned.</span></button>
    </div>
    <div class="hint" style="margin-top:8px">Choosing a template replaces the current document. Each template is fully parametric and editable afterwards.</div>`;
    const result = await openModal({
      title: "New from Template",
      icon: "layout-grid",
      body,
      width: 560,
      actions: [
        { label: "Cancel", value: "cancel", kind: "plain" },
        { label: "Create", value: "create", kind: "primary" },
      ],
      onMount: (root) => {
        root.querySelectorAll<HTMLElement>("[data-template]").forEach((card) => {
          card.addEventListener("click", () => {
            root.querySelectorAll(".template-card").forEach((el) => el.classList.remove("active"));
            card.classList.add("active");
          });
        });
        root.querySelector<HTMLElement>('[data-template="beam"]')?.classList.add("active");
      },
    });
    if (result !== "create") return;
    const active = body.querySelector<HTMLElement>(".template-card.active")?.dataset.template;
    if (!active) return;
    await this.buildTemplate(active);
  }

  private addRectSketch(part: Part, plane: "front" | "top" | "right", x0: number, y0: number, x1: number, y1: number, name = nextSketchName(part.sketches)): Sketch {
    const sketch: Sketch = { id: uid("sk"), name, plane: basePlane(plane), points: [], entities: [], constraints: [], visible: false };
    for (const [x, y] of [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as [number, number][]) {
      sketch.points.push({ id: uid("pt"), x, y });
    }
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = uid("ln");
      lines.push(id);
      sketch.entities.push({ id, kind: "line", p1: sketch.points[i].id, p2: sketch.points[(i + 1) % 4].id });
    }
    sketch.constraints.push({ id: uid("c"), type: "horizontal", entity: lines[0] });
    sketch.constraints.push({ id: uid("c"), type: "horizontal", entity: lines[2] });
    sketch.constraints.push({ id: uid("c"), type: "vertical", entity: lines[1] });
    sketch.constraints.push({ id: uid("c"), type: "vertical", entity: lines[3] });
    part.sketches.push(sketch);
    return sketch;
  }

  private addExtrude(part: Part, sketchId: string, depth: number, operation: "new" | "join" | "cut" = "join"): Feature {
    const feature: Feature = {
      id: uid("feat"),
      type: operation === "cut" ? "cut" : "extrude",
      name: nextFeatureName(operation === "cut" ? "cut" : "extrude", part.features),
      sketchId,
      params: { depth, direction: 1, operation },
    };
    part.features.push(feature);
    return feature;
  }

  private async buildTemplate(template: string): Promise<void> {
    const doc = createDocument();
    const base = doc.parts[0];
    if (template === "blank") {
      // A blank document has no material and no variables — just one empty part.
      base.materialId = undefined;
      doc.variables = [];
      this.doc = doc;
      this.applyDocumentState({ history: false, clearResults: true });
      return;
    }
    doc.variables = standardVariables([["L", "100"]]);
    base.materialId = "aisi1020";
    if (template === "beam") {
      doc.name = "Cantilever Beam";
      base.name = "Beam";
      const sketch = this.addRectSketch(base, "right", -30, -10, 90, 10, "Sketch1");
      this.addExtrude(base, sketch.id, 12, "new");
      const study: AnalysisStudy = {
        id: uid("study"),
        name: "Static 1",
        partId: base.id,
        materialId: "aisi1020",
        meshSize: 2.5,
        supports: [],
        loads: [],
        status: "draft",
      };
      doc.analyses.push(study);
      doc.activeStudyId = study.id;
    } else if (template === "bracket") {
      doc.name = "L-Bracket";
      base.name = "L-Bracket";
      const sketch: Sketch = { id: uid("sk"), name: "Sketch1", plane: basePlane("front"), points: [], entities: [], constraints: [], visible: false };
      const verts: [number, number][] = [
        [0, 0],
        [60, 0],
        [60, 8],
        [8, 8],
        [8, 40],
        [0, 40],
      ];
      for (const [x, y] of verts) sketch.points.push({ id: uid("pt"), x, y });
      for (let i = 0; i < verts.length; i++) {
        sketch.entities.push({ id: uid("ln"), kind: "line", p1: sketch.points[i].id, p2: sketch.points[(i + 1) % verts.length].id });
      }
      base.sketches.push(sketch);
      this.addExtrude(base, sketch.id, 30, "new");
    } else {
      doc.name = "Box + Lid Assembly";
      base.name = "Box";
      const sketch = this.addRectSketch(base, "top", -30, -20, 30, 20, "Sketch1");
      this.addExtrude(base, sketch.id, 30, "new");
      base.features.push({ id: uid("feat"), type: "shell", name: "Shell1", params: { thickness: 2 } });
      const lid = createPart("Lid", 1);
      lid.materialId = "aisi1020";
      const lidSketch = this.addRectSketch(lid, "top", -32, -22, 32, 22, "Sketch1");
      this.addExtrude(lid, lidSketch.id, 3, "new");
      doc.parts.push(lid);
      doc.components.push(
        { id: uid("comp"), name: "Box1", partId: base.id, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, fixed: true },
        { id: uid("comp"), name: "Lid1", partId: lid.id, position: [0, 30, 0], rotation: [0, 0, 0], visible: true },
      );
      doc.mode = "assembly";
    }
    this.doc = doc;
    this.applyDocumentState({ history: false, clearResults: true });
    toast(`${doc.name} template created.`, "success");
  }

  private materialLibrary(): void {
    const part = this.activePart();
    if (!part) return;
    const body = document.createElement("div");
    const render = () => {
      body.innerHTML = MATERIALS.map(
        (material) => `<div class="material-row ${material.id === part.materialId ? "active" : ""}" data-material="${material.id}">
          <span class="material-swatch" style="background:${material.color}"></span>
          <div style="flex:1;min-width:0"><div class="name">${escapeHtml(material.name)}</div>
          <div class="props">${material.category} · E ${material.E >= 1000 ? `${fmt(material.E / 1000, 1)} GPa` : `${fmt(material.E, 0)} MPa`} · ν ${material.nu} · σy ${fmt(material.yield, 0)} MPa</div></div>
          ${material.id === part.materialId ? icon("check") : ""}
        </div>`,
      ).join("") + `<div class="hint" style="margin-top:10px">Assigning a material updates the active part and every analysis study that uses it.</div>`;
    };
    render();
    body.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-material]");
      if (!row?.dataset.material) return;
      const id = row.dataset.material;
      const before = this.capture();
      part.materialId = id;
      for (const study of this.doc.analyses) if (study.partId === part.id) study.materialId = id;
      this.commit(before);
      this.updateMassCard();
      this.refreshTree();
      render();
      toast(`${materialById(id).name} assigned.`, "success");
    });
    void openModal({
      title: "Material Library",
      icon: "layers",
      body,
      width: 560,
      actions: [{ label: "Close", value: "close", kind: "primary" }],
    });
  }

  private modelInfo(): void {
    const part = this.activePart();
    const mesh = part ? this.meshForPart(part.id) : undefined;
    const features = this.doc.parts.reduce((sum, p) => sum + p.features.length, 0);
    const sketches = this.doc.parts.reduce((sum, p) => sum + p.sketches.length, 0);
    const triangles = mesh ? Math.round(mesh.indices.length / 3) : 0;
    const body = `<div class="study-stats">
      <span>Application</span><span>MarmaraCad 1.0</span>
      <span>Document</span><span>${escapeHtml(this.doc.name)}</span>
      <span>Workspace</span><span>${this.doc.mode}</span>
      <span>Units</span><span>mm / N / MPa</span>
      <span>Parts</span><span>${this.doc.parts.length}</span>
      <span>Components</span><span>${this.doc.components.length}</span>
      <span>Sketches</span><span>${sketches}</span>
      <span>Features</span><span>${features}</span>
      <span>Active bodies</span><span>${this.viewport.bodyCount}</span>
      <span>Triangles (active)</span><span>${triangles.toLocaleString()}</span>
      <span>Kernel</span><span>OCCT WASM · boot ${(this.bootMs / 1000).toFixed(2)} s${cadClient().kernelFromCache ? " · cached" : ""}</span>
      <span>Kernel cache</span><span>${cadClient().kernelBytes > 0 ? `${(cadClient().kernelBytes / 1048576).toFixed(1)} MB in Cache API` : "Cache API unavailable"}</span>
      <span>Renderer</span><span>${this.graphics.label} · Three.js</span>
      <span>Autosave</span><span>IndexedDB</span>
    </div>`;
    void openModal({ title: "Model Info", icon: "info", body, width: 470, actions: [{ label: "Close", value: "close", kind: "primary" }] });
  }

  private quickStart(): void {
    const body = `<div class="quick-steps">
      <p><b>1 · Sketch.</b> Select a plane in the FeatureManager (or a planar face in the viewport), then click <b>New Sketch</b>. Draw a closed contour with Line/Rectangle/Circle/Arc.</p>
      <p><b>2 · Dimension.</b> Use Smart Dimension, then double-click a label to type an exact value. Add relations (horizontal, vertical, coincident, tangent, equal, fix).</p>
      <p><b>3 · Feature.</b> Exit the sketch and run <b>Extruded Boss</b>, <b>Revolve</b>, <b>Fillet</b> or <b>Chamfer</b>. Double-click a feature in the tree to edit it.</p>
      <p><b>4 · Assembly.</b> Switch to Assembly, insert components, then pick two faces and add a Coincident, Concentric or Distance mate.</p>
      <p><b>5 · Analysis.</b> Switch to Analysis, create a Static Study, choose a material and mesh size, add Fixed Supports and a Force or Pressure, then Solve.</p>
      <p><b>Files.</b> Import STEP/IGES or STL/OBJ, and export STEP (AP214), IGES, binary STL or OBJ. Projects are saved as <code>.mcad.json</code> and autosaved to IndexedDB.</p>
      <div class="hint">Everything runs in your browser. No model data leaves this device.</div>
    </div>`;
    void openModal({ title: "Quick Start", icon: "book-open", body, width: 560, actions: [{ label: "Got it", value: "close", kind: "primary" }] });
  }

  private showShortcuts(): void {
    const rows: [string, string][] = [
      ["Ctrl + N", "New document"],
      ["Ctrl + O", "Open project"],
      ["Ctrl + S", "Save project"],
      ["Ctrl + Z / Ctrl + Y", "Undo / redo"],
      ["Delete", "Delete selection"],
      ["F2", "Rename selection"],
      ["F", "Zoom fit"],
      ["Esc", "Cancel current command / tool"],
      ["Space", "3D View Selector cube"],
      ["S", "Shortcut bar at the cursor"],
      ["N / Ctrl+8", "Normal to the selected face"],
      ["L / R / C / A / D / S", "Line / Rectangle / Circle / Arc / Dimension / Select (sketch)"],
      ["T / O / X", "Trim / Offset / Convert Entities (sketch)"],
      ["Ctrl + Click", "Add/remove a face, edge or vertex from the selection"],
      ["Left drag", "Window (left→right) or crossing (right→left) selection"],
      ["Middle drag", "Orbit (SolidWorks / Fusion scheme)"],
      ["Right drag", "Pan"],
      ["Wheel", "Zoom"],
    ];
    const body = `<div class="study-stats">${rows.map(([key, label]) => `<span><code>${key}</code></span><span>${label}</span>`).join("")}</div>`;
    void openModal({ title: "Keyboard Shortcuts", icon: "help-circle", body, width: 470, actions: [{ label: "Close", value: "close", kind: "primary" }] });
  }

  private about(): void {
    const body = `<div style="text-align:center;padding:4px 0 8px">
      <div class="boot-mark" style="margin:0 auto 10px;width:52px;height:52px;border-radius:14px;font-size:26px;">M</div>
      <div style="font-size:20px;font-weight:700">MarmaraCad <span style="color:#1668b3">1.0</span></div>
      <p style="color:#5a6c7e;margin:4px 0 12px">Browser-native parametric CAD, assembly and linear-static FEA.</p>
      <div class="study-stats" style="text-align:left">
        <span>Geometry kernel</span><span>Open CASCADE (OCCT) compiled to WebAssembly</span>
        <span>Rendering</span><span>Three.js WebGL 2</span>
        <span>FEA solver</span><span>8-node hexahedra · Jacobi-PCG</span>
        <span>License</span><span>MIT (application code)</span>
        <span>OCCT license</span><span>LGPL-2.1</span>
      </div>
      <p style="margin-top:12px;color:#5a6c7e">Open source on GitHub · Baran1248/MarmaraCad</p>
    </div>`;
    void openModal({ title: "About MarmaraCad", icon: "info", body, width: 500, actions: [{ label: "Close", value: "close", kind: "primary" }] });
  }

  private async recentDocuments(): Promise<void> {
    const entries = await listRecent();
    if (entries.length === 0) {
      await alertDialog("Recent Documents", "<p>No saved or autosaved documents yet. Use <b>File → Save Project</b> to create one.</p>", "list-tree");
      return;
    }
    let chosen: RecentEntry | null = null;
    const body = document.createElement("div");
    body.innerHTML = entries
      .map(
        (entry, index) => `<div class="material-row" data-recent="${index}" style="cursor:pointer">
          <span class="material-swatch" style="background:#9db7cd"></span>
          <div style="flex:1;min-width:0"><div class="name">${escapeHtml(entry.name)}</div>
          <div class="props">${new Date(entry.savedAt).toLocaleString()} · ${entry.doc.parts.length} part(s) · ${entry.doc.mode}</div></div>
          ${icon("chevron-right")}
        </div>`,
      )
      .join("");
    const result = await openModal({
      title: "Recent Documents",
      icon: "list-tree",
      body,
      width: 560,
      actions: [{ label: "Close", value: "close", kind: "plain" }],
      onMount: (root, close) => {
        root.querySelectorAll<HTMLElement>("[data-recent]").forEach((row) => {
          row.addEventListener("click", () => {
            chosen = entries[Number(row.dataset.recent)] ?? null;
            close("open");
          });
        });
      },
    });
    if (result === "open" && chosen) {
      const entry = chosen as RecentEntry;
      this.applyDocument(entry.doc);
      toast(`Opened “${entry.name}”.`, "success");
    }
  }

  private async clearAutosave(): Promise<void> {
    const ok = await confirmDialog("Clear Autosave", "Remove the autosaved document and all recent entries from this browser?", "Clear");
    if (!ok) return;
    await clearAll();
    toast("Autosave and recent documents cleared.", "success");
  }

  private async clearKernelCacheAction(): Promise<void> {
    const bytes = await kernelCacheSize();
    const ok = await confirmDialog(
      "Clear Cached Kernel",
      bytes > 0
        ? `Remove the ${(bytes / 1048576).toFixed(1)} MB cached geometry kernel? The next reload downloads it again.`
        : "The geometry kernel is not cached in this browser yet.",
      "Clear",
    );
    if (!ok) return;
    await clearKernelCache();
    toast("Cached kernel removed. The next reload re-downloads OCCT.", "success");
  }

  // ------------------------------------------------------------- dispatcher

  private async runAction(action: string, kind?: string, id?: string): Promise<void> {
    void kind;
    void id;
    switch (action) {
      case "new-document":
        await this.newDocument();
        break;
      case "open-project":
        await this.openProject();
        break;
      case "save":
        await this.saveProject(false);
        break;
      case "save-as":
        await this.saveProject(true);
        break;
      case "import-cad":
        await this.importCad();
        break;
      case "import-mesh":
        await this.importMeshFile();
        break;
      case "export-step":
        await this.exportCad("step");
        break;
      case "export-iges":
        await this.exportCad("iges");
        break;
      case "export-stl":
        this.exportMesh("stl");
        break;
      case "export-obj":
        this.exportMesh("obj");
        break;
      case "recent-documents":
        await this.recentDocuments();
        break;
      case "sample":
        await this.loadSample();
        break;
      case "clear-autosave":
        await this.clearAutosave();
        break;
      case "clear-kernel-cache":
        await this.clearKernelCacheAction();
        break;
      case "undo":
        this.undo();
        break;
      case "redo":
        this.redo();
        break;
      case "delete-selected":
        await this.deleteSelected();
        break;
      case "rename-selected":
        await this.renameSelected();
        break;
      case "select-all":
        toast("Pick faces or edges directly in the viewport; the FeatureManager selects one item at a time.", "info");
        break;
      case "view-front":
        this.viewport.setView("front");
        break;
      case "view-top":
        this.viewport.setView("top");
        break;
      case "view-right":
        this.viewport.setView("right");
        break;
      case "isometric":
        this.viewport.setView("iso");
        break;
      case "zoom-fit":
        this.viewport.zoomFit();
        break;
      case "style-edges":
        this.setDisplayStyle("shaded-edges");
        break;
      case "style-shaded":
        this.setDisplayStyle("shaded");
        break;
      case "style-wire":
        this.setDisplayStyle("wireframe");
        break;
      case "toggle-planes":
        this.setPlanes(!this.planesVisible);
        break;
      case "display-settings":
        this.shell.setPanelTab("display");
        break;
      case "new-sketch":
        await this.newSketchCommand();
        break;
      case "exit-sketch":
        this.finishSketch();
        break;
      case "sketch-delete":
        if (this.editor.isActive) {
          if (this.editor.deleteSelection()) {
            this.sketchDirty = true;
            this.updateSketchPanelInfo();
            this.refreshTree();
          }
        }
        break;
      case "sketch-fit":
        if (this.editor.isActive) this.editor.fit();
        break;
      case "tool-line":
        this.setSketchTool("line");
        break;
      case "tool-rectangle":
        this.setSketchTool("rectangle");
        break;
      case "tool-circle":
        this.setSketchTool("circle");
        break;
      case "tool-arc":
        this.setSketchTool("arc");
        break;
      case "tool-dimension":
        this.setSketchTool("dimension");
        break;
      case "tool-trim":
        this.setSketchTool("trim");
        break;
      case "tool-convert":
        this.setSketchTool("convert");
        break;
      case "tool-offset":
      case "sketch-offset":
        if (!this.editor.isActive) {
          toast("Open a sketch before offsetting entities.", "info");
          break;
        }
        void promptNumber({ title: "Offset Entities", label: "Offset distance", value: 5, unit: "mm", step: 0.5 }).then((value) => {
          if (value === null) return;
          if (this.editor.offsetSelection(value)) {
            this.sketchDirty = true;
            this.updateSketchPanelInfo();
            this.refreshTree();
            toast(`Entities offset by ${fmt(value, 2)} mm.`, "success");
          }
        });
        break;
      case "sketch-construction":
        if (!this.editor.isActive) {
          toast("Open a sketch first.", "info");
          break;
        }
        if (!this.editor.toggleConstructionSelection()) {
          this.editor.setConstructionMode(!this.editor.construction);
          this.shell.setStatus(this.editor.construction ? "For Construction mode on — new entities are dashed" : "For Construction mode off");
        } else {
          this.sketchDirty = true;
          this.updateSketchPanelInfo();
          this.refreshTree();
        }
        break;
      case "tool-select":
        this.setSketchTool("select");
        break;
      case "rel-horizontal":
      case "rel-vertical":
      case "rel-coincident":
      case "rel-tangent":
      case "rel-equal":
      case "rel-fix":
      case "rel-perpendicular":
        if (this.editor.isActive) {
          const relation = action.slice(4) as "horizontal" | "vertical" | "coincident" | "tangent" | "equal" | "fix" | "perpendicular";
          if (this.editor.applyConstraint(relation)) {
            this.sketchDirty = true;
            this.updateSketchPanelInfo();
            this.refreshTree();
          }
        } else {
          toast("Open a sketch before adding a relation.", "info");
        }
        break;
      case "extrude-boss":
        this.openExtrude("extrude");
        break;
      case "extrude-cut":
        this.openExtrude("cut");
        break;
      case "revolve":
        this.openRevolve();
        break;
      case "fillet":
        this.openFillet("fillet");
        break;
      case "chamfer":
        this.openFillet("chamfer");
        break;
      case "shell":
        this.openShell();
        break;
      case "mirror":
        this.openMirror();
        break;
      case "linear-pattern":
        this.openPattern();
        break;
      case "section-view":
        this.openSection();
        break;
      case "interference":
        this.runInterference();
        break;
      case "make-drawing":
        await this.makeDrawing();
        break;
      case "equations":
        this.openEquations();
        break;
      case "measure":
        this.openMeasure();
        break;
      case "toolbox-bolt":
        await this.openToolbox("bolt");
        break;
      case "toolbox-nut":
        await this.openToolbox("nut");
        break;
      case "toolbox-washer":
        await this.openToolbox("washer");
        break;
      case "edit-material":
        this.openMaterialDialog(this.selection?.kind === "part" ? this.selection.id : undefined);
        break;
      case "templates":
        await this.openTemplates();
        break;
      case "edit-feature": {
        const feature = this.selection?.kind === "feature"
          ? this.doc.parts.flatMap((p) => p.features).find((f) => f.id === this.selection?.id)
          : undefined;
        if (feature) this.editFeature(feature);
        else toast("Double-click a feature in the FeatureManager to edit it.", "info");
        break;
      }
      case "insert-component":
        await this.insertComponent();
        break;
      case "component-transform": {
        const componentId = this.selection?.kind === "component" ? this.selection.id : this.doc.activeComponentId;
        if (componentId) this.openTransform(componentId);
        else toast("Select a component first.", "info");
        break;
      }
      case "component-fix": {
        const componentId = this.selection?.kind === "component" ? this.selection.id : this.doc.activeComponentId;
        if (componentId) this.toggleFixed(componentId);
        else toast("Select a component first.", "info");
        break;
      }
      case "mate":
        this.openMate("coincident");
        break;
      case "mate-coincident":
        this.openMate("coincident");
        break;
      case "mate-concentric":
        this.openMate("concentric");
        break;
      case "mate-distance":
        this.openMate("distance");
        break;
      case "resolve-mates":
        this.resolveMates();
        break;
      case "new-study":
        await this.newStudy();
        break;
      case "study-material":
        this.openStudyPanel();
        break;
      case "study-mesh":
        await this.meshStudy();
        break;
      case "add-support":
        this.openSupportPick();
        break;
      case "add-force":
        this.openForcePick();
        break;
      case "add-pressure":
        this.openPressurePick();
        break;
      case "clear-loads": {
        const study = this.activeStudy();
        if (!study) {
          toast("Create an analysis study first.", "info");
          break;
        }
        const before = this.capture();
        study.supports = [];
        study.loads = [];
        this.invalidateStudy(study);
        this.commit(before);
        this.refreshScene();
        this.refreshTree();
        this.openStudyPanel();
        toast("Boundary conditions cleared.", "info");
        break;
      }
      case "fea-solve":
        await this.solveStudy();
        break;
      case "clear-results": {
        const study = this.activeStudy();
        if (study) this.clearStudyResults(study);
        break;
      }
      case "result-deformation":
        this.showResult("deformation");
        break;
      case "result-stress":
        this.showResult("stress");
        break;
      case "result-safety":
        this.showResult("safety");
        break;
      case "mass-props":
        this.massProperties();
        break;
      case "material-library":
        this.materialLibrary();
        break;
      case "model-info":
        this.modelInfo();
        break;
      case "quick-start":
        this.quickStart();
        break;
      case "shortcuts":
        this.showShortcuts();
        break;
      case "about":
        this.about();
        break;
      case "github":
        window.open("https://github.com/Baran1248/MarmaraCad", "_blank", "noopener");
        break;
      default:
        toast(`Unknown command: ${action}`, "warn");
    }
  }

  // ----------------------------------------------------------- context menu

  private contextMenu(items: { label: string; icon: string; run: () => void; danger?: boolean }[], x: number, y: number): void {
    document.querySelectorAll(".ctx-menu").forEach((menu) => menu.remove());
    const menu = document.createElement("div");
    menu.className = "menu ctx-menu";
    menu.style.position = "fixed";
    menu.style.zIndex = "420";
    menu.innerHTML = items
      .map(
        (item, index) =>
          `<div class="menu-item" data-ctx="${index}" ${item.danger ? 'style="color:var(--danger)"' : ""}>${icon(item.icon)}<span>${escapeHtml(item.label)}</span></div>`,
      )
      .join("");
    document.body.appendChild(menu);
    const width = 232;
    const height = items.length * 28 + 10;
    menu.style.left = `${clamp(x, 6, window.innerWidth - width - 6)}px`;
    menu.style.top = `${clamp(y, 6, window.innerHeight - height - 6)}px`;
    this.shell.refreshIcons();
    const close = () => {
      menu.remove();
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const onDown = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    menu.querySelectorAll<HTMLElement>("[data-ctx]").forEach((row) => {
      row.addEventListener("click", () => {
        const item = items[Number(row.dataset.ctx)];
        close();
        item?.run();
      });
    });
  }
}

function startApplication(): void {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app mount point.");
  const bootStatus = document.getElementById("boot-status");
  void (async () => {
    try {
      if (bootStatus) bootStatus.textContent = "Detecting the graphics backend…";
      const graphics = await createBestRenderer();
      const app = new App(root, graphics);
      void app.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (bootStatus) bootStatus.textContent = message;
      const bar = document.querySelector<HTMLElement>(".boot-bar");
      if (bar) bar.style.display = "none";
      const pct = document.getElementById("boot-pct");
      if (pct) pct.textContent = "";
      const note = document.createElement("div");
      note.className = "boot-error";
      note.textContent = "MarmaraCad needs WebGL2 or WebGPU. Enable hardware acceleration and reload.";
      note.style.cssText = "margin-top:14px;font-size:12px;color:#b23b3b;max-width:420px;text-align:center;line-height:1.5;";
      document.querySelector(".boot")?.appendChild(note);
      const btn = document.createElement("button");
      btn.className = "btn primary";
      btn.textContent = "Reload";
      btn.style.marginTop = "14px";
      btn.addEventListener("click", () => window.location.reload());
      document.querySelector(".boot")?.appendChild(btn);
      console.error("MarmaraCad graphics startup failed:", error);
    }
  })();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApplication, { once: true });
} else {
  startApplication();
}

/** Parity ray test along +X for the interference sampler. */
function pointInMesh(p: Vec3, mesh: MeshData): boolean {
  let crossings = 0;
  const pos = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const ia = idx[t] * 3;
    const ib = idx[t + 1] * 3;
    const ic = idx[t + 2] * 3;
    const ax = pos[ia];
    const ay = pos[ia + 1];
    const az = pos[ia + 2];
    const ex = pos[ib] - ax;
    const ey = pos[ib + 1] - ay;
    const ez = pos[ib + 2] - az;
    const fx = pos[ic] - ax;
    const fy = pos[ic + 1] - ay;
    const fz = pos[ic + 2] - az;
    // Ray direction = +X: solve p + t*(1,0,0) = a + u*e + v*f.
    const den = ey * fz - ez * fy;
    if (Math.abs(den) < 1e-12) continue;
    const py = p[1] - ay;
    const pz = p[2] - az;
    const u = (py * fz - pz * fy) / den;
    const v = (ey * pz - ez * py) / den;
    if (u < 0 || v < 0 || u + v > 1) continue;
    const x = ax + u * ex + v * fx;
    if (x > p[0]) crossings++;
  }
  return crossings % 2 === 1;
}
