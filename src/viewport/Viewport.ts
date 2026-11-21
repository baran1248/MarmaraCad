import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { EdgeInfo, FaceInfo, MeshData, SketchPlane, Vec3 } from "../model/types";
import { bodyGeometry, edgeLineGeometry, edgePolylineGeometry, faceGeometry } from "./geometry";
import type { RendererBackend, RendererLike } from "./renderer";

export type ViewName = "front" | "back" | "top" | "bottom" | "right" | "left" | "iso";
export type DisplayStyle = "shaded-edges" | "shaded" | "wireframe";
export type PickFilter = "face" | "edge" | "vertex" | "all" | "none";
export type NavScheme = "cad" | "legacy";
export type SectionAxis = "x" | "y" | "z";

export interface SectionState {
  enabled: boolean;
  axis: SectionAxis;
  offset: number;
  flipped: boolean;
}

export interface VertexPick {
  componentId: string | null;
  partId: string;
  point: Vec3;
  edgeIndex: number;
}

export interface BoxSelection {
  faces: FacePick[];
  edges: EdgePick[];
  vertices: VertexPick[];
  crossing: boolean;
}

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
  readonly renderer: RendererLike;
  readonly backend: RendererBackend;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  onPickFace: ((pick: FacePick | null) => void) | null = null;
  onPickEdge: ((pick: EdgePick | null) => void) | null = null;
  onPickVertex: ((pick: VertexPick | null) => void) | null = null;
  onBoxSelect: ((selection: BoxSelection) => void) | null = null;
  onContextPick: ((x: number, y: number, pick: { face?: FacePick; edge?: EdgePick; vertex?: VertexPick }) => void) | null = null;
  onHoverFace: ((pick: FacePick | null) => void) | null = null;
  onHoverEdge: ((pick: EdgePick | null) => void) | null = null;
  onCameraChange: (() => void) | null = null;
  onFrame: (() => void) | null = null;
  onPickFilterChanged: ((filter: PickFilter) => void) | null = null;

  private bodies = new Map<string, BodyView>();
  private root = new THREE.Group();
  private planeGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pickFilter: PickFilter = "face";
  private hoverPickKey = "";
  private selectedFaces: FaceSel[] = [];
  private selectedVertices: { componentId: string | null; point: Vec3 }[] = [];
  private activeComponentId: string | null = null;
  private displayStyle: DisplayStyle = "shaded-edges";
  private sketchPlane: SketchPlane | null = null;
  private navScheme: NavScheme = "cad";
  private fitted = false;
  private down: { x: number; y: number; button: number } | null = null;
  private band: { startX: number; startY: number; el: HTMLDivElement; crossing: boolean } | null = null;
  private section: SectionState = { enabled: false, axis: "z", offset: 0, flipped: false };
  private vertexGroup = new THREE.Group();
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

  constructor(container: HTMLElement, renderer: RendererLike, backend: RendererBackend = "webgl2") {
    this.container = container;
    this.renderer = renderer;
    this.backend = backend;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.classList.add("viewport-canvas");
    container.appendChild(this.renderer.domElement);
    if ("localClippingEnabled" in this.renderer) this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.scene.add(this.root);
    this.scene.add(this.planeGroup);
    this.scene.add(this.sketchGroup);
    this.scene.add(this.vertexGroup);

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
    this.applyNavScheme();
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", () => this.onCameraChange?.());

    this.setupLights();
    this.buildOriginPlanes();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
    this.renderer.domElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openContextMenu(e);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  /** Mouse ergonomics: SolidWorks-like CAD scheme by default (middle = orbit,
   *  right = pan, left = select/box). `legacy` restores left-drag orbit. */
  setNavScheme(scheme: NavScheme): void {
    this.navScheme = scheme;
    this.applyNavScheme();
  }

  private applyNavScheme(): void {
    if (this.sketchPlane) {
      this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      return;
    }
    if (this.navScheme === "legacy") {
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    } else {
      this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    }
    this.controls.enableZoom = false;
  }

  /** Cursor-anchored dolly: the point under the pointer stays put while zooming. */
  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const before = this.camera.position.distanceTo(this.controls.target);
    const factor = Math.exp(clampNumber(e.deltaY * 0.0011, -0.6, 0.6));
    const dist = clampNumber(before * factor, this.controls.minDistance, this.controls.maxDistance);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.8, 1);
    dir.normalize();

    // World point under the cursor on the plane through the orbit target.
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      this.camera.position.clone().sub(this.controls.target).normalize(),
      this.controls.target,
    );
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(plane, hit) && before > 1e-6) {
      const k = 1 - dist / before;
      this.controls.target.addScaledVector(hit.clone().sub(this.controls.target), k);
    }
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
    this.onCameraChange?.();
  };

  /** Record the section state. The actual cut is produced on the CPU by
   *  `sectionMesh()` in main.ts, so both the WebGL2 and WebGPU backends show the
   *  same capped result; the renderer must not clip a second time. */
  setSectionState(state: Partial<SectionState>): SectionState {
    this.section = { ...this.section, ...state };
    return this.section;
  }

  getSection(): SectionState {
    return { ...this.section };
  }

  private setupLights(): void {    const hemi = new THREE.HemisphereLight(0xffffff, 0x5b6b7c, 1.35);
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

      // Line (not LineLoop): Three's WebGPU renderer does not implement LineLoop.
      const border = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, size / 2, 0),
          new THREE.Vector3(-size / 2, size / 2, 0),
          new THREE.Vector3(-size / 2, -size / 2, 0),
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
    this.applyClipToMaterial(material);
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
    this.applyClipToMaterial(lineMat);
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

  private applyClipToMaterial(material: THREE.Material): void {
    // Section cuts are computed on the CPU (`sectionMesh`), so new materials
    // must never inherit a shader clipping plane (that would cut twice).
    material.clippingPlanes = [];
    material.needsUpdate = true;
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
      this.applyNavScheme();
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
    this.applyNavScheme();
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

  setPickFilter(filter: PickFilter): void {
    this.pickFilter = filter;
    this.renderer.domElement.style.cursor = filter === "none" ? "" : "crosshair";
    this.clearHover();
    this.onPickFilterChanged?.(filter);
  }

  getPickFilter(): PickFilter {
    return this.pickFilter;
  }

  setSelectedVertices(sel: { componentId: string | null; point: Vec3 }[]): void {
    this.selectedVertices = sel;
    for (const child of [...this.vertexGroup.children]) {
      this.vertexGroup.remove(child);
      if (child instanceof THREE.Points) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
    if (sel.length === 0) return;
    const arr: number[] = [];
    for (const v of sel) arr.push(v.point[0], v.point[1], v.point[2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffb100,
      size: 11,
      sizeAttenuation: false,
      depthTest: false,
      transparent: true,
    });
    const points = new THREE.Points(geo, mat);
    points.renderOrder = 40;
    this.vertexGroup.add(points);
  }

  /** Unique topological vertices of every visible body. */
  private vertices(): ({ componentId: string | null; partId: string; point: Vec3; edgeIndex: number })[] {
    const out: { componentId: string | null; partId: string; point: Vec3; edgeIndex: number }[] = [];
    const seen = new Set<string>();
    for (const view of this.bodies.values()) {
      if (!view.group.visible) continue;
      const offset = view.group.position;
      for (const edge of view.data.edges) {
        for (const p of [edge.points[0], edge.points[edge.points.length - 1]]) {
          if (!p) continue;
          const world: Vec3 = [p[0] + offset.x, p[1] + offset.y, p[2] + offset.z];
          const key = `${view.key}:${world.map((v) => Math.round(v * 100)).join(",")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ componentId: view.componentId, partId: view.partId, point: world, edgeIndex: edge.index });
        }
      }
    }
    return out;
  }

  private pickVertex(clientX: number, clientY: number): VertexPick | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best: { pick: VertexPick; dist: number } | null = null;
    for (const v of this.vertices()) {
      const s = this.projectToScreen(v.point);
      if (!s.visible) continue;
      const sx = rect.left + s.x;
      const sy = rect.top + s.y;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < 10 && (!best || d < best.dist)) best = { pick: v, dist: d };
    }
    return best?.pick ?? null;
  }

  /** Public raycast helpers used by Convert Entities and Measure. */
  raycastEdgeAt(clientX: number, clientY: number): EdgePick | null {
    this.updatePointerAt(clientX, clientY);
    return this.pickEdge();
  }

  raycastFaceAt(clientX: number, clientY: number): FacePick | null {
    this.updatePointerAt(clientX, clientY);
    return this.pickFace();
  }

  /** Edges connected end-to-end to the picked edge (a topological loop).
   *  With `tangentOnly`, the walk also requires the directions to line up, which
   *  is how SolidWorks' Select Tangency behaves. */
  edgeLoop(start: EdgePick, tangentOnly: boolean): EdgePick[] {
    const view = [...this.bodies.values()].find(
      (v) => v.group.visible && v.partId === start.partId && v.componentId === start.componentId,
    );
    if (!view) return [start];
    const keyOf = (p: Vec3) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)},${Math.round(p[2] * 100)}`;
    const dirAt = (edge: EdgeInfo, point: Vec3): Vec3 | null => {
      const pts = edge.points;
      if (pts.length < 2) return null;
      const pointKey = keyOf(point);
      const isEnd = keyOf(pts[pts.length - 1]!) === pointKey;
      const end = isEnd ? pts[pts.length - 1] : pts[0];
      const ref = isEnd ? pts[Math.max(0, pts.length - 2)] : pts[1];
      const v: Vec3 = [end[0] - ref[0], end[1] - ref[1], end[2] - ref[2]];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const startEdge = view.data.edges.find((e) => e.index === start.edgeIndex);
    if (!startEdge) return [start];
    const picked = new Set<number>([start.edgeIndex]);
    const queue: EdgeInfo[] = [startEdge];
    while (queue.length && picked.size < 400) {
      const current = queue.shift()!;
      for (const endpoint of [current.points[0], current.points[current.points.length - 1]]) {
        if (!endpoint) continue;
        const endpointKey = keyOf(endpoint);
        for (const other of view.data.edges) {
          if (picked.has(other.index)) continue;
          const a = other.points[0];
          const b = other.points[other.points.length - 1];
          if (!a || !b) continue;
          let shared: Vec3 | null = null;
          if (keyOf(a) === endpointKey) shared = a;
          else if (keyOf(b) === endpointKey) shared = b;
          if (!shared) continue;
          if (tangentOnly) {
            const d1 = dirAt(current, endpoint);
            const d2 = dirAt(other, shared);
            if (!d1 || !d2) continue;
            const dot = Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]);
            if (dot < 0.985) continue;
          }
          picked.add(other.index);
          queue.push(other);
        }
      }
    }
    return [...picked]
      .map((index) => {
        const edge = view.data.edges.find((e) => e.index === index);
        return edge ? { componentId: view.componentId, partId: view.partId, edgeIndex: index, edge } : null;
      })
      .filter((e): e is EdgePick => !!e);
  }

  /** Align the camera with a face normal (SolidWorks' Normal To). */
  normalTo(point: Vec3, normal: Vec3): void {
    const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
    const target = new THREE.Vector3(point[0], point[1], point[2]);
    const distance = Math.max(this.camera.position.distanceTo(this.controls.target), this.sceneRadius() * 1.8);
    this.camera.up.copy(Math.abs(n.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0));
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(n, distance);
    this.controls.update();
    this.onCameraChange?.();
  }

  private updatePointerAt(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
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
    if (e.button === 0 && this.pickFilter !== "none" && !this.sketchPlane) {
      // A left drag on the canvas is a window/crossing selection in CAD mode;
      // orbit stays on the middle mouse button.
      this.startBand(e);
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (!this.down || e.button !== 0) {
      this.down = null;
      if (this.band) this.cancelBand();
      return;
    }
    const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
    this.down = null;
    if (this.band) {
      if (moved > 6) {
        this.finishBand(e);
        return;
      }
      this.cancelBand();
    }
    if (moved > 6 || this.pickFilter === "none") return;
    this.updatePointer(e);
    const filter = this.pickFilter;
    if (filter === "vertex") {
      this.onPickVertex?.(this.pickVertex(e.clientX, e.clientY));
      return;
    }
    if (filter === "all") {
      const vertex = this.pickVertex(e.clientX, e.clientY);
      if (vertex) {
        this.onPickVertex?.(vertex);
        return;
      }
      const edge = this.pickEdge();
      if (edge) {
        this.onPickEdge?.(edge);
        return;
      }
      this.onPickFace?.(this.pickFace());
      return;
    }
    if (filter === "edge") {
      const pick = this.pickEdge();
      if (pick) this.onPickEdge?.(pick);
      else this.onPickEdge?.(null);
    } else {
      const pick = this.pickFace();
      if (pick) this.onPickFace?.(pick);
      else this.onPickFace?.(null);
    }
  };

  private startBand(e: PointerEvent): void {
    this.cancelBand();
    const el = document.createElement("div");
    el.className = "select-band";
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.width = "0px";
    el.style.height = "0px";
    this.container.appendChild(el);
    this.band = { startX: e.clientX, startY: e.clientY, el, crossing: false };
  }

  private updateBand(e: PointerEvent): void {
    if (!this.band) return;
    const { startX, startY, el } = this.band;
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    this.band.crossing = e.clientX < startX;
    el.classList.toggle("crossing", this.band.crossing);
  }

  private cancelBand(): void {
    if (!this.band) return;
    this.band.el.remove();
    this.band = null;
  }

  private finishBand(e: PointerEvent): void {
    if (!this.band) return;
    const { startX, startY } = this.band;
    const crossing = e.clientX < startX;
    const rect = {
      x1: Math.min(startX, e.clientX),
      x2: Math.max(startX, e.clientX),
      y1: Math.min(startY, e.clientY),
      y2: Math.max(startY, e.clientY),
    };
    this.cancelBand();
    if (rect.x2 - rect.x1 < 4 || rect.y2 - rect.y1 < 4) return;
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const screen = (world: THREE.Vector3) => {
      const s = this.projectToScreen([world.x, world.y, world.z]);
      return { x: canvasRect.left + s.x, y: canvasRect.top + s.y, visible: s.visible };
    };
    const inside = (p: { x: number; y: number }) => p.x >= rect.x1 && p.x <= rect.x2 && p.y >= rect.y1 && p.y <= rect.y2;
    const faces: FacePick[] = [];
    const edges: EdgePick[] = [];
    const vertices: VertexPick[] = [];

    for (const view of this.bodies.values()) {
      if (!view.group.visible) continue;
      view.group.updateMatrixWorld(true);
      const data = view.data;
      for (const face of data.faces) {
        const triStart = face.triStart;
        const triCount = face.triCount;
        let any = false;
        let all = true;
        let seen = 0;
        for (let t = 0; t < triCount && seen < 240; t++) {
          const base = (triStart + t) * 3;
          for (let k = 0; k < 3; k++) {
            const idx = data.indices[base + k];
            const p = new THREE.Vector3(data.positions[idx * 3], data.positions[idx * 3 + 1], data.positions[idx * 3 + 2]);
            view.group.localToWorld(p);
            const s = screen(p);
            if (!s.visible) continue;
            seen++;
            if (inside(s)) any = true;
            else all = false;
          }
        }
        if (seen === 0) continue;
        if ((!crossing && all) || (crossing && any)) {
          faces.push({ componentId: view.componentId, partId: view.partId, faceIndex: face.index, face });
        }
      }
      for (const edge of data.edges) {
        let any = false;
        let all = true;
        for (const p of edge.points) {
          const world = new THREE.Vector3(p[0], p[1], p[2]);
          view.group.localToWorld(world);
          const s = screen(world);
          if (!s.visible) {
            all = false;
            continue;
          }
          if (inside(s)) any = true;
          else all = false;
        }
        if ((!crossing && all && edge.points.length > 0) || (crossing && any)) {
          edges.push({ componentId: view.componentId, partId: view.partId, edgeIndex: edge.index, edge });
        }
      }
      for (const v of this.vertices().filter((q) => q.componentId === view.componentId && q.partId === view.partId)) {
        const world = new THREE.Vector3(v.point[0], v.point[1], v.point[2]);
        const s = screen(world);
        if (s.visible && inside(s)) vertices.push(v);
      }
    }
    this.onBoxSelect?.({ faces, edges, vertices, crossing });
  }

  private openContextMenu(e: MouseEvent): void {
    this.updatePointerAt(e.clientX, e.clientY);
    const vertex = this.pickVertex(e.clientX, e.clientY);
    const edge = vertex ? null : this.pickEdge();
    const face = vertex || edge ? null : this.pickFace();
    this.onContextPick?.(e.clientX, e.clientY, {
      face: face ?? undefined,
      edge: edge ?? undefined,
      vertex: vertex ?? undefined,
    });
  }

  private handlePointerMove = (e: PointerEvent): void => {
    if (this.band) {
      this.updateBand(e);
      return;
    }
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
    this.cancelBand();
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

function clampNumber(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
