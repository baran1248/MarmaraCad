import type { ProjectDocument, WorkspaceMode } from "../model/types";
import type { DisplayStyle, ViewName } from "../viewport/Viewport";
import type { TreeContext, TreeHandlers } from "./FeatureTree";
import { FeatureTree } from "./FeatureTree";
import { CommandManager, type CommandTab } from "./CommandManager";
import { ViewCube } from "./ViewCube";
import { hydrateIcons, icon } from "./icons";
import { fmtMm } from "./dom";

export type PanelTab = "tree" | "property" | "display";

export interface MassRow {
  label: string;
  value: string;
}

interface MenuEntry {
  label?: string;
  action?: string;
  icon?: string;
  shortcut?: string;
  separator?: boolean;
  heading?: string;
}

const MENUS: Record<string, MenuEntry[]> = {
  file: [
    { label: "New Document", action: "new-document", icon: "file-plus-2", shortcut: "Ctrl+N" },
    { label: "New from Template…", action: "templates", icon: "layout-grid" },
    { label: "Open Project…", action: "open-project", icon: "folder-open", shortcut: "Ctrl+O" },
    { label: "Save Project", action: "save", icon: "save", shortcut: "Ctrl+S" },
    { label: "Save As…", action: "save-as", icon: "file-down" },
    { separator: true },
    { heading: "IMPORT" },
    { label: "STEP / IGES CAD…", action: "import-cad", icon: "file-up" },
    { label: "STL / OBJ Mesh…", action: "import-mesh", icon: "upload" },
    { separator: true },
    { heading: "EXPORT" },
    { label: "STEP (AP214)", action: "export-step", icon: "download" },
    { label: "IGES", action: "export-iges", icon: "download" },
    { label: "STL (binary)", action: "export-stl", icon: "download" },
    { label: "OBJ", action: "export-obj", icon: "download" },
    { separator: true },
    { label: "Recent Documents…", action: "recent-documents", icon: "list-tree" },
    { label: "Sample: Mounting Plate", action: "sample", icon: "sparkles" },
  ],
  edit: [
    { label: "Undo", action: "undo", icon: "undo-2", shortcut: "Ctrl+Z" },
    { label: "Redo", action: "redo", icon: "redo-2", shortcut: "Ctrl+Y" },
    { separator: true },
    { label: "Delete", action: "delete-selected", icon: "trash-2", shortcut: "Del" },
    { label: "Rename…", action: "rename-selected", icon: "pencil", shortcut: "F2" },
    { separator: true },
    { label: "Select All", action: "select-all", icon: "layout-grid" },
  ],
  view: [
    { label: "Front", action: "view-front", icon: "camera" },
    { label: "Top", action: "view-top", icon: "frame" },
    { label: "Right", action: "view-right", icon: "axis-3d" },
    { label: "Isometric", action: "isometric", icon: "box", shortcut: "F" },
    { separator: true },
    { label: "Zoom Fit", action: "zoom-fit", icon: "maximize", shortcut: "F" },
    { separator: true },
    { label: "Shaded with Edges", action: "style-edges", icon: "layers" },
    { label: "Shaded", action: "style-shaded", icon: "sun" },
    { label: "Wireframe", action: "style-wire", icon: "grid-3x3" },
    { separator: true },
    { label: "Toggle Origin Planes", action: "toggle-planes", icon: "frame" },
  ],
  insert: [
    { label: "New Sketch", action: "new-sketch", icon: "drafting-compass" },
    { label: "Extruded Boss", action: "extrude-boss", icon: "square" },
    { label: "Extruded Cut", action: "extrude-cut", icon: "circle-off" },
    { label: "Revolve", action: "revolve", icon: "rotate-3d" },
    { label: "Fillet", action: "fillet", icon: "circle" },
    { label: "Chamfer", action: "chamfer", icon: "triangle" },
    { label: "Shell", action: "shell", icon: "box" },
    { label: "Mirror", action: "mirror", icon: "arrow-right-left" },
    { label: "Linear Pattern", action: "linear-pattern", icon: "layout-grid" },
    { separator: true },
    { label: "Toolbox Bolt…", action: "toolbox-bolt", icon: "wrench" },
    { label: "Technical Drawing…", action: "make-drawing", icon: "file-down" },
    { label: "Section View…", action: "section-view", icon: "scan" },
    { label: "Interference Detection…", action: "interference", icon: "boxes" },
    { separator: true },
    { label: "Insert Component", action: "insert-component", icon: "component" },
    { label: "Mate", action: "mate", icon: "link" },
    { separator: true },
    { label: "New Static Study", action: "new-study", icon: "activity" },
  ],
  tools: [
    { label: "Mass Properties…", action: "mass-props", icon: "gauge" },
    { label: "Measure…", action: "measure", icon: "ruler" },
    { label: "Equations / Variables…", action: "equations", icon: "equal" },
    { label: "Material Library…", action: "material-library", icon: "layers" },
    { label: "Edit Material…", action: "edit-material", icon: "layers" },
    { label: "Model Info…", action: "model-info", icon: "info" },
    { separator: true },
    { label: "Display Settings", action: "display-settings", icon: "settings" },
    { label: "Clear Cached Kernel", action: "clear-kernel-cache", icon: "database" },
    { label: "Clear Autosave", action: "clear-autosave", icon: "trash-2" },
  ],
  help: [
    { label: "Quick Start", action: "quick-start", icon: "book-open" },
    { label: "Keyboard Shortcuts", action: "shortcuts", icon: "help-circle" },
    { label: "About MarmaraCad", action: "about", icon: "info" },
    { separator: true },
    { label: "GitHub Repository", action: "github", icon: "github", shortcut: "↗" },
  ],
};

