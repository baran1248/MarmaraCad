import * as THREE from "three";
import type { FeaNodeResult } from "../model/types";
import type { Viewport } from "../viewport/Viewport";

export type ResultMode = "deformation" | "stress" | "safety";

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

export class ResultView {
  private viewport: Viewport;
  private group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private material: THREE.MeshStandardMaterial;
  private result: FeaNodeResult | null = null;
  private yieldStrength = 250;
  private autoScale = 1;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
    this.group.name = "fea-result";
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

  show(mode: ResultMode, userScale: number): ResultDisplay | null {
    const result = this.result;
    if (!result) return null;
    this.disposeMesh();

    const count = result.positions.length / 3;
    const positions = new Float32Array(result.positions.length);
    const colors = new Float32Array(count * 3);
    const deformation = mode === "deformation";
    const scale = deformation ? this.autoScale * userScale : 1;
    const maxStress = Math.max(1e-9, result.maxStress);
    const cap = Math.min(Math.max(1, this.yieldStrength / maxStress), 15);

    for (let i = 0; i < count; i++) {
      const o = i * 3;
      positions[o] = result.positions[o] + result.displacement[o] * (deformation ? scale : 0);
      positions[o + 1] = result.positions[o + 1] + result.displacement[o + 1] * (deformation ? scale : 0);
      positions[o + 2] = result.positions[o + 2] + result.displacement[o + 2] * (deformation ? scale : 0);

      let t: number;
      if (mode === "deformation") {
        t = result.magnitude[i] / Math.max(1e-12, result.maxDisplacement);
      } else if (mode === "stress") {
        t = result.vonMises[i] / maxStress;
      } else {
        const sf = result.vonMises[i] > 1e-9 ? this.yieldStrength / result.vonMises[i] : cap;
        t = 1 - Math.min(cap, sf) / cap;
      }
      sampleColor(t, colors, o);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.surfaceIndices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = "fea-result-mesh";
    this.mesh = mesh;
    this.group.add(mesh);

    if (mode === "deformation") {
      return {
        mode,
        title: "Total Deformation",
        min: 0,
        max: result.maxDisplacement,
        unit: "mm",
        gradient: RESULT_GRADIENT,
        scale,
        summary: `max ${result.maxDisplacement.toExponential(3)} mm · ${scale.toFixed(1)}× amplified`,
      };
    }
    if (mode === "stress") {
      return {
        mode,
        title: "Equivalent (von Mises) Stress",
        min: 0,
        max: result.maxStress,
        unit: "MPa",
        gradient: RESULT_GRADIENT,
        scale: 1,
        summary: `max ${result.maxStress.toFixed(2)} MPa · yield ${this.yieldStrength.toFixed(0)} MPa · SF ${Number.isFinite(result.safetyFactor) ? result.safetyFactor.toFixed(2) : "∞"}`,
      };
    }
    return {
      mode,
      title: "Safety Factor",
      min: 0,
      max: cap,
      unit: "FoS",
      gradient: RESULT_GRADIENT_REVERSED,
      scale: 1,
      summary: `min SF ${Number.isFinite(result.safetyFactor) ? result.safetyFactor.toFixed(2) : "∞"} · colour capped at ${cap.toFixed(1)}`,
    };
  }

  clear(): void {
    this.disposeMesh();
    this.result = null;
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  dispose(): void {
    this.clear();
    this.viewport.scene.remove(this.group);
    this.material.dispose();
  }
}
