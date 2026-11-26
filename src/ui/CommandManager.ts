import { hydrateIcons, icon } from "./icons";

export type CommandTab = "sketch" | "features" | "sheetmetal" | "assembly" | "evaluate" | "analysis";

export interface CommandMenuItem {
  action: string;
  label: string;
  icon: string;
}

export interface CmdItem {
  action: string;
  label: string;
  icon: string;
  primary?: boolean;
  sketchOnly?: boolean;
  requiresSketch?: boolean;
  /** Icon-only cell: keeps a crowded group readable while the tooltip names it. */
  compact?: boolean;
  /** Related tools that live under this command's split caret. */
  menu?: CommandMenuItem[];
}

export interface CmdGroup {
  name: string;
  items: CmdItem[];
}

export interface TabDef {
  id: CommandTab;
  label: string;
  groups: CmdGroup[];
}

export const TABS: TabDef[] = [
  {
    id: "sketch",
    label: "Sketch",
    groups: [
      {
        name: "Sketch",
        items: [
          { action: "new-sketch", label: "New Sketch", icon: "drafting-compass", primary: true },
          { action: "exit-sketch", label: "Exit Sketch", icon: "check", sketchOnly: true, compact: true },
        ],
      },
      {
        name: "Draw",
        items: [
          {
            action: "tool-line",
            label: "Line",
            icon: "pen-tool",
            sketchOnly: true,
            primary: true,
            menu: [
              { action: "tool-rectangle", label: "Rectangle", icon: "square-dashed" },
              { action: "tool-circle", label: "Circle", icon: "circle-dashed" },
              { action: "tool-arc", label: "3-Point Arc", icon: "spline" },
              { action: "tool-slot", label: "Slot", icon: "panel-top" },
              { action: "tool-polygon", label: "Polygon", icon: "hexagon" },
              { action: "tool-spline", label: "Spline", icon: "waypoints" },
            ],
          },
          { action: "tool-dimension", label: "Smart Dimension", icon: "ruler", sketchOnly: true },
        ],
      },
      {
        name: "Relations",
        items: [
          { action: "rel-horizontal", label: "Horizontal", icon: "move-horizontal", sketchOnly: true, compact: true },
          { action: "rel-vertical", label: "Vertical", icon: "move-vertical", sketchOnly: true, compact: true },
          { action: "rel-coincident", label: "Coincident", icon: "link", sketchOnly: true, compact: true },
          { action: "rel-tangent", label: "Tangent", icon: "magnet", sketchOnly: true, compact: true },
          { action: "rel-equal", label: "Equal", icon: "equal", sketchOnly: true, compact: true },
          { action: "rel-fix", label: "Fix", icon: "lock", sketchOnly: true, compact: true },
        ],
      },
      {
        name: "Modify",
        items: [
          { action: "sketch-construction", label: "For Construction", icon: "ruler", sketchOnly: true, compact: true },
          { action: "tool-trim", label: "Trim", icon: "scissors", compact: true },
          { action: "sketch-offset", label: "Offset Entities", icon: "arrow-right-left", sketchOnly: true, compact: true },
          { action: "tool-convert", label: "Convert Entities", icon: "waypoints", sketchOnly: true, compact: true },
          { action: "rel-perpendicular", label: "Perpendicular", icon: "move-3d", sketchOnly: true, compact: true },
          {
            action: "sketch-fillet",
            label: "Sketch Fillet",
            icon: "radius",
            sketchOnly: true,
            menu: [{ action: "sketch-chamfer", label: "Sketch Chamfer", icon: "slice" }],
          },
          {
            action: "sketch-pattern",
            label: "Sketch Pattern",
            icon: "repeat-2",
            sketchOnly: true,
            menu: [{ action: "sketch-delete", label: "Delete", icon: "trash-2" }],
          },
          { action: "sketch-fit", label: "Fit Sketch", icon: "focus", sketchOnly: true, compact: true },
          { action: "toggle-planes", label: "Origin Planes", icon: "frame", compact: true },
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
          {
            action: "extrude-boss",
            label: "Extruded Boss",
            icon: "cuboid",
            primary: true,
            menu: [
              { action: "extrude-cut", label: "Extruded Cut", icon: "circle-off" },
              { action: "revolve", label: "Revolve", icon: "orbit" },
              { action: "sweep", label: "Sweep", icon: "waypoints" },
              { action: "loft", label: "Loft", icon: "layers-3" },
              { action: "helix", label: "Helix / Spiral", icon: "rotate-3d" },
            ],
          },
        ],
      },
      {
        name: "Modify",
        items: [
          {
            action: "fillet",
            label: "Fillet",
            icon: "radius",
            primary: true,
            menu: [{ action: "chamfer", label: "Chamfer", icon: "slice" }],
          },
          { action: "shell", label: "Shell", icon: "layers-2", compact: true },
          { action: "mirror", label: "Mirror", icon: "flip-horizontal-2", compact: true },
          {
            action: "linear-pattern",
            label: "Linear Pattern",
            icon: "layout-grid",
            menu: [{ action: "circular-pattern", label: "Circular Pattern", icon: "refresh-cw" }],
          },
          { action: "hole-wizard", label: "Hole Wizard", icon: "drill", compact: true },
          { action: "draft", label: "Draft", icon: "diamond", compact: true },
          { action: "rib", label: "Rib", icon: "grid-2x2", compact: true },
          { action: "reference-geometry", label: "Reference Geometry", icon: "frame", compact: true },
          { action: "edit-feature", label: "Edit", icon: "pencil", compact: true },
          { action: "delete-selected", label: "Delete", icon: "trash-2", compact: true },
        ],
      },
      {
        name: "Toolbox",
        items: [
          {
            action: "toolbox-bolt",
            label: "Bolt",
            icon: "bolt",
            menu: [
              { action: "toolbox-nut", label: "Nut", icon: "hexagon" },
              { action: "toolbox-washer", label: "Washer", icon: "circle" },
            ],
          },
        ],
      },
      {
        name: "Inspect",
        items: [
          { action: "section-view", label: "Section View", icon: "scan", compact: true },
          { action: "interference", label: "Interference", icon: "boxes", compact: true },
          { action: "make-drawing", label: "Drawing / PDF", icon: "file-down", compact: true },
          { action: "equations", label: "Equations", icon: "equal", compact: true },
        ],
      },
      {
        name: "Import",
        items: [
          { action: "import-cad", label: "STEP / IGES", icon: "file-up", compact: true },
          { action: "import-mesh", label: "STL / OBJ", icon: "upload", compact: true },
        ],
      },
      {
        name: "Output",
        items: [
          { action: "save", label: "Save Project", icon: "save", compact: true },
          { action: "export-step", label: "Export STEP", icon: "download", compact: true },
          { action: "export-stl", label: "Export STL", icon: "download", compact: true },
        ],
      },
      {
        name: "View",
        items: [
          { action: "isometric", label: "Isometric", icon: "box", compact: true },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize", compact: true },
        ],
      },
    ],
  },
  {
    id: "sheetmetal",
    label: "Sheet Metal",
    groups: [
      {
        name: "Sheet Metal",
        items: [
          { action: "base-flange", label: "Base Flange", icon: "sheet", primary: true },
          {
            action: "edge-flange",
            label: "Edge Flange",
            icon: "workflow",
            menu: [{ action: "flatten", label: "Flatten", icon: "rotate-ccw" }],
          },
        ],
      },
      {
        name: "Flat Pattern",
        items: [
          { action: "export-dxf", label: "Export DXF", icon: "file-down" },
          { action: "sheet-settings", label: "Sheet Settings", icon: "settings", compact: true },
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
          { action: "component-transform", label: "Transform", icon: "move-3d", compact: true },
          { action: "component-fix", label: "Fix / Float", icon: "lock", compact: true },
          { action: "delete-selected", label: "Delete", icon: "trash-2", compact: true },
        ],
      },
      {
        name: "Mates",
        items: [
          { action: "mate-coincident", label: "Coincident", icon: "link" },
          { action: "mate-concentric", label: "Concentric", icon: "target", compact: true },
          { action: "mate-distance", label: "Distance", icon: "ruler", compact: true },
          { action: "mate-angle", label: "Angle", icon: "diamond", compact: true },
          { action: "exploded-view", label: "Exploded View", icon: "boxes", compact: true },
          { action: "resolve-mates", label: "Resolve All", icon: "refresh-cw", compact: true },
        ],
      },
      {
        name: "View",
        items: [
          { action: "isometric", label: "Isometric", icon: "box", compact: true },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize", compact: true },
          { action: "toggle-planes", label: "Origin Planes", icon: "frame", compact: true },
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
          { action: "section-view", label: "Section View", icon: "scan", compact: true },
          { action: "model-info", label: "Model Info", icon: "info", compact: true },
        ],
      },
      {
        name: "Display",
        items: [
          { action: "style-edges", label: "Shaded + Edges", icon: "layers" },
          { action: "style-shaded", label: "Shaded", icon: "sun-medium", compact: true },
          { action: "style-wire", label: "Wireframe", icon: "grid-3x3", compact: true },
        ],
      },
      {
        name: "Views",
        items: [
          { action: "view-front", label: "Front", icon: "camera", compact: true },
          { action: "view-top", label: "Top", icon: "frame", compact: true },
          { action: "view-right", label: "Right", icon: "axis-3d", compact: true },
          { action: "isometric", label: "Isometric", icon: "box", compact: true },
          { action: "zoom-fit", label: "Zoom Fit", icon: "maximize", compact: true },
        ],
      },
      {
        name: "Export",
        items: [
          { action: "export-step", label: "STEP", icon: "download", compact: true },
          { action: "export-iges", label: "IGES", icon: "download", compact: true },
          { action: "export-stl", label: "STL", icon: "download", compact: true },
          { action: "export-obj", label: "OBJ", icon: "download", compact: true },
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
          { action: "study-mesh", label: "Mesh", icon: "grid-3x3", compact: true },
        ],
      },
      {
        name: "Boundary",
        items: [
          { action: "add-support", label: "Fixed Support", icon: "anchor" },
          { action: "add-force", label: "Force", icon: "arrow-down-to-line", compact: true },
          { action: "add-pressure", label: "Pressure", icon: "gauge", compact: true },
          { action: "clear-loads", label: "Clear Loads", icon: "trash-2", compact: true },
        ],
      },
      {
        name: "Solve",
        items: [
          { action: "fea-solve", label: "Solve", icon: "play", primary: true },
          { action: "clear-results", label: "Clear Results", icon: "x", compact: true },
        ],
      },
      {
        name: "Results",
        items: [
          { action: "result-deformation", label: "Deformation", icon: "activity", compact: true },
          { action: "result-stress", label: "von Mises Stress", icon: "flame", compact: true },
          { action: "result-safety", label: "Safety Factor", icon: "gauge", compact: true },
        ],
      },
    ],
  },
];