export class Shell {
  readonly root: HTMLElement;
  readonly viewHost: HTMLElement;
  readonly commandManager: CommandManager;
  readonly viewCube: ViewCube;
  readonly tree: FeatureTree;
  readonly colorbarEl: HTMLElement;
  readonly resultToolbarEl: HTMLElement;

  onCommand: (action: string) => void = () => undefined;
  onMenuAction: (action: string) => void = () => undefined;
  onModeChange: (mode: WorkspaceMode) => void = () => undefined;
  onView: (name: ViewName) => void = () => undefined;
  onDisplayStyle: (style: DisplayStyle) => void = () => undefined;
  onPlanesToggle: (visible: boolean) => void = () => undefined;
  onZoomFit: () => void = () => undefined;
  onUndo: () => void = () => undefined;
  onRedo: () => void = () => undefined;
  onSave: () => void = () => undefined;
  onTreeSelect: TreeHandlers["select"] = () => undefined;
  onTreeToggle: TreeHandlers["toggleVisibility"] = () => undefined;
  onTreeOpen: TreeHandlers["open"] = () => undefined;
  onTreeContext: TreeHandlers["contextMenu"] = () => undefined;
  onTreeAction: TreeHandlers["action"] = () => undefined;
  onSnapStep: (step: number) => void = () => undefined;
  onMeshQuality: (q: number) => void = () => undefined;
  onDisplaySettingsChanged: () => void = () => undefined;
  onPickFilter: (filter: string) => void = () => undefined;
  onSnapToggle: (enabled: boolean) => void = () => undefined;
  onAssistantToggle: () => void = () => undefined;
  onLanguageToggle: () => void = () => undefined;
  onShortcut: (action: string) => void = () => undefined;
  onNavScheme: (scheme: "cad" | "legacy") => void = () => undefined;
  onSnapSettings: (settings: Partial<Record<"endpoint" | "midpoint" | "center" | "origin" | "quadrant" | "intersection" | "perpendicular" | "tangent" | "grid", boolean>>) => void = () => undefined;

