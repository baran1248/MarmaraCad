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
import { Viewport, type DisplayStyle, type EdgePick, type FacePick, type SceneBody, type ViewName } from "./viewport/Viewport";
import { SketchEditor, type SketchTool } from "./sketch/SketchEditor";
import { profileSummary } from "./sketch/geometry";
import { dimensionValue } from "./sketch/solver";
import { cadClient } from "./kernel/CadClient";
import { cloneDocument, parseProject, serializeProject } from "./io/project";
import { addRecent, clearAll, listRecent, loadAutosave, saveAutosave, type RecentEntry } from "./io/storage";
import { meshMass, parseOBJ, parseSTL, writeOBJ, writeSTL } from "./io/meshio";
import { transformMeshData } from "./viewport/geometry";
import { componentMatrix, matrixArray } from "./viewport/math";
import { faceRefFromPick, solveMates } from "./assembly/mates";
import { MATERIALS, materialById } from "./analysis/materials";
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

interface ActiveCommand {
  kind: string;
  onFace?: (pick: FacePick) => void;
  onEdge?: (pick: EdgePick) => void;
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
    this.viewport.onCameraChange = () => this.shell.setViewCubeSynced(this.viewport.camera);
  }

  private bindViewport(): void {
    this.viewport.onPickFace = (pick) => this.handleFacePick(pick);
    this.viewport.onPickEdge = (pick) => this.handleEdgePick(pick);
    this.viewport.onHoverFace = () => undefined;
    this.viewport.onHoverEdge = () => undefined;
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
        if (this.editor.isActive) {
          if (!this.editor.cancel()) this.editor.setTool("select");
          return;
        }
        if (this.command) this.cancelCommand();
        this.shell.closeMenu();
        return;
      }
      if (typing) return;
      const ctrl = event.ctrlKey || event.metaKey;
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
      if (this.editor.isActive) {
        const map: Record<string, SketchTool> = {
          l: "line",
          r: "rectangle",
          c: "circle",
          a: "arc",
          d: "dimension",
          s: "select",
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
    this.touchDocument();
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
    this.toolbarMode = null;
    this.activeResult = null;
    this.shell.setSketching(false);
    this.shell.setActiveCommand(null);
    this.shell.setHint(null);
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    this.viewport.setSelectedEdges([]);

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
    if (this.doc.mode === "assembly") {
      for (const component of this.doc.components) {
        const part = this.doc.parts.find((p) => p.id === component.partId);
        if (!part) continue;
        const mesh = this.meshForPart(part.id);
        if (!mesh || mesh.positions.length === 0) continue;
        bodies.push({
          partId: part.id,
          componentId: component.id,
          mesh,
          color: component.color ?? part.color,
          visible: component.visible && part.visible,
          position: component.position,
          rotation: component.rotation,
        });
      }
    } else if (activePart) {
      const mesh = this.meshForPart(activePart.id);
      if (mesh && mesh.positions.length > 0) {
        bodies.push({
          partId: activePart.id,
          componentId: null,
          mesh,
          color: activePart.color,
          visible: activePart.visible && !this.resultIsVisible(),
          position: [0, 0, 0],
          rotation: [0, 0, 0],
        });
      }
    }
    this.viewport.setBodies(bodies);
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
      for (const component of this.doc.components) {
        if (!component.visible) continue;
        const part = this.doc.parts.find((p) => p.id === component.partId);
        const mesh = part ? this.meshForPart(part.id) : undefined;
        if (!part || !mesh || mesh.positions.length === 0) continue;
        volume += mesh.volume;
        area += mesh.area;
        grams += mesh.volume * materialById(part.materialId).density * 1e-6;
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
    const material = materialById(part.materialId);
    this.shell.setMassRows([
      { label: "Volume", value: `${fmt(mesh.volume, 0)} mm³` },
      { label: "Mass", value: formatMass(mesh.volume, material.density) },
      { label: "Area", value: `${fmt(mesh.area, 0)} mm²` },
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
    if (action === "delete") {
      await this.deleteSelected();
      return;
    }
    void this.runAction(action, kind, id);
  }

  // ----------------------------------------------------------- view picking

  private handleFacePick(pick: FacePick | null): void {
    if (this.command?.onFace) {
      if (pick) this.command.onFace(pick);
      return;
    }
    if (!pick) {
      this.selectedFace = null;
      this.viewport.setSelectedFaces([]);
      this.shell.setSelection(null);
      this.shell.setStatus("Ready");
      return;
    }
    this.selectedFace = pick;
    this.viewport.setSelectedFaces([{ componentId: pick.componentId, faceIndex: pick.faceIndex }]);
    const materialName = pick.face.surface[0].toUpperCase() + pick.face.surface.slice(1);
    this.shell.setSelection(`Face ${pick.faceIndex + 1} · ${materialName}`);
    this.shell.setStatus(
      `${componentName(this.doc, pick.componentId)} · face ${pick.faceIndex + 1} (${pick.face.surface}) selected`,
    );
  }

  private handleEdgePick(pick: EdgePick | null): void {
    if (this.command?.onEdge) {
      if (pick) this.command.onEdge(pick);
      return;
    }
    if (!pick) {
      this.viewport.setSelectedEdges([]);
      return;
    }
    this.viewport.setSelectedEdges([{ componentId: pick.componentId, edgeIndex: pick.edgeIndex }]);
    this.shell.setSelection(`Edge ${pick.edgeIndex + 1} · ${fmt(pick.edge.length, 2)} mm`);
    this.shell.setStatus(`Edge ${pick.edgeIndex + 1} selected`);
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
      this.viewport.setPickFilter("face");
      this.viewport.setSelectedFaces([]);
      this.viewport.setSelectedEdges([]);
    }
    this.shell.setActiveCommand(null);
    this.shell.setHint(null);
    this.panelRoot = null;
    this.shell.clearProperty();
    this.shell.showTree();
  }

  private finishCommand(): void {
    this.command = null;
    this.panelRoot = null;
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    this.viewport.setSelectedEdges([]);
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
    const value = await promptNumber({
      title: constraint.type === "radius" ? "Edit Radius" : "Edit Dimension",
      label: constraint.type === "radius" ? "Radius" : "Length",
      value: Math.max(0.01, current),
      unit: "mm",
      min: 0.01,
      step: 0.5,
    });
    if (value === null) return;
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
    this.viewport.setPickFilter("face");
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
    const picked = new Set<number>(existing?.params.edgeIndices ?? []);
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
    const picks: FacePick[] = [];
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
          let suffix = 1;
          while (this.doc.mates.some((m) => m.name === `Mate${suffix}`)) suffix++;
          const mate: Mate = {
            id: uid("mate"),
            type: mateType,
            name: `Mate${suffix}`,
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
    const material = materialById(study.materialId);
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
        `<div class="hint">Units: mm, N, MPa. The solver uses 8-node hexahedra with a Jacobi-preconditioned conjugate-gradient iteration.</div>`,
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
    this.command = {
      kind: "support-pick",
      onFace: (pick) => {
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
      },
    };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
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
    this.command = {
      kind: "force-pick",
      onFace: (pick) => {
        if (pick.partId !== study.partId) {
          toast("Pick a face on the study part.", "warn");
          return;
        }
        void this.openForceDialog(study, pick);
      },
    };
    this.viewport.setPickFilter("face");
    this.viewport.setSelectedFaces([]);
    this.shell.setHint("Click a face to apply a force. Press Esc or Done when finished.");
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
          `<div class="selection-list" id="pm-load-list"></div>
          <div class="hint" style="margin-top:6px">A force is distributed evenly over the nodes of the selected face.</div>`,
        ),
      onMount: () => {
        this.refreshPickLists(study);
        this.bindPickListRemoval(study);
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

  private async openForceDialog(study: AnalysisStudy, pick: FacePick): Promise<void> {
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
      <div class="hint">Face ${pick.faceIndex + 1} · ${escapeHtml(pick.face.surface)}</div>
    `;
    let magnitudeInput: HTMLInputElement | null = null;
    let directionSelect: HTMLSelectElement | null = null;
    const result = await openModal({
      title: "Force",
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
    const n = pick.face.normal;
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
    const before = this.capture();
    const load: AnalysisLoad = {
      id: uid("load"),
      type: "force",
      faceIndex: pick.faceIndex,
      face: { faceIndex: pick.faceIndex, surface: pick.face.surface, point: pick.face.point, normal: pick.face.normal },
      magnitude,
      direction,
      label: `Force ${fmt(magnitude, 0)} N`,
    };
    study.loads.push(load);
    this.invalidateStudy(study);
    this.commit(before);
    this.refreshTree();
    this.refreshScene();
    this.refreshPickLists(study);
    toast(`Force ${fmt(magnitude, 0)} N added on face ${pick.faceIndex + 1}.`, "success");
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
    const material = materialById(study.materialId);
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
    this.resultView.setResult(result, materialById(study.materialId).yield);
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
    const yieldStrength = materialById(study.materialId).yield;
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
        const material = materialById(part.materialId);
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
      const material = materialById(part.materialId);
      const mass = mesh.volume * material.density * 1e-9;
      const centroid = meshMass(mesh).centroid;
      const size: Vec3 = [
        mesh.bbox.max[0] - mesh.bbox.min[0],
        mesh.bbox.max[1] - mesh.bbox.min[1],
        mesh.bbox.max[2] - mesh.bbox.min[2],
      ];
      body.innerHTML = `<div class="study-stats">
        <span>Part</span><span>${escapeHtml(part.name)}</span>
        <span>Material</span><span>${material.name}</span>
        <span>Volume</span><span>${fmt(mesh.volume, 2)} mm³</span>
        <span>Mass</span><span>${fmt(mass, 5)} kg (${fmt(mass * 1000, 1)} g)</span>
        <span>Surface area</span><span>${fmt(mesh.area, 2)} mm²</span>
        <span>Bounding box</span><span>${fmt(size[0], 2)} × ${fmt(size[1], 2)} × ${fmt(size[2], 2)} mm</span>
        <span>Centroid</span><span>${fmt(centroid[0], 2)}, ${fmt(centroid[1], 2)}, ${fmt(centroid[2], 2)} mm</span>
        <span>Density</span><span>${fmt(material.density, 0)} kg/m³</span>
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
      ["L / R / C / A / D / S", "Line / Rectangle / Circle / Arc / Dimension / Select (sketch)"],
      ["Left drag", "Orbit"],
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
      case "tool-select":
        this.setSketchTool("select");
        break;
      case "rel-horizontal":
      case "rel-vertical":
      case "rel-coincident":
      case "rel-tangent":
      case "rel-equal":
      case "rel-fix":
        if (this.editor.isActive) {
          const relation = action.slice(4) as "horizontal";
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
