import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { EdgeInfo, FaceInfo, MeshData, SketchPlane, Vec3 } from "../model/types";
import { bodyGeometry, edgeLineGeometry, edgePolylineGeometry, faceGeometry } from "./geometry";
import type { RendererBackend, RendererLike } from "./renderer";

export type ViewName = "front" | "back" | "top" | "bottom" | "right" | "left" | "iso";
export type DisplayStyle = "shaded-edges" | "shaded" | "wireframe";
export type PickFilter = "face" | "edge" | "vertex" | "all" | "none";
export type NavScheme = "cad" | "legacy";
export type ControlMode = "mouse" | "trackpad" | "pen";
export type MousePreset = "solidworks" | "fusion" | "ansys";
export type SectionAxis = "x" | "y" | "z";
/** Shapr3D trackpad default: two fingers always orbit, or always pan. */
export type TrackpadScheme = "orbit" | "pan";

export interface NavigationSettings {
  /** Multiplier applied to every orbit / pan / zoom gesture (0.25 – 3). */
  speed: number;
  /** Inertia retention per frame (0 = off, 0.92 = long glide). */
  damping: number;
  invertOrbitX: boolean;
  invertOrbitY: boolean;
  invertPan: boolean;
  /** Two-finger trackpad scroll performs orbit (default) or pan. */
  trackpadScheme: TrackpadScheme;
}

export const DEFAULT_NAVIGATION: NavigationSettings = {
  speed: 1,
  damping: 0.82,
  invertOrbitX: false,
  invertOrbitY: false,
  invertPan: false,
  trackpadScheme: "orbit",
};

export type NavSettingKey = keyof NavigationSettings;

export interface GizmoDragEvent {
  kind: "face" | "edge";
  /** Signed millimetres: positive pulls outwards / grows the fillet. */
  distance: number;
  done: boolean;
  face?: FacePick;
  edge?: EdgePick;
}

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
  /** Studio PBR taken from the part material (0 = dielectric, 1 = metal). */
  metalness?: number;
  roughness?: number;
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

/** A JPEG frame of the viewport, ready for a Gemini `inlineData` part. */
export interface ViewportCapture {
  mimeType: "image/jpeg";
  base64: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  /** Fraction of sampled pixels that differ from the corner pixel (0..1). */
  content: number;
  fallback: boolean;
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

function makeBodyMaterial(color: string, metalness = 0.18, roughness = 0.52): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    metalness,
    roughness,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/** Release every geometry/material below a preview group. */
function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose?.();
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
  /** Direct push/pull and edge-handle drags (face normal / fillet radius). */
  onGizmoDrag: ((event: GizmoDragEvent) => void) | null = null;
  /** One-finger double-tap on a face (Shapr3D "Normal To"). */
  onTouchDoubleTap: ((pick: FacePick | null) => void) | null = null;
  /** Three-finger horizontal swipe: -1 left (undo), +1 right (redo). */
  onThreeFingerSwipe: ((direction: -1 | 1) => void) | null = null;
  /** Assembly drag of a floating component (world delta in mm). */
  onComponentDrag: ((event: { componentId: string; delta: Vec3; done: boolean; start: boolean }) => void) | null = null;

