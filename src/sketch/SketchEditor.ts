import * as THREE from "three";
import type { Sketch, SketchConstraint, SketchPlane, Vec2, Vec3 } from "../model/types";
import { dimensionLabel, planePoint, sampleArc, sampleCircle } from "./geometry";
import { solveSketch } from "./solver";
import { uid } from "../model/defaults";
import type { Viewport } from "../viewport/Viewport";

export type SketchTool = "select" | "line" | "rectangle" | "circle" | "arc" | "dimension";

export interface SketchEditorCallbacks {
  onChange: (sketch: Sketch, committed: boolean) => void;
  onToolChange: (tool: SketchTool) => void;
  onCursor: (p: Vec2 | null) => void;
  onSelection: (points: number, entities: number) => void;
  onRequestDimensionEdit: (constraintId: string) => void;
  notify: (message: string, kind?: "info" | "warn" | "error") => void;
}

interface SnapResult {
  x: number;
  y: number;
  pointId?: string;
}

const BLUE = 0x1565c0;
const PREVIEW = 0x4a90d9;
const SELECT = 0xff9f1c;
const HOVER = 0x2fa4e7;

export class SketchEditor {
  private viewport: Viewport;
  private callbacks: SketchEditorCallbacks;
  sketch: Sketch | null = null;
  tool: SketchTool = "select";
  snapStep = 1;

  private group = new THREE.Group();
  private previewGroup = new THREE.Group();
  private leaderGroup = new THREE.Group();
  private labelLayer: HTMLDivElement;
  private labels = new Map<string, HTMLDivElement>();
  private selectedPoints = new Set<string>();
  private selectedEntities = new Set<string>();
  private hoverPoint: string | null = null;
  private hoverEntity: string | null = null;
  private drag: { pointId: string; moved: boolean } | null = null;
  private pending: { stage: number; points: Vec2[] } = { stage: 0, points: [] };
  private cursor: Vec2 | null = null;
  private enabled = false;

  constructor(viewport: Viewport, callbacks: SketchEditorCallbacks) {
    this.viewport = viewport;
    this.callbacks = callbacks;
    this.group.name = "sketch-overlay";
    this.previewGroup.name = "sketch-preview";
    this.leaderGroup.name = "sketch-leaders";
    this.group.add(this.previewGroup);
    this.group.add(this.leaderGroup);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "sketch-labels";
    viewport.container.appendChild(this.labelLayer);
    this.labelLayer.addEventListener("dblclick", (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>("[data-dimension]");
      if (target?.dataset.dimension) {
        e.stopPropagation();
        this.callbacks.onRequestDimensionEdit(target.dataset.dimension);
      }
    });
    viewport.container.addEventListener("pointerdown", this.onPointerDown, true);
    viewport.container.addEventListener("pointermove", this.onPointerMove, true);
    viewport.container.addEventListener("pointerup", this.onPointerUp, true);
    this.viewport.onFrame = () => this.updateLabelPositions();
  }

  get isActive(): boolean {
    return this.enabled;
  }

  begin(sketch: Sketch): void {
    this.sketch = sketch;
    this.enabled = true;
    this.selectedPoints.clear();
    this.selectedEntities.clear();
    this.pending = { stage: 0, points: [] };
    this.hoverPoint = null;
    this.hoverEntity = null;
    this.tool = "select";
    this.viewport.scene.add(this.group);
    this.viewport.setSketchMode(sketch.plane);
    this.labelLayer.classList.add("visible");
    this.render();
    this.emitSelection();
    this.viewport.zoomFit(true);
    this.callbacks.onToolChange(this.tool);
  }

  end(): void {
    this.enabled = false;
    this.sketch = null;
    this.drag = null;
    this.viewport.scene.remove(this.group);
    this.viewport.setSketchMode(null);
    this.labelLayer.classList.remove("visible");
    this.labelLayer.innerHTML = "";
    this.labels.clear();
    this.clearGroup(this.group);
    this.group.add(this.previewGroup);
    this.callbacks.onCursor(null);
  }

  setTool(tool: SketchTool): void {
    if (!this.sketch) return;
    this.tool = tool;
    this.pending = { stage: 0, points: [] };
    this.hoverPoint = null;
    this.stripPreview();
    this.render();
    this.callbacks.onToolChange(tool);
  }