const TR_LABELS: Record<string, string> = {
  Sketch: "Eskiz",
  Features: "Özellikler",
  "Sheet Metal": "Sac Metal",
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
  View: "Görünüm",
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
  Slot: "Kanal",
  Polygon: "Çokgen",
  Spline: "Eğri",
  "Sketch Fillet": "Eskiz Yuvarlat",
  "Sketch Chamfer": "Eskiz Pah",
  "Sketch Pattern": "Eskiz Deseni",
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
  Sweep: "Süpürme",
  Loft: "Kaburga Geçiş",
  "Helix / Spiral": "Helezon / Spiral",
  Fillet: "Yuvarlat",
  Chamfer: "Pah",
  Shell: "Kabuk",
  Mirror: "Ayna",
  "Linear Pattern": "Doğrusal Desen",
  "Circular Pattern": "Dairesel Desen",
  "Hole Wizard": "Delik Sihirbazı",
  Draft: "Çekme Açısı",
  Rib: "Kaburga",
  "Reference Geometry": "Referans Geometri",
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
  Angle: "Açı",
  "Exploded View": "Patlatılmış Görünüm",
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
  "Base Flange": "Taban Flanşı",
  "Edge Flange": "Kenar Flanşı",
  Flatten: "Açınım",
  "Export DXF": "DXF Aktar",
  "Sheet Settings": "Sac Ayarları",
  "Save Project": "Projeyi Kaydet",
  "Export STEP": "STEP Aktar",
  "Export STL": "STL Aktar",
  "STEP / IGES": "STEP / IGES",
  "STL / OBJ": "STL / OBJ",
};