  private panelBody: HTMLElement;
  private docNameEl: HTMLElement;
  private docSubEl: HTMLElement;
  private modeTabs: HTMLElement;
  private panelTabs: HTMLElement;
  private massCard: HTMLElement;
  private statusMsg: HTMLElement;
  private cursorItem: HTMLElement;
  private selectionItem: HTMLElement;
  private sketchStateItem: HTMLElement;
  private kernelItem: HTMLElement;
  private kernelDot: HTMLElement;
  private badgeEl: HTMLElement;
  private hintEl: HTMLElement;
  private menuLayer: HTMLElement;
  private toolButtons: Record<string, HTMLElement> = {};
  private planesBtn: HTMLElement;
  readonly aiPanelEl: HTMLElement;
  readonly contextEl: HTMLElement;
  readonly shortcutEl: HTMLElement;
  readonly confirmationEl: HTMLElement;
  readonly measureEl: HTMLElement;
  private filterEl: HTMLElement;
  private spaceSelectorEl: HTMLElement;
  private activePanel: PanelTab = "tree";
  private treeContext: TreeContext | null = null;
  private propertyHtml: string | null = null;
  private displayState = { style: "shaded-edges" as DisplayStyle, planes: false, snapStep: 1, quality: 0.12 };
  private mode: WorkspaceMode = "part";
  private busy = false;
  private snapOn = true;
  private language: "en" | "tr" = "en";

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="app-shell">
        <header class="titlebar">
          <div class="brand"><span class="brand-mark">M</span><span>MarmaraCad</span><span class="ver">1.0</span></div>
          <nav class="menubar">
            <button data-menu="file">File</button>
            <button data-menu="edit">Edit</button>
            <button data-menu="view">View</button>
            <button data-menu="insert">Insert</button>
            <button data-menu="tools">Tools</button>
            <button data-menu="help">Help</button>
          </nav>
          <div class="doc-title"><span class="doc-name">Untitled</span><span class="doc-sub">Part</span></div>
          <div class="title-actions">
            <button class="ai-launch" data-title-action="ai" title="Gemini AI assistant">${icon("sparkles")} AI</button>
            <button class="lang-btn" data-title-action="language" title="Switch language (TR/EN)">EN</button>
            <span class="title-sep"></span>
            <button class="icon-btn" data-title-action="undo" title="Undo (Ctrl+Z)">${icon("undo-2")}</button>
            <button class="icon-btn" data-title-action="redo" title="Redo (Ctrl+Y)">${icon("redo-2")}</button>
            <span class="title-sep"></span>
            <button class="save-btn" data-title-action="save" title="Save project (Ctrl+S)">${icon("save")} Save</button>
            <a class="gh-link" href="https://github.com/Baran1248/MarmaraCad" target="_blank" rel="noreferrer" title="GitHub repository">${icon("github")}</a>
          </div>
        </header>
        <div class="commandbar">
          <div class="cmd-tabs" role="tablist"></div>
          <div class="cmd-groups"></div>
        </div>
        <main class="workspace">
          <aside class="left-panel">
            <div class="doc-mode-tabs">
              <button class="doc-mode-tab active" data-mode="part">${icon("box")} Part</button>
              <button class="doc-mode-tab" data-mode="assembly">${icon("boxes")} Assembly</button>
              <button class="doc-mode-tab" data-mode="analysis">${icon("activity")} Analysis</button>
            </div>
            <div class="panel-tabs">
              <button class="panel-tab active" data-panel="tree">FeatureManager</button>
              <button class="panel-tab" data-panel="property">PropertyManager</button>
              <button class="panel-tab" data-panel="display" title="Display settings">${icon("settings")}</button>
            </div>
            <div class="panel-body" id="panel-body"></div>
            <div class="mass-card" id="mass-card"></div>
          </aside>
          <section class="view-area" id="view-area">
            <div class="viewport-host" id="viewport"></div>
            <div class="view-badge" id="view-badge">Part · mm</div>
            <div class="view-tools">
              <button class="view-tool-btn" data-view="front" title="Front view">${icon("camera")}</button>
              <button class="view-tool-btn" data-view="top" title="Top view">${icon("frame")}</button>
              <button class="view-tool-btn" data-view="right" title="Right view">${icon("axis-3d")}</button>
              <button class="view-tool-btn" data-view="iso" title="Isometric view">${icon("box")}</button>
              <span class="view-tool-sep"></span>
              <button class="view-tool-btn" data-view="fit" title="Zoom fit">${icon("maximize")}</button>
              <span class="view-tool-sep"></span>
              <button class="view-tool-btn" data-style="shaded-edges" title="Shaded with edges">${icon("layers")}</button>
              <button class="view-tool-btn" data-style="shaded" title="Shaded">${icon("sun")}</button>
              <button class="view-tool-btn" data-style="wireframe" title="Wireframe">${icon("grid-3x3")}</button>
              <span class="view-tool-sep"></span>
              <button class="view-tool-btn" data-planes="toggle" title="Show origin planes">${icon("frame")}</button>
            </div>
            <div class="viewcube" id="viewcube"></div>
            <div class="selection-filters" id="selection-filters">
              <span class="sf-label">Select</span>
              <button class="sel-filter active" data-pick-filter="all" title="Select faces, edges and vertices">All</button>
              <button class="sel-filter" data-pick-filter="face" title="Faces only">Faces</button>
              <button class="sel-filter" data-pick-filter="edge" title="Edges only">Edges</button>
              <button class="sel-filter" data-pick-filter="vertex" title="Vertices only">Vertices</button>
              <span class="sf-sep"></span>
              <button class="sel-filter snap-toggle active" id="snap-toggle" title="Object snap on/off (sketch)">${icon("magnet")} Snap</button>
            </div>
            <div class="confirmation-corner" id="confirmation-corner"></div>
            <div class="space-selector" id="space-selector">
              <div class="ss-title">View Selector <span>Space</span></div>
              <div class="ss-cube">
                <button data-ss-view="top" class="ss-face top">TOP</button>
                <button data-ss-view="front" class="ss-face front">FRONT</button>
                <button data-ss-view="right" class="ss-face right">RIGHT</button>
                <button data-ss-view="back" class="ss-face back">BACK</button>
                <button data-ss-view="left" class="ss-face left">LEFT</button>
                <button data-ss-view="bottom" class="ss-face bottom">BOTTOM</button>
              </div>
              <button class="ss-iso" data-ss-view="iso">Isometric</button>
            </div>
            <div class="shortcut-bar" id="shortcut-bar"></div>
            <div class="measure-readout" id="measure-readout"></div>
            <div class="ai-panel" id="ai-panel"></div>
            <div class="viewport-context" id="viewport-context"></div>
            <div class="selection-hint" id="selection-hint"></div>
            <div class="colorbar" id="colorbar"></div>
            <div class="result-toolbar" id="result-toolbar"></div>
          </section>
        </main>
        <footer class="statusbar">
          <div class="status-msg" id="status-msg">Starting…</div>
          <div class="status-item mono" id="status-cursor" style="display:none"></div>
          <div class="status-item" id="status-selection" style="display:none"></div>
          <div class="status-item">mm</div>
          <div class="status-item" id="status-kernel"><span class="status-dot" id="status-dot"></span><span id="status-kernel-text">OCCT</span></div>
        </footer>
      </div>
      <div class="dropdown-layer" id="dropdown-layer"></div>
      <div class="toast-stack" id="toast-stack"></div>
      <div class="modal-layer" id="modal-layer"></div>
    `;
    this.viewHost = this.getId("viewport");
    this.docNameEl = root.querySelector(".doc-name")!;
    this.docSubEl = root.querySelector(".doc-sub")!;
    this.modeTabs = root.querySelector(".doc-mode-tabs")!;
    this.panelTabs = root.querySelector(".panel-tabs")!;
    this.panelBody = this.getId("panel-body");
    this.massCard = this.getId("mass-card");
    this.statusMsg = this.getId("status-msg");
    this.cursorItem = this.getId("status-cursor");
    this.selectionItem = this.getId("status-selection");
    this.sketchStateItem = document.createElement("div");
    this.sketchStateItem.className = "status-item sketch-state";
    this.sketchStateItem.style.display = "none";
    this.statusMsg.parentElement?.insertBefore(this.sketchStateItem, this.selectionItem);
    this.kernelItem = this.getId("status-kernel");
    this.kernelDot = this.getId("status-dot");
    this.badgeEl = this.getId("view-badge");
    this.hintEl = this.getId("selection-hint");
    this.menuLayer = this.getId("dropdown-layer");
    this.planesBtn = root.querySelector('[data-planes="toggle"]')!;
    this.colorbarEl = this.getId("colorbar");
    this.resultToolbarEl = this.getId("result-toolbar");
    this.aiPanelEl = this.getId("ai-panel");
    this.contextEl = this.getId("viewport-context");
    this.shortcutEl = this.getId("shortcut-bar");
    this.confirmationEl = this.getId("confirmation-corner");
    this.measureEl = this.getId("measure-readout");
    this.filterEl = this.getId("selection-filters");
    this.spaceSelectorEl = this.getId("space-selector");

    this.commandManager = new CommandManager(
      root.querySelector(".cmd-tabs") as HTMLElement,
      root.querySelector(".cmd-groups") as HTMLElement,
    );
    this.commandManager.onAction = (action) => this.onCommand(action);
    this.viewCube = new ViewCube(this.getId("viewcube"));
    this.viewCube.onView = (name) => this.onView(name);
    this.viewCube.onHome = () => this.onView("iso");

    this.tree = new FeatureTree(this.panelBody, {
      select: (kind, id, additive) => this.onTreeSelect(kind, id, additive),
      toggleVisibility: (kind, id) => this.onTreeToggle(kind, id),
      open: (kind, id) => this.onTreeOpen(kind, id),
      contextMenu: (kind, id, x, y) => this.onTreeContext(kind, id, x, y),
      action: (action, kind, id) => this.onTreeAction(action, kind, id),
    });

    this.bindChrome();
    this.modeTabs.querySelectorAll<HTMLElement>("[data-mode]").forEach((btn) => {
      btn.addEventListener("click", () => this.onModeChange(btn.dataset.mode as WorkspaceMode));
    });
    this.panelTabs.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      btn.addEventListener("click", () => this.setPanelTab(btn.dataset.panel as PanelTab));
    });
    hydrateIcons();
    this.setMassRows([{ label: "Volume", value: "—" }]);
  }

  private getId(id: string): HTMLElement {
    const el = this.root.querySelector<HTMLElement>(`#${id}`);
    if (!el) throw new Error(`Missing shell element #${id}`);
    return el;
  }

  private bindChrome(): void {
    this.root.querySelectorAll<HTMLElement>("[data-menu]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openMenu(btn.dataset.menu ?? "", btn);
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-title-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.titleAction;
        if (action === "undo") this.onUndo();
        else if (action === "redo") this.onRedo();
        else if (action === "save") this.onSave();
        else if (action === "ai") this.onAssistantToggle();
        else if (action === "language") this.onLanguageToggle();
      });
    });
    this.filterEl.querySelectorAll<HTMLElement>("[data-pick-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.setPickFilter(btn.dataset.pickFilter ?? "all");
        this.onPickFilter(btn.dataset.pickFilter ?? "all");
      });
    });
    this.getId("snap-toggle").addEventListener("click", () => {
      this.snapOn = !this.snapOn;
      this.getId("snap-toggle").classList.toggle("active", this.snapOn);
      this.onSnapToggle(this.snapOn);
    });
    this.spaceSelectorEl.querySelectorAll<HTMLElement>("[data-ss-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.ssView;
        this.spaceSelectorEl.classList.remove("visible");
        if (name) this.onView(name as ViewName);
      });
    });
    this.root.querySelectorAll<HTMLElement>(".view-tools [data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v === "fit") this.onZoomFit();
        else this.onView(v as ViewName);
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-style]").forEach((btn) => {
      btn.addEventListener("click", () => this.onDisplayStyle(btn.dataset.style as DisplayStyle));
    });
    this.planesBtn.addEventListener("click", () => this.onPlanesToggle(!this.displayState.planes));
    this.menuLayer.addEventListener("click", (e) => {
      if (e.target === this.menuLayer) this.closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
    window.addEventListener("blur", () => this.closeMenu());
  }

  private openMenu(name: string, anchor: HTMLElement): void {
    const items = MENUS[name];
    if (!items) return;
    this.closeMenu();
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.innerHTML = items
      .map((item) => {
        if (item.separator) return `<div class="menu-sep"></div>`;
        if (item.heading) return `<div class="menu-label">${item.heading}</div>`;
        return `<div class="menu-item" data-menu-action="${item.action}">
          ${item.icon ? icon(item.icon) : ""}
          <span>${item.label}</span>
          ${item.shortcut ? `<span class="shortcut">${item.shortcut}</span>` : ""}
        </div>`;
      })
      .join("");
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
    menu.style.top = `${rect.bottom + 3}px`;
    this.menuLayer.appendChild(menu);
    this.menuLayer.classList.add("open");
    anchor.classList.add("open");
    hydrateIcons();
    menu.querySelectorAll<HTMLElement>("[data-menu-action]").forEach((item) => {
      item.addEventListener("click", () => {
        const action = item.dataset.menuAction ?? "";
        this.closeMenu();
        this.onMenuAction(action);
      });
    });
  }

  closeMenu(): void {
    this.menuLayer.classList.remove("open");
    this.menuLayer.innerHTML = "";
    this.root.querySelectorAll(".menubar button.open").forEach((b) => b.classList.remove("open"));
  }

  setDocument(doc: ProjectDocument): void {
    this.docNameEl.textContent = doc.name;
    this.docSubEl.textContent = doc.mode === "part" ? (doc.parts.find((p) => p.id === doc.activePartId)?.name ?? "Part") : doc.mode;
  }

  setMode(mode: WorkspaceMode): void {
    this.mode = mode;
    this.modeTabs.querySelectorAll<HTMLElement>("[data-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    this.badgeEl.textContent = `${mode === "part" ? "Part" : mode === "assembly" ? "Assembly" : "Static Structural"} · mm`;
    if (this.activePanel === "display") this.renderDisplayPanel();
  }

  get currentMode(): WorkspaceMode {
    return this.mode;
  }

  setTreeContext(ctx: TreeContext): void {
    this.treeContext = ctx;
    if (this.activePanel === "tree") {
      const scroll = this.panelBody.scrollTop;
      this.tree.render(ctx);
      hydrateIcons();
      this.panelBody.scrollTop = scroll;
    }
  }

  refreshTree(): void {
    if (this.treeContext && this.activePanel === "tree") {
      const scroll = this.panelBody.scrollTop;
      this.tree.render(this.treeContext);
      hydrateIcons();
      this.panelBody.scrollTop = scroll;
    }
  }

  setPanelTab(tab: PanelTab): void {
    this.activePanel = tab;
    this.panelTabs.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.panel === tab);
    });
    if (tab === "tree" && this.treeContext) {
      this.panelBody.className = "panel-body";
      this.tree.render(this.treeContext);
      hydrateIcons();
    } else if (tab === "display") {
      this.renderDisplayPanel();
    } else if (tab === "property") {
      this.panelBody.className = "panel-body pm";
      this.panelBody.innerHTML =
        this.propertyHtml ??
        `<div class="tree-empty" style="margin:14px 12px">No active command.<br />Pick a tool from the CommandManager to open its PropertyManager.</div>`;
      hydrateIcons();
    }
  }

  get panelTab(): PanelTab {
    return this.activePanel;
  }

  /** Show a command's PropertyManager and return its content body. */
  showProperty(html: string): HTMLElement {
    this.activePanel = "property";
    this.panelTabs.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.panel === "property");
    });
    this.panelBody.className = "panel-body pm";
    this.propertyHtml = html;
    this.panelBody.innerHTML = html;
    hydrateIcons();
    return this.panelBody;
  }

  clearProperty(): void {
    this.propertyHtml = null;
    if (this.activePanel === "property") this.setPanelTab("tree");
    else if (this.activePanel === "tree") this.refreshTree();
  }

  showTree(): void {
    this.setPanelTab("tree");
  }

  refreshIcons(): void {
    hydrateIcons();
  }

  private renderDisplayPanel(): void {
    this.activePanel = "display";
    this.panelTabs.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.panel === "display");
    });
    this.panelBody.className = "panel-body";
    const d = this.displayState;
    this.panelBody.innerHTML = `
      <div class="pm-body" style="background:transparent">
        <div class="pm-section">
          <div class="pm-section-head">${icon("layers")} Display Style</div>
          <div class="pm-section-body">
            <div class="inline-options">
              <button class="opt-btn ${d.style === "shaded-edges" ? "active" : ""}" data-display-style="shaded-edges">${icon("layers")} Shaded + Edges</button>
              <button class="opt-btn ${d.style === "shaded" ? "active" : ""}" data-display-style="shaded">${icon("sun")} Shaded</button>
              <button class="opt-btn ${d.style === "wireframe" ? "active" : ""}" data-display-style="wireframe">${icon("grid-3x3")} Wire</button>
            </div>
            <label class="check-row"><input type="checkbox" id="display-planes" ${d.planes ? "checked" : ""} /> Show origin planes</label>
          </div>
        </div>
        <div class="pm-section">
          <div class="pm-section-head">${icon("grid-3x3")} Sketch &amp; Tessellation</div>
          <div class="pm-section-body">
            <div class="field"><label>Snap increment</label>
              <select id="display-snap">
                ${[0.5, 1, 2, 5, 10].map((s) => `<option value="${s}" ${d.snapStep === s ? "selected" : ""}>${s} mm</option>`).join("")}
              </select>
            </div>
            <div class="field"><label>Mesh quality</label>
              <select id="display-quality">
                <option value="0.05" ${d.quality === 0.05 ? "selected" : ""}>Fine (slower)</option>
                <option value="0.12" ${d.quality === 0.12 ? "selected" : ""}>Normal</option>
                <option value="0.3" ${d.quality === 0.3 ? "selected" : ""}>Coarse (fast)</option>
              </select>
            </div>
            <div class="field"><label>Mouse scheme</label>
              <select id="display-nav">
                <option value="cad">SolidWorks / Fusion (MMB orbit, RMB pan)</option>
                <option value="legacy">Legacy (LMB orbit)</option>
              </select>
            </div>
            <label class="check-row"><input type="checkbox" id="display-snap-endpoint" checked /> Snap to endpoints, midpoints &amp; centres</label>
            <label class="check-row"><input type="checkbox" id="display-snap-tangent" checked /> Perpendicular / tangent snaps</label>
            <label class="check-row"><input type="checkbox" id="display-snap-grid" checked /> Grid &amp; alignment guides</label>
            <div class="hint">Higher quality increases triangle density and rebuild time.</div>
          </div>
        </div>
        <div class="pm-section">
          <div class="pm-section-head">${icon("info")} Units &amp; Grid</div>
          <div class="pm-section-body">
            <div class="study-stats"><span>Units</span><span>mm / N / MPa</span><span>Grid</span><span>major 25 mm</span><span>Kernel</span><span>OCCT WASM</span></div>
          </div>
        </div>
      </div>
    `;
    hydrateIcons();
    this.panelBody.querySelectorAll<HTMLElement>("[data-display-style]").forEach((btn) => {
      btn.addEventListener("click", () => this.onDisplayStyle(btn.dataset.displayStyle as DisplayStyle));
    });
    this.panelBody.querySelector<HTMLInputElement>("#display-planes")?.addEventListener("change", (e) => {
      this.onPlanesToggle((e.target as HTMLInputElement).checked);
    });
    this.panelBody.querySelector<HTMLSelectElement>("#display-snap")?.addEventListener("change", (e) => {
      this.displayState.snapStep = Number((e.target as HTMLSelectElement).value);
      this.onSnapStep(this.displayState.snapStep);
    });
    this.panelBody.querySelector<HTMLSelectElement>("#display-quality")?.addEventListener("change", (e) => {
      this.displayState.quality = Number((e.target as HTMLSelectElement).value);
      this.onMeshQuality(this.displayState.quality);
    });
    this.panelBody.querySelector<HTMLSelectElement>("#display-nav")?.addEventListener("change", (e) => {
      this.onNavScheme((e.target as HTMLSelectElement).value as "cad" | "legacy");
    });
    this.panelBody.querySelector<HTMLInputElement>("#display-snap-endpoint")?.addEventListener("change", (e) => {
      this.onSnapSettings({
        endpoint: (e.target as HTMLInputElement).checked,
        midpoint: (e.target as HTMLInputElement).checked,
        center: (e.target as HTMLInputElement).checked,
        origin: (e.target as HTMLInputElement).checked,
        quadrant: (e.target as HTMLInputElement).checked,
        intersection: (e.target as HTMLInputElement).checked,
      });
    });
    this.panelBody.querySelector<HTMLInputElement>("#display-snap-tangent")?.addEventListener("change", (e) => {
      this.onSnapSettings({ perpendicular: (e.target as HTMLInputElement).checked, tangent: (e.target as HTMLInputElement).checked });
    });
    this.panelBody.querySelector<HTMLInputElement>("#display-snap-grid")?.addEventListener("change", (e) => {
      this.onSnapSettings({ grid: (e.target as HTMLInputElement).checked });
    });
  }

  setDisplayState(style: DisplayStyle, planes: boolean): void {
    this.displayState.style = style;
    this.displayState.planes = planes;
    this.root.querySelectorAll<HTMLElement>("[data-style]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.style === style);
    });
    this.planesBtn.classList.toggle("active", planes);
    if (this.activePanel === "display") this.renderDisplayPanel();
  }

  setPickFilter(filter: string): void {
    this.filterEl.querySelectorAll<HTMLElement>("[data-pick-filter]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pickFilter === filter);
    });
  }

  setSnapOn(on: boolean): void {
    this.snapOn = on;
    this.getId("snap-toggle").classList.toggle("active", on);
  }

  toggleViewSelector(): boolean {
    const visible = this.spaceSelectorEl.classList.toggle("visible");
    return visible;
  }

  hideViewSelector(): void {
    this.spaceSelectorEl.classList.remove("visible");
  }

  get viewSelectorOpen(): boolean {
    return this.spaceSelectorEl.classList.contains("visible");
  }

  setSketchStatus(text: string | null, state: "under" | "full" | "over" | "empty" = "under"): void {
    if (!text) {
      this.sketchStateItem.style.display = "none";
      this.sketchStateItem.textContent = "";
      return;
    }
    this.sketchStateItem.style.display = "";
    this.sketchStateItem.className = `status-item sketch-state ${state}`;
    this.sketchStateItem.innerHTML = `<span class="state-dot"></span>${text}`;
  }

  showConfirmationCorner(onOk: () => void, onCancel: () => void): void {
    this.confirmationEl.classList.add("visible");
    this.confirmationEl.innerHTML = `
      <button class="cc-btn ok" title="OK (Enter)">${icon("check")}</button>
      <button class="cc-btn cancel" title="Cancel (Esc)">${icon("x")}</button>`;
    hydrateIcons();
    this.confirmationEl.querySelector(".cc-btn.ok")?.addEventListener("click", () => {
      this.hideConfirmationCorner();
      onOk();
    });
    this.confirmationEl.querySelector(".cc-btn.cancel")?.addEventListener("click", () => {
      this.hideConfirmationCorner();
      onCancel();
    });
  }

  hideConfirmationCorner(): void {
    this.confirmationEl.classList.remove("visible");
    this.confirmationEl.innerHTML = "";
  }

  showShortcutBar(x: number, y: number, items: { action: string; label: string; icon: string }[]): void {
    this.shortcutEl.innerHTML = items
      .map((it) => `<button class="shortcut-btn" data-shortcut="${it.action}" title="${it.label}">${icon(it.icon)}<span>${it.label}</span></button>`)
      .join("");
    this.shortcutEl.classList.add("visible");
    this.shortcutEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 420))}px`;
    this.shortcutEl.style.top = `${Math.max(90, Math.min(y, window.innerHeight - 280))}px`;
    hydrateIcons();
    this.shortcutEl.querySelectorAll<HTMLElement>("[data-shortcut]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.hideShortcutBar();
        this.onShortcut(btn.dataset.shortcut ?? "");
      });
    });
  }

  hideShortcutBar(): void {
    this.shortcutEl.classList.remove("visible");
    this.shortcutEl.innerHTML = "";
  }

  showContextMenu(x: number, y: number, items: { label: string; icon?: string; run: () => void; danger?: boolean; disabled?: boolean }[]): void {
    this.hideContextMenu();
    this.contextEl.innerHTML = items
      .map(
        (it, i) =>
          `<div class="ctx-item ${it.danger ? "danger" : ""} ${it.disabled ? "disabled" : ""}" data-ctx="${i}">${it.icon ? icon(it.icon) : ""}<span>${it.label}</span></div>`,
      )
      .join("");
    this.contextEl.classList.add("visible");
    this.contextEl.style.left = `${x}px`;
    this.contextEl.style.top = `${y}px`;
    hydrateIcons();
    this.contextEl.querySelectorAll<HTMLElement>("[data-ctx]").forEach((el) => {
      el.addEventListener("click", () => {
        const item = items[Number(el.dataset.ctx)];
        this.hideContextMenu();
        if (item && !item.disabled) item.run();
      });
    });
    window.setTimeout(() => {
      const close = (ev: MouseEvent) => {
        if (!this.contextEl.contains(ev.target as Node)) {
          this.hideContextMenu();
          document.removeEventListener("pointerdown", close, true);
        }
      };
      document.addEventListener("pointerdown", close, true);
    }, 0);
  }

  hideContextMenu(): void {
    this.contextEl.classList.remove("visible");
    this.contextEl.innerHTML = "";
  }

  setLanguageButton(lang: "en" | "tr"): void {
    const btn = this.root.querySelector<HTMLElement>('[data-title-action="language"]');
    if (btn) btn.textContent = lang === "en" ? "EN" : "TR";
  }

  applyLanguage(lang: "en" | "tr"): void {
    this.language = lang;
    this.setLanguageButton(lang);
    const tr: Record<string, string> = {
      File: "Dosya",
      Edit: "Düzen",
      View: "Görünüm",
      Insert: "Ekle",
      Tools: "Araçlar",
      Help: "Yardım",
      Part: "Parça",
      "FeatureManager": "Özellik Yöneticisi",
      "PropertyManager": "Özellik Paneli",
      "Static Structural": "Statik Yapısal",
      "Mass Properties": "Kütle Özellikleri",
      "Sections": "Kesitler",
    };
    const en: Record<string, string> = {
      File: "File",
      Edit: "Edit",
      View: "View",
      Insert: "Insert",
      Tools: "Tools",
      Help: "Help",
      Part: "Part",
      "FeatureManager": "FeatureManager",
      "PropertyManager": "PropertyManager",
      "Static Structural": "Static Structural",
      "Mass Properties": "Mass Properties",
    };
    const map = lang === "tr" ? tr : en;
    this.root.querySelectorAll<HTMLElement>("[data-menu]").forEach((button) => {
      const key = button.dataset.menu ?? "";
      const label = map[key.charAt(0).toUpperCase() + key.slice(1)];
      if (label) button.textContent = label;
    });
    this.root.querySelector<HTMLElement>(".panel-tab[data-panel=tree]")!.textContent = map["FeatureManager"] ?? "FeatureManager";
    this.root.querySelector<HTMLElement>(".panel-tab[data-panel=property]")!.textContent = map["PropertyManager"] ?? "PropertyManager";
    const partTab = this.root.querySelector<HTMLElement>('[data-mode="part"]');
    if (partTab) partTab.innerHTML = `${icon("box")} ${map.Part ?? "Part"}`;
    this.badgeEl.textContent = `${this.mode === "part" ? (map.Part ?? "Part") : this.mode === "assembly" ? "Assembly" : map["Static Structural"] ?? "Static Structural"} · mm`;
    hydrateIcons();
  }

  setMassRows(rows: MassRow[]): void {
    this.massCard.innerHTML = `<div class="title"><span>Mass Properties</span><span>${icon("gauge")}</span></div><div class="mass-grid">${rows
      .map((r) => `<span>${r.label}</span><span>${r.value}</span>`)
      .join("")}</div>`;
    hydrateIcons();
  }

  setStatus(message: string): void {
    this.statusMsg.textContent = message;
  }

  setCursor(text: string | null): void {
    if (!text) {
      this.cursorItem.style.display = "none";
      this.cursorItem.textContent = "";
    } else {
      this.cursorItem.style.display = "";
      this.cursorItem.textContent = text;
    }
  }

  setSelection(text: string | null): void {
    if (!text) {
      this.selectionItem.style.display = "none";
      this.selectionItem.textContent = "";
    } else {
      this.selectionItem.style.display = "";
      this.selectionItem.innerHTML = `${icon("mouse-pointer-2")} ${text}`;
      hydrateIcons();
    }
  }

  setKernel(text: string, state: "ok" | "busy" | "error" = "ok"): void {
    this.kernelItem.querySelector("#status-kernel-text")!.textContent = text;
    this.kernelDot.className = "status-dot" + (state === "busy" ? " busy" : state === "error" ? " err" : "");
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.setKernel(busy ? "Kernel busy" : "OCCT ready", busy ? "busy" : "ok");
  }

  get isBusy(): boolean {
    return this.busy;
  }

  setUndoRedo(canUndo: boolean, canRedo: boolean): void {
    const undo = this.root.querySelector<HTMLButtonElement>('[data-title-action="undo"]');
    const redo = this.root.querySelector<HTMLButtonElement>('[data-title-action="redo"]');
    if (undo) undo.disabled = !canUndo;
    if (redo) redo.disabled = !canRedo;
    if (undo) undo.style.opacity = canUndo ? "1" : "0.4";
    if (redo) redo.style.opacity = canRedo ? "1" : "0.4";
  }

  setHint(text: string | null): void {
    if (!text) {
      this.hintEl.classList.remove("visible");
      this.hintEl.textContent = "";
    } else {
      this.hintEl.classList.add("visible");
      this.hintEl.innerHTML = text;
    }
  }

  setViewBadge(text: string): void {
    this.badgeEl.textContent = text;
  }

  setCommandTab(tab: CommandTab): void {
    this.commandManager.setTab(tab);
  }

  setActiveCommand(action: string | null): void {
    this.commandManager.setActive(action);
  }

  setSketching(active: boolean): void {
    this.commandManager.setSketching(active);
  }

  showColorbar(options: { title: string; min: number; max: number; unit: string; gradient: string } | null): void {
    document.body.classList.toggle("has-legend", Boolean(options));
    if (!options) {
      this.colorbarEl.classList.remove("visible");
      this.colorbarEl.innerHTML = "";
      return;
    }
    this.colorbarEl.classList.add("visible");
    const mid = (options.min + options.max) / 2;
    const scale = formatScaleSet([options.min, mid, options.max]);
    this.colorbarEl.innerHTML = `
      <div class="cb-title">${options.title}</div>
      <div class="cb-scale">
        <div class="cb-gradient" style="background:${options.gradient}"></div>
        <div class="cb-labels">
          <span>${scale(options.max)}</span>
          <span>${scale(mid)}</span>
          <span>${scale(options.min)}</span>
        </div>
      </div>
      <div class="cb-title cb-unit">${options.unit}</div>
    `;
  }

  showResultToolbar(html: string | null): void {
    if (!html) {
      this.resultToolbarEl.classList.remove("visible");
      this.resultToolbarEl.innerHTML = "";
      return;
    }
    this.resultToolbarEl.classList.add("visible");
    this.resultToolbarEl.innerHTML = html;
    hydrateIcons();
  }

  setViewCubeSynced(camera: import("three").Camera): void {
    this.viewCube.sync(camera);
  }

  setEditorMode(_active: boolean): void {
    void _active;
  }

  formatStatusMm(v: number): string {
    return fmtMm(v);
  }
}

function formatScaleSet(values: number[]): (v: number) => string {
  const peak = Math.max(...values.filter((v) => Number.isFinite(v)).map((v) => Math.abs(v)), 0);
  // One decimal rule for the whole legend so 0, the midpoint and the peak line up.
  const digits = peak >= 10 ? 1 : peak >= 1 ? 2 : peak >= 0.01 ? 3 : peak > 0 ? 4 : 2;
  const kilo = peak >= 10_000;
  return (v: number) => {
    if (!Number.isFinite(v)) return "—";
    if (kilo) return (v / 1000).toFixed(digits) + "k";
    if (Math.abs(v) < Math.pow(10, -digits) / 2) return (0).toFixed(digits);
    return v.toFixed(digits);
  };
}

export type { CommandTab };
