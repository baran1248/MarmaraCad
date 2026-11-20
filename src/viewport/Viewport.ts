import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { EdgeInfo, FaceInfo, MeshData, SketchPlane, Vec3 } from "../model/types";
import { bodyGeometry, edgeLineGeometry, edgePolylineGeometry, faceGeometry } from "./geometry";

export type ViewName = "front" | "back" | "top" | "bottom" | "right" | "left" | "iso";
export type DisplayStyle = "shaded-edges" | "shaded" | "wireframe";

export interface SceneBody {
  partId: string;
  componentId: string | null;
  mesh: MeshData;
  color: string;
  visible?: boolean;
  position?: Vec3;
  rotation?: Vec3;
}

export interface FacePick {
  componentId: string | null;
  partId: string;
  faceIndex: number;
  face: FaceInfo;
}

export interface EdgePick {
  componentId: string | null;
  partId: string;
  edgeIndex: number;
  edge: EdgeInfo;
}

export interface FaceSel {
  componentId: string | null;
  faceIndex: number;
}

export interface EdgeSel {
  componentId: string | null;
  edgeIndex: number;
}

interface BodyView {
  key: string;
  partId: string;
  componentId: string | null;
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  data: MeshData;
  edges: THREE.Group;
  edgeLines: Map<number, THREE.Line>;
  highlight: THREE.Mesh | null;
  hover: THREE.Mesh | null;
  hoverEdge: THREE.Mesh | null;
  selectedEdges: THREE.Group;
  baseColor: THREE.Color;
}

const FACE_SELECT = 0xffb100;
const FACE_HOVER = 0x55a8f0;
const EDGE_HIGHLIGHT = 0xffa000;

