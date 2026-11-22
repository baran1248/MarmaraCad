import * as THREE from "three";
import type { FeaNodeResult, Vec3 } from "../model/types";
import type { Viewport } from "../viewport/Viewport";

export type ResultMode =
  | "deformation"
  | "directional-x"
  | "directional-y"
  | "directional-z"
  | "stress"
  | "max-principal"
  | "min-principal"
  | "shear"
  | "safety"
  | "reaction"
  | "temperature"
  | "mode"
  | "buckling";

/** Blue → cyan → green → yellow → orange → red, low to high. */
const STOPS: [number, number, number][] = [
  [0.16, 0.22, 0.62],
  [0.12, 0.47, 0.84],
  [0.14, 0.68, 0.62],
  [0.56, 0.79, 0.33],
  [0.96, 0.79, 0.24],
  [0.91, 0.42, 0.16],
  [0.69, 0.11, 0.16],
];

function cssColor(stop: [number, number, number]): string {
  return `rgb(${Math.round(stop[0] * 255)} ${Math.round(stop[1] * 255)} ${Math.round(stop[2] * 255)})`;
}

export const RESULT_GRADIENT = `linear-gradient(to top, ${STOPS.map(cssColor).join(", ")})`;
export const RESULT_GRADIENT_REVERSED = `linear-gradient(to top, ${[...STOPS].reverse().map(cssColor).join(", ")})`;

function sampleColor(t: number, out: Float32Array, offset: number): void {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
}

export interface ResultDisplay {
  mode: ResultMode;
  title: string;
  min: number;
  max: number;
  unit: string;
  gradient: string;
  /** Deformation amplification actually used (1 for stress/safety). */
  scale: number;
  /** Text summary for the status bar. */
  summary: string;
}

export interface ProbeReading {
  node: number;
  position: Vec3;
  displacement: Vec3;
  displacementMagnitude: number;
  vonMises: number;
  field: number;
  fieldLabel: string;
  unit: string;
}

interface FieldSpec {
  values: Float32Array;
  title: string;
  unit: string;
  min: number;
  max: number;
  gradient: string;
  reversed?: boolean;
  /** Deformation to draw for this result. */
  displacement?: Float32Array;
}

