import { hydrateIcons, icon } from "./icons";

export type CommandTab = "sketch" | "features" | "assembly" | "evaluate" | "analysis";

interface CmdItem {
  action: string;
  label: string;
  icon: string;
  primary?: boolean;
  sketchOnly?: boolean;
  requiresSketch?: boolean;
}

interface CmdGroup {
  name: string;
  items: CmdItem[];
}

interface TabDef {
  id: CommandTab;
  label: string;
  groups: CmdGroup[];
}

const TABS: TabDef[] = [
  {
    id: "sketch",
    label: "Sketch",
    groups: [
      {
        name: "Sketch",
        items: [
          { action: "new-sketch", label: "New Sketch", icon: "drafting-compass", primary: true },
          { action: "exit-sketch", label: "Exit Sketch", icon: "check", sketchOnly: true },
        ],
      },
      {
        name: "Draw",
        items: [
          { action: "tool-line", label: "Line", icon: "pencil", sketchOnly: true },
          { action: "tool-rectangle", label: "Rectangle", icon: "rectangle-horizontal", sketchOnly: true },
          { action: "tool-circle", label: "Circle", icon: "circle", sketchOnly: true },
          { action: "tool-arc", label: "3-Point Arc", icon: "circle-dot", sketchOnly: true },
          { action: "tool-dimension", label: "Smart Dimension", icon: "ruler", sketchOnly: true },
        ],
      },
      {
        name: "Relations",
        items: [
          { action: "rel-horizontal", label: "Horizontal", icon: "move-horizontal", sketchOnly: true },
          { action: "rel-vertical", label: "Vertical", icon: "move-vertical", sketchOnly: true },
          { action: "rel-coincident", label: "Coincident", icon: "link", sketchOnly: true },
          { action: "rel-tangent", label: "Tangent", icon: "magnet", sketchOnly: true },
          { action: "rel-equal", label: "Equal", icon: "equal", sketchOnly: true },
          { action: "rel-fix", label: "Fix", icon: "lock", sketchOnly: true },
        ],
      },
      {
        name: "Modify",
        items: [
          { action: "sketch-construction", label: "For Construction", icon: "ruler", sketchOnly: true },
          { action: "tool-trim", label: "Trim", icon: "split" },
          { action: "sketch-offset", label: "Offset Entities", icon: "arrow-right-left", sketchOnly: true },
          { action: "tool-convert", label: "Convert Entities", icon: "waypoints", sketchOnly: true },
          { action: "rel-perpendicular", label: "Perpendicular", icon: "move-3d", sketchOnly: true },
          { action: "sketch-delete", label: "Delete", icon: "trash-2", sketchOnly: true },
          { action: "sketch-fit", label: "Fit Sketch", icon: "focus", sketchOnly: true },
          { action: "toggle-planes", label: "Origin Planes", icon: "frame" },
        ],
      },
    ],
  },
  {
    id: "features",
    label: "Features",
    groups: [
      {
        name: "Base / Boss",
        items: [
          { action: "extrude-boss", label: "Extruded Boss", icon: "square", primary: true },
          { action: "extrude-cut", label: "Extruded Cut", icon: "circle-off" },
          { action: "revolve", label: "Revolve", icon: "rotate-3d" },
        ],
      },
      {
        name: "Modify",
        items: [
          { action: "fillet", label: "Fillet", icon: "circle" },
          { action: "chamfer", label: "Chamfer", icon: "triangle" },
          { action: "shell", label: "Shell", icon: "box" },
          { action: "mirror", label: "Mirror", icon: "arrow-right-left" },
          { action: "linear-pattern", label: "Linear Pattern", icon: "layout-grid" },
          { action: "edit-feature", label: "Edit", icon: "pencil" },
          { action: "delete-selected", label: "Delete", icon: "trash-2" },
        ],
      },
      {
        name: "Toolbox",
        items: [
          { action: "toolbox-bolt", label: "Bolt", icon: "wrench" },
          { action: "toolbox-nut", label: "Nut", icon: "circle-dot" },
          { action: "toolbox-washer", label: "Washer", icon: "circle" },
        ],
      },
      {
        name: "Inspect",
        items: [
          { action: "section-view", label: "Section View", icon: "scan" },
          { action: "interference", label: "Interference", icon: "boxes" },
          { action: "make-drawing", label: "Drawing / PDF", icon: "file-down" },
          { action: "equations", label: "Equations", icon: "equal" },
        ],
      },
      {
        name: "Import",
        items: [
          { action: "import-cad", label: "STEP / IGES", icon: "file-up" },
          { action: "import-mesh", label: "STL / OBJ", icon: "upload" },
        ],
      },
      {
        name: "Output",
        items: [
          { action: "save", label: "Save Project", icon: "save" },
          { action: "export-step", label: "Export STEP", icon: "download" },
          { action: "export-stl", label: "Export STL", icon: "download" },
        ],
      },
      {
        name: "View",
        items: [
          { action: "isometric", label: "Isometric", icon: "box" },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize" },
        ],
      },
    ],
  },
  {
    id: "assembly",
    label: "Assembly",
    groups: [
      {
        name: "Components",
        items: [
          { action: "insert-component", label: "Insert Component", icon: "plus", primary: true },
          { action: "component-transform", label: "Transform", icon: "move-3d" },
          { action: "component-fix", label: "Fix / Float", icon: "lock" },
          { action: "delete-selected", label: "Delete", icon: "trash-2" },
        ],
      },
      {
        name: "Mates",
        items: [
          { action: "mate-coincident", label: "Coincident", icon: "link" },
          { action: "mate-concentric", label: "Concentric", icon: "target" },
          { action: "mate-distance", label: "Distance", icon: "ruler" },
          { action: "resolve-mates", label: "Resolve All", icon: "refresh-cw" },
        ],
      },
      {
        name: "View",
        items: [
          { action: "isometric", label: "Isometric", icon: "box" },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize" },
          { action: "toggle-planes", label: "Origin Planes", icon: "frame" },
        ],
      },
    ],
  },
  {
    id: "evaluate",
    label: "Evaluate",
    groups: [
      {
        name: "Inspect",
        items: [
          { action: "mass-props", label: "Mass Properties", icon: "gauge", primary: true },
          { action: "measure", label: "Measure", icon: "ruler" },
          { action: "section-view", label: "Section View", icon: "scan" },
          { action: "model-info", label: "Model Info", icon: "info" },
        ],
      },
      {
        name: "Display",
        items: [
          { action: "style-edges", label: "Shaded + Edges", icon: "layers" },
          { action: "style-shaded", label: "Shaded", icon: "sun" },
          { action: "style-wire", label: "Wireframe", icon: "grid-3x3" },
        ],
      },
      {
        name: "Views",
        items: [
          { action: "view-front", label: "Front", icon: "camera" },
          { action: "view-top", label: "Top", icon: "frame" },
          { action: "view-right", label: "Right", icon: "axis-3d" },
          { action: "isometric", label: "Isometric", icon: "box" },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize" },
        ],
      },
      {
        name: "Export",
        items: [
          { action: "export-step", label: "STEP", icon: "download" },
          { action: "export-iges", label: "IGES", icon: "download" },
          { action: "export-stl", label: "STL", icon: "download" },
          { action: "export-obj", label: "OBJ", icon: "download" },
        ],
      },
    ],
  },
  {
    id: "analysis",
    label: "Analysis",
    groups: [
      {
        name: "Setup",
        items: [
          { action: "new-study", label: "New Study", icon: "plus", primary: true },
          { action: "study-material", label: "Material", icon: "layers" },
          { action: "study-mesh", label: "Mesh", icon: "grid-3x3" },
        ],
      },
      {
        name: "Boundary",
        items: [
          { action: "add-support", label: "Fixed Support", icon: "anchor" },
          { action: "add-force", label: "Force", icon: "arrow-down-to-line" },
          { action: "add-pressure", label: "Pressure", icon: "gauge" },
          { action: "clear-loads", label: "Clear Loads", icon: "trash-2" },
        ],
      },
      {
        name: "Solve",
        items: [
          { action: "fea-solve", label: "Solve", icon: "play" },
          { action: "clear-results", label: "Clear Results", icon: "x" },
        ],
      },
      {
        name: "Results",
        items: [
          { action: "result-deformation", label: "Deformation", icon: "activity" },
          { action: "result-stress", label: "von Mises Stress", icon: "flame" },
          { action: "result-safety", label: "Safety Factor", icon: "gauge" },
        ],
      },
    ],
  },
];

