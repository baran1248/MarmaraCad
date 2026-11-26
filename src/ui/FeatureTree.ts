import type { AnalysisStudy, Feature, Part, ProjectDocument, Sketch, WorkspaceMode } from "../model/types";
import { MATERIALS, materialById, partMaterial } from "../analysis/materials";
import { escapeHtml } from "../utils/misc";
import { icon } from "./icons";

export interface SketchInfo {
  closed: boolean;
  area: number;
  warnings: string[];
}

export interface TreeContext {
  doc: ProjectDocument;
  mode: WorkspaceMode;
  selection: string | null;
  expanded: Set<string>;
  planesVisible: boolean;
  sketchInfo: Record<string, SketchInfo>;
  activeResult: string | null;
  /** UI language, used for the labels FeatureTree owns. */
  lang?: "en" | "tr";
}

export interface TreeHandlers {
  select: (kind: string, id: string, additive: boolean) => void;
  toggleVisibility: (kind: string, id: string) => void;
  open: (kind: string, id: string) => void;
  contextMenu: (kind: string, id: string, x: number, y: number) => void;
  action: (action: string, kind?: string, id?: string) => void;
}

interface QuickAction {
  action: string;
  icon: string;
  title: string;
}

interface RowOptions {
  kind: string;
  id: string;
  depth: number;
  label: string;
  labelHtml?: string;
  iconName: string;
  iconClass?: string;
  selected?: boolean;
  hidden?: boolean;
  error?: boolean;
  suppressed?: boolean;
  sub?: string;
  badge?: string;
  twisty?: boolean;
  expanded?: boolean;
  eye?: "on" | "off" | null;
  title?: string;
  extra?: string;
  /** SolidWorks-style inline actions, revealed on hover/selection. */
  quick?: QuickAction[];
}

export class FeatureTree {
  private root: HTMLElement;
  private handlers: TreeHandlers;
  handlersSet = false;
  private lang: "en" | "tr" = "en";

  /** Localise a label that FeatureTree owns (feature names are user data). */
  private t(en: string, tr: string): string {
    return this.lang === "tr" ? tr : en;
  }