export class ResultView {
  private viewport: Viewport;
  private group = new THREE.Group();
  private markerGroup = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private wireframe: THREE.LineSegments | null = null;
  private material: THREE.MeshStandardMaterial;
  private result: FeaNodeResult | null = null;
  private yieldStrength = 250;
  private autoScale = 1;
  private modeIndex = 0;
  private activeMode: ResultMode = "stress";
  private activeField: FieldSpec | null = null;
  private activeScale = 1;
  private basePositions: Float32Array | null = null;
  private activeDisplacement: Float32Array | null = null;
  private animationPhase = 0;
  private animationActive = false;
  private minMaxVisible = false;
  private undeformedVisible = false;
  private probeNode: number | null = null;
  private probeMarker: THREE.Mesh | null = null;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
    this.group.name = "fea-result";
    this.markerGroup.name = "fea-result-markers";
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      metalness: 0.08,
      roughness: 0.58,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    viewport.scene.add(this.group);
    viewport.scene.add(this.markerGroup);
  }

  setResult(result: FeaNodeResult, yieldStrength: number): void {
    this.result = result;
    this.yieldStrength = Math.max(1e-6, yieldStrength);
    const maxDisp = Math.max(1e-9, result.maxDisplacement);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const p = result.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 100;
    this.autoScale = (diagonal * 0.08) / maxDisp;
  }

  get hasResult(): boolean {
    return this.result !== null;
  }

  get modeShapeCount(): number {
    return this.result?.modeShapes?.length ?? 0;
  }

  setModeIndex(index: number): void {
    this.modeIndex = Math.max(0, index);
  }

  getModeIndex(): number {
    return this.modeIndex;
  }

  getAnimationState(): { active: boolean; phase: number } {
    return { active: this.animationActive, phase: this.animationPhase };
  }

  setAnimation(active: boolean): void {
    this.animationActive = active;
    if (!active) {
      this.animationPhase = 0;
      this.applyPhase();
    }
  }

  /** Phase in [0,1]; the deformation oscillates as sin(2π·phase). */
  setAnimationPhase(phase: number): void {
    this.animationPhase = phase;
    if (this.animationActive) this.applyPhase();
  }

  setUndeformedWireframe(visible: boolean): void {
    this.undeformedVisible = visible;
    this.syncWireframe();
  }

  isUndeformedWireframeVisible(): boolean {
    return this.undeformedVisible;
  }

  setMinMaxFlags(visible: boolean): void {
    this.minMaxVisible = visible;
    this.buildMinMaxMarkers();
  }

  isMinMaxVisible(): boolean {
    return this.minMaxVisible;
  }

  setProbeNode(node: number | null): void {
    this.probeNode = node;
    this.buildProbeMarker();
  }

  clearProbe(): void {
    this.setProbeNode(null);
  }

  private fieldFor(mode: ResultMode): FieldSpec | null {
    const result = this.result;
    if (!result) return null;
    const field = (values: Float32Array | undefined, title: string, unit: string, gradient = RESULT_GRADIENT): FieldSpec | null => {
      if (!values || !values.length) return null;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < values.length; i++) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      return { values, title, unit, min, max, gradient };
    };
    const derived = (source: Float32Array, title: string, unit: string): FieldSpec => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < source.length; i++) {
        if (source[i] < min) min = source[i];
        if (source[i] > max) max = source[i];
      }
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max)) max = 0;
      return { values: source, title, unit, min, max, gradient: RESULT_GRADIENT };
    };
    if (mode === "deformation") {
      return {
        values: result.magnitude,
        title: "Total Deformation",
        unit: "mm",
        min: 0,
        max: Math.max(1e-12, result.maxDisplacement),
        gradient: RESULT_GRADIENT,
        displacement: result.displacement,
      };
    }
    if (mode === "stress") {
      const spec = derived(result.vonMises, "von Mises Stress", "MPa");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "safety") {
      const cap = this.safetyCap();
      const values = new Float32Array(result.vonMises.length);
      for (let i = 0; i < result.vonMises.length; i++) {
        const sf = result.vonMises[i] > 1e-9 ? this.yieldStrength / result.vonMises[i] : cap;
        values[i] = Math.min(cap, sf);
      }
      return {
        values,
        title: "Safety Factor",
        unit: "FoS",
        min: 0,
        max: cap,
        gradient: RESULT_GRADIENT_REVERSED,
        reversed: true,
        displacement: result.displacement,
      };
    }
    if (mode === "directional-x" || mode === "directional-y" || mode === "directional-z") {
      const axis = mode.endsWith("x") ? 0 : mode.endsWith("y") ? 1 : 2;
      const values = result.directional
        ? result.directional[axis === 0 ? "x" : axis === 1 ? "y" : "z"]
        : (() => {
            const out = new Float32Array(result.displacement.length / 3);
            for (let i = 0; i < out.length; i++) out[i] = result.displacement[i * 3 + axis];
            return out;
          })();
      const name = axis === 0 ? "X" : axis === 1 ? "Y" : "Z";
      const spec = derived(values, `Directional Deformation (${name})`, "mm");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "max-principal") {
      const spec = derived(result.maxPrincipal ?? new Float32Array(), "Maximum Principal Stress", "MPa");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "min-principal") {
      const spec = derived(result.minPrincipal ?? new Float32Array(), "Minimum Principal Stress", "MPa");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "shear") {
      const spec = derived(result.shearStress ?? new Float32Array(), "Maximum Shear Stress", "MPa");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "reaction") {
      const values = result.reactionForce ?? new Float32Array(result.magnitude.length);
      const spec = derived(values, "Reaction Force", "N");
      spec.displacement = result.displacement;
      return spec;
    }
    if (mode === "temperature") {
      const spec = field(result.temperature, "Temperature", "°C", RESULT_GRADIENT);
      return spec;
    }
    if (mode === "mode") {
      const shapes = result.modeShapes ?? [];
      const shape = shapes[Math.min(this.modeIndex, Math.max(0, shapes.length - 1))];
      if (!shape) return null;
      const magnitude = new Float32Array(shape.length / 3);
      let max = 0;
      for (let i = 0; i < magnitude.length; i++) {
        magnitude[i] = Math.hypot(shape[i * 3], shape[i * 3 + 1], shape[i * 3 + 2]);
        if (magnitude[i] > max) max = magnitude[i];
      }
      const frequency = result.frequencies?.[this.modeIndex];
      return {
        values: magnitude,
        title: `Mode ${this.modeIndex + 1}${frequency !== undefined ? ` — ${frequency.toFixed(2)} Hz` : ""}`,
        unit: "mm",
        min: 0,
        max: Math.max(1e-12, max),
        gradient: RESULT_GRADIENT,
        displacement: shape,
      };
    }
    if (mode === "buckling") {
      const shape = result.bucklingMode;
      if (!shape) return null;
      const magnitude = new Float32Array(shape.length / 3);
      let max = 0;
      for (let i = 0; i < magnitude.length; i++) {
        magnitude[i] = Math.hypot(shape[i * 3], shape[i * 3 + 1], shape[i * 3 + 2]);
        if (magnitude[i] > max) max = magnitude[i];
      }
      return {
        values: magnitude,
        title: "Buckling Mode",
        unit: "mm",
        min: 0,
        max: Math.max(1e-12, max),
        gradient: RESULT_GRADIENT,
        displacement: shape,
      };
    }
    return null;
  }

  private safetyCap(): number {
    const result = this.result;
    const maxStress = Math.max(1e-9, result?.maxStress ?? 1);
    return Math.min(Math.max(1, this.yieldStrength / maxStress), 15);
  }

  show(mode: ResultMode, userScale: number): ResultDisplay | null {
    const result = this.result;
    if (!result) return null;
    const field = this.fieldFor(mode);
    if (!field) return null;
    this.activeMode = mode;
    this.activeField = field;
    this.basePositions = result.positions;
    this.activeDisplacement = field.displacement ?? null;
    this.disposeMesh();
    this.buildGeometry();
    this.applyPhase();
    this.buildMinMaxMarkers();
    this.buildProbeMarker();
    this.syncWireframe();

    const isDeformation = mode === "deformation" || mode === "mode" || mode === "buckling";
    const scale = isDeformation ? this.autoScale * Math.max(0.01, userScale) : 1;
    this.activeScale = scale;
    let summary: string;
    if (mode === "stress") {
      summary = `max ${result.maxStress.toFixed(2)} MPa · yield ${this.yieldStrength.toFixed(0)} MPa · SF ${Number.isFinite(result.safetyFactor) ? result.safetyFactor.toFixed(2) : "∞"}`;
    } else if (mode === "safety") {
      summary = `min SF ${Number.isFinite(result.safetyFactor) ? result.safetyFactor.toFixed(2) : "∞"} · colour capped at ${field.max.toFixed(1)}`;
    } else if (mode === "reaction") {
      summary = `Fx ${result.reaction[0].toFixed(1)} N · Fy ${result.reaction[1].toFixed(1)} N · Fz ${result.reaction[2].toFixed(1)} N`;
    } else if (mode === "temperature") {
      summary = `min ${field.min.toFixed(1)} °C · max ${field.max.toFixed(1)} °C`;
    } else if (mode === "mode") {
      summary = `${field.title} · ${scale.toFixed(1)}× amplified`;
    } else if (mode === "buckling") {
      summary = `load multiplier ${Number.isFinite(result.bucklingMultiplier ?? Infinity) ? (result.bucklingMultiplier ?? 0).toFixed(3) : "∞"}`;
    } else if (isDeformation) {
      summary = `max ${result.maxDisplacement.toExponential(3)} mm · ${scale.toFixed(1)}× amplified`;
    } else {
      summary = `min ${field.min.toFixed(3)} · max ${field.max.toFixed(3)} ${field.unit}`;
    }
    return {
      mode,
      title: field.title,
      min: field.min,
      max: field.max,
      unit: field.unit,
      gradient: field.gradient,
      scale,
      summary,
    };
  }

  private buildGeometry(): void {
    const result = this.result;
    if (!result || !this.basePositions) return;
    const count = this.basePositions.length / 3;
    const colors = new Float32Array(count * 3);
    const field = this.activeField;
    const values = field?.values;
    const range = Math.max(1e-12, (field?.max ?? 1) - (field?.min ?? 0));
    for (let i = 0; i < count; i++) {
      let t = 0;
      if (values && values.length > i) t = (values[i] - (field?.min ?? 0)) / range;
      if (field?.reversed) t = 1 - t;
      sampleColor(t, colors, i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.basePositions), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.surfaceIndices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = "fea-result-mesh";
    this.mesh = mesh;
    this.group.add(mesh);
  }

  private applyPhase(): void {
    const mesh = this.mesh;
    const base = this.basePositions;
    if (!mesh || !base) return;
    const attribute = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const positions = attribute.array as Float32Array;
    const disp = this.activeDisplacement;
    const isDeformation = this.activeMode === "deformation" || this.activeMode === "mode" || this.activeMode === "buckling";
    const factor = isDeformation ? this.animationActive ? Math.sin(this.animationPhase * Math.PI * 2) : 1 : 0;
    const scale = isDeformation ? this.activeScale : 0;
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = base[i] + (disp ? disp[i] * scale * factor : 0);
      positions[i + 1] = base[i + 1] + (disp ? disp[i + 1] * scale * factor : 0);
      positions[i + 2] = base[i + 2] + (disp ? disp[i + 2] * scale * factor : 0);
    }
    attribute.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
  }

  private syncWireframe(): void {
    if (this.wireframe) {
      this.group.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      this.wireframe = null;
    }
    if (!this.undeformedVisible || !this.result || !this.basePositions) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.basePositions), 3));
    geometry.setIndex(new THREE.BufferAttribute(this.result.surfaceIndices, 1));
    const wires = new THREE.WireframeGeometry(geometry);
    const material = new THREE.LineBasicMaterial({ color: 0x8fb4d9, transparent: true, opacity: 0.55 });
    this.wireframe = new THREE.LineSegments(wires, material);
    this.wireframe.name = "fea-undeformed-wireframe";
    this.group.add(this.wireframe);
    geometry.dispose();
  }

  private buildMinMaxMarkers(): void {
    for (const child of [...this.markerGroup.children]) {
      if (child.userData.kind === "minmax") {
        this.markerGroup.remove(child);
        const mesh = child as THREE.Mesh;
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }
    if (!this.minMaxVisible || !this.result || !this.activeField) return;
    const values = this.activeField.values;
    let minNode = 0;
    let maxNode = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] < values[minNode]) minNode = i;
      if (values[i] > values[maxNode]) maxNode = i;
    }
    const size = Math.max(0.5, this.result.meshSize * 0.45);
    this.markerGroup.add(this.marker(this.result.positions, maxNode, 0xff3b30, size, "minmax"));
    this.markerGroup.add(this.marker(this.result.positions, minNode, 0x2f6bff, size, "minmax"));
  }

  private buildProbeMarker(): void {
    if (this.probeMarker) {
      this.markerGroup.remove(this.probeMarker);
      this.probeMarker.geometry.dispose();
      (this.probeMarker.material as THREE.Material).dispose();
      this.probeMarker = null;
    }
    if (this.probeNode === null || !this.result) return;
    const marker = this.marker(this.result.positions, this.probeNode, 0xffd60a, Math.max(0.8, this.result.meshSize * 0.6), "probe");
    this.probeMarker = marker;
    this.markerGroup.add(marker);
  }

  private marker(positions: Float32Array, node: number, color: number, radius: number, kind: string): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(radius, 14, 10);
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]);
    mesh.renderOrder = 40;
    mesh.userData.kind = kind;
    return mesh;
  }

  /** Nearest surface node to a screen point, using the rendered result mesh. */
  probeFromScreen(clientX: number, clientY: number): ProbeReading | null {
    const result = this.result;
    const mesh = this.mesh;
    if (!result || !mesh) return null;
    const rect = this.viewport.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, this.viewport.camera);
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) return null;
    const point = hits[0].point;
    const boundary = result.boundaryIndices.length ? result.boundaryIndices : null;
    let best = -1;
    let bestDist = Infinity;
    const count = result.positions.length / 3;
    const candidates = boundary ? Array.from(boundary) : Array.from({ length: count }, (_, i) => i);
    for (const node of candidates) {
      const dx = result.positions[node * 3] - point.x;
      const dy = result.positions[node * 3 + 1] - point.y;
      const dz = result.positions[node * 3 + 2] - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = node;
      }
    }
    if (best < 0) return null;
    this.setProbeNode(best);
    const field = this.activeField;
    return {
      node: best,
      position: [result.positions[best * 3], result.positions[best * 3 + 1], result.positions[best * 3 + 2]],
      displacement: [result.displacement[best * 3], result.displacement[best * 3 + 1], result.displacement[best * 3 + 2]],
      displacementMagnitude: result.magnitude[best] ?? 0,
      vonMises: result.vonMises[best] ?? 0,
      field: field?.values[best] ?? 0,
      fieldLabel: field?.title ?? "Value",
      unit: field?.unit ?? "",
    };
  }

  getFieldExtrema(): { min: number; max: number; minNode: number; maxNode: number } | null {
    const field = this.activeField;
    if (!field) return null;
    let minNode = 0;
    let maxNode = 0;
    for (let i = 1; i < field.values.length; i++) {
      if (field.values[i] < field.values[minNode]) minNode = i;
      if (field.values[i] > field.values[maxNode]) maxNode = i;
    }
    return { min: field.values[minNode], max: field.values[maxNode], minNode, maxNode };
  }

  clear(): void {
    this.disposeMesh();
    this.result = null;
    this.activeField = null;
    this.activeDisplacement = null;
    this.basePositions = null;
    this.probeNode = null;
    this.animationActive = false;
    for (const child of [...this.markerGroup.children]) {
      this.markerGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  private disposeMesh(): void {
    if (this.wireframe) {
      this.group.remove(this.wireframe);
      this.wireframe.geometry.dispose();
      this.wireframe = null;
    }
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  dispose(): void {
    this.clear();
    this.viewport.scene.remove(this.group);
    this.viewport.scene.remove(this.markerGroup);
    this.material.dispose();
  }
}