const TR_LABELS: Record<string, string> = {
  Sketch: "Eskiz",
  Features: "Özellikler",
  Assembly: "Montaj",
  Evaluate: "Değerlendir",
  Analysis: "Analiz",
  Draw: "Çiz",
  Relations: "İlişkiler",
  Modify: "Değiştir",
  "Base / Boss": "Taban / Kabartma",
  Toolbox: "Takım Kutusu",
  Inspect: "İncele",
  Components: "Bileşenler",
  Mates: "Eşleşmeler",
  Import: "İçe Aktar",
  Output: "Çıktı",
  Display: "Görünüm",
  Views: "Bakışlar",
  Export: "Dışa Aktar",
  Setup: "Kurulum",
  Boundary: "Sınır Koşulları",
  Solve: "Çöz",
  Results: "Sonuçlar",
  Line: "Çizgi",
  Rectangle: "Dikdörtgen",
  Circle: "Daire",
  "3-Point Arc": "3 Noktalı Yay",
  "Smart Dimension": "Akıllı Ölçü",
  "New Sketch": "Yeni Eskiz",
  "Exit Sketch": "Eskizden Çık",
  Horizontal: "Yatay",
  Vertical: "Düşey",
  Coincident: "Çakışık",
  Tangent: "Teğet",
  Equal: "Eşit",
  Fix: "Sabitle",
  Perpendicular: "Dik",
  "For Construction": "Yardımcı Geometri",
  Trim: "Kırp",
  "Offset Entities": "Ötele",
  "Convert Entities": "Dönüştür",
  Delete: "Sil",
  "Fit Sketch": "Eskizi Sığdır",
  "Origin Planes": "Orijin Düzlemleri",
  "Extruded Boss": "Kabartma",
  "Extruded Cut": "Kesme",
  Revolve: "Döndür",
  Fillet: "Yuvarlat",
  Chamfer: "Pah",
  Shell: "Kabuk",
  Mirror: "Ayna",
  "Linear Pattern": "Doğrusal Desen",
  Edit: "Düzenle",
  Bolt: "Cıvata",
  Nut: "Somun",
  Washer: "Pul",
  "Section View": "Kesit Görünümü",
  Interference: "Girişim",
  "Drawing / PDF": "Teknik Resim / PDF",
  Equations: "Denklemler",
  "Mass Properties": "Kütle Özellikleri",
  Measure: "Ölç",
  "Model Info": "Model Bilgisi",
  "Shaded + Edges": "Gölgeli + Kenar",
  Shaded: "Gölgeli",
  Wireframe: "Tel Kafes",
  Front: "Ön",
  Top: "Üst",
  Right: "Sağ",
  Isometric: "İzometrik",
  "Zoom Fit": "Sığdır",
  STEP: "STEP",
  IGES: "IGES",
  STL: "STL",
  OBJ: "OBJ",
  "Insert Component": "Bileşen Ekle",
  Transform: "Dönüştür",
  "Fix / Float": "Sabitle / Serbest",
  Concentric: "Eş Merkezli",
  Distance: "Mesafe",
  "Resolve All": "Tümünü Çöz",
  "New Study": "Yeni Çalışma",
  Material: "Malzeme",
  Mesh: "Ağ",
  "Fixed Support": "Sabit Mesnet",
  Force: "Kuvvet",
  Pressure: "Basınç",
  "Clear Loads": "Yükleri Temizle",
  "Clear Results": "Sonuçları Temizle",
  Deformation: "Deformasyon",
  "von Mises Stress": "von Mises Gerilmesi",
  "Safety Factor": "Emniyet Katsayısı",
};