  private bodies = new Map<string, BodyView>();
  private root = new THREE.Group();
  private planeGroup = new THREE.Group();
  private referenceGroup = new THREE.Group();
  private bendGroup = new THREE.Group();
  private gizmoGroup = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private nav: NavigationSettings = { ...DEFAULT_NAVIGATION };
  private inertia = { orbitX: 0, orbitY: 0, panX: 0, panY: 0 };
  private lastTick = 0;
  private gizmo: {
    kind: "face" | "edge";
    face?: FacePick;
    edge?: EdgePick;
    origin: THREE.Vector3;
    dir: THREE.Vector3;
    startX: number;
    startY: number;
    distance: number;
    /** Screen-space pixels per millimetre at the gizmo. */
    pxPerMm: number;
    screenDir: THREE.Vector2;
    object: THREE.Object3D;
    label: HTMLDivElement;
  } | null = null;
  private gizmoPreview: THREE.Mesh | null = null;
  private gizmoDragging = false;
  private componentDragEnabled = false;
  private bendLines: THREE.LineSegments | null = null;
  private touchTap: { time: number; x: number; y: number } | null = null;
  private swipe: { ids: number[]; startX: number; startY: number; fired: boolean } | null = null;
  private penArmed = false;
  private dragComponent: { id: string; lastX: number; lastY: number; moved: boolean } | null = null;
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
  private controlMode: ControlMode = "mouse";
  private mousePreset: MousePreset = "solidworks";
  private touchPointers = new Map<number, { x: number; y: number }>();
  private penTimer = 0;
  private penStart: { x: number; y: number } | null = null;
  private customDrag: { kind: "orbit" | "pan"; x: number; y: number } | null = null;
  private lastPinch = 0;
  readonly debugControl = { orbits: 0, pans: 0, zooms: 0, pinches: 0, penDown: 0, touches: 0, gizmoDrags: 0 };
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
  /** Studio backdrop: soft grid + faked contact shadow under the model. */
  private groundGroup = new THREE.Group();
  private shadowPlane: THREE.Mesh | null = null;
  /** Translucent live preview from a PropertyManager (Extrude, Cut, Fillet…). */
  private ghostGroup: THREE.Group | null = null;
  /** Last JPEG handed to the AI panel; the e2e suite reads this as evidence. */
  lastCapture: ViewportCapture | null = null;

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
    this.scene.add(this.referenceGroup);
    this.scene.add(this.bendGroup);
    this.scene.add(this.gizmoGroup);
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
    this.setupStudioEnvironment();
    this.buildOriginPlanes();
    this.buildStudioGround();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.handlePointerLeave);
    this.renderer.domElement.addEventListener("pointercancel", this.handlePointerCancel);
    this.renderer.domElement.style.touchAction = "none";
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

  setControlMode(mode: ControlMode): void {
    this.controlMode = mode;
    this.touchPointers.clear();
    this.customDrag = null;
    this.clearGizmo();
    this.applyNavScheme();
  }

  setMousePreset(preset: MousePreset): void {
    this.mousePreset = preset;
    this.applyNavScheme();
  }

  /** Apply the persisted Shapr3D navigation preferences. */
  setNavigationSettings(settings: Partial<NavigationSettings>): NavigationSettings {
    this.nav = {
      ...this.nav,
      ...settings,
      speed: clampNumber(settings.speed ?? this.nav.speed, 0.2, 3),
      damping: clampNumber(settings.damping ?? this.nav.damping, 0, 0.95),
      trackpadScheme: settings.trackpadScheme === "pan" ? "pan" : settings.trackpadScheme === "orbit" ? "orbit" : this.nav.trackpadScheme,
    };
    return { ...this.nav };
  }

  getNavigationSettings(): NavigationSettings {
    return { ...this.nav };
  }

  getControlState(): { mode: ControlMode; preset: MousePreset; navScheme: NavScheme; nav: NavigationSettings } {
    return { mode: this.controlMode, preset: this.mousePreset, navScheme: this.navScheme, nav: { ...this.nav } };
  }

  private applyNavScheme(): void {
    this.controls.enabled = this.controlMode === "mouse";
    this.controls.enableZoom = false;
    if (this.sketchPlane) {
      this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      return;
    }
    if (this.controlMode !== "mouse") {
      // Touch/pen navigation is handled by the Pointer Events code below; the
      // OrbitControls mouse mapping must not fight it.
      this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
      this.controls.mouseButtons.MIDDLE = null as unknown as THREE.MOUSE;
      this.controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;
      return;
    }
    if (this.navScheme === "legacy") {
      this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      return;
    }
    this.controls.mouseButtons.LEFT = null as unknown as THREE.MOUSE;
    this.controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;
    // Middle-button orbit/pan for all three presets is implemented in
    // handlePointerDown (customDrag), so OrbitControls must not also react.
    this.controls.mouseButtons.MIDDLE = null as unknown as THREE.MOUSE;
  }

  /** Orbit with the current sensitivity and invert flags. `record` seeds the
   *  inertia velocity; inertia frames call it with `record = false`. */
  private orbitBy(dx: number, dy: number, record = true): void {
    const speed = this.nav.speed;
    const ox = this.nav.invertOrbitX ? -1 : 1;
    const oy = this.nav.invertOrbitY ? -1 : 1;
    const stepX = dx * 0.005 * speed * ox;
    const stepY = dy * 0.005 * speed * oy;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= stepX;
    spherical.phi = clampNumber(spherical.phi - stepY, 0.05, Math.PI - 0.05);
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.debugControl.orbits++;
    if (record && this.nav.damping > 0.01) {
      this.inertia.orbitX = dx * 0.35;
      this.inertia.orbitY = dy * 0.35;
    }
    this.onCameraChange?.();
  }

  private panBy(dx: number, dy: number, record = true): void {
    const speed = this.nav.speed;
    const inv = this.nav.invertPan ? -1 : 1;
    const scale = this.worldPerPixel();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right
      .multiplyScalar(-dx * scale * speed * inv)
      .add(up.multiplyScalar(dy * scale * speed * inv));
    this.controls.target.add(move);
    this.camera.position.add(move);
    this.controls.update();
    this.debugControl.pans++;
    if (record && this.nav.damping > 0.01) {
      this.inertia.panX = dx * 0.35;
      this.inertia.panY = dy * 0.35;
    }
    this.onCameraChange?.();
  }

  /** Stop any residual glide (a new gesture or a view change cancels it). */
  private clearInertia(): void {
    this.inertia = { orbitX: 0, orbitY: 0, panX: 0, panY: 0 };
  }

  private applyInertia(dt: number): void {
    if (this.nav.damping <= 0.01) {
      this.clearInertia();
      return;
    }
    if (this.down || this.customDrag || this.touchPointers.size > 0 || this.viewAnim) {
      return;
    }
    const { orbitX, orbitY, panX, panY } = this.inertia;
    if (Math.abs(orbitX) + Math.abs(orbitY) + Math.abs(panX) + Math.abs(panY) < 0.02) {
      this.clearInertia();
      return;
    }
    const frames = clampNumber(dt / 16.67, 0.4, 2.5);
    const keep = Math.pow(this.nav.damping, frames);
    if (Math.abs(orbitX) + Math.abs(orbitY) > 0.02) this.orbitBy(orbitX, orbitY, false);
    if (Math.abs(panX) + Math.abs(panY) > 0.02) this.panBy(panX, panY, false);
    this.inertia.orbitX *= keep;
    this.inertia.orbitY *= keep;
    this.inertia.panX *= keep;
    this.inertia.panY *= keep;
  }

  /** Cursor-anchored dolly shared by mouse wheel, pinch and keyboard zoom. */
  zoomToward(clientX: number, clientY: number, factor: number): void {
    const before = this.camera.position.distanceTo(this.controls.target);
    const dist = clampNumber(before * factor, this.controls.minDistance, this.controls.maxDistance);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.8, 1);
    dir.normalize();
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
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
    this.debugControl.zooms++;
    this.onCameraChange?.();
  }

  /** Wheel routing follows the Shapr3D control mode:
   *  mouse = zoom, trackpad = two-finger orbit/pan (Shift pan, Ctrl/pinch zoom),
   *  pen = wheel zoom for hybrid pens that emit wheel events.
   *
   *  A trackpad two-finger scroll orbits in *both* axes: the old
   *  `|dx| > |dy| * 1.8` shortcut hijacked horizontal gestures into a pan and
   *  made the camera jump mid-orbit, so it is gone. */
  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const scale = e.deltaMode === 1 ? 18 : e.deltaMode === 2 ? 300 : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    if (this.controlMode === "trackpad" && !e.ctrlKey) {
      // Two fingers follow the chosen scheme; Shift swaps the roles, so
      // "Pan" + Shift = Orbit and "Orbit" + Shift = Pan.
      const scheme = this.nav.trackpadScheme === "pan" ? "pan" : "orbit";
      const pan = e.shiftKey ? scheme === "orbit" : scheme === "pan";
      if (pan) this.panBy(-dx * 0.9, -dy * 0.9);
      else this.orbitBy(dx * 0.55, dy * 0.55);
      return;
    }
    const factor = Math.exp(clampNumber(dy * 0.0011, -0.6, 0.6));
    this.zoomToward(e.clientX, e.clientY, factor);
    // Ctrl+wheel is the trackpad pinch gesture; keep it visible to the debug
    // hook and the status HUD alongside a plain wheel zoom.
    if (e.ctrlKey) this.debugControl.pinches++;
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

  /** Studio image-based lighting: RoomEnvironment through a PMREM prefilter.
   *
   *  The WebGL2 path uses Three's WebGL PMREM. The WebGPU renderer needs the
   *  PMREM implementation that ships with `three/webgpu`; it is imported lazily
   *  so WebGL2 clients never download the second bundle. If either path fails
   *  (older driver, headless GPU), a procedural equirect canvas keeps the
   *  viewport shaded instead of leaving materials flat. */
  private async setupStudioEnvironment(): Promise<void> {
    const room = new RoomEnvironment();
    try {
      if (this.backend === "webgpu") {
        const mod = (await import("three/webgpu")) as unknown as {
          PMREMGenerator?: new (renderer: RendererLike) => {
            fromScene(scene: THREE.Scene, sigma?: number): { texture: THREE.Texture };
            dispose(): void;
          };
        };
        if (!mod.PMREMGenerator) throw new Error("WebGPU PMREMGenerator is unavailable");
        const pmrem = new mod.PMREMGenerator(this.renderer);
        const target = pmrem.fromScene(room, 0.04);
        this.scene.environment = target.texture;
        this.scene.environmentIntensity = 0.9;
        pmrem.dispose();
      } else {
        const pmrem = new THREE.PMREMGenerator(this.renderer as unknown as THREE.WebGLRenderer);
        const target = pmrem.fromScene(room, 0.04);
        this.scene.environment = target.texture;
        this.scene.environmentIntensity = 0.9;
        pmrem.dispose();
      }
    } catch (error) {
      console.warn("Studio environment fell back to the procedural sky:", error);
      this.scene.environment = this.proceduralStudioEnvironment();
      this.scene.environmentIntensity = 0.75;
    } finally {
      room.traverse((child) => {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose?.();
      });
    }
  }

  /** Equirectangular studio gradient used when PMREM is not available. */
  private proceduralStudioEnvironment(): THREE.Texture {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const sky = ctx.createLinearGradient(0, 0, 0, 256);
      sky.addColorStop(0, "#f7fbff");
      sky.addColorStop(0.42, "#dfeaf3");
      sky.addColorStop(0.52, "#9fb2c3");
      sky.addColorStop(1, "#39434d");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 512, 256);
      // Overhead softbox + two side panels: the highlights that read as metal.
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(96, 18, 200, 26);
      ctx.fillRect(330, 42, 90, 40);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(20, 60, 54, 48);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  /** Soft grid and a faked contact shadow — cheaper and more stable than a
   *  shadow-map pass, and identical on WebGL2 and WebGPU. */
  private buildStudioGround(): void {
    const grid = new THREE.GridHelper(800, 80, 0xa9bccd, 0xd4dfe9);
    const gridMat = grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.34;
    gridMat.depthWrite = false;
    grid.raycast = () => undefined;
    this.groundGroup.add(grid);

    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = 256;
    shadowCanvas.height = 256;
    const ctx = shadowCanvas.getContext("2d");
    if (ctx) {
      const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 124);
      gradient.addColorStop(0, "rgba(18,32,46,0.42)");
      gradient.addColorStop(0.55, "rgba(18,32,46,0.18)");
      gradient.addColorStop(1, "rgba(18,32,46,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 256, 256);
    }
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    shadowTexture.colorSpace = THREE.SRGBColorSpace;
    const shadowGeometry = new THREE.PlaneGeometry(1, 1);
    shadowGeometry.rotateX(-Math.PI / 2);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.raycast = () => undefined;
    shadow.renderOrder = 0;
    this.shadowPlane = shadow;
    this.groundGroup.add(shadow);
    this.scene.add(this.groundGroup);
  }

  private updateGround(list: SceneBody[]): void {
    if (!this.shadowPlane) return;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const spec of list) {
      const offset = spec.position ?? [0, 0, 0];
      minX = Math.min(minX, spec.mesh.bbox.min[0] + offset[0]);
      maxX = Math.max(maxX, spec.mesh.bbox.max[0] + offset[0]);
      minY = Math.min(minY, spec.mesh.bbox.min[1] + offset[1]);
      minZ = Math.min(minZ, spec.mesh.bbox.min[2] + offset[2]);
      maxZ = Math.max(maxZ, spec.mesh.bbox.max[2] + offset[2]);
    }
    if (!Number.isFinite(minX)) {
      this.groundGroup.visible = false;
      return;
    }
    this.groundGroup.visible = true;
    const grid = this.groundGroup.children[0] as THREE.GridHelper;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const span = Math.max(20, Math.hypot(maxX - minX, maxZ - minZ));
    const floor = minY - Math.max(0.25, span * 0.004);
    grid.position.set(cx, floor, cz);
    const size = span * 2.6;
    this.shadowPlane.position.set(cx, floor - 0.02, cz);
    this.shadowPlane.scale.set(size, 1, size);
  }

  /** Show or clear a translucent live-preview group (world coordinates). */
  setGhost(group: THREE.Group | null): void {
    if (this.ghostGroup) {
      this.scene.remove(this.ghostGroup);
      disposeObject3D(this.ghostGroup);
    }
    this.ghostGroup = group;
    if (group) {
      group.renderOrder = 4;
      this.scene.add(group);
    }
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
    this.planesVisibleState = visible;
    this.planeGroup.visible = visible;
    this.referenceGroup.visible = visible;
  }

  /** Show user-created reference planes and axes. */
  setReferenceGeometry(
    planes: { id: string; name: string; origin: Vec3; u: Vec3; v: Vec3; n: Vec3; visible: boolean }[],
    axes: { id: string; origin: Vec3; direction: Vec3; visible: boolean }[],
  ): void {
    while (this.referenceGroup.children.length) {
      const child = this.referenceGroup.children.pop()!;
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose?.();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else (mesh.material as THREE.Material | undefined)?.dispose?.();
    }
    const size = 46;
    for (const plane of planes) {
      if (!plane.visible) continue;
      const geometry = new THREE.PlaneGeometry(size, size);
      const material = new THREE.MeshBasicMaterial({
        color: 0xb98b3f,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      const u = new THREE.Vector3(...plane.u).normalize();
      const v = new THREE.Vector3(...plane.v).normalize();
      const n = new THREE.Vector3(...plane.n).normalize();
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
      mesh.position.set(...plane.origin);
      this.referenceGroup.add(mesh);
      const border = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, -size / 2, 0),
          new THREE.Vector3(size / 2, size / 2, 0),
          new THREE.Vector3(-size / 2, size / 2, 0),
          new THREE.Vector3(-size / 2, -size / 2, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0xb98b3f, transparent: true, opacity: 0.75 }),
      );
      border.quaternion.copy(mesh.quaternion);
      border.position.copy(mesh.position);
      this.referenceGroup.add(border);
    }
    for (const axis of axes) {
      if (!axis.visible) continue;
      const dir = new THREE.Vector3(...axis.direction).normalize();
      const origin = new THREE.Vector3(...axis.origin);
      const geometry = new THREE.BufferGeometry().setFromPoints([
        origin.clone().addScaledVector(dir, -size / 2),
        origin.clone().addScaledVector(dir, size / 2),
      ]);
      this.referenceGroup.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x8a5a2b })));
    }
    this.referenceGroup.visible = this.planesVisibleState;
  }

  private planesVisibleState = false;

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
        view.material.color.set(spec.color);
        view.baseColor.set(spec.color);
        view.material.metalness = spec.metalness ?? 0.18;
        view.material.roughness = spec.roughness ?? 0.52;
        view.material.needsUpdate = true;
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
    this.updateGround(list);
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
    const material = makeBodyMaterial(spec.color, spec.metalness, spec.roughness);
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

  // ----------------------------------------------------------- direct modelling

  /** Enable the Shapr3D "drag a floating component" path (assembly mode). */
  setComponentDragEnabled(enabled: boolean): void {
    this.componentDragEnabled = enabled;
    if (!enabled) this.dragComponent = null;
  }

  /** Push/Pull arrow on a planar face. `null` clears it. */
  showFaceGizmo(pick: FacePick | null, label = ""): void {
    if (!pick || pick.face.surface !== "plane") {
      this.clearGizmo();
      return;
    }
    this.clearGizmo();
    const origin = new THREE.Vector3(...pick.face.point);
    const dir = new THREE.Vector3(...pick.face.normal).normalize();
    const length = Math.max(8, this.modelRadius() * 0.34);
    const material = new THREE.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false, transparent: true, opacity: 0.96 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(length * 0.028, length * 0.028, length * 0.8, 12), material);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(length * 0.085, length * 0.2, 16), material);
    tip.position.y = length * 0.5;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(length * 0.1, 14, 10), material);
    knob.position.y = length * 0.42;
    const handle = new THREE.Group();
    handle.add(shaft, tip, knob);
    handle.userData.gizmo = "face";
    handle.position.copy(origin);
    handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    handle.renderOrder = 999;
    this.gizmoGroup.add(handle);
    this.gizmo = {
      kind: "face",
      face: pick,
      origin,
      dir,
      startX: 0,
      startY: 0,
      distance: 0,
      pxPerMm: 1,
      screenDir: new THREE.Vector2(0, -1),
      object: handle,
      label: this.makeGizmoLabel(label || "Push / Pull"),
    };
  }

  /** Fillet/chamfer handle on a straight edge. `null` clears it. */
  showEdgeGizmo(pick: EdgePick | null): void {
    if (!pick || pick.edge.points.length < 2) {
      this.clearGizmo();
      return;
    }
    this.clearGizmo();
    const a = new THREE.Vector3(...pick.edge.points[0]);
    const b = new THREE.Vector3(...pick.edge.points[pick.edge.points.length - 1]);
    const origin = a.clone().add(b).multiplyScalar(0.5);
    const edgeDir = b.clone().sub(a);
    if (edgeDir.lengthSq() < 1e-9) edgeDir.set(1, 0, 0);
    edgeDir.normalize();
    const away = new THREE.Vector3().crossVectors(edgeDir, this.camera.position.clone().sub(origin)).normalize();
    const material = new THREE.MeshBasicMaterial({ color: 0x1f9dd8, depthTest: false, transparent: true, opacity: 0.95 });
    const knob = new THREE.Mesh(new THREE.SphereGeometry(Math.max(1.2, this.modelRadius() * 0.055), 16, 12), material);
    knob.userData.gizmo = "edge";
    knob.position.copy(origin).addScaledVector(away, Math.max(3, this.modelRadius() * 0.08));
    knob.renderOrder = 999;
    this.gizmoGroup.add(knob);
    this.gizmo = {
      kind: "edge",
      edge: pick,
      origin: knob.position.clone(),
      dir: away,
      startX: 0,
      startY: 0,
      distance: 0,
      pxPerMm: 1,
      screenDir: new THREE.Vector2(0.7, -0.7),
      object: knob,
      label: this.makeGizmoLabel("Fillet / Chamfer"),
    };
  }

  /** The active direct-modelling handle, for keyboard value entry. */
  getActiveGizmo(): { kind: "face" | "edge"; face?: FacePick; edge?: EdgePick; distance: number } | null {
    if (!this.gizmo) return null;
    return { kind: this.gizmo.kind, face: this.gizmo.face, edge: this.gizmo.edge, distance: this.gizmo.distance };
  }

  clearGizmo(): void {
    if (this.gizmoPreview) {
      this.gizmoPreview.parent?.remove(this.gizmoPreview);
      this.gizmoPreview.geometry.dispose();
      (this.gizmoPreview.material as THREE.Material).dispose();
      this.gizmoPreview = null;
    }
    for (const child of [...this.gizmoGroup.children]) {
      this.gizmoGroup.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.gizmo?.label.remove();
    this.gizmo = null;
    this.gizmoDragging = false;
  }

  private makeGizmoLabel(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "gizmo-label";
    el.textContent = text;
    this.container.appendChild(el);
    return el;
  }

  private updateGizmoLabel(text: string): void {
    if (!this.gizmo) return;
    this.gizmo.label.textContent = text;
    const screen = this.projectToScreen([this.gizmo.origin.x, this.gizmo.origin.y, this.gizmo.origin.z]);
    this.gizmo.label.style.left = `${screen.x}px`;
    this.gizmo.label.style.top = `${Math.max(12, screen.y - 34)}px`;
  }

  private startGizmoDrag(e: PointerEvent): boolean {
    if (!this.gizmo) return false;
    this.updatePointerAt(e.clientX, e.clientY);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.gizmoGroup.children, true);
    if (hits.length === 0) return false;
    const origin = this.gizmo.origin;
    const dir = this.gizmo.dir;
    const s0 = this.projectToScreen([origin.x, origin.y, origin.z]);
    const s1 = this.projectToScreen([origin.x + dir.x * 10, origin.y + dir.y * 10, origin.z + dir.z * 10]);
    const dx = s1.x - s0.x;
    const dy = s1.y - s0.y;
    const px = Math.hypot(dx, dy) / 10;
    this.gizmo.pxPerMm = Math.max(0.05, px);
    this.gizmo.screenDir = new THREE.Vector2(dx, dy).normalize();
    this.gizmo.startX = e.clientX;
    this.gizmo.startY = e.clientY;
    this.gizmo.distance = 0;
    this.gizmoDragging = true;
    this.down = null;
    e.preventDefault();
    this.updateGizmoLabel(this.gizmo.kind === "face" ? "0.0 mm" : "R 0.0");
    return true;
  }

  private updateGizmoDrag(clientX: number, clientY: number): void {
    if (!this.gizmo) return;
    const dx = clientX - this.gizmo.startX;
    const dy = clientY - this.gizmo.startY;
    let distance: number;
    if (this.gizmo.kind === "face") {
      distance = (dx * this.gizmo.screenDir.x + dy * this.gizmo.screenDir.y) / this.gizmo.pxPerMm;
    } else {
      // Edge handles read the diagonal (up-right grows, down-left shrinks).
      distance = (dx - dy) / this.gizmo.pxPerMm;
    }
    this.gizmo.distance = distance;
    if (this.gizmo.kind === "face") {
      this.updateGizmoLabel(`${distance >= 0 ? "+" : ""}${distance.toFixed(1)} mm`);
      this.updatePushPullPreview(distance);
      this.onGizmoDrag?.({ kind: "face", distance, done: false, face: this.gizmo.face });
    } else {
      this.updateGizmoLabel(distance >= 0 ? `R ${distance.toFixed(1)}` : `C ${Math.abs(distance).toFixed(1)}`);
      this.onGizmoDrag?.({ kind: "edge", distance, done: false, edge: this.gizmo.edge });
    }
    this.debugControl.gizmoDrags++;
  }

  private finishGizmoDrag(): void {
    if (!this.gizmo) return;
    const event: GizmoDragEvent = {
      kind: this.gizmo.kind,
      distance: this.gizmo.distance,
      done: true,
      face: this.gizmo.face,
      edge: this.gizmo.edge,
    };
    const moved = Math.abs(this.gizmo.distance) > 0.05;
    this.gizmoDragging = false;
    if (!moved) {
      // A click without movement just dismisses the handle.
      this.clearGizmo();
      return;
    }
    this.onGizmoDrag?.(event);
  }

  private updatePushPullPreview(distance: number): void {
    if (!this.gizmo || this.gizmo.kind !== "face" || !this.gizmo.face) return;
    const pick = this.gizmo.face;
    const view = [...this.bodies.values()].find(
      (v) => v.partId === pick.partId && v.componentId === pick.componentId,
    );
    if (!view) return;
    if (!this.gizmoPreview) {
      const geometry = faceGeometry(view.data, [pick.face.index]);
      if (!geometry) return;
      const material = new THREE.MeshBasicMaterial({
        color: 0xff9a3c,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.gizmoPreview = new THREE.Mesh(geometry, material);
      this.gizmoPreview.name = "push-pull-preview";
      view.group.add(this.gizmoPreview);
      this.gizmoPreview.userData.owner = view.key;
    }
    this.gizmoPreview.position.set(
      this.gizmo.dir.x * distance,
      this.gizmo.dir.y * distance,
      this.gizmo.dir.z * distance,
    );
  }

  /** Dashed bend lines of a sheet-metal flat pattern. The WebGPU backend has no
   *  LineDashedMaterial (it throws on the dash uniforms), so the gaps are baked
   *  into the geometry as short segments — renderer independent and visible. */
  setBendLines(segments: [Vec3, Vec3][]): void {
    for (const child of [...this.bendGroup.children]) {
      this.bendGroup.remove(child);
      const line = child as THREE.LineSegments;
      line.geometry?.dispose();
      (line.material as THREE.Material)?.dispose();
    }
    this.bendLines = null;
    if (segments.length === 0) return;
    const dash = 1.4;
    const gap = 0.9;
    const points: number[] = [];
    for (const [a, b] of segments) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (len < 1e-6) continue;
      const dir: Vec3 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
      for (let t = 0; t < len; t += dash + gap) {
        const t1 = Math.min(len, t + dash);
        points.push(a[0] + dir[0] * t, a[1] + dir[1] * t, a[2] + dir[2] * t);
        points.push(a[0] + dir[0] * t1, a[1] + dir[1] * t1, a[2] + dir[2] * t1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const material = new THREE.LineBasicMaterial({ color: 0xd8452a, linewidth: 1 });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = "sheet-metal-bends";
    this.bendGroup.add(lines);
    this.bendLines = lines;
  }

  hasBendLines(): boolean {
    return Boolean(this.bendLines);
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
    const startEdge = view.data.edges.find((e) => e.index === start.edgeIndex);
    if (!startEdge) return [start];
    const picked = new Set<number>([start.edgeIndex]);
    const visited = new Set<number>([start.edgeIndex]);
    const queue: EdgeInfo[] = [startEdge];
    const connects = (edge: EdgeInfo, endpointKey: string): boolean => {
      const a = edge.points[0];
      const b = edge.points[edge.points.length - 1];
      if (!a || !b) return false;
      return keyOf(a) === endpointKey || keyOf(b) === endpointKey;
    };

    if (!tangentOnly) {
      // Select Loop: the boundary of the planar face the picked edge lies on.
      // A box edge therefore yields the four edges of that face, not the whole
      // connected shell.
      const a0 = startEdge.points[0];
      const b0 = startEdge.points[startEdge.points.length - 1];
      if (a0 && b0) {
        const onPlane = (p: Vec3, face: FaceInfo) =>
          Math.abs(
            (p[0] - face.point[0]) * face.normal[0] +
              (p[1] - face.point[1]) * face.normal[1] +
              (p[2] - face.point[2]) * face.normal[2],
          ) < 0.05;
        const face = view.data.faces.find(
          (f) => f.surface === "plane" && onPlane(a0, f) && onPlane(b0, f),
        );
        if (face) {
          const onFace = (edge: EdgeInfo) => {
            const a = edge.points[0];
            const b = edge.points[edge.points.length - 1];
            if (!a || !b) return false;
            return onPlane(a, face) && (edge.closed || onPlane(b, face));
          };
          while (queue.length && picked.size < 400) {
            const current = queue.shift()!;
            for (const endpoint of [current.points[0], current.points[current.points.length - 1]]) {
              if (!endpoint) continue;
              const endpointKey = keyOf(endpoint);
              for (const other of view.data.edges) {
                if (visited.has(other.index) || !onFace(other) || !connects(other, endpointKey)) continue;
                visited.add(other.index);
                picked.add(other.index);
                queue.push(other);
              }
            }
          }
          return this.edgePicks(view, picked);
        }
      }
    }

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

    // Select Tangency: follow the direction of the previous edge, so fillet
    // surfaces and tangent arcs chain together and sharp corners stop the walk.
    while (queue.length && picked.size < 400) {
      const current = queue.shift()!;
      for (const endpoint of [current.points[0], current.points[current.points.length - 1]]) {
        if (!endpoint) continue;
        const endpointKey = keyOf(endpoint);
        for (const other of view.data.edges) {
          if (visited.has(other.index) || !connects(other, endpointKey)) continue;
          const d1 = dirAt(current, endpoint);
          const a = other.points[0];
          const b = other.points[other.points.length - 1];
          const d2 = keyOf(a!) === endpointKey ? dirAt(other, a!) : dirAt(other, b!);
          if (!d1 || !d2) continue;
          const dot = Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]);
          if (dot < 0.985) continue;
          visited.add(other.index);
          picked.add(other.index);
          queue.push(other);
        }
      }
    }
    return this.edgePicks(view, picked);
  }

  private edgePicks(
    view: { componentId: string | null; partId: string; data: MeshData },
    indices: Set<number>,
  ): EdgePick[] {
    return [...indices]
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
    return this.pickEdges()[0] ?? null;
  }

  /** Every edge under the cursor, nearest first. Convert Entities needs this:
   *  a click exactly on a corner can hit an edge that is perpendicular to the
   *  sketch plane, and projecting that one would only yield a zero-length line. */
  raycastEdgesAt(clientX: number, clientY: number): EdgePick[] {
    this.updatePointerAt(clientX, clientY);
    return this.pickEdges();
  }

  private pickEdges(): EdgePick[] {
    this.raycaster.params.Line = { threshold: Math.max(0.25, this.modelRadius() * 0.014) };
    const hits = this.raycaster.intersectObjects(this.edgeLines(), false);
    const out: EdgePick[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const line = hit.object as THREE.Line;
      if (!line.userData.pickEdge) continue;
      const key = line.userData.key as string;
      const view = this.bodies.get(key);
      const edgeIndex = line.userData.edgeIndex as number;
      const id = `${key}:${edgeIndex}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        componentId: view?.componentId ?? null,
        partId: view?.partId ?? "",
        edgeIndex,
        edge: line.userData.edge as EdgeInfo,
      });
    }
    return out;
  }

  private handlePointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      this.clearInertia();
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.debugControl.touches++;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* Synthetic pointer events have no active pointer to capture. */
      }
      if (this.touchPointers.size === 2) {
        const [a, b] = [...this.touchPointers.values()];
        this.lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      if (this.touchPointers.size === 3) {
        const pts = [...this.touchPointers.values()];
        this.swipe = {
          ids: [...this.touchPointers.keys()],
          startX: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
          startY: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
          fired: false,
        };
      }
      e.preventDefault();
      return;
    }
    if (e.pointerType === "pen") {
      this.debugControl.penDown++;
      this.penStart = { x: e.clientX, y: e.clientY };
      this.penArmed = false;
      this.cancelPenTimer();
      // A pen barrel/side button opens the context menu immediately; a
      // press-and-hold opens the same menu after the pen rests in place.
      if (e.button === 2) {
        e.preventDefault();
        this.openContextMenu(e);
        return;
      }
      this.penTimer = window.setTimeout(() => {
        this.penTimer = 0;
        if (this.penStart) this.openContextMenu({ clientX: this.penStart.x, clientY: this.penStart.y } as MouseEvent);
      }, 620);
    }
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
    // A gizmo handle wins over every navigation and selection route.
    if (e.button === 0 && this.startGizmoDrag(e)) return;
    // In the CAD mouse scheme OrbitControls no longer drives the middle button:
    // every preset route goes through customDrag, so the orbit/pan feel is
    // identical across SolidWorks, Fusion and Ansys (and it is observable).
    const cadMouse = this.controlMode === "mouse" && this.navScheme === "cad" && !this.sketchPlane;
    const wantsPan = e.button === 1 && (e.ctrlKey || e.metaKey || (cadMouse && this.mousePreset === "fusion" && !e.shiftKey));
    const wantsOrbit =
      e.button === 1 &&
      cadMouse &&
      ((this.mousePreset === "fusion" && e.shiftKey) || (this.mousePreset !== "fusion" && !e.ctrlKey && !e.metaKey));
    if ((wantsPan || wantsOrbit) && !this.sketchPlane) {
      e.preventDefault();
      this.clearInertia();
      this.controls.enabled = false;
      this.customDrag = { kind: wantsPan ? "pan" : "orbit", x: e.clientX, y: e.clientY };
      return;
    }
    // Assembly drag: a floating component follows the pointer with its mates
    // re-projected every frame. Left button only, and never in a sketch.
    if (e.button === 0 && !this.sketchPlane && this.pickFilter === "all" && this.componentDragEnabled) {
      const pick = this.pickFace();
      if (pick?.componentId) {
        this.dragComponent = { id: pick.componentId, lastX: e.clientX, lastY: e.clientY, moved: false };
        this.onComponentDrag?.({ componentId: pick.componentId, delta: [0, 0, 0], done: false, start: true });
        e.preventDefault();
        return;
      }
    }
    if (e.button === 0 && this.pickFilter !== "none" && !this.sketchPlane && e.pointerType !== "pen") {
      // A left drag on the canvas is a window/crossing selection in CAD mode;
      // orbit stays on the middle mouse button. Pen drags arm lazily after the
      // 4 px tremor dead-zone (see handlePointerMove).
      this.startBand(e);
    }
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      this.touchPointers.delete(e.pointerId);
      this.lastPinch = 0;
      if (this.touchPointers.size === 0) {
        this.down = null;
        this.swipe = null;
        // One-finger double-tap = Shapr3D "Normal To" on the tapped face.
        const tap = this.touchTap;
        const now = performance.now();
        if (tap && now - tap.time < 340 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 32) {
          this.touchTap = null;
          this.updatePointerAt(e.clientX, e.clientY);
          this.onTouchDoubleTap?.(this.pickFace());
        } else {
          this.touchTap = { time: now, x: e.clientX, y: e.clientY };
        }
      } else if (this.touchPointers.size < 3) {
        this.swipe = null;
      }
      return;
    }
    if (this.gizmo && this.gizmoDragging) {
      this.finishGizmoDrag();
      return;
    }
    if (this.dragComponent) {
      const drag = this.dragComponent;
      this.dragComponent = null;
      this.onComponentDrag?.({
        componentId: drag.id,
        delta: [0, 0, 0],
        done: true,
        start: false,
      });
      return;
    }
    if (this.penTimer) {
      this.cancelPenTimer();
      if (this.penStart && e.type === "pointerup") this.penStart = null;
    }
    if (this.customDrag) {
      this.customDrag = null;
      this.down = null;
      this.controls.enabled = this.controlMode === "mouse";
      return;
    }
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
    this.startBandAt(e.clientX, e.clientY);
  }

  private startBandAt(clientX: number, clientY: number): void {
    this.cancelBand();
    const el = document.createElement("div");
    el.className = "select-band";
    el.style.left = `${clientX}px`;
    el.style.top = `${clientY}px`;
    el.style.width = "0px";
    el.style.height = "0px";
    this.container.appendChild(el);
    this.band = { startX: clientX, startY: clientY, el, crossing: false };
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

  private cancelPenTimer(): void {
    if (this.penTimer) {
      window.clearTimeout(this.penTimer);
      this.penTimer = 0;
    }
  }

  private handlePointerCancel = (e: PointerEvent): void => {
    this.touchPointers.delete(e.pointerId);
    this.lastPinch = 0;
    if (this.customDrag) {
      this.customDrag = null;
      this.controls.enabled = this.controlMode === "mouse";
    }
    this.cancelPenTimer();
    this.penStart = null;
    this.down = null;
    if (this.band) this.cancelBand();
  };

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
    if (e.pointerType === "pen") {
      if (this.penStart) {
        const travel = Math.hypot(e.clientX - this.penStart.x, e.clientY - this.penStart.y);
        // 4 px tremor dead-zone: a pen that shakes while touching down must not
        // start a selection band or a drag.
        if (!this.penArmed) {
          if (travel <= 4) return;
          this.penArmed = true;
          if (this.pickFilter !== "none" && !this.sketchPlane) this.startBandAt(this.penStart.x, this.penStart.y);
        }
        if (travel > 6) {
          this.cancelPenTimer();
          this.penStart = null;
        }
      }
    }
    if (e.pointerType === "touch") {
      const before = this.touchPointers.get(e.pointerId);
      if (!before) return;
      this.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.swipe) {
        // Three-finger horizontal swipe = undo / redo. The camera stays still.
        const pts = [...this.touchPointers.values()];
        const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
        const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
        const dx = cx - this.swipe.startX;
        const dy = cy - this.swipe.startY;
        if (!this.swipe.fired && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          this.swipe.fired = true;
          this.onThreeFingerSwipe?.(dx > 0 ? 1 : -1);
        }
        return;
      }
      if (this.touchPointers.size >= 2) {
        const [a, b] = [...this.touchPointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // Move the centroid while pinching: two-finger pan + pinch zoom around
        // the midpoint between the fingers.
        this.panBy((e.clientX - before.x) / 2, (e.clientY - before.y) / 2);
        if (this.lastPinch > 4 && dist > 4) {
          this.zoomToward(midX, midY, this.lastPinch / dist);
          this.debugControl.pinches++;
        }
        this.lastPinch = dist;
      } else {
        this.orbitBy(e.clientX - before.x, e.clientY - before.y);
      }
      e.preventDefault();
      return;
    }
    if (this.gizmoDragging) {
      this.updateGizmoDrag(e.clientX, e.clientY);
      return;
    }
    if (this.dragComponent) {
      const drag = this.dragComponent;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (!drag.moved && Math.hypot(dx, dy) > 2) drag.moved = true;
      const scale = this.worldPerPixel();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
      const delta = right.multiplyScalar(dx * scale).add(up.multiplyScalar(-dy * scale));
      this.onComponentDrag?.({
        componentId: drag.id,
        delta: [delta.x, delta.y, delta.z],
        done: false,
        start: false,
      });
      return;
    }
    if (this.customDrag) {
      const dx = e.clientX - this.customDrag.x;
      const dy = e.clientY - this.customDrag.y;
      this.customDrag.x = e.clientX;
      this.customDrag.y = e.clientY;
      if (this.customDrag.kind === "pan") this.panBy(dx, dy);
      else this.orbitBy(dx, dy);
      return;
    }
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
    const now = performance.now();
    const dt = this.lastTick ? now - this.lastTick : 16.67;
    this.lastTick = now;
    if (this.viewAnim) {
      const a = Math.min(1, (performance.now() - this.viewAnim.start) / this.viewAnim.duration);
      const t = a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2;
      this.camera.position.lerpVectors(this.viewAnim.fromPos, this.viewAnim.toPos, t);
      this.controls.target.lerpVectors(this.viewAnim.fromTarget, this.viewAnim.toTarget, t);
      this.camera.up.lerpVectors(this.viewAnim.fromUp, this.viewAnim.toUp, t).normalize();
      if (a >= 1) this.viewAnim = null;
    } else {
      this.applyInertia(dt);
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

  /** Capture the current viewport as a downscaled JPEG for the multimodal AI.
   *  The frame is drawn into a 2D canvas so the result works for both WebGL2
   *  and WebGPU canvases, and so the image stays small enough for the model. */
  captureJpeg(quality = 0.78, maxWidth = 1024): ViewportCapture | null {
    const canvas = this.renderer.domElement;
    const encode = (fallback: boolean): ViewportCapture | null => {
      try {
        const scale = Math.min(1, maxWidth / Math.max(1, canvas.width));
        const width = Math.max(1, Math.round(canvas.width * scale));
        const height = Math.max(1, Math.round(canvas.height * scale));
        const out = document.createElement("canvas");
        out.width = width;
        out.height = height;
        const ctx = out.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(canvas, 0, 0, width, height);
        const dataUrl = out.toDataURL("image/jpeg", quality);
        const comma = dataUrl.indexOf(",");
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        let content = 0;
        try {
          const pixels = ctx.getImageData(0, 0, width, height).data;
          const r0 = pixels[0];
          const g0 = pixels[1];
          const b0 = pixels[2];
          const total = width * height;
          const step = Math.max(1, Math.floor(total / 6000));
          let samples = 0;
          let different = 0;
          for (let i = 0; i < total; i += step) {
            const o = i * 4;
            samples++;
            if (Math.abs(pixels[o] - r0) > 8 || Math.abs(pixels[o + 1] - g0) > 8 || Math.abs(pixels[o + 2] - b0) > 8) {
              different++;
            }
          }
          content = samples ? different / samples : 0;
        } catch {
          content = 0;
        }
        return {
          mimeType: "image/jpeg",
          base64,
          dataUrl,
          width,
          height,
          bytes: Math.round((base64.length * 3) / 4),
          content,
          fallback,
        };
      } catch {
        return null;
      }
    };

    // The last presented frame is already readable. If it is empty (a WebGPU
    // canvas can expose an unpresented buffer), force one frame and retry.
    let capture = encode(false);
    if (!capture || capture.content < 0.01) {
      this.renderer.render(this.scene, this.camera);
      capture = encode(true);
    }
    this.lastCapture = capture;
    return capture;
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