  setSnapStep(step: number): void {
    this.snapStep = Math.max(0.1, step);
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child !== this.previewGroup) {
        if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
          child.geometry.dispose();
          const mat = child.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
        if (child instanceof THREE.Group) this.clearGroup(child);
      }
    }
  }

  private stripPreview(): void {
    for (const child of [...this.previewGroup.children]) {
      this.previewGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Points) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  // ---------------------------------------------------------------- geometry

  private world(p: Vec2): Vec3 {
    return planePoint(this.sketch!.plane, p);
  }

  private addLine(pts: Vec2[], color: number, dashed = false, opacity = 1, parent: THREE.Group = this.group, width = 1): void {
    if (pts.length < 2) return;
    const arr: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = this.world(pts[i]);
      const b = this.world(pts[i + 1]);
      arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: opacity < 1 || dashed,
      opacity,
      depthTest: false,
      linewidth: width,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 30;
    parent.add(line);
    if (dashed) {
      // No line distances for LineSegments dashed material; emulate with reduced opacity.
      mat.opacity = 0.45;
    }
  }

  private addPolyline(pts: Vec2[], color: number, parent: THREE.Group = this.group, depthTest = false): void {
    if (pts.length < 2) return;
    const verts = pts.map((p) => {
      const w = this.world(p);
      return new THREE.Vector3(w[0], w[1], w[2]);
    });
    const geo = new THREE.BufferGeometry().setFromPoints(verts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest, transparent: depthTest }));
    line.renderOrder = 31;
    parent.add(line);
  }

  private addPoints(points: { p: Vec2; id?: string; selected?: boolean; fixed?: boolean }[]): void {
    if (points.length === 0) return;
    const arr: number[] = [];
    for (const p of points) {
      const w = this.world(p.p);
      arr.push(w[0], w[1], w[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({
      color: BLUE,
      size: 7,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 32;
    this.group.add(pts);
    const selected = points.filter((p) => p.selected);
    if (selected.length) {
      const sarr: number[] = [];
      for (const p of selected) {
        const w = this.world(p.p);
        sarr.push(w[0], w[1], w[2]);
      }
      const sgeo = new THREE.BufferGeometry();
      sgeo.setAttribute("position", new THREE.Float32BufferAttribute(sarr, 3));
      const smat = new THREE.PointsMaterial({
        color: SELECT,
        size: 11,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
      });
      const sp = new THREE.Points(sgeo, smat);
      sp.renderOrder = 33;
      this.group.add(sp);
    }
    const fixedPts = points.filter((p) => p.fixed);
    if (fixedPts.length) {
      const farr: number[] = [];
      for (const p of fixedPts) {
        const w = this.world(p.p);
        farr.push(w[0], w[1], w[2]);
      }
      const fgeo = new THREE.BufferGeometry();
      fgeo.setAttribute("position", new THREE.Float32BufferAttribute(farr, 3));
      const fmat = new THREE.PointsMaterial({
        color: 0x20262c,
        size: 11,
        sizeAttenuation: false,
        depthTest: false,
      });
      const fp = new THREE.Points(fgeo, fmat);
      fp.renderOrder = 33;
      this.group.add(fp);
    }
  }

  private entityPoints2D(): { id: string; p: Vec2; fixed?: boolean }[] {
    if (!this.sketch) return [];
    return this.sketch.points.map((p) => ({ id: p.id, p: { x: p.x, y: p.y }, fixed: p.fixed }));
  }

  private entitySample(id: string): Vec2[] | null {
    const s = this.sketch;
    if (!s) return null;
    const e = s.entities.find((x) => x.id === id);
    if (!e) return null;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    if (e.kind === "line") {
      const a = pm.get(e.p1);
      const b = pm.get(e.p2);
      return a && b ? [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] : null;
    }
    if (e.kind === "circle") {
      const c = pm.get(e.center);
      return c ? sampleCircle({ x: c.x, y: c.y }, Math.max(0.01, e.radius)) : null;
    }
    const c = pm.get(e.center);
    const a = pm.get(e.start);
    const b = pm.get(e.end);
    return c && a && b ? sampleArc({ x: c.x, y: c.y }, { x: a.x, y: a.y }, { x: b.x, y: b.y }, e.ccw) : null;
  }

  private render(): void {
    if (!this.sketch) return;
    const keep = new Set<THREE.Object3D>([this.previewGroup, this.leaderGroup]);
    for (const child of [...this.group.children]) {
      if (keep.has(child)) continue;
      this.group.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const m = child.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    }
    this.labels.forEach((el) => el.remove());
    this.labels.clear();
    for (const child of [...this.leaderGroup.children]) {
      this.leaderGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }

    const pm = new Map(this.sketch.points.map((p) => [p.id, p]));
    for (const e of this.sketch.entities) {
      const pts = this.entitySample(e.id);
      if (!pts) continue;
      const selected = this.selectedEntities.has(e.id);
      const hovered = this.hoverEntity === e.id;
      this.addPolyline(pts, selected ? SELECT : hovered ? HOVER : e.construction ? 0x8a97a3 : BLUE);
    }

    this.addPoints(
      this.entityPoints2D().map((p) => ({
        p: p.p,
        id: p.id,
        selected: this.selectedPoints.has(p.id),
        fixed: p.fixed || p.id === this.hoverPoint,
      })),
    );

    // Dimension leaders and labels.
    for (const c of this.sketch.constraints) {
      if (c.type !== "distance" && c.type !== "radius") continue;
      const label = dimensionLabel(this.sketch, c.id);
      if (!label) continue;
      const el = document.createElement("div");
      el.className = "sketch-dimension" + (this.selectedEntities.has(c.entity ?? "") ? " selected" : "");
      el.dataset.dimension = c.id;
      el.textContent = label.text;
      el.title = "Double-click to edit";
      this.labelLayer.appendChild(el);
      this.labels.set(c.id, el);
      this.drawDimensionLeader(c.id);
    }
    void pm;
    this.renderPreview();
    this.updateLabelPositions();
    this.emitSelection();
  }

  private drawDimensionLeader(id: string): void {
    if (!this.sketch) return;
    const c = this.sketch.constraints.find((x) => x.id === id);
    if (!c) return;
    const pm = new Map(this.sketch.points.map((p) => [p.id, p]));
    const offset = c.labelOffset?.x ?? 9;
    if (c.type === "distance") {
      let a: Vec2 | null = null;
      let b: Vec2 | null = null;
      if (c.entity) {
        const e = this.sketch.entities.find((x) => x.id === c.entity);
        if (e?.kind === "line") {
          const pa = pm.get(e.p1);
          const pb = pm.get(e.p2);
          if (pa && pb) {
            a = { x: pa.x, y: pa.y };
            b = { x: pb.x, y: pb.y };
          }
        }
      } else if (c.a && c.b) {
        const pa = pm.get(c.a);
        const pb = pm.get(c.b);
        if (pa && pb) {
          a = { x: pa.x, y: pa.y };
          b = { x: pb.x, y: pb.y };
        }
      }
      if (a && b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const oa = { x: a.x + nx * offset, y: a.y + ny * offset };
        const ob = { x: b.x + nx * offset, y: b.y + ny * offset };
        this.addLine([a, oa], 0x6a83a0, false, 0.5, this.leaderGroup);
        this.addLine([b, ob], 0x6a83a0, false, 0.5, this.leaderGroup);
        this.addLine([oa, ob], 0x5b7391, false, 0.8, this.leaderGroup);
      }
    } else if (c.type === "radius" && c.entity) {
      const e = this.sketch.entities.find((x) => x.id === c.entity);
      if (e && e.kind !== "line") {
        const ctr = pm.get(e.center);
        const r = e.kind === "circle" ? e.radius : Math.hypot((pm.get(e.start)?.x ?? 0) - (ctr?.x ?? 0), (pm.get(e.start)?.y ?? 0) - (ctr?.y ?? 0));
        if (ctr) {
          const ang = Math.PI / 4;
          this.addLine(
            [{ x: ctr.x, y: ctr.y }, { x: ctr.x + Math.cos(ang) * r, y: ctr.y + Math.sin(ang) * r }],
            0x5b7391,
            false,
            0.7,
            this.leaderGroup,
          );
        }
      }
    }
  }

  private updateLabelPositions(): void {
    if (!this.enabled || !this.sketch) return;
    for (const [id, el] of this.labels) {
      const label = dimensionLabel(this.sketch, id);
      if (!label) continue;
      const c = this.sketch.constraints.find((x) => x.id === id);
      const offset = c?.labelOffset?.x ?? 9;
      let anchor = { x: label.x, y: label.y };
      if (label.kind === "length" || label.kind === "distance") {
        // dimensionLabel returns the midpoint; offset it perpendicular to the entity.
        let nx = 0;
        let ny = 1;
        if (c?.entity) {
          const e = this.sketch.entities.find((x) => x.id === c.entity);
          if (e?.kind === "line") {
            const a = this.sketch.points.find((p) => p.id === e.p1);
            const b = this.sketch.points.find((p) => p.id === e.p2);
            if (a && b) {
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const l = Math.hypot(dx, dy) || 1;
              nx = -dy / l;
              ny = dx / l;
            }
          }
        }
        anchor = { x: anchor.x + nx * offset, y: anchor.y + ny * offset };
      }
      if (label.kind === "radius") anchor = { x: anchor.x, y: anchor.y + offset * 0.35 };
      const w = this.world(anchor);
      const scr = this.viewport.projectToScreen(w);
      el.style.transform = `translate(-50%, -50%) translate(${scr.x}px, ${scr.y}px)`;
      el.style.display = scr.visible ? "" : "none";
    }
  }

  private renderPreview(): void {
    this.stripPreview();
    if (this.tool === "select" || !this.sketch || !this.cursor) return;
    const p = this.cursor;
    if (this.tool === "line" && this.pending.stage === 1) {
      const start = this.pending.points[0];
      this.addLine([start, p], PREVIEW, true, 0.9, this.previewGroup);
    } else if (this.tool === "rectangle" && this.pending.stage === 1) {
      const a = this.pending.points[0];
      this.addLine(
        [
          { x: a.x, y: a.y },
          { x: p.x, y: a.y },
          { x: p.x, y: p.y },
          { x: a.x, y: p.y },
          { x: a.x, y: a.y },
        ],
        PREVIEW,
        true,
        0.9,
        this.previewGroup,
      );
    } else if (this.tool === "circle" && this.pending.stage === 1) {
      const c = this.pending.points[0];
      this.addLine(sampleCircle(c, Math.hypot(p.x - c.x, p.y - c.y)), PREVIEW, true, 0.9, this.previewGroup);
    } else if (this.tool === "arc") {
      if (this.pending.stage === 1) {
        this.addLine([this.pending.points[0], p], PREVIEW, true, 0.8, this.previewGroup);
      } else if (this.pending.stage === 2) {
        const [a, b] = this.pending.points;
        const circle = circumcircle(a, b, p);
        if (circle) {
          const ccw = isCcw(a, p, b);
          this.addLine(sampleArc(circle.center, a, b, ccw), PREVIEW, true, 0.9, this.previewGroup);
        } else {
          this.addLine([a, b], PREVIEW, true, 0.6, this.previewGroup);
        }
      }
    }
  }

  // --------------------------------------------------------------- interaction

  private eventPoint(e: PointerEvent): Vec2 | null {
    if (!this.sketch) return null;
    const p = this.viewport.screenToPlane(e.clientX, e.clientY, this.sketch.plane);
    return p ? { x: p[0], y: p[1] } : null;
  }

  private snap(p: Vec2, exclude?: string): SnapResult {
    if (!this.sketch) return { ...p };
    const tol = this.viewport.worldPerPixel() * 9;
    let best: { id: string; d: number; x: number; y: number } | null = null;
    for (const q of this.sketch.points) {
      if (q.id === exclude) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < tol && (!best || d < best.d)) best = { id: q.id, d, x: q.x, y: q.y };
    }
    if (best) return { x: best.x, y: best.y, pointId: best.id };
    const step = this.snapStep;
    return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
  }

  private ensurePoint(p: Vec2, existingId?: string): string {
    if (!this.sketch) throw new Error("No sketch");
    if (existingId) return existingId;
    const id = uid("pt");
    this.sketch.points.push({ id, x: p.x, y: p.y });
    return id;
  }

  private hitPoint(p: Vec2, exclude?: string): string | null {
    if (!this.sketch) return null;
    const tol = this.viewport.worldPerPixel() * 10;
    let best: { id: string; d: number } | null = null;
    for (const q of this.sketch.points) {
      if (q.id === exclude) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < tol && (!best || d < best.d)) best = { id: q.id, d };
    }
    return best?.id ?? null;
  }

  private hitEntity(p: Vec2): string | null {
    if (!this.sketch) return null;
    const tol = this.viewport.worldPerPixel() * 8;
    let best: { id: string; d: number } | null = null;
    for (const e of this.sketch.entities) {
      const d = this.distanceToEntity(e.id, p);
      if (d < tol && (!best || d < best.d)) best = { id: e.id, d };
    }
    return best?.id ?? null;
  }

  private distanceToEntity(id: string, p: Vec2): number {
    const s = this.sketch;
    if (!s) return Infinity;
    const e = s.entities.find((x) => x.id === id);
    if (!e) return Infinity;
    const pm = new Map(s.points.map((q) => [q.id, q]));
    if (e.kind === "line") {
      const a = pm.get(e.p1);
      const b = pm.get(e.p2);
      if (!a || !b) return Infinity;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }
    const c = pm.get(e.center);
    if (!c) return Infinity;
    const r = e.kind === "circle" ? e.radius : Math.hypot((pm.get(e.start)?.x ?? c.x) - c.x, (pm.get(e.start)?.y ?? c.y) - c.y);
    const radial = Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - r);
    if (e.kind === "circle") return radial;
    // For an arc, only count points in the angular range.
    const startPt = pm.get(e.start);
    const endPt = pm.get(e.end);
    if (!startPt || !endPt) return radial;
    const a0 = Math.atan2(startPt.y - c.y, startPt.x - c.x);
    const a1 = Math.atan2(endPt.y - c.y, endPt.x - c.x);
    const ap = Math.atan2(p.y - c.y, p.x - c.x);
    let delta = a1 - a0;
    if (e.ccw) {
      while (delta <= 0) delta += Math.PI * 2;
      let dp = ap - a0;
      while (dp < 0) dp += Math.PI * 2;
      return dp <= delta ? radial : Math.min(Math.hypot(p.x - startPt.x, p.y - startPt.y), Math.hypot(p.x - endPt.x, p.y - endPt.y));
    }
    while (delta >= 0) delta -= Math.PI * 2;
    let dp = ap - a0;
    while (dp > 0) dp -= Math.PI * 2;
    return dp >= delta ? radial : Math.min(Math.hypot(p.x - startPt.x, p.y - startPt.y), Math.hypot(p.x - endPt.x, p.y - endPt.y));
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || !this.sketch || e.button !== 0) return;
    const raw = this.eventPoint(e);
    if (!raw) return;
    e.stopPropagation();
    e.preventDefault();
    const snap = this.snap(raw);
    const p = { x: snap.x, y: snap.y };

    if (this.tool === "select") {
      const pointId = this.hitPoint(raw);
      const entityId = pointId ? null : this.hitEntity(raw);
      if (pointId) {
        if (!e.shiftKey) {
          this.selectedPoints.clear();
          this.selectedEntities.clear();
        }
        if (e.shiftKey && this.selectedPoints.has(pointId)) this.selectedPoints.delete(pointId);
        else this.selectedPoints.add(pointId);
        this.drag = { pointId, moved: false };
        this.render();
        return;
      }
      if (entityId) {
        if (!e.shiftKey) {
          this.selectedPoints.clear();
          this.selectedEntities.clear();
        }
        if (e.shiftKey && this.selectedEntities.has(entityId)) this.selectedEntities.delete(entityId);
        else this.selectedEntities.add(entityId);
        this.render();
        return;
      }
      if (!e.shiftKey) {
        this.selectedPoints.clear();
        this.selectedEntities.clear();
      }
      this.render();
      return;
    }

    if (this.tool === "dimension") {
      const pointId = this.hitPoint(raw);
      if (pointId) {
        if (this.pending.stage === 0) {
          this.pending = { stage: 1, points: [raw] };
          this.pendingPointId = pointId;
          this.selectedPoints = new Set([pointId]);
          this.callbacks.notify("Select the second point for the dimension.");
        } else {
          const firstId = this.pendingPointId;
          if (firstId && firstId !== pointId) {
            this.addDimension(firstId, pointId);
            this.pending = { stage: 0, points: [] };
            this.pendingPointId = null;
            this.selectedPoints.clear();
          }
        }
        this.render();
        return;
      }
      const entityId = this.hitEntity(raw);
      if (entityId) {
        this.dimensionEntity(entityId);
        return;
      }
      return;
    }

    if (this.tool === "line") {
      if (this.pending.stage === 0) {
        this.pending = { stage: 1, points: [p] };
        this.pending.points[0] = p;
        this.pendingPointId = snap.pointId ?? null;
      } else {
        const start = this.pending.points[0];
        if (Math.hypot(p.x - start.x, p.y - start.y) < this.viewport.worldPerPixel() * 3) return;
        let end = p;
        let infer: "horizontal" | "vertical" | null = null;
        const dx = Math.abs(p.x - start.x);
        const dy = Math.abs(p.y - start.y);
        const tol = Math.max(0.6, this.viewport.worldPerPixel() * 12);
        if (dy < tol) {
          end = { x: p.x, y: start.y };
          infer = "horizontal";
        } else if (dx < tol) {
          end = { x: start.x, y: p.y };
          infer = "vertical";
        }
        const endId = this.ensurePoint(end, snap.pointId ?? undefined);
        const startId = this.ensurePoint(start, this.pendingPointId ?? undefined);
        const id = uid("ln");
        this.sketch.entities.push({ id, kind: "line", p1: startId, p2: endId });
        if (infer) {
          this.sketch.constraints.push({ id: uid("c"), type: infer, entity: id });
        }
        this.commit(false);
        const solved = this.sketch.points.find((q) => q.id === endId);
        this.pending = { stage: 1, points: [solved ? { x: solved.x, y: solved.y } : end] };
        this.pendingPointId = endId;
      }
      this.render();
      return;
    }

    if (this.tool === "rectangle") {
      if (this.pending.stage === 0) {
        this.pending = { stage: 1, points: [p] };
        this.pendingPointId = snap.pointId ?? null;
        this.render();
        return;
      }
      this.createRectangle(this.pending.points[0], p, this.pendingPointId ?? undefined, snap.pointId ?? undefined);
      this.pending = { stage: 0, points: [] };
      this.pendingPointId = null;
      this.commit(false);
      this.render();
      return;
    }

    if (this.tool === "circle") {
      if (this.pending.stage === 0) {
        this.pending = { stage: 1, points: [p] };
        this.pendingPointId = snap.pointId ?? null;
        this.render();
        return;
      }
      const center = this.pending.points[0];
      const radius = Math.hypot(p.x - center.x, p.y - center.y);
      if (radius < 0.05) return;
      const centerId = this.ensurePoint(center, this.pendingPointId ?? undefined);
      const id = uid("ci");
      this.sketch.entities.push({ id, kind: "circle", center: centerId, radius });
      this.sketch.constraints.push({ id: uid("c"), type: "radius", entity: id, value: radius });
      this.pending = { stage: 0, points: [] };
      this.pendingPointId = null;
      this.commit(false);
      this.render();
      return;
    }

    if (this.tool === "arc") {
      if (this.pending.stage === 0) {
        this.pending = { stage: 1, points: [p] };
        this.pendingPointId = snap.pointId ?? null;
      } else if (this.pending.stage === 1) {
        if (Math.hypot(p.x - this.pending.points[0].x, p.y - this.pending.points[0].y) < 0.05) return;
        this.pending = { stage: 2, points: [...this.pending.points, p] };
        this.pendingSecondId = snap.pointId ?? null;
      } else {
        const [a, b] = this.pending.points;
        const circle = circumcircle(a, b, p);
        if (!circle) {
          this.callbacks.notify("Those three points are collinear — pick another arc point.", "warn");
          return;
        }
        const startId = this.ensurePoint(a, this.pendingPointId ?? undefined);
        const endId = this.ensurePoint(b, this.pendingSecondId ?? undefined);
        const centerId = this.ensurePoint(circle.center);
        const id = uid("ar");
        this.sketch.entities.push({
          id,
          kind: "arc",
          center: centerId,
          start: startId,
          end: endId,
          radius: circle.radius,
          ccw: isCcw(a, p, b),
        });
        this.sketch.constraints.push({ id: uid("c"), type: "radius", entity: id, value: circle.radius });
        this.pending = { stage: 0, points: [] };
        this.pendingPointId = null;
        this.pendingSecondId = null;
        this.commit(false);
      }
      this.render();
      return;
    }
  };

  private pendingPointId: string | null = null;
  private pendingSecondId: string | null = null;

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.sketch) return;
    const raw = this.eventPoint(e);
    if (!raw) {
      this.callbacks.onCursor(null);
      return;
    }
    const snap = this.snap(raw);
    this.cursor = { x: snap.x, y: snap.y };
    this.callbacks.onCursor(this.cursor);
    if (this.drag) {
      const p = this.sketch.points.find((q) => q.id === this.drag!.pointId);
      if (p) {
        p.x = snap.x;
        p.y = snap.y;
        this.drag.moved = true;
        this.solve(false);
        this.render();
      }
      return;
    }
    const hoverPoint = this.hitPoint(raw);
    const hoverEntity = hoverPoint ? null : this.hitEntity(raw);
    if (hoverPoint !== this.hoverPoint || hoverEntity !== this.hoverEntity) {
      this.hoverPoint = hoverPoint;
      this.hoverEntity = hoverEntity;
      this.render();
    } else if (this.pending.stage > 0 || this.tool === "line") {
      this.renderPreview();
    }
  };

  private onPointerUp = (): void => {
    if (!this.enabled) return;
    if (this.drag?.moved) {
      this.drag = null;
      this.commit(false);
    } else {
      this.drag = null;
    }
  };

  private solve(commit = false): void {
    if (!this.sketch) return;
    const result = solveSketch(this.sketch, { maxIterations: 80 });
    this.sketch.points = result.sketch.points;
    this.sketch.entities = result.sketch.entities;
    this.sketch.constraints = result.sketch.constraints;
    if (!result.converged || result.conflict.length) {
      this.callbacks.notify(result.conflict[0] ?? "The sketch solver could not satisfy all constraints.", "warn");
    }
    if (commit) this.callbacks.onChange(this.sketch, true);
  }

  private commit(rebuild: boolean): void {
    this.solve(false);
    this.callbacks.onChange(this.sketch!, rebuild);
    this.renderPreview();
    this.updateLabelPositions();
  }

  private createRectangle(a: Vec2, b: Vec2, aid?: string, bid?: string): void {
    if (!this.sketch) return;
    if (Math.abs(b.x - a.x) < 1e-4 || Math.abs(b.y - a.y) < 1e-4) {
      this.callbacks.notify("The rectangle is too small.", "warn");
      return;
    }
    const p1 = { x: a.x, y: a.y };
    const p2 = { x: b.x, y: a.y };
    const p3 = { x: b.x, y: b.y };
    const p4 = { x: a.x, y: b.y };
    const ids = [
      this.ensurePoint(p1, aid),
      this.ensurePoint(p2, bid),
      this.ensurePoint(p3),
      this.ensurePoint(p4),
    ];
    const l1 = uid("ln");
    const l2 = uid("ln");
    const l3 = uid("ln");
    const l4 = uid("ln");
    this.sketch.entities.push(
      { id: l1, kind: "line", p1: ids[0], p2: ids[1] },
      { id: l2, kind: "line", p1: ids[1], p2: ids[2] },
      { id: l3, kind: "line", p1: ids[2], p2: ids[3] },
      { id: l4, kind: "line", p1: ids[3], p2: ids[0] },
    );
    this.sketch.constraints.push(
      { id: uid("c"), type: "horizontal", entity: l1 },
      { id: uid("c"), type: "vertical", entity: l2 },
      { id: uid("c"), type: "horizontal", entity: l3 },
      { id: uid("c"), type: "vertical", entity: l4 },
      { id: uid("c"), type: "distance", entity: l1, value: Math.abs(b.x - a.x) },
      { id: uid("c"), type: "distance", entity: l2, value: Math.abs(b.y - a.y) },
    );
  }

  private dimensionEntity(entityId: string): void {
    if (!this.sketch) return;
    const e = this.sketch.entities.find((x) => x.id === entityId);
    if (!e) return;
    const pm = new Map(this.sketch.points.map((p) => [p.id, p]));
    if (e.kind === "line") {
      // Re-dimensioning an already dimensioned line edits the existing value
      // instead of stacking a second, conflicting constraint on the same edge.
      const existing = this.sketch.constraints.find((c) => c.type === "distance" && c.entity === entityId);
      if (existing) {
        this.callbacks.onRequestDimensionEdit(existing.id);
        return;
      }
      const a = pm.get(e.p1);
      const b = pm.get(e.p2);
      if (!a || !b) return;
      const id = uid("c");
      this.sketch.constraints.push({
        id,
        type: "distance",
        entity: entityId,
        value: Math.hypot(b.x - a.x, b.y - a.y),
        labelOffset: { x: 9, y: 0 },
      });
      this.commit(false);
      this.render();
      this.callbacks.onRequestDimensionEdit(id);
    } else {
      const existing = this.sketch.constraints.find((c) => c.type === "radius" && c.entity === entityId);
      if (existing) {
        this.callbacks.onRequestDimensionEdit(existing.id);
        return;
      }
      const c = pm.get(e.center);
      if (!c) return;
      const r =
        e.kind === "circle"
          ? e.radius
          : Math.hypot((pm.get(e.start)?.x ?? c.x) - c.x, (pm.get(e.start)?.y ?? c.y) - c.y);
      const id = uid("c");
      this.sketch.constraints.push({ id, type: "radius", entity: entityId, value: r });
      this.commit(false);
      this.render();
      this.callbacks.onRequestDimensionEdit(id);
    }
  }

  private addDimension(aId: string, bId: string): void {
    if (!this.sketch) return;
    const a = this.sketch.points.find((p) => p.id === aId);
    const b = this.sketch.points.find((p) => p.id === bId);
    if (!a || !b) return;
    const id = uid("c");
    this.sketch.constraints.push({
      id,
      type: "distance",
      a: aId,
      b: bId,
      value: Math.hypot(b.x - a.x, b.y - a.y),
      labelOffset: { x: 9, y: 0 },
    });
    this.commit(false);
    this.render();
    this.callbacks.onRequestDimensionEdit(id);
  }

  setDimensionValue(constraintId: string, value: number): void {
    if (!this.sketch) return;
    const c = this.sketch.constraints.find((q) => q.id === constraintId);
    if (!c) return;
    c.value = value;
    this.commit(false);
    this.render();
  }

  setDimensionOffset(constraintId: string, offset: number): void {
    if (!this.sketch) return;
    const c = this.sketch.constraints.find((q) => q.id === constraintId);
    if (!c) return;
    c.labelOffset = { x: offset, y: 0 };
    this.render();
  }

  // --------------------------------------------------------------- commands

  /** Apply a geometric relation to the current sketch selection. */
  applyConstraint(type: "horizontal" | "vertical" | "coincident" | "tangent" | "fix" | "equal"): boolean {
    if (!this.sketch) return false;
    const sp = [...this.selectedPoints];
    const se = [...this.selectedEntities];
    const add = (c: SketchConstraint) => this.sketch!.constraints.push(c);
    if (type === "horizontal" || type === "vertical") {
      const lines = se
        .map((id) => this.sketch!.entities.find((e) => e.id === id))
        .filter((e): e is Extract<typeof e, { kind: "line" }> => !!e && e.kind === "line");
      const targets =
        lines.length > 0
          ? lines
          : sp.length === 2
            ? [
                {
                  id: this.sketch.entities.find(
                    (e) => e.kind === "line" && sp.includes(e.p1) && sp.includes(e.p2),
                  )?.id ?? "",
                },
              ].filter((e) => e.id)
            : [];
      if (targets.length === 0) {
        this.callbacks.notify(`Select one or more lines for a ${type} relation.`, "warn");
        return false;
      }
      for (const line of targets) {
        if (this.sketch.constraints.some((c) => c.type === type && c.entity === line.id)) continue;
        add({ id: uid("c"), type, entity: line.id });
      }
    } else if (type === "coincident") {
      if (sp.length !== 2) {
        this.callbacks.notify("Select exactly two points to make them coincident.", "warn");
        return false;
      }
      add({ id: uid("c"), type: "coincident", a: sp[0], b: sp[1] });
    } else if (type === "fix") {
      const points = new Set(sp);
      if (points.size === 0) {
        for (const id of se) {
          const e = this.sketch.entities.find((x) => x.id === id);
          if (e?.kind === "line") {
            points.add(e.p1);
            points.add(e.p2);
          } else if (e) points.add(e.center);
        }
      }
      if (points.size === 0) {
        this.callbacks.notify("Select a point or entity to fix.", "warn");
        return false;
      }
      for (const id of points) {
        const p = this.sketch.points.find((q) => q.id === id);
        if (p) p.fixed = true;
      }
    } else if (type === "tangent") {
      const entities = se.map((id) => this.sketch!.entities.find((e) => e.id === id)).filter((e) => !!e);
      if (entities.length !== 2) {
        this.callbacks.notify("Select two entities for a tangent relation.", "warn");
        return false;
      }
      const line = entities.find((e) => e!.kind === "line");
      const curve = entities.find((e) => e!.kind !== "line");
      if (!line || !curve) {
        this.callbacks.notify("Tangent needs one line and one circle or arc.", "warn");
        return false;
      }
      add({ id: uid("c"), type, a: line.id, entity: curve.id });
    } else if (type === "equal") {
      const entities = se.map((id) => this.sketch!.entities.find((e) => e.id === id)).filter((e) => !!e);
      if (entities.length !== 2) {
        this.callbacks.notify("Select two entities for an equal relation.", "warn");
        return false;
      }
      const bothLines = entities.every((e) => e!.kind === "line");
      const bothCurves = entities.every((e) => e!.kind !== "line");
      if (!bothLines && !bothCurves) {
        this.callbacks.notify("Equal needs two lines or two curves.", "warn");
        return false;
      }
      add({ id: uid("c"), type, a: entities[0]!.id, b: entities[1]!.id });
    }
    this.commit(false);
    this.render();
    return true;
  }

  deleteSelection(): boolean {
    if (!this.sketch) return false;
    const entities = new Set(this.selectedEntities);
    const points = new Set(this.selectedPoints);
    if (entities.size === 0 && points.size === 0) return false;
    this.sketch.entities = this.sketch.entities.filter((e) => {
      if (entities.has(e.id)) return false;
      if (e.kind === "line") return !(points.has(e.p1) || points.has(e.p2));
      if (e.kind === "circle") return !points.has(e.center);
      return !(points.has(e.center) || points.has(e.start) || points.has(e.end));
    });
    const usedPoints = new Set<string>();
    for (const e of this.sketch.entities) {
      if (e.kind === "line") {
        usedPoints.add(e.p1);
        usedPoints.add(e.p2);
      } else if (e.kind === "circle") usedPoints.add(e.center);
      else {
        usedPoints.add(e.center);
        usedPoints.add(e.start);
        usedPoints.add(e.end);
      }
    }
    const removedPoints = new Set([...points].filter((id) => !usedPoints.has(id)));
    this.sketch.points = this.sketch.points.filter((p) => usedPoints.has(p.id) || !removedPoints.has(p.id));
    const entityIds = new Set(this.sketch.entities.map((e) => e.id));
    this.sketch.constraints = this.sketch.constraints.filter((c) => {
      if (c.entity && !entityIds.has(c.entity)) return false;
      if (c.a && !this.sketch!.points.some((p) => p.id === c.a)) return false;
      if (c.b && !this.sketch!.points.some((p) => p.id === c.b)) return false;
      return true;
    });
    this.selectedEntities.clear();
    this.selectedPoints.clear();
    this.commit(false);
    this.render();
    return true;
  }

  cancel(): boolean {
    if (this.pending.stage > 0) {
      this.pending = { stage: 0, points: [] };
      this.pendingPointId = null;
      this.pendingSecondId = null;
      this.stripPreview();
      this.render();
      return true;
    }
    if (this.selectedPoints.size || this.selectedEntities.size) {
      this.selectedPoints.clear();
      this.selectedEntities.clear();
      this.render();
      return true;
    }
    if (this.tool !== "select") {
      this.setTool("select");
      return true;
    }
    return false;
  }

  selectConstraint(constraintId: string): void {
    if (!this.sketch) return;
    const c = this.sketch.constraints.find((x) => x.id === constraintId);
    if (!c) return;
    this.selectedEntities.clear();
    this.selectedPoints.clear();
    if (c.entity) this.selectedEntities.add(c.entity);
    if (c.a) this.selectedPoints.add(c.a);
    if (c.b) this.selectedPoints.add(c.b);
    this.render();
  }

  private emitSelection(): void {
    this.callbacks.onSelection(this.selectedPoints.size, this.selectedEntities.size);
  }

  /** Fit the view to the sketch extents. */
  fit(): void {
    if (!this.sketch) return;
    this.viewport.zoomFit(true);
  }
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const center = { x: ux, y: uy };
  return { center, radius: Math.hypot(a.x - ux, a.y - uy) };
}

function isCcw(a: Vec2, mid: Vec2, b: Vec2): boolean {
  return (mid.x - a.x) * (b.y - mid.y) - (mid.y - a.y) * (b.x - mid.x) > 0;
}

export type { SketchPlane };