function makeBodyMaterial(color: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness: 0.18,
    roughness: 0.52,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export class Viewport {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  onPickFace: ((pick: FacePick | null) => void) | null = null;
  onPickEdge: ((pick: EdgePick | null) => void) | null = null;
  onHoverFace: ((pick: FacePick | null) => void) | null = null;
  onHoverEdge: ((pick: EdgePick | null) => void) | null = null;
  onCameraChange: (() => void) | null = null;
  onFrame: (() => void) | null = null;

  private bodies = new Map<string, BodyView>();
  private root = new THREE.Group();
  private planeGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickFilter: "face" | "edge" | "none" = "face";
  private hoverPickKey = "";
  private selectedFaces: FaceSel[] = [];
  private activeComponentId: string | null = null;
  private displayStyle: DisplayStyle = "shaded-edges";
  private sketchPlane: SketchPlane | null = null;
  private fitted = false;
  private down: { x: number; y: number; button: number } | null = null;
  private viewAnim: {
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    fromUp: THREE.Vector3;
    toUp: THREE.Vector3;
    start: number;
    duration: number;
  } | null = null;
  private resizeObserver: ResizeObserver;
  private disposed = false;
  private debugWire: THREE.Mesh | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.classList.add("viewport-canvas");
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(this.root);
    this.scene.add(this.planeGroup);
    this.scene.add(this.sketchGroup);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 50000);
    this.camera.position.set(150, 140, 210);
    this.camera.up.set(0, 1, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 20000;
    this.controls.rotateSpeed = 0.9;
    this.controls.zoomSpeed = 1.1;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", () => this.onCameraChange?.());

    this.setupLights();
    this.buildOriginPlanes();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x5b6b7c, 1.35);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(180, 260, 220);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce9ff, 1.0);
    fill.position.set(-200, 110, -140);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.65);
    rim.position.set(100, -160, 90);
    this.scene.add(rim);
  }

  private buildOriginPlanes(): void {
    const size = 42;
    const defs: { color: number; u: Vec3; v: Vec3; label: string }[] = [
      { color: 0x4f8fd6, u: [1, 0, 0], v: [0, 1, 0], label: "Front" },
      { color: 0x67b37a, u: [1, 0, 0], v: [0, 0, 1], label: "Top" },
      { color: 0xd18f6b, u: [0, 0, 1], v: [0, 1, 0], label: "Right" },
    ];
    for (const d of defs) {
      const geo = new THREE.PlaneGeometry(size, size);
      const mat = new THREE.MeshBasicMaterial({
        color: d.color,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const u = new THREE.Vector3(...d.u);
      const v = new THREE.Vector3(...d.v);
      const normal = new THREE.Vector3().crossVectors(u, v).normalize();
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, normal));
      mesh.userData.planeLabel = d.label;
      this.planeGroup.add(mesh);

      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, size / 2, 0),
          new THREE.Vector3(-size / 2, size / 2, 0),
        ]),
        new THREE.LineBasicMaterial({ color: d.color, transparent: true, opacity: 0.5 }),
      );
      border.quaternion.copy(mesh.quaternion);
      this.planeGroup.add(border);
    }
    this.planeGroup.visible = false;
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  setPlanesVisible(visible: boolean): void {
    this.planeGroup.visible = visible;
  }

  /** Replace the rendered bodies. Reuses bodies whose key matches to avoid flicker. */
  setBodies(list: SceneBody[]): void {
    const keys = new Set(list.map((b) => b.componentId ?? b.partId));
    for (const [key, view] of this.bodies) {
      if (!keys.has(key) || !list.some((b) => (b.componentId ?? b.partId) === key && b.partId === view.partId)) {
        this.disposeBody(view);
        this.bodies.delete(key);
      }
    }
    for (const spec of list) {
      const key = spec.componentId ?? spec.partId;
      let view = this.bodies.get(key);
      const meshChanged = !view || view.data !== spec.mesh;
      if (view && !meshChanged) {
        view.group.visible = spec.visible !== false;
        view.group.position.set(...(spec.position ?? [0, 0, 0]));
        const r = spec.rotation ?? [0, 0, 0];
        view.group.rotation.set(
          (r[0] * Math.PI) / 180,
          (r[1] * Math.PI) / 180,
          (r[2] * Math.PI) / 180,
          "XYZ",
        );
        continue;
      }
      if (view) {
        this.disposeBody(view);
        this.bodies.delete(key);
      }
      view = this.createBody(spec, key);
      this.bodies.set(key, view);
      this.root.add(view.group);
    }
    this.applyDisplayStyle();
    this.applySelections();
    this.applyActiveComponent();
    if (!this.fitted && this.bodies.size > 0) {
      this.fitted = true;
      this.zoomFit(false);
    }
  }

  private createBody(spec: SceneBody, key: string): BodyView {
    const group = new THREE.Group();
    group.userData.componentId = spec.componentId;
    group.userData.partId = spec.partId;
    group.visible = spec.visible !== false;
    if (spec.position) group.position.set(...spec.position);
    if (spec.rotation) {
      group.rotation.set(
        (spec.rotation[0] * Math.PI) / 180,
        (spec.rotation[1] * Math.PI) / 180,
        (spec.rotation[2] * Math.PI) / 180,
        "XYZ",
      );
    }
    const material = makeBodyMaterial(spec.color);
    const mesh = new THREE.Mesh(bodyGeometry(spec.mesh), material);
    mesh.userData.pickBody = true;
    mesh.userData.key = key;
    mesh.userData.partId = spec.partId;
    mesh.userData.componentId = spec.componentId;
    mesh.userData.data = spec.mesh;
    mesh.renderOrder = 1;
    group.add(mesh);

    const edges = new THREE.Group();
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2a3642, transparent: true, opacity: 0.9 });
    const edgeLines = new Map<number, THREE.Line>();
    for (const edge of spec.mesh.edges) {
      const line = new THREE.Line(edgePolylineGeometry(edge), lineMat);
      line.userData.pickEdge = true;
      line.userData.edgeIndex = edge.index;
      line.userData.key = key;
      line.userData.edge = edge;
      line.renderOrder = 2;
      edges.add(line);
      edgeLines.set(edge.index, line);
    }
    group.add(edges);

    const view: BodyView = {
      key,
      partId: spec.partId,
      componentId: spec.componentId,
      group,
      mesh,
      material,
      data: spec.mesh,
      edges,
      edgeLines,
      highlight: null,
      hover: null,
      hoverEdge: null,
      selectedEdges: new THREE.Group(),
      baseColor: new THREE.Color(spec.color),
    };
    group.add(view.selectedEdges);
    return view;
  }

  private disposeBody(view: BodyView): void {
    this.root.remove(view.group);
    view.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        if (obj.geometry && obj.geometry !== view.mesh.geometry) {
          // highlight geometries share the body position attribute; disposing them is safe.
          obj.geometry.dispose();
        }
      }
    });
    view.mesh.geometry.dispose();
    view.material.dispose();
    view.highlight = null;
    view.hover = null;
  }

  setDisplayStyle(style: DisplayStyle): void {
    this.displayStyle = style;
    this.applyDisplayStyle();
  }

  getDisplayStyle(): DisplayStyle {
    return this.displayStyle;
  }

  private applyDisplayStyle(): void {
    for (const view of this.bodies.values()) {
      const wire = this.displayStyle === "wireframe";
      view.mesh.visible = !wire;
      view.edges.visible = this.displayStyle !== "shaded";
      if (view.highlight) view.highlight.visible = !wire;
      if (view.hover) view.hover.visible = !wire;
      for (const line of view.edgeLines.values()) {
        (line.material as THREE.LineBasicMaterial).opacity = wire ? 1 : 0.85;
      }
    }
  }

  setSketchMode(plane: SketchPlane | null): void {
    this.sketchPlane = plane;
    this.clearSketchGrid();
    if (!plane) {
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      this.renderer.domElement.style.cursor = "";
      for (const view of this.bodies.values()) {
        view.material.transparent = false;
        view.material.opacity = 1;
        view.material.depthWrite = true;
        view.material.needsUpdate = true;
        view.edges.visible = this.displayStyle !== "shaded";
      }
      return;
    }
    (this.controls.mouseButtons as any).LEFT = null;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.buildSketchGrid(plane);
    for (const view of this.bodies.values()) {
      view.material.transparent = true;
      view.material.opacity = 0.32;
      view.material.depthWrite = false;
      view.material.needsUpdate = true;
      view.edges.visible = false;
    }
  }

  private clearSketchGrid(): void {
    for (const child of [...this.sketchGroup.children]) {
      this.sketchGroup.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.LineSegments) child.geometry.dispose();
    }
  }

  private buildSketchGrid(plane: SketchPlane): void {
    const extent = 160;
    const minor = 5;
    const major = 25;
    const minorPts: number[] = [];
    const majorPts: number[] = [];
    const pushLine = (arr: number[], a: THREE.Vector3, b: THREE.Vector3) => {
      arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
    };
    const origin = new THREE.Vector3(...plane.origin);
    const u = new THREE.Vector3(...plane.u);
    const v = new THREE.Vector3(...plane.v);
    const at = (x: number, y: number) => origin.clone().addScaledVector(u, x).addScaledVector(v, y);
    for (let d = -extent; d <= extent; d += minor) {
      if (d === 0) continue;
      const arr = d % major === 0 ? majorPts : minorPts;
      pushLine(arr, at(d, -extent), at(d, extent));
      pushLine(arr, at(-extent, d), at(extent, d));
    }
    const mk = (pts: number[], color: number, opacity: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthTest: false,
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.renderOrder = 20;
      this.sketchGroup.add(lines);
    };
    mk(minorPts, 0x8fa3b5, 0.28);
    mk(majorPts, 0x6f8497, 0.5);
    // Sketch axes: u = red, v = green.
    const axisPts: number[] = [];
    pushLine(axisPts, at(-extent, 0), at(extent, 0));
    const axisGeo = new THREE.BufferGeometry();
    axisGeo.setAttribute("position", new THREE.Float32BufferAttribute(axisPts, 3));
    const xAxis = new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: 0xc0504d, depthTest: false }));
    xAxis.renderOrder = 21;
    this.sketchGroup.add(xAxis);
    const yPts: number[] = [];
    pushLine(yPts, at(0, -extent), at(0, extent));
    const yGeo = new THREE.BufferGeometry();
    yGeo.setAttribute("position", new THREE.Float32BufferAttribute(yPts, 3));
    const yAxis = new THREE.Line(yGeo, new THREE.LineBasicMaterial({ color: 0x4f8a4f, depthTest: false }));
    yAxis.renderOrder = 21;
    this.sketchGroup.add(yAxis);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.75, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x1f2a35, depthTest: false }),
    );
    dot.position.copy(origin);
    dot.renderOrder = 22;
    this.sketchGroup.add(dot);
  }

  /** Add an object to the sketch overlay group (entities, previews). */
  sketchOverlay(): THREE.Group {
    return this.sketchGroup;
  }

  clearHover(): void {
    for (const view of this.bodies.values()) {
      if (view.hover) {
        view.group.remove(view.hover);
        view.hover.geometry.dispose();
        view.hover = null;
      }
      if (view.hoverEdge) {
        view.group.remove(view.hoverEdge);
        view.hoverEdge.geometry.dispose();
        view.hoverEdge = null;
      }
    }
    const prev = this.hoverPickKey;
    this.hoverPickKey = "";
    if (prev) this.onHoverFace?.(null);
  }

  setSelectedFaces(sel: FaceSel[]): void {
    this.selectedFaces = sel;
    this.applySelections();
  }

  setSelectedEdges(sel: EdgeSel[]): void {
    for (const view of this.bodies.values()) {
      for (const child of [...view.selectedEdges.children]) {
        view.selectedEdges.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      const mine = sel.filter((s) => s.componentId === view.componentId);
      for (const s of mine) {
        const edge = view.data.edges.find((e) => e.index === s.edgeIndex);
        if (!edge) continue;
        const tube = this.buildEdgeTube(edge, 0xffa000);
        if (tube) view.selectedEdges.add(tube);
      }
    }
  }

  setActiveComponent(componentId: string | null): void {
    this.activeComponentId = componentId;
    this.applyActiveComponent();
  }

  private applyActiveComponent(): void {
    for (const view of this.bodies.values()) {
      const active = this.activeComponentId !== null && view.componentId === this.activeComponentId;
      view.material.emissive.set(active ? 0x1c5c96 : 0x000000);
      view.material.emissiveIntensity = active ? 0.5 : 0;
    }
  }

  private applySelections(): void {
    for (const view of this.bodies.values()) {
      if (view.highlight) {
        view.group.remove(view.highlight);
        view.highlight.geometry.dispose();
        view.highlight = null;
      }
      const ids = this.selectedFaces.filter((s) => s.componentId === view.componentId).map((s) => s.faceIndex);
      if (ids.length === 0) continue;
      const geo = faceGeometry(view.data, ids);
      if (!geo) continue;
      const mat = new THREE.MeshBasicMaterial({
        color: FACE_SELECT,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 5;
      view.group.add(mesh);
      view.highlight = mesh;
    }
    this.applyDisplayStyle();
  }

  private buildEdgeTube(edge: EdgeInfo, color: number): THREE.Mesh | null {
    if (edge.points.length < 2) return null;
    const pts = edge.points.map((p) => new THREE.Vector3(...p));
    const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.02);
    const radius = Math.max(0.12, this.modelRadius() * 0.0035);
    const geo = new THREE.TubeGeometry(curve, Math.max(8, Math.min(160, pts.length * 2)), radius, 6, false);
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 6;
    return mesh;
  }

  private modelRadius(): number {
    let r = 1;
    const box = new THREE.Box3();
    for (const view of this.bodies.values()) {
      box.expandByObject(view.mesh);
    }
    if (!box.isEmpty()) r = box.getSize(new THREE.Vector3()).length() * 0.5;
    return Math.max(r, 1);
  }

  setPickFilter(filter: "face" | "edge" | "none"): void {
    this.pickFilter = filter;
    this.renderer.domElement.style.cursor = filter === "none" ? "" : "crosshair";
    this.clearHover();
  }

  private updatePointer(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private bodyMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const view of this.bodies.values()) {
      if (view.group.visible && view.mesh.visible) out.push(view.mesh);
    }
    return out;
  }

  private edgeLines(): THREE.Line[] {
    const out: THREE.Line[] = [];
    for (const view of this.bodies.values()) {
      if (!view.group.visible) continue;
      for (const line of view.edgeLines.values()) out.push(line);
    }
    return out;
  }

  private pickFace(): FacePick | null {
    const hits = this.raycaster.intersectObjects(this.bodyMeshes(), false);
    for (const hit of hits) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.userData.pickBody || hit.faceIndex == null) continue;
      const data = mesh.userData.data as MeshData;
      const faceIndex = data.triFaceIds[hit.faceIndex];
      const face = data.faces.find((f) => f.index === faceIndex);
      if (!face) continue;
      return {
        componentId: (mesh.userData.componentId as string | null) ?? null,
        partId: mesh.userData.partId as string,
        faceIndex,
        face,
      };
    }
    return null;
  }

  private pickEdge(): EdgePick | null {
    this.raycaster.params.Line = { threshold: Math.max(0.25, this.modelRadius() * 0.014) };
    const hits = this.raycaster.intersectObjects(this.edgeLines(), false);
    for (const hit of hits) {
      const line = hit.object as THREE.Line;
      if (!line.userData.pickEdge) continue;
      const key = line.userData.key as string;
      const view = this.bodies.get(key);
      return {
        componentId: view?.componentId ?? null,
        partId: view?.partId ?? "",
        edgeIndex: line.userData.edgeIndex as number,
        edge: line.userData.edge as EdgeInfo,
      };
    }
    return null;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (!this.down || e.button !== 0) {
      this.down = null;
      return;
    }
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (moved > 6 || this.pickFilter === "none") return;
    this.updatePointer(e);
    if (this.pickFilter === "edge") {
      const pick = this.pickEdge();
      if (pick) this.onPickEdge?.(pick);
      else this.onPickEdge?.(null);
    } else {
      const pick = this.pickFace();
      if (pick) this.onPickFace?.(pick);
      else this.onPickFace?.(null);
    }
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.pickFilter === "none") return;
    this.updatePointer(e);
    if (this.pickFilter === "edge") {
      const pick = this.pickEdge();
      const key = pick ? `${pick.componentId}:${pick.edgeIndex}` : "";
      if (key === this.hoverPickKey) return;
      this.hoverPickKey = key;
      for (const view of this.bodies.values()) {
        if (view.hoverEdge) {
          view.group.remove(view.hoverEdge);
          view.hoverEdge.geometry.dispose();
          view.hoverEdge = null;
        }
      }
      if (pick) {
        const view = this.bodies.get(pick.componentId ?? pick.partId);
        if (view) {
          const tube = this.buildEdgeTube(pick.edge, EDGE_HIGHLIGHT);
          if (tube) {
            view.group.add(tube);
            view.hoverEdge = tube;
          }
        }
      }
      this.onHoverEdge?.(pick);
      return;
    }
    const pick = this.pickFace();
    const key = pick ? `${pick.componentId}:${pick.faceIndex}` : "";
    if (key === this.hoverPickKey) return;
    this.hoverPickKey = key;
    for (const view of this.bodies.values()) {
      if (view.hover) {
        view.group.remove(view.hover);
        view.hover.geometry.dispose();
        view.hover = null;
      }
    }
    if (pick) {
      const view = this.bodies.get(pick.componentId ?? pick.partId);
      if (view) {
        const geo = faceGeometry(view.data, [pick.faceIndex]);
        if (geo) {
          const mat = new THREE.MeshBasicMaterial({
            color: FACE_HOVER,
            transparent: true,
            opacity: 0.26,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.renderOrder = 4;
          view.group.add(mesh);
          view.hover = mesh;
        }
      }
    }
    this.onHoverFace?.(pick);
  };

  private handlePointerLeave = (): void => {
    this.clearHover();
    this.onHoverFace?.(null);
    this.onHoverEdge?.(null);
  };

  /** World-space ray/plane conversion used by the sketch editor. */
  screenToPlane(clientX: number, clientY: number, plane: SketchPlane): Vec3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const n = new THREE.Vector3(...plane.n);
    const p = new THREE.Vector3(...plane.origin);
    const mathPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(mathPlane, hit)) return null;
    const d = hit.clone().sub(p);
    const u = new THREE.Vector3(...plane.u);
    const v = new THREE.Vector3(...plane.v);
    return [d.dot(u), d.dot(v), 0];
  }

  projectToScreen(world: Vec3): { x: number; y: number; visible: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(world[0], world[1], world[2]).project(this.camera);
    return {
      x: ((v.x + 1) / 2) * rect.width,
      y: ((-v.y + 1) / 2) * rect.height,
      visible: v.z < 1 && v.z > -1,
    };
  }

  /** Approximate world units per screen pixel at the orbit target. */
  worldPerPixel(): number {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const h = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * distance;
    return h / Math.max(1, this.renderer.domElement.clientHeight);
  }

  setView(name: ViewName, animate = true): void {
    const target = this.fitTarget();
    const radius = this.sceneRadius();
    const distance = (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.35;
    const dirs: Record<ViewName, Vec3> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      top: [0, 1, 0],
      bottom: [0, -1, 0],
      right: [1, 0, 0],
      left: [-1, 0, 0],
      iso: [1, 0.82, 1],
    };
    const dir = new THREE.Vector3(...dirs[name]).normalize();
    const pos = target.clone().addScaledVector(dir, Math.max(distance, 30));
    const up =
      name === "top"
        ? new THREE.Vector3(0, 0, -1)
        : name === "bottom"
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);
    if (!animate) {
      this.camera.up.copy(up);
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.onCameraChange?.();
      return;
    }
    this.viewAnim = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromUp: this.camera.up.clone(),
      toUp: up,
      start: performance.now(),
      duration: 320,
    };
  }

  private fitTarget(): THREE.Vector3 {
    const box = new THREE.Box3();
    for (const view of this.bodies.values()) {
      if (view.group.visible) box.expandByObject(view.mesh);
    }
    if (box.isEmpty()) return new THREE.Vector3(0, 0, 0);
    return box.getCenter(new THREE.Vector3());
  }

  private sceneRadius(): number {
    const box = new THREE.Box3();
    for (const view of this.bodies.values()) {
      if (view.group.visible) box.expandByObject(view.mesh);
    }
    if (box.isEmpty()) return 60;
    return Math.max(10, box.getSize(new THREE.Vector3()).length() * 0.5);
  }

  zoomFit(animate = true): void {
    const center = this.fitTarget();
    const radius = this.sceneRadius();
    const dist = (radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.15;
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1);
    dir.normalize();
    const pos = center.clone().addScaledVector(dir, Math.max(dist, 20));
    if (!animate) {
      this.controls.target.copy(center);
      this.camera.position.copy(pos);
      this.controls.update();
      return;
    }
    this.viewAnim = {
      fromPos: this.camera.position.clone(),
      toPos: pos,
      fromTarget: this.controls.target.clone(),
      toTarget: center,
      fromUp: this.camera.up.clone(),
      toUp: this.camera.up.clone(),
      start: performance.now(),
      duration: 260,
    };
  }

  private tick = (): void => {
    if (this.disposed) return;
    if (this.viewAnim) {
      const a = Math.min(1, (performance.now() - this.viewAnim.start) / this.viewAnim.duration);
      const t = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2;
      this.camera.position.lerpVectors(this.viewAnim.fromPos, this.viewAnim.toPos, t);
      this.controls.target.lerpVectors(this.viewAnim.fromTarget, this.viewAnim.toTarget, t);
      this.camera.up.lerpVectors(this.viewAnim.fromUp, this.viewAnim.toUp, t).normalize();
      if (a >= 1) this.viewAnim = null;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  };

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  screenshotDataURL(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const view of this.bodies.values()) this.disposeBody(view);
    this.renderer.dispose();
  }
}