/** Extra search words (Turkish + English) that are not part of the label. */
export const COMMAND_KEYWORDS: Record<string, string[]> = {
  "hole-wizard": ["delik", "hole", "drill", "cıvata deliği", "counterbore", "havşa"],
  fillet: ["yuvarlat", "radius", "radius", "köşe", "round"],
  chamfer: ["pah", "pah kırma", "edge break", "45"],
  "extrude-boss": ["kabartma", "extrude", "boss", "çekme", "pad"],
  "extrude-cut": ["kesme", "cut", "kes", "pocket", "cep"],
  revolve: ["döndür", "devir", "lathe", "axis", "eksen"],
  sweep: ["süpürme", "profil", "yol", "rail"],
  loft: ["kaburga geçiş", "geçiş", "sections", "kesitler"],
  helix: ["helezon", "spiral", "yay", "spring", "thread", "vida"],
  shell: ["kabuk", "duvar", "wall", "hollow", "içi boş"],
  mirror: ["ayna", "simetri", "symmetry"],
  "linear-pattern": ["doğrusal desen", "pattern", "dizi", "çoğalt"],
  "circular-pattern": ["dairesel desen", "polar", "döndürerek çoğalt"],
  "base-flange": ["sac", "sheet", "levha", "flanş", "base"],
  "edge-flange": ["sac", "kenar", "büküm", "bend", "flange"],
  flatten: ["açınım", "aç", "flat", "unfold", "düzleştir", "k-faktör"],
  "export-dxf": ["dxf", "ac1009", "lazer", "cnc", "kesim"],
  "new-sketch": ["eskiz", "sketch", "çizim başlat"],
  "new-study": ["analiz", "study", "fea", "sonlu eleman", "modal", "modal analiz", "titreşim", "vibration", "buckling", "termal", "thermal"],
  "study-material": ["malzeme", "material", "ansys", "engineering data", "çelik", "alüminyum"],
  "study-mesh": ["ağ", "mesh", "eleman", "tet", "hex"],
  "fea-solve": ["çöz", "solve", "hesapla", "run"],
  "mass-props": ["kütle", "mass", "hacim", "ağırlık", "center of mass"],
  measure: ["ölç", "measure", "mesafe", "distance"],
  "section-view": ["kesit", "section", "cut plane"],
  "make-drawing": ["resim", "drawing", "pdf", "teknik resim", "bom"],
  equations: ["denklem", "global değişken", "variable", "formül"],
  save: ["kaydet", "save", "mcad", "proje"],
  "export-step": ["step", "iges", "aktar", "export"],
  "export-stl": ["stl", "3d baskı", "print", "mesh"],
  "zoom-fit": ["sığdır", "fit", "zoom", "ekrana sığdır"],
  "toggle-planes": ["düzlem", "plane", "orijin", "origin"],
  "insert-component": ["bileşen", "component", "montaj", "assembly"],
  "mate-coincident": ["çakışık", "mate", "eşleşme", "coincident"],
  "mate-concentric": ["eş merkezli", "concentric", "mil", "delik"],
  "exploded-view": ["patlat", "explode", "patlatılmış"],
  "tool-dimension": ["ölçü", "dimension", "boyut"],
  "tool-trim": ["kırp", "trim", "kes"],
  "sketch-offset": ["ötele", "offset", "paralel"],
  "tool-convert": ["dönüştür", "convert", "projeksiyon"],
  "toolbox-bolt": ["cıvata", "bolt", "m8", "metrik"],
  toolbar: ["araç çubuğu"],
};