  constructor(root: HTMLElement, handlers: TreeHandlers) {
    this.root = root;
    this.handlers = handlers;
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("contextmenu", this.onContextMenu);
    this.root.addEventListener("dragstart", (event) => {
      const bar = (event.target as HTMLElement).closest<HTMLElement>("[data-rollback]");
      if (!bar) return;
      this.dragPart = bar.dataset.part ?? "";
      bar.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", "rollback");
    });
    this.root.addEventListener("dragend", () => {
      this.root.querySelectorAll(".rollback-bar.dragging").forEach((el) => el.classList.remove("dragging"));
    });
    this.root.addEventListener("dragover", (event) => {
      if (!this.dragPart) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    this.root.addEventListener("drop", (event) => {
      if (!this.dragPart) return;
      event.preventDefault();
      const row = (event.target as HTMLElement).closest<HTMLElement>(".tree-row");
      if (row?.dataset.kind === "feature" && row.dataset.id) {
        this.handlers.action("rollback", "feature", `${this.dragPart}|${row.dataset.id}`);
      } else if ((event.target as HTMLElement).closest("[data-rollback]")) {
        this.handlers.action("rollback-clear", "part", this.dragPart);
      }
      this.dragPart = "";
    });
  }

  private dragPart = "";

  private lastClickKey = "";
  private lastClickTime = 0;

  private rowElement(key: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const twist = target.closest<HTMLElement>("[data-twist]");
    if (twist) {
      e.stopPropagation();
      this.handlers.action("twist", twist.dataset.twist ?? "");
      return;
    }
    const eye = target.closest<HTMLElement>("[data-eye]");
    if (eye) {
      e.stopPropagation();
      this.handlers.toggleVisibility(eye.dataset.kind ?? "", eye.dataset.id ?? "");
      return;
    }
    const action = target.closest<HTMLElement>("[data-tree-action]");
    if (action) {
      e.stopPropagation();
      this.handlers.action(action.dataset.treeAction ?? "", action.dataset.kind, action.dataset.id);
      return;
    }
    const row = target.closest<HTMLElement>(".tree-row");
    if (!row) return;
    const kind = row.dataset.kind ?? "";
    const id = row.dataset.id ?? "";
    // Selection re-renders the tree, so a native dblclick never lands on the
    // same element twice. Detect the second click on the same row ourselves.
    const key = `${kind}:${id}`;
    const now = performance.now();
    if (this.lastClickKey === key && now - this.lastClickTime < 420) {
      this.lastClickKey = "";
      this.lastClickTime = 0;
      this.handlers.open(kind, id);
      return;
    }
    this.lastClickKey = key;
    this.lastClickTime = now;
    this.handlers.select(kind, id, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  private onContextMenu = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row) return;
    e.preventDefault();
    this.handlers.contextMenu(row.dataset.kind ?? "", row.dataset.id ?? "", e.clientX, e.clientY);
  };

  private row(key: string, opts: RowOptions): string {
    const classes = ["tree-row"];
    if (opts.selected) classes.push("selected");
    if (opts.hidden) classes.push("hidden-item");
    if (opts.error) classes.push("error");
    if (opts.suppressed) classes.push("suppressed");
    const twisty = opts.twisty
      ? `<button class="twisty" data-twist="${escapeHtml(key)}" title="${this.t("Expand / collapse", "Genişlet / daralt")}">${icon(opts.expanded ? "chevron-down" : "chevron-right")}</button>`
      : `<span class="twisty"></span>`;
    const eye =
      opts.eye === null
        ? ""
        : `<button class="row-btn ${opts.eye === "on" ? "pinned" : ""}" data-eye data-kind="${escapeHtml(opts.kind)}" data-id="${escapeHtml(opts.id)}" title="${opts.eye === "on" ? this.t("Hide", "Gizle") : this.t("Show", "Göster")}">${icon(opts.eye === "on" ? "eye" : "eye-off")}</button>`;
    const quick = opts.quick?.length
      ? `<span class="row-quick">${opts.quick
          .map(
            (q) =>
              `<button class="row-btn quick-btn" data-tree-action="${escapeHtml(q.action)}" data-kind="${escapeHtml(opts.kind)}" data-id="${escapeHtml(opts.id)}" title="${escapeHtml(q.title)}">${icon(q.icon)}</button>`,
          )
          .join("")}</span>`
      : "";
    return `<div class="${classes.join(" ")}" data-key="${escapeHtml(key)}" data-kind="${escapeHtml(opts.kind)}" data-id="${escapeHtml(opts.id)}" style="--depth:${opts.depth}" title="${escapeHtml(opts.title ?? opts.label)}">
      ${twisty}
      ${icon(opts.iconName, `node-icon ${opts.iconClass ?? ""}`)}
      <span class="label">${opts.labelHtml ?? escapeHtml(opts.label)}</span>
      ${opts.badge ? `<span class="badge">${escapeHtml(opts.badge)}</span>` : ""}
      ${opts.sub ? `<span class="sub">${escapeHtml(opts.sub)}</span>` : ""}
      ${opts.extra ?? ""}
      ${quick}
      ${eye}
    </div>`;
  }

  private constraintRow(sketchId: string, c: { id: string; type: string; value?: number; entity?: string; a?: string; b?: string }, depth: number): string {
    const labels: Record<string, string> = {
      horizontal: "Horizontal",
      vertical: "Vertical",
      coincident: "Coincident",
      distance: "Distance",
      radius: "Radius",
      tangent: "Tangent",
      fix: "Fixed",
      equal: "Equal",
      perpendicular: "Perpendicular",
      angle: "Angle",
    };
    const iconNames: Record<string, string> = {
      horizontal: "move-horizontal",
      vertical: "move-vertical",
      coincident: "link",
      distance: "ruler",
      radius: "ruler",
      tangent: "magnet",
      fix: "lock",
      equal: "equal",
      perpendicular: "move-3d",
      angle: "ruler",
    };
    const value =
      c.value !== undefined && (c.type === "distance" || c.type === "radius")
        ? `${c.value.toFixed(1)} mm`
        : c.value !== undefined && c.type === "angle"
          ? `${c.value.toFixed(1)}°`
          : "";
    return this.row(`constraint:${sketchId}:${c.id}`, {
      kind: "constraint",
      id: `${sketchId}|${c.id}`,
      depth,
      label: `${labels[c.type] ?? c.type}${value ? ` ${value}` : ""}`,
      iconName: iconNames[c.type] ?? "link",
      iconClass: "feature",
    });
  }

  render(ctx: TreeContext): void {
    this.lang = ctx.lang ?? "en";
    const expand = (key: string, fallback = false) => ctx.expanded.has(key) || fallback;
    const { doc, mode } = ctx;
    const activePart = doc.parts.find((p) => p.id === doc.activePartId) ?? doc.parts[0];
    let html = "";
    if (mode === "part") {
      html += this.partTree(ctx, activePart, expand);
    } else if (mode === "assembly") {
      html += this.assemblyTree(ctx, expand);
    } else {
      const study = doc.analyses.find((s) => s.id === doc.activeStudyId) ?? doc.analyses[0];
      html += this.analysisTree(ctx, study, activePart, expand);
    }
    this.root.innerHTML = html;
    void activePart;
  }

  private partTree(ctx: TreeContext, part: Part | undefined, expand: (key: string, fallback?: boolean) => boolean): string {
    const { doc } = ctx;
    if (!part) return `<div class="tree-empty">No part in this document.</div>`;
    const originOpen = expand("origin", true);
    const planeRow = (kind: string, name: string, color: string) =>
      this.row(`plane:${kind}`, {
        kind: "plane",
        id: kind,
        depth: 2,
        label: name,
        iconName: "frame",
        iconClass: "feature",
        selected: ctx.selection === `plane:${kind}`,
        title: `${name} — select it, then choose Sketch`,
        extra: `<span style="width:8px;height:8px;border-radius:2px;background:${color};display:inline-block;flex:0 0 auto"></span>`,
      });
    let html = `<div class="tree-root">${icon("box")}<span>${escapeHtml(doc.name)}</span><span class="badge" style="background:#e1ecf7;color:#41698d">PART</span></div>`;
    html += this.row("part-root", {
      kind: "part",
      id: part.id,
      depth: 0,
      label: part.name,
      labelHtml: `${escapeHtml(part.name)}${part.visible ? "" : " <span style='color:#9aa6b2'>(hidden)</span>"}`,
      iconName: "box",
      selected: ctx.selection === `part:${part.id}` || ctx.selection === "part-root",
      twisty: true,
      expanded: true,
      eye: part.visible ? "on" : "off",
    });
    html += this.row("origin", {
      kind: "origin",
      id: "origin",
      depth: 1,
      label: "Origin",
      iconName: "axis-3d",
      twisty: true,
      expanded: originOpen,
    });
    if (originOpen) {
      html += planeRow("front", "Front Plane", "#7faed4");
      html += planeRow("top", "Top Plane", "#86b98e");
      html += planeRow("right", "Right Plane", "#cf9f7d");
      for (const ref of part.referencePlanes ?? []) {
        html += this.row(`refplane:${ref.id}`, {
          kind: "refplane",
          id: ref.id,
          depth: 2,
          label: ref.name,
          iconName: "frame",
          iconClass: "feature",
          selected: ctx.selection === `refplane:${ref.id}`,
          hidden: !ref.visible,
          eye: ref.visible ? "on" : "off",
          title: `${ref.name} — double-click to sketch on it`,
          extra: `<span style="width:8px;height:8px;border-radius:2px;background:#c9a25e;display:inline-block;flex:0 0 auto"></span>`,
        });
      }
      for (const axis of part.referenceAxes ?? []) {
        html += this.row(`refaxis:${axis.id}`, {
          kind: "refaxis",
          id: axis.id,
          depth: 2,
          label: axis.name,
          iconName: "axis-3d",
          iconClass: "feature",
          hidden: !axis.visible,
          eye: axis.visible ? "on" : "off",
          title: `${axis.name} — reference axis`,
        });
      }
    }

    // Material line, like SolidWorks' "Material <not specified>" row.
    const material = part.materialId ? materialById(part.materialId) : undefined;
    html += `<div class="tree-material">
      <button class="material-button" data-tree-action="edit-material" data-kind="part" data-id="${escapeHtml(part.id)}" title="${this.t("Assign or edit the part material", "Parça malzemesini ata veya düzenle")}">
        <span class="swatch" style="background:${material?.color ?? "#c9d3dc"}"></span>
        ${
          material
            ? `<span>${escapeHtml(material.name)}</span>`
            : `<span class="unset">${this.t("Material &lt;not specified&gt;", "Malzeme &lt;belirtilmemiş&gt;")}</span>`
        }
        <span class="edit">${material ? this.t("Edit Material", "Malzemeyi Düzenle") : this.t("Assign", "Ata")}</span>
      </button>
    </div>`;

    if (doc.parts.length > 1) {
      const open = expand("parts", true);
      html += this.row("parts-folder", {
        kind: "folder",
        id: "parts",
        depth: 1,
        label: `Parts (${doc.parts.length})`,
        iconName: "layers-3",
        twisty: true,
        expanded: open,
      });
      if (open) {
        for (const p of doc.parts) {
          html += this.row(`part:${p.id}`, {
            kind: "part",
            id: p.id,
            depth: 2,
            label: p.name,
            iconName: "box",
            selected: p.id === doc.activePartId,
            eye: p.visible ? "on" : "off",
          });
        }
      }
    }

    if (part.sketches.length === 0 && part.features.length === 0) {
      html += `<div class="tree-empty">
        <strong>Start modelling</strong><br />
        Select a plane or a planar face, then click <b>New Sketch</b>.
        <div class="tree-actions" style="padding:8px 0 0">
          <button class="tree-action" data-tree-action="new-sketch">${icon("drafting-compass")} New Sketch</button>
          <button class="tree-action" data-tree-action="sample">${icon("sparkles")} Sample</button>
        </div>
      </div>`;
    }

    // Sketches consumed by a feature nest under that feature (SolidWorks style);
    // only sketches no feature uses stay at the top level.
    const consumed = new Set<string>();
    for (const f of part.features) for (const s of this.featureSketches(part, f)) consumed.add(s.id);

    for (const sketch of part.sketches) {
      if (consumed.has(sketch.id)) continue;
      html += this.sketchRows(ctx, sketch, 1);
    }

    for (const f of part.features) {
      if (f.type === "imported") continue;
      const key = `feature:${f.id}`;
      const iconName =
        f.type === "extrude"
          ? "square"
          : f.type === "cut"
            ? "circle-off"
            : f.type === "revolve"
              ? "rotate-3d"
              : f.type === "fillet"
                ? "circle"
                : f.type === "chamfer"
                  ? "triangle"
                  : f.type === "shell"
                    ? "box"
                    : f.type === "mirror"
                      ? "arrow-right-left"
                      : f.type === "pattern"
                        ? "layout-grid"
                        : f.type === "sweep"
                          ? "waypoints"
                          : f.type === "loft"
                            ? "layers-3"
                            : f.type === "circularPattern"
                              ? "refresh-cw"
                              : f.type === "hole"
                                ? "circle-dot"
                                : f.type === "draft"
                                  ? "triangle"
                                  : f.type === "rib"
                                    ? "layout-grid"
                                    : f.type === "helix"
                                      ? "rotate-3d"
                                      : "box";
      const params =
        f.type === "extrude" || f.type === "cut"
          ? `${f.params.depth ?? 0} mm`
          : f.type === "revolve"
            ? `${f.params.angle ?? 360}°`
            : f.type === "fillet"
              ? `R${f.params.radius ?? 0}`
              : f.type === "chamfer"
                ? `${f.params.distance ?? 0} mm`
                : f.type === "shell"
                  ? `t ${f.params.thickness ?? 0} mm`
                  : f.type === "mirror"
                    ? `${f.params.mirrorPlane ?? "right"} plane`
                    : f.type === "pattern"
                      ? `${f.params.patternCount ?? 2} × ${f.params.patternSpacing ?? 10} mm`
                      : f.type === "sweep"
                        ? "profile + path"
                        : f.type === "loft"
                          ? `${f.params.profileSketchIds?.length ?? 2} sections`
                          : f.type === "circularPattern"
                            ? `${f.params.circularCount ?? 4} × ${f.params.circularAngle ?? 360}°`
                            : f.type === "hole"
                              ? `Ø${f.params.holeDiameter ?? 6} ${f.params.holeType ?? "simple"}`
                              : f.type === "draft"
                                ? `${f.params.draftAngle ?? 3}°`
                                : f.type === "rib"
                                  ? `${f.params.ribThickness ?? 3} mm rib`
                                  : f.type === "helix"
                                    ? `Ø${f.params.helixDiameter ?? 20} · P${f.params.helixPitch ?? 5} · ${f.params.helixTurns ?? 4} turns`
                                    : "";
      const rolledBack = part.rollbackIndex !== undefined && part.features.indexOf(f) >= part.rollbackIndex;
      const children = this.featureSketches(part, f);
      const open = children.length > 0 && expand(key);
      html += this.row(key, {
        kind: "feature",
        id: f.id,
        depth: 1,
        label: f.name,
        iconName,
        iconClass: "feature",
        selected: ctx.selection === key,
        suppressed: f.suppressed || rolledBack,
        error: !!f.error,
        badge: f.error ? "!" : undefined,
        sub: params,
        twisty: children.length > 0,
        expanded: open,
        eye: null,
        title: f.error ? `${f.name}: ${f.error}` : `${f.name} — ${this.t("double-click to edit", "düzenlemek için çift tıkla")}`,
        quick: [
          { action: "feature-edit", icon: "pencil", title: this.t("Edit Feature", "Özelliği Düzenle") },
          ...(children.length ? [{ action: "feature-edit-sketch", icon: "drafting-compass", title: this.t("Edit Sketch", "Eskizi Düzenle") }] : []),
          {
            action: "feature-suppress",
            icon: f.suppressed ? "circle" : "circle-off",
            title: f.suppressed ? this.t("Unsuppress", "Bastırmayı Kaldır") : this.t("Suppress", "Bastır"),
          },
          { action: "feature-hide", icon: part.visible ? "eye" : "eye-off", title: part.visible ? this.t("Hide body", "Gövdeyi gizle") : this.t("Show body", "Gövdeyi göster") },
        ],
      });
      if (f.error && ctx.expanded.has(`error:${f.id}`)) {
        html += `<div class="tree-note" style="color:#c0392b;padding-left:32px">${escapeHtml(f.error)}</div>`;
      }
      if (open) {
        for (const child of children) html += this.sketchRows(ctx, child, 2, f);
      }
      if (part.rollbackIndex !== undefined && part.features.indexOf(f) === part.rollbackIndex - 1) {
        html += `<div class="rollback-bar active" draggable="true" data-rollback data-part="${escapeHtml(part.id)}" title="Drag the rollback bar to rebuild up to a feature">
          <span class="drag-icon">${icon("more-horizontal")}</span> Rollback
        </div>`;
      }
    }
    if (part.rollbackIndex === 0 && part.features.length > 0) {
      html += `<div class="rollback-bar active" draggable="true" data-rollback data-part="${escapeHtml(part.id)}" title="Drag the rollback bar to rebuild up to a feature">
        <span class="drag-icon">${icon("more-horizontal")}</span> Rollback
      </div>`;
    }
    if (part.rollbackIndex === undefined && part.features.length > 0) {
      html += `<div class="rollback-bar" draggable="true" data-rollback data-part="${escapeHtml(part.id)}" title="Drag the rollback bar up to rebuild only part of the tree">
        <span class="drag-icon">${icon("more-horizontal")}</span> Rollback
      </div>`;
    }

    if (part.asset) {
      html += this.row(`imported:${part.id}`, {
        kind: "imported",
        id: part.id,
        depth: 1,
        label: `Imported ${part.asset.format.toUpperCase()} body`,
        iconName: "file-box",
        sub: `${(part.asset.size / 1024).toFixed(0)} KB`,
      });
    }

    const activeFeatures = part.features.filter((f) => !f.suppressed && f.type !== "imported").length;
    html += `<div class="tree-note">${icon("info")} &nbsp;${
      this.lang === "tr"
        ? `${activeFeatures} özellik · ${part.sketches.length} eskiz`
        : `${activeFeatures} feature(s) · ${part.sketches.length} sketch(es)`
    }</div>`;
    html += this.configurationsBlock(ctx, part, expand);
    if (part.asset && part.asset.format !== "step" && part.asset.format !== "iges") {
      html += `<div class="tree-note">Mesh-only imported body — boolean features are unavailable.</div>`;
    }
    return html;
  }

  /** Sketches a feature consumes: its profile, loft sections and sweep path. */
  private featureSketches(part: Part, feature: Feature): Sketch[] {
    const ids: string[] = [];
    if (feature.sketchId) ids.push(feature.sketchId);
    for (const id of feature.params?.profileSketchIds ?? []) ids.push(id);
    if (feature.params?.pathSketchId) ids.push(feature.params.pathSketchId);
    const seen = new Set<string>();
    const sketches: Sketch[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const sketch = part.sketches.find((s) => s.id === id);
      if (sketch) sketches.push(sketch);
    }
    return sketches;
  }

  /** A sketch row (and its dimensions/relations), optionally nested in a feature. */
  private sketchRows(ctx: TreeContext, sketch: Sketch, depth: number, parent?: Feature): string {
    const info = ctx.sketchInfo[sketch.id];
    const key = `sketch:${sketch.id}`;
    const open = ctx.expanded.has(key);
    const warnings = info?.warnings?.length ?? 0;
    let html = this.row(key, {
      kind: "sketch",
      id: sketch.id,
      depth,
      label: sketch.name,
      iconName: "drafting-compass",
      iconClass: "sketch",
      selected: ctx.selection === key,
      hidden: !sketch.visible,
      twisty: true,
      expanded: open,
      eye: sketch.visible ? "on" : "off",
      badge: warnings && !info?.closed ? "OPEN" : undefined,
      error: !!warnings && !info?.closed,
      sub: info?.closed ? `${info.area.toFixed(0)} mm²` : undefined,
      title: `${sketch.name} — ${info?.closed ? this.t("closed profile", "kapalı profil") : this.t("open profile", "açık profil")}`,
      quick: [
        { action: "sketch-edit", icon: "pencil", title: this.t("Edit Sketch", "Eskizi Düzenle") },
        ...(parent ? [{ action: "feature-edit", icon: "square", title: this.t("Edit Feature", "Özelliği Düzenle") }] : []),
        { action: "sketch-hide", icon: sketch.visible ? "eye" : "eye-off", title: sketch.visible ? this.t("Hide", "Gizle") : this.t("Show", "Göster") },
      ],
    });
    if (open) {
      const constraints = sketch.constraints.slice(0, 40);
      if (constraints.length === 0) {
        html += `<div class="tree-note" style="padding-left:${28 + depth * 15}px">${this.t("No dimensions or relations.", "Ölçü veya ilişki yok.")}</div>`;
      } else {
        for (const c of constraints) html += this.constraintRow(sketch.id, c, depth + 1);
      }
    }
    return html;
  }

  /** Configurations section shown under every part tree. */
  private configurationsBlock(ctx: TreeContext, part: Part, expand: (key: string, fallback?: boolean) => boolean): string {
    const open = expand("configurations", true);
    const configs = part.configurations ?? [];
    let html = `<div class="tree-section-head" data-tree-action="configurations">
      ${icon("layers-3")}<span>${this.t("Configurations", "Yapılandırmalar")}</span>
      <button class="tree-section-add" data-tree-action="configuration-add" title="${this.t("Add configuration", "Yapılandırma ekle")}">${icon("plus")}</button>
    </div>`;
    if (!open) return html;
    if (configs.length === 0) {
      html += `<div class="tree-note">${this.t("No configurations yet. Click + to create one.", "Henüz yapılandırma yok. Oluşturmak için +'ya tıklayın.")}</div>`;
      return html;
    }
    for (const config of configs) {
      html += this.row(`configuration:${config.id}`, {
        kind: "configuration",
        id: config.id,
        depth: 1,
        label: config.name,
        iconName: config.id === part.activeConfigurationId ? "check-circle-2" : "circle",
        selected: ctx.selection === `configuration:${config.id}`,
        title: `${config.name} — double-click to activate`,
        sub: `${Object.keys(config.variables).length ? `${Object.keys(config.variables).length} var` : ""}${config.suppressed.length ? ` · ${config.suppressed.length} sup` : ""}`,
        eye: null,
      });
    }
    return html;
  }

  private assemblyTree(ctx: TreeContext, expand: (key: string, fallback?: boolean) => boolean): string {
    const { doc } = ctx;
    let html = `<div class="tree-root">${icon("boxes")}<span>${escapeHtml(doc.name)}</span><span class="badge" style="background:#e9e3f3;color:#6d5597">ASSEMBLY</span></div>`;
    const compOpen = expand("components", true);
    html += this.row("components-folder", {
      kind: "folder",
      id: "components",
      depth: 0,
      label: `Components (${doc.components.length})`,
      iconName: "component",
      twisty: true,
      expanded: compOpen,
    });
    if (doc.components.length === 0) {
      html += `<div class="tree-empty">No components yet.<br /><button class="tree-action" style="margin-top:7px;width:100%" data-tree-action="insert-component">${icon("plus")} Insert Component</button></div>`;
    } else if (compOpen) {
      for (const c of doc.components) {
        const part = doc.parts.find((p) => p.id === c.partId);
        const key = `component:${c.id}`;
        html += this.row(key, {
          kind: "component",
          id: c.id,
          depth: 1,
          label: c.name,
          iconName: "component",
          selected: ctx.selection === key,
          eye: c.visible ? "on" : "off",
          sub: part?.name,
          title: `${c.name} — double-click for transform`,
          extra: c.fixed ? `<span title="Fixed">${icon("lock")}</span>` : "",
        });
      }
    }
    html += this.row("mates-folder", {
      kind: "folder",
      id: "mates",
      depth: 0,
      label: `Mates (${doc.mates.length})`,
      iconName: "link",
      twisty: true,
      expanded: expand("mates", true),
    });
    if (expand("mates", true)) {
      if (doc.mates.length === 0) {
        html += `<div class="tree-note" style="padding-left:16px">Select two faces in the viewport and choose a mate type.</div>`;
      }
      for (const m of doc.mates) {
        const key = `mate:${m.id}`;
        html += this.row(key, {
          kind: "mate",
          id: m.id,
          depth: 1,
          label: m.name,
          iconName: m.type === "concentric" ? "target" : m.type === "distance" ? "ruler" : "link",
          iconClass: "feature",
          selected: ctx.selection === key,
          error: !!m.error,
          badge: m.type.charAt(0).toUpperCase() + m.type.slice(1),
          title: m.error ? `${m.name}: ${m.error}` : `${m.name} — ${m.type} mate, double-click to edit`,
        });
      }
    }
    html += `<div class="tree-actions">
      <button class="tree-action" data-tree-action="insert-component">${icon("plus")} Insert</button>
      <button class="tree-action" data-tree-action="mate">${icon("link")} Mate</button>
      <button class="tree-action" data-tree-action="resolve-mates">${icon("refresh-cw")} Resolve</button>
    </div>`;
    return html;
  }

  private analysisTree(
    ctx: TreeContext,
    study: AnalysisStudy | undefined,
    part: Part | undefined,
    expand: (key: string, fallback?: boolean) => boolean,
  ): string {
    const { doc } = ctx;
    let html = `<div class="tree-root">${icon("activity")}<span>${escapeHtml(doc.name)}</span><span class="badge" style="background:#e4f0e8;color:#3e7a58">FEA</span></div>`;
    if (!study) {
      html += `<div class="tree-empty">
        No analysis study yet.<br />
        <button class="tree-action" style="margin-top:8px;width:100%" data-tree-action="new-study">${icon("plus")} New Static Study</button>
      </div>`;
      return html;
    }
    const material = part ? partMaterial(part) : materialById(study.materialId);
    const statusLabel =
      study.status === "solved" ? "Solved" : study.status === "meshed" ? "Meshed" : study.status === "failed" ? "Failed" : "Setup";
    html += this.row(`study:${study.id}`, {
      kind: "study",
      id: study.id,
      depth: 0,
      label: study.name,
      iconName: "activity",
      selected: ctx.selection === `study:${study.id}`,
      badge: statusLabel.toUpperCase(),
      twisty: true,
      expanded: true,
      eye: null,
    });
    // Ansys-style state ribbon: geometry, material, mesh, loads, results.
    const hasMesh = !!study.meshStats;
    const hasLoads = study.supports.length > 0 && study.loads.length > 0;
    const stale = !!study.stale;
    const solved = study.status === "solved" && !stale;
    const pill = (label: string, state: "ok" | "input" | "solve" | "stale", text: string) =>
      `<div class="status-pill ${state}"><span class="dot"></span><span class="label">${label}</span><span class="state">${text}</span></div>`;
    html += `<div class="analysis-status-grid">
      ${pill("Geometry", part && part.features.length > 0 ? "ok" : "input", part && part.features.length > 0 ? "Current" : "Input required")}
      ${pill("Material", part?.materialId ? "ok" : "input", part?.materialId ? "Current" : "Input required")}
      ${pill("Mesh", hasMesh ? (stale ? "stale" : "ok") : "input", hasMesh ? (stale ? "Stale" : "Current") : "Input required")}
      ${pill("Loads", hasLoads ? "ok" : "input", hasLoads ? "Current" : "Input required")}
      ${pill("Results", solved ? "ok" : stale ? "stale" : study.status === "failed" ? "solve" : "solve", solved ? "Current" : stale ? "Stale · re-solve" : "Solve required")}
    </div>
    <div class="analysis-units">MMGS / NMM · mm, N, MPa</div>`;
    html += this.row(`study-geometry:${study.id}`, {
      kind: "study-geometry",
      id: study.id,
      depth: 1,
      label: `Geometry — ${part?.name ?? "part"}`,
      iconName: "box",
      eye: null,
    });
    html += this.row(`study-material:${study.id}`, {
      kind: "study-material",
      id: study.id,
      depth: 1,
      label: `Materials — ${material.name}`,
      iconName: "layers",
      sub: `E=${(material.E / 1000).toFixed(0)} GPa`,
      eye: null,
    });
    const meshStats = study.meshStats ? `${study.meshStats.nodes} nodes · ${study.meshStats.elements} elems` : "not generated";
    html += this.row(`study-mesh:${study.id}`, {
      kind: "study-mesh",
      id: study.id,
      depth: 1,
      label: `Mesh — ${study.meshSize.toFixed(1)} mm`,
      iconName: "grid-3x3",
      sub: meshStats,
      eye: null,
    });
    html += this.row(`study-loads:${study.id}`, {
      kind: "folder",
      id: "study-loads",
      depth: 1,
      label: "Static Structural",
      iconName: "workflow",
      twisty: true,
      expanded: expand(`loads:${study.id}`, true),
      eye: null,
    });
    if (expand(`loads:${study.id}`, true)) {
      if (study.supports.length === 0 && study.loads.length === 0) {
        html += `<div class="tree-note" style="padding-left:32px">No boundary conditions.</div>`;
      }
      for (const s of study.supports) {
        html += this.row(`support:${s.id}`, {
          kind: "support",
          id: s.id,
          depth: 2,
          label: "Fixed Support",
          iconName: "anchor",
          selected: ctx.selection === `support:${s.id}`,
          sub: `face ${s.faceIndex + 1}`,
          eye: null,
        });
      }
      for (const l of study.loads) {
        html += this.row(`load:${l.id}`, {
          kind: "load",
          id: l.id,
          depth: 2,
          label: l.type === "pressure" ? `Pressure ${l.magnitude} MPa` : (l.label || "Force"),
          iconName: l.type === "pressure" ? "gauge" : "arrow-down-to-line",
          selected: ctx.selection === `load:${l.id}`,
          sub: `face ${l.faceIndex + 1}`,
          eye: null,
        });
      }
    }
    html += this.row(`study-solution:${study.id}`, {
      kind: "folder",
      id: "study-solution",
      depth: 1,
      label: "Solution",
      iconName: "scan",
      twisty: true,
      expanded: expand(`solution:${study.id}`, true),
      eye: null,
    });
    if (expand(`solution:${study.id}`, true)) {
      const resultRow = (kind: string, label: string, iconName: string) =>
        this.row(`result:${kind}`, {
          kind: "result",
          id: kind,
          depth: 2,
          label,
          iconName,
          selected: ctx.activeResult === kind,
          hidden: study.status !== "solved",
          eye: null,
        });
      html += resultRow("deformation", "Total Deformation", "activity");
      html += resultRow("stress", "Equivalent (von Mises) Stress", "flame");
      html += resultRow("safety", "Safety Factor", "gauge");
    }
    html += `<div class="tree-actions">
      <button class="tree-action" data-tree-action="mesh">${icon("grid-3x3")} Mesh</button>
      <button class="tree-action" data-tree-action="solve">${icon("play")} Solve</button>
    </div>`;
    return html;
  }
}

export function materialOptions(selected: string): string {
  return MATERIALS.map(
    (m) =>
      `<option value="${m.id}" ${m.id === selected ? "selected" : ""}>${escapeHtml(m.name)} — E ${m.E >= 1000 ? (m.E / 1000).toFixed(0) + " GPa" : m.E + " MPa"}</option>`,
  ).join("");
}