const TAB_LABELS: Record<CommandTab, string> = { sketch: "Sketch", features: "Features", assembly: "Assembly", evaluate: "Evaluate", analysis: "Analysis" };

export class CommandManager {
  private tabsEl: HTMLElement;
  private groupsEl: HTMLElement;
  private activeTab: CommandTab = "features";
  private activeAction: string | null = null;
  private sketching = false;
  private lang: "en" | "tr" = "en";
  onAction: (action: string) => void = () => undefined;

  constructor(tabsEl: HTMLElement, groupsEl: HTMLElement) {
    this.tabsEl = tabsEl;
    this.groupsEl = groupsEl;
    this.tabsEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd-tab]");
      if (!btn) return;
      this.setTab(btn.dataset.cmdTab as CommandTab);
    });
    this.groupsEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd-action]");
      if (!btn || btn.classList.contains("disabled")) return;
      this.onAction(btn.dataset.cmdAction ?? "");
    });
    this.render();
  }

  get tab(): CommandTab {
    return this.activeTab;
  }

  setSketching(active: boolean): void {
    this.sketching = active;
    if (active) this.setTab("sketch");
    else if (this.activeTab === "sketch") this.setTab("features");
    else this.renderGroups();
  }

  setTab(tab: CommandTab): void {
    this.activeTab = tab;
    this.render();
  }

  setActive(action: string | null): void {
    this.activeAction = action;
    for (const btn of this.groupsEl.querySelectorAll<HTMLElement>("[data-cmd-action]")) {
      btn.classList.toggle("active", btn.dataset.cmdAction === action);
    }
  }

  private setLanguageInternal(lang: "en" | "tr"): void {
    this.lang = lang;
    this.render();
  }

  setLanguage(lang: "en" | "tr"): void {
    this.setLanguageInternal(lang);
  }

  private t(text: string): string {
    if (this.lang === "en") return text;
    return TR_LABELS[text] ?? text;
  }

  private render(): void {
    this.tabsEl.innerHTML = TABS.map(
      (t) => `<button class="cmd-tab ${t.id === this.activeTab ? "active" : ""}" data-cmd-tab="${t.id}">${this.t(TAB_LABELS[t.id] ?? t.label)}</button>`,
    ).join("");
    this.renderGroups();
  }

  private renderGroups(): void {
    const tab = TABS.find((t) => t.id === this.activeTab) ?? TABS[1];
    this.groupsEl.innerHTML = tab.groups
      .map((g) => {
        const btns = g.items
          .map((item) => {
            const disabled = item.sketchOnly && !this.sketching;
            const label = this.t(item.label);
            return `<button class="cmd-btn ${item.primary ? "primary" : ""} ${disabled ? "disabled" : ""} ${this.activeAction === item.action ? "active" : ""}" data-cmd-action="${item.action}" title="${label}" ${disabled ? "disabled" : ""}>
              ${icon(item.icon)}<span>${label}</span>
            </button>`;
          })
          .join("");
        return `<div class="cmd-group"><div class="cmd-buttons" style="display:flex;gap:1px;align-items:stretch">${btns}</div><div class="cmd-group-label">${this.t(g.name)}</div></div>`;
      })
      .join("");
    hydrateIcons();
  }
}