export const TAB_LABELS: Record<CommandTab, string> = {
  sketch: "Sketch",
  features: "Features",
  sheetmetal: "Sheet Metal",
  assembly: "Assembly",
  evaluate: "Evaluate",
  analysis: "Analysis",
};

export interface CommandEntry {
  action: string;
  label: string;
  icon: string;
  tab: CommandTab;
  tabLabel: string;
  group: string;
  keywords: string[];
}

export class CommandManager {
  private tabsEl: HTMLElement;
  private groupsEl: HTMLElement;
  private activeTab: CommandTab = "features";
  private activeAction: string | null = null;
  private sketching = false;
  private lang: "en" | "tr" = "en";
  private openMenu: string | null = null;
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
      const caret = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd-menu]");
      if (caret) {
        e.stopPropagation();
        const id = caret.dataset.cmdMenu ?? null;
        this.openMenu = this.openMenu === id ? null : id;
        this.syncMenus();
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd-action]");
      if (!btn || btn.classList.contains("disabled")) return;
      const action = btn.dataset.cmdAction ?? "";
      this.openMenu = null;
      this.syncMenus();
      this.onAction(action);
    });
    // Close an open split menu when the pointer/clicks go elsewhere.
    document.addEventListener("pointerdown", (event) => {
      if (!this.openMenu) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".cmd-split")) return;
      this.openMenu = null;
      this.syncMenus();
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
    this.openMenu = null;
    this.render();
  }

  setActive(action: string | null): void {
    this.activeAction = action;
    for (const btn of this.groupsEl.querySelectorAll<HTMLElement>("[data-cmd-action]")) {
      btn.classList.toggle("active", btn.dataset.cmdAction === action);
    }
  }

  setLanguage(lang: "en" | "tr"): void {
    this.lang = lang;
    this.render();
  }

  /** Every command in the ribbon, flattened for the Ctrl+K palette. */
  commands(): CommandEntry[] {
    const list: CommandEntry[] = [];
    const seen = new Set<string>();
    for (const tab of TABS) {
      for (const group of tab.groups) {
        for (const item of group.items) {
          if (seen.has(item.action)) continue;
          seen.add(item.action);
          list.push({
            action: item.action,
            label: item.label,
            icon: item.icon,
            tab: tab.id,
            tabLabel: tab.label,
            group: group.name,
            keywords: [item.label, TR_LABELS[item.label] ?? "", item.action, ...(COMMAND_KEYWORDS[item.action] ?? [])].filter(Boolean),
          });
          for (const sub of item.menu ?? []) {
            if (seen.has(sub.action)) continue;
            seen.add(sub.action);
            list.push({
              action: sub.action,
              label: sub.label,
              icon: sub.icon,
              tab: tab.id,
              tabLabel: tab.label,
              group: group.name,
              keywords: [sub.label, TR_LABELS[sub.label] ?? "", sub.action, ...(COMMAND_KEYWORDS[sub.action] ?? [])].filter(Boolean),
            });
          }
        }
      }
    }
    return list;
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

  private button(item: { action: string; label: string; icon: string }, options: { primary?: boolean; compact?: boolean; disabled?: boolean } = {}): string {
    const disabled = options.disabled === true;
    const label = this.t(item.label);
    const cls = ["cmd-btn", options.primary ? "primary" : "", options.compact ? "compact" : "", disabled ? "disabled" : "", this.activeAction === item.action ? "active" : ""]
      .filter(Boolean)
      .join(" ");
    return `<button class="${cls}" data-cmd-action="${item.action}" title="${label}" ${disabled ? "disabled" : ""}>
      ${icon(item.icon)}${options.compact ? "" : `<span>${label}</span>`}
    </button>`;
  }

  private renderGroups(): void {
    const tab = TABS.find((t) => t.id === this.activeTab) ?? TABS[1];
    this.groupsEl.innerHTML = tab.groups
      .map((g) => {
        const btns = g.items
          .map((item) => {
            const disabled = Boolean(item.sketchOnly && !this.sketching);
            if (!item.menu?.length) {
              return this.button(item, { primary: item.primary, compact: item.compact, disabled });
            }
            const menu = [
              `<button class="cmd-menu-item" data-cmd-action="${item.action}">${icon(item.icon)}<span>${this.t(item.label)}</span></button>`,
              ...item.menu.map(
                (sub) =>
                  `<button class="cmd-menu-item" data-cmd-action="${sub.action}">${icon(sub.icon)}<span>${this.t(sub.label)}</span></button>`,
              ),
            ].join("");
            const open = this.openMenu === item.action;
            return `<div class="cmd-split ${open ? "open" : ""}" data-cmd-split="${item.action}">
              ${this.button(item, { primary: item.primary, compact: false, disabled })}
              <button class="cmd-caret" data-cmd-menu="${item.action}" title="${this.t("More")}: ${item.menu.map((m) => this.t(m.label)).join(", ")}" ${disabled ? "disabled" : ""}>${icon("chevron-down")}</button>
              <div class="cmd-menu" data-cmd-menu-panel="${item.action}" ${open ? "" : "hidden"}>${menu}</div>
            </div>`;
          })
          .join("");
        return `<div class="cmd-group"><div class="cmd-buttons">${btns}</div><div class="cmd-group-label">${this.t(g.name)}</div></div>`;
      })
      .join("");
    hydrateIcons();
    this.syncMenus();
  }

  private syncMenus(): void {
    for (const panel of this.groupsEl.querySelectorAll<HTMLElement>("[data-cmd-menu-panel]")) {
      panel.hidden = panel.dataset.cmdMenuPanel !== this.openMenu;
      panel.parentElement?.classList.toggle("open", panel.dataset.cmdMenuPanel === this.openMenu);
    }
  }
}
