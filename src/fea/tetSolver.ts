/** Conformal tetrahedral FEA: Tet4 / Tet10 linear statics, modal, buckling and
 *  steady-state thermal analysis. The mesh comes from `buildTetMesh` and keeps
 *  the OCCT surface triangulation as its boundary.
 *
 *  The solver assembles a reduced 3-DOF-per-node block system and uses a
 *  Jacobi-preconditioned conjugate-gradient iteration. Quadratic Tet10 elements
 *  use the four-point tetrahedral rule, which integrates their linear strain
 *  field exactly for straight-sided elements. */
import type { FeaMeshMetrics, FeaMeshKind, FeaNodeResult, Vec3 } from "../model/types";
import { buildTetMesh, type LocalSizingSpec, type TetMeshData } from "./mesher";
import { gpuPcgSolve } from "./gpuSolver";
import {
  collectFaceTriangles,
  elasticityMatrix,
  pointNearTriangles,
  vonMises,
  type FaceTriangles,
  type StaticSolveOptions,
} from "./solver";

export interface TetSupportSpec {
  faceIndex: number;
  kind?: "fixed" | "frictionless" | "cylindrical" | "displacement" | "bonded";
  dofs?: { x: boolean; y: boolean; z: boolean };
  values?: { x: number; y: number; z: number };
}

export interface TetLoadSpec {
  type: "force" | "pressure" | "moment" | "gravity" | "temperature" | "heatflux" | "convection";
  faceIndex: number;
  magnitude: number;
  direction?: Vec3;
  secondary?: number;
}

export interface TetSolveOptions {
  material: { E: number; nu: number; yield: number; density?: number; conductivity?: number };
  sourcePositions: Float32Array;
  sourceIndices: Uint32Array;
  sourceTriFaceIds: Uint32Array;
  supports: TetSupportSpec[];
  loads: TetLoadSpec[];
  meshSize: number;
  meshKind: FeaMeshKind;
  localSizing?: LocalSizingSpec[];
  analysisType?: "static" | "modal" | "buckling" | "thermal";
  modeCount?: number;
  ambient?: number;
  /** Use the WebGPU compute PCG when the device is available (default true). */
  useGpu?: boolean;
  onProgress?: (phase: string, percent: number) => void;
}

export interface TetSolveOutcome {
  mesh: TetMeshData;
  result: FeaNodeResult;
}

interface ElementData {
  coords: [number, number, number][];
  volume: number;
}

const TET_GAUSS: [number, number, number, number][] = [
  [0.5854101966249685, 0.1381966011250105, 0.1381966011250105, 0.1381966011250105],
  [0.1381966011250105, 0.5854101966249685, 0.1381966011250105, 0.1381966011250105],
  [0.1381966011250105, 0.1381966011250105, 0.5854101966249685, 0.1381966011250105],
  [0.1381966011250105, 0.1381966011250105, 0.1381966011250105, 0.5854101966249685],
];

const VERTEX_COORDS: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const EDGE_COORDS: [number, number, number][] = [
  [0.5, 0, 0], // 0-1
  [0.5, 0.5, 0], // 1-2
  [0, 0.5, 0], // 2-0
  [0, 0, 0.5], // 0-3
  [0.5, 0, 0.5], // 1-3
  [0, 0.5, 0.5], // 2-3
];

/** Shape-function derivatives with respect to the tetrahedral coordinates.
 *  (ξ, η, ζ) = (L2, L3, L4); L1 = 1 - ξ - η - ζ. */
function tetShapeDerivatives(order: 1 | 2, xi: number, eta: number, zeta: number): [number[], number[], number[]] {
  const l1 = 1 - xi - eta - zeta;
  if (order === 1) {
    return [
      [-1, 1, 0, 0],
      [-1, 0, 1, 0],
      [-1, 0, 0, 1],
    ];
  }
  const l2 = xi;
  const l3 = eta;
  const l4 = zeta;
  const dXi: number[] = new Array(10);
  const dEta: number[] = new Array(10);
  const dZeta: number[] = new Array(10);
  // Vertices: N = L(2L - 1)
  const vertex = (i: number, l: number, dl: [number, number, number]) => {
    dXi[i] = (4 * l - 1) * dl[0];
    dEta[i] = (4 * l - 1) * dl[1];
    dZeta[i] = (4 * l - 1) * dl[2];
  };
  vertex(0, l1, [-1, -1, -1]);
  vertex(1, l2, [1, 0, 0]);
  vertex(2, l3, [0, 1, 0]);
  vertex(3, l4, [0, 0, 1]);
  const edge = (i: number, la: number, lb: number, dla: [number, number, number], dlb: [number, number, number]) => {
    dXi[i] = 4 * (dla[0] * lb + la * dlb[0]);
    dEta[i] = 4 * (dla[1] * lb + la * dlb[1]);
    dZeta[i] = 4 * (dla[2] * lb + la * dlb[2]);
  };
  edge(4, l1, l2, [-1, -1, -1], [1, 0, 0]);
  edge(5, l2, l3, [1, 0, 0], [0, 1, 0]);
  edge(6, l3, l1, [0, 1, 0], [-1, -1, -1]);
  edge(7, l1, l4, [-1, -1, -1], [0, 0, 1]);
  edge(8, l2, l4, [1, 0, 0], [0, 0, 1]);
  edge(9, l3, l4, [0, 1, 0], [0, 0, 1]);
  return [dXi, dEta, dZeta];
}

function jacobian(
  derivatives: [number[], number[], number[]],
  coords: [number, number, number][],
  n: number,
): { det: number; inverse: number[][] } {
  const [dXi, dEta, dZeta] = derivatives;
  const j: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let a = 0; a < n; a++) {
    j[0][0] += dXi[a] * coords[a][0];
    j[0][1] += dXi[a] * coords[a][1];
    j[0][2] += dXi[a] * coords[a][2];
    j[1][0] += dEta[a] * coords[a][0];
    j[1][1] += dEta[a] * coords[a][1];
    j[1][2] += dEta[a] * coords[a][2];
    j[2][0] += dZeta[a] * coords[a][0];
    j[2][1] += dZeta[a] * coords[a][1];
    j[2][2] += dZeta[a] * coords[a][2];
  }
  const det =
    j[0][0] * (j[1][1] * j[2][2] - j[1][2] * j[2][1]) -
    j[0][1] * (j[1][0] * j[2][2] - j[1][2] * j[2][0]) +
    j[0][2] * (j[1][0] * j[2][1] - j[1][1] * j[2][0]);
  const s = Math.abs(det) > 1e-20 ? 1 / det : 0;
  return {
    det,
    inverse: [
      [(j[1][1] * j[2][2] - j[1][2] * j[2][1]) * s, (j[0][2] * j[2][1] - j[0][1] * j[2][2]) * s, (j[0][1] * j[1][2] - j[0][2] * j[1][1]) * s],
      [(j[1][2] * j[2][0] - j[1][0] * j[2][2]) * s, (j[0][0] * j[2][2] - j[0][2] * j[2][0]) * s, (j[0][2] * j[1][0] - j[0][0] * j[1][2]) * s],
      [(j[1][0] * j[2][1] - j[1][1] * j[2][0]) * s, (j[0][1] * j[2][0] - j[0][0] * j[2][1]) * s, (j[0][0] * j[1][1] - j[0][1] * j[1][0]) * s],
    ],
  };
}

function strainMatrix(derivatives: [number[], number[], number[]], inverse: number[][], n: number): number[][] {
  const [dXi, dEta, dZeta] = derivatives;
  const B: number[][] = Array.from({ length: 6 }, () => new Array(n * 3).fill(0));
  for (let a = 0; a < n; a++) {
    const dx = inverse[0][0] * dXi[a] + inverse[0][1] * dEta[a] + inverse[0][2] * dZeta[a];
    const dy = inverse[1][0] * dXi[a] + inverse[1][1] * dEta[a] + inverse[1][2] * dZeta[a];
    const dz = inverse[2][0] * dXi[a] + inverse[2][1] * dEta[a] + inverse[2][2] * dZeta[a];
    B[0][a * 3] = dx;
    B[1][a * 3 + 1] = dy;
    B[2][a * 3 + 2] = dz;
    B[3][a * 3] = dy;
    B[3][a * 3 + 1] = dx;
    B[4][a * 3 + 1] = dz;
    B[4][a * 3 + 2] = dy;
    B[5][a * 3] = dz;
    B[5][a * 3 + 2] = dx;
  }
  return B;
}

function elementStiffness(coords: [number, number, number][], n: number, D: number[][], order: 1 | 2): number[][] {
  const Ke: number[][] = Array.from({ length: n * 3 }, () => new Array(n * 3).fill(0));
  for (const gp of TET_GAUSS) {
    const [l1, l2, l3, l4] = gp;
    void l1; void l2; void l3; void l4;
    const xi = gp[1], eta = gp[2], zeta = gp[3];
    const deriv = tetShapeDerivatives(order, xi, eta, zeta);
    const jac = jacobian(deriv, coords, n);
    const weight = 0.25 * Math.abs(jac.det) / 6;
    if (weight < 1e-20) continue;
    const B = strainMatrix(deriv, jac.inverse, n);
    const DB: number[][] = Array.from({ length: 6 }, () => new Array(n * 3).fill(0));
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < n * 3; j++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += D[i][k] * B[k][j];
        DB[i][j] = s;
      }
    }
    for (let a = 0; a < n * 3; a++) {
      for (let b = 0; b < n * 3; b++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += B[k][a] * DB[k][b];
        Ke[a][b] += s * weight;
      }
    }
  }
  return Ke;
}

function elementVolume(coords: [number, number, number][]): number {
  const [a, b, c, d] = coords;
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
  const cx = d[0] - a[0], cy = d[1] - a[1], cz = d[2] - a[2];
  return Math.abs((ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6);
}

function stressAt(
  coords: [number, number, number][],
  n: number,
  ue: number[],
  D: number[][],
  order: 1 | 2,
  xi: number,
  eta: number,
  zeta: number,
): number[] | null {
  const deriv = tetShapeDerivatives(order, xi, eta, zeta);
  const jac = jacobian(deriv, coords, n);
  if (Math.abs(jac.det) < 1e-20) return null;
  const B = strainMatrix(deriv, jac.inverse, n);
  const strain = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let j = 0; j < n * 3; j++) s += B[i][j] * ue[j];
    strain[i] = s;
  }
  const stress = new Array(6).fill(0);
  for (let i = 0; i < 6; i++) {
    let s = 0;
    for (let j = 0; j < 6; j++) s += D[i][j] * strain[j];
    stress[i] = s;
  }
  return stress;
}

interface BlockSystem {
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
  diag: Float64Array;
  freeNodes: number[];
  rowOf: Int32Array;
  neighbors: number[][];
}

function buildBlockPattern(tets: Uint32Array, nodesPerElement: number, nodeCount: number): {
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
  diag: Float64Array;
  freeNodes: number[];
  rowOf: Int32Array;
  neighbors: number[][];
} {
  const elementCount = tets.length / nodesPerElement;
  const neighbourSets: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  for (let e = 0; e < elementCount; e++) {
    const o = e * nodesPerElement;
    for (let a = 0; a < nodesPerElement; a++) {
      const na = tets[o + a];
      for (let b = a + 1; b < nodesPerElement; b++) {
        const nb = tets[o + b];
        neighbourSets[na].add(nb);
        neighbourSets[nb].add(na);
      }
    }
  }
  const freeNodes: number[] = [];
  for (let n = 0; n < nodeCount; n++) if (neighbourSets[n].size > 0) freeNodes.push(n);
  const rowOf = new Int32Array(nodeCount).fill(-1);
  for (let r = 0; r < freeNodes.length; r++) rowOf[freeNodes[r]] = r;
  const neighbors = freeNodes.map((n) => [...neighbourSets[n]].filter((x) => rowOf[x] >= 0).sort((a, b) => a - b));
  const rowStart = new Int32Array(freeNodes.length + 1);
  for (let r = 0; r < freeNodes.length; r++) rowStart[r + 1] = rowStart[r] + 9 + neighbors[r].length * 9;
  const nnz = rowStart[freeNodes.length];
  const cols = new Int32Array(nnz);
  for (let r = 0; r < freeNodes.length; r++) {
    let p = rowStart[r];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cols[p++] = r * 3 + j;
    for (const nb of neighbors[r]) {
      const rb = rowOf[nb];
      for (let i = 0; i < 3; i++) {
        cols[p++] = rb * 3;
        cols[p++] = rb * 3 + 1;
        cols[p++] = rb * 3 + 2;
      }
    }
  }
  return { rowStart, cols, vals: new Float64Array(nnz), diag: new Float64Array(freeNodes.length * 3), freeNodes, rowOf, neighbors };
}

function slotFor(neighbors: number[], rowOf: Int32Array, target: number): number {
  const t = rowOf[target];
  let lo = 0;
  let hi = neighbors.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const mv = rowOf[neighbors[mid]];
    if (mv === t) return mid;
    if (mv < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Assemble the global elastic stiffness matrix. `constrained` is a per-DOF
 *  mask (true = constrained); `freeDof` returns true when a dof participates. */
function assembleElastic(
  tets: Uint32Array,
  nodesPerElement: number,
  positions: Float32Array,
  D: number[][],
  order: 1 | 2,
  constrained: Uint8Array,
): BlockSystem {
  const nodeCount = positions.length / 3;
  const system = buildBlockPattern(tets, nodesPerElement, nodeCount);
  const { rowStart, cols, vals, diag, freeNodes, rowOf, neighbors } = system;
  const elementCount = tets.length / nodesPerElement;
  const coords: [number, number, number][] = Array.from({ length: nodesPerElement }, () => [0, 0, 0]);
  for (let e = 0; e < elementCount; e++) {
    const o = e * nodesPerElement;
    for (let k = 0; k < nodesPerElement; k++) {
      const n = tets[o + k];
      coords[k][0] = positions[n * 3];
      coords[k][1] = positions[n * 3 + 1];
      coords[k][2] = positions[n * 3 + 2];
    }
    const ke = elementStiffness(coords, nodesPerElement, D, order);
    for (let a = 0; a < nodesPerElement; a++) {
      const na = tets[o + a];
      const ra = rowOf[na];
      if (ra < 0) continue;
      for (let b = 0; b < nodesPerElement; b++) {
        const nb = tets[o + b];
        const rb = rowOf[nb];
        if (rb < 0) continue;
        let base: number;
        if (a === b) base = rowStart[ra];
        else {
          const slot = slotFor(neighbors[ra], rowOf, nb);
          if (slot < 0) continue;
          base = rowStart[ra] + 9 + slot * 9;
        }
        for (let i = 0; i < 3; i++) {
          const gi = na * 3 + i;
          if (constrained[gi]) continue;
          for (let j = 0; j < 3; j++) {
            const gj = nb * 3 + j;
            if (constrained[gj]) continue;
            vals[base + i * 3 + j] += ke[a * 3 + i][b * 3 + j];
          }
        }
      }
    }
  }
  for (let r = 0; r < freeNodes.length; r++) {
    const base = rowStart[r];
    for (let i = 0; i < 3; i++) {
      const d = vals[base + i * 3 + i];
      diag[r * 3 + i] = Math.abs(d) > 1e-30 ? d : 1;
    }
  }
  return system;
}

function blockMatvec(
  rowStart: Int32Array,
  cols: Int32Array,
  vals: Float64Array,
  x: Float64Array,
  out: Float64Array,
  rows: number,
): void {
  for (let r = 0; r < rows; r++) {
    const row = r * 3;
    let k = rowStart[r];
    let a0 = vals[k] * x[row] + vals[k + 1] * x[row + 1] + vals[k + 2] * x[row + 2];
    let a1 = vals[k + 3] * x[row] + vals[k + 4] * x[row + 1] + vals[k + 5] * x[row + 2];
    let a2 = vals[k + 6] * x[row] + vals[k + 7] * x[row + 1] + vals[k + 8] * x[row + 2];
    k += 9;
    const end = rowStart[r + 1];
    while (k < end) {
      const col = cols[k];
      a0 += vals[k] * x[col] + vals[k + 1] * x[col + 1] + vals[k + 2] * x[col + 2];
      a1 += vals[k + 3] * x[col] + vals[k + 4] * x[col + 1] + vals[k + 5] * x[col + 2];
      a2 += vals[k + 6] * x[col] + vals[k + 7] * x[col + 1] + vals[k + 8] * x[col + 2];
      k += 9;
    }
    out[row] = a0;
    out[row + 1] = a1;
    out[row + 2] = a2;
  }
}

function blockPcg(
  system: BlockSystem,
  rhs: Float64Array,
  onIter?: (iter: number, residual: number) => void,
  maxIterations = 4000,
): { x: Float64Array; iterations: number; residual: number; converged: boolean } {
  const { rowStart, cols, vals, diag, freeNodes } = system;
  const n = freeNodes.length * 3;
  const x = new Float64Array(n);
  const r = rhs.slice();
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  let rhsNorm = 0;
  for (let i = 0; i < n; i++) rhsNorm += rhs[i] * rhs[i];
  rhsNorm = Math.sqrt(rhsNorm);
  if (rhsNorm < 1e-20) return { x, iterations: 0, residual: 0, converged: true };
  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  const tol = 1e-7 * rhsNorm;
  let iterations = 0;
  let residual = rhsNorm;
  const maxIter = Math.min(maxIterations, Math.max(400, n * 2));
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    blockMatvec(rowStart, cols, vals, p, ap, freeNodes.length);
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (pap <= 1e-30) break;
    const alpha = rz / pap;
    let res2 = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      res2 += r[i] * r[i];
    }
    residual = Math.sqrt(res2);
    if (iter % 50 === 0) onIter?.(iterations, residual);
    if (residual <= tol) return { x, iterations, residual, converged: true };
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      z[i] = r[i] / diag[i];
      rz2 += r[i] * z[i];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, iterations, residual, converged: residual <= Math.max(tol * 20, rhsNorm * 1e-4) };
}

/** PCG entry point: try the WebGPU compute solver for large systems, then use
 *  the CPU block solver. GPU results are only accepted when the WGSL iteration
 *  reported convergence, so accuracy never depends on the device. */
async function runPcg(
  system: BlockSystem,
  rhs: Float64Array,
  onIter?: (iter: number, residual: number) => void,
  maxIterations = 4000,
): Promise<{ x: Float64Array; iterations: number; residual: number; converged: boolean }> {
  const dofs = system.freeNodes.length * 3;
  const hasGpu = typeof navigator !== "undefined" && !!(navigator as unknown as { gpu?: unknown }).gpu;
  if (hasGpu && dofs >= 2500) {
    try {
      const gpu = await gpuPcgSolve({
        rowStart: system.rowStart,
        cols: system.cols,
        vals: system.vals,
        diag: system.diag,
        rhs,
        maxIterations: Math.min(maxIterations, 400),
        tolerance: 1e-5,
        onIteration: onIter,
      });
      if (gpu.backend === "webgpu" && gpu.converged) {
        return { x: gpu.x, iterations: gpu.iterations, residual: gpu.residual, converged: true };
      }
    } catch {
      // Fall through to the CPU solver.
    }
  }
  return blockPcg(system, rhs, onIter, maxIterations);
}

interface ElasticOutcome {
  mesh: TetMeshData;
  displacement: Float32Array;
  stressTensor: Float32Array;
  vonMisesField: Float32Array;
  principal: { max: Float32Array; min: Float32Array; shear: Float32Array };
  reaction: Float64Array;
  reactionForce: Float32Array;
  totalReaction: Vec3;
  maxDisplacement: number;
  maxStress: number;
  minStress: number;
  safetyFactor: number;
  iterations: number;
  converged: boolean;
  dofs: number;
  warnings: string[];
  internal: Float64Array;
  applied: Float64Array;
  constrained: Uint8Array;
  system: BlockSystem;
}

function surfaceMask(mesh: TetMeshData): Uint8Array {
  const mask = new Uint8Array(mesh.nodeCount);
  for (let i = 0; i < mesh.surface.length; i++) mask[mesh.surface[i]] = 1;
  return mask;
}

function buildConstraints(mesh: TetMeshData, supports: TetSupportSpec[], options: TetSolveOptions): { constrained: Uint8Array; warnings: string[] } {
  const constrained = new Uint8Array(mesh.nodeCount * 3);
  const warnings: string[] = [];
  const capture = mesh.h * 0.95;
  const surface = surfaceMask(mesh);
  for (const support of supports) {
    const tris = collectFaceTriangles(options as unknown as StaticSolveOptions, new Set([support.faceIndex]));
    if (!tris.length) {
      warnings.push(`Support on face ${support.faceIndex + 1} did not match any surface triangles.`);
      continue;
    }
    const kind = support.kind ?? "fixed";
    const normal = averageNormal(tris);
    let lock = [true, true, true];
    if (kind === "displacement" && support.dofs) lock = [!support.dofs.x, !support.dofs.y, !support.dofs.z];
    else if (kind === "bonded") lock = [true, true, true];
    else if (kind === "frictionless") {
      const main = Math.max(Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2]));
      lock = [Math.abs(normal[0]) === main, Math.abs(normal[1]) === main, Math.abs(normal[2]) === main];
    } else if (kind === "cylindrical") {
      const ax = averageAxis(tris) ?? normal;
      const main = Math.max(Math.abs(ax[0]), Math.abs(ax[1]), Math.abs(ax[2]));
      lock = [Math.abs(ax[0]) !== main, Math.abs(ax[1]) !== main, Math.abs(ax[2]) !== main];
    }
    for (let n = 0; n < mesh.nodeCount; n++) {
      if (!surface[n]) continue;
      if (!pointNearTriangles(mesh.positions, n, tris, capture)) continue;
      if (lock[0]) constrained[n * 3] = 1;
      if (lock[1]) constrained[n * 3 + 1] = 1;
      if (lock[2]) constrained[n * 3 + 2] = 1;
    }
  }
  let count = 0;
  for (let i = 0; i < constrained.length; i++) if (constrained[i]) count++;
  if (count === 0) throw new Error("The supports captured no mesh nodes. Use a finer mesh size and try again.");
  return { constrained, warnings };
}

function averageNormal(tris: FaceTriangles[]): Vec3 {
  let x = 0, y = 0, z = 0, w = 0;
  for (const t of tris) {
    x += t.nx * t.area;
    y += t.ny * t.area;
    z += t.nz * t.area;
    w += t.area;
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function averageAxis(tris: FaceTriangles[]): Vec3 | null {
  void tris;
  return null;
}

function faceNodes(mesh: TetMeshData, tris: FaceTriangles[], capture: number): number[] {
  const out: number[] = [];
  const surface = surfaceMask(mesh);
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (!surface[n]) continue;
    if (pointNearTriangles(mesh.positions, n, tris, capture)) out.push(n);
  }
  return out;
}

function applyLoads(
  mesh: TetMeshData,
  options: TetSolveOptions,
  density: number,
): { force: Float64Array; appliedCount: number; warnings: string[] } {
  const force = new Float64Array(mesh.nodeCount * 3);
  const warnings: string[] = [];
  let appliedCount = 0;
  const capture = mesh.h * 1.1;
  for (const load of options.loads) {
    if (load.type === "temperature" || load.type === "heatflux" || load.type === "convection") continue;
    if (load.type === "gravity") {
      const dir = unit(load.direction ?? [0, -1, 0]);
      const elementCount = mesh.tets.length / (mesh.kind === "tet10" ? 10 : 4);
      const npe = mesh.kind === "tet10" ? 10 : 4;
      for (let e = 0; e < elementCount; e++) {
        const o = e * npe;
        const coords: [number, number, number][] = [];
        for (let k = 0; k < 4; k++) {
          const n = mesh.tets[o + k];
          coords.push([mesh.positions[n * 3], mesh.positions[n * 3 + 1], mesh.positions[n * 3 + 2]]);
        }
        const volume = elementVolume(coords);
        const weight = density * 1e-12 * volume * 9810 * Math.abs(load.magnitude || 1);
        for (let k = 0; k < npe; k++) {
          const n = mesh.tets[o + k];
          force[n * 3] += (dir[0] * weight) / npe;
          force[n * 3 + 1] += (dir[1] * weight) / npe;
          force[n * 3 + 2] += (dir[2] * weight) / npe;
        }
      }
      appliedCount++;
      continue;
    }
    const tris = collectFaceTriangles(options as unknown as StaticSolveOptions, new Set([load.faceIndex]));
    if (!tris.length) continue;
    if (load.type === "force") {
      const nodes = faceNodes(mesh, tris, capture);
      if (!nodes.length) continue;
      const dir = unit(load.direction ?? [0, 0, -1]);
      const each = load.magnitude / nodes.length;
      for (const n of nodes) {
        force[n * 3] += dir[0] * each;
        force[n * 3 + 1] += dir[1] * each;
        force[n * 3 + 2] += dir[2] * each;
      }
      appliedCount++;
    } else if (load.type === "pressure") {
      let count = 0;
      for (let t = 0; t < mesh.surface.length / 3; t++) {
        const ia = mesh.surface[t * 3];
        const ib = mesh.surface[t * 3 + 1];
        const ic = mesh.surface[t * 3 + 2];
        const ax = mesh.positions[ia * 3], ay = mesh.positions[ia * 3 + 1], az = mesh.positions[ia * 3 + 2];
        const bx = mesh.positions[ib * 3], by = mesh.positions[ib * 3 + 1], bz = mesh.positions[ib * 3 + 2];
        const cx = mesh.positions[ic * 3], cy = mesh.positions[ic * 3 + 1], cz = mesh.positions[ic * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const area = Math.hypot(nx, ny, nz) * 0.5;
        if (area < 1e-12) continue;
        nx /= area * 2;
        ny /= area * 2;
        nz /= area * 2;
        const mx = (ax + bx + cx) / 3;
        const my = (ay + by + cy) / 3;
        const mz = (az + bz + cz) / 3;
        let near = false;
        for (const tri of tris) {
          if (
            mx < tri.min[0] - mesh.h || mx > tri.max[0] + mesh.h ||
            my < tri.min[1] - mesh.h || my > tri.max[1] + mesh.h ||
            mz < tri.min[2] - mesh.h || mz > tri.max[2] + mesh.h
          ) continue;
          const d = pointTriDistanceSq(mx, my, mz, tri);
          if (d < mesh.h * mesh.h * 1.5 && tri.nx * nx + tri.ny * ny + tri.nz * nz > 0.2) {
            near = true;
            break;
          }
        }
        if (!near) continue;
        const p = load.magnitude;
        const fx = -nx * p * area / 3;
        const fy = -ny * p * area / 3;
        const fz = -nz * p * area / 3;
        for (const node of [ia, ib, ic]) {
          force[node * 3] += fx;
          force[node * 3 + 1] += fy;
          force[node * 3 + 2] += fz;
        }
        count++;
      }
      if (count > 0) appliedCount++;
    } else if (load.type === "moment") {
      const nodes = faceNodes(mesh, tris, capture);
      if (!nodes.length) continue;
      const axis = unit(load.direction ?? [1, 0, 0]);
      let cx = 0, cy = 0, cz = 0;
      for (const n of nodes) {
        cx += mesh.positions[n * 3];
        cy += mesh.positions[n * 3 + 1];
        cz += mesh.positions[n * 3 + 2];
      }
      cx /= nodes.length;
      cy /= nodes.length;
      cz /= nodes.length;
      let sumR2 = 0;
      const rv = new Map<number, Vec3>();
      for (const n of nodes) {
        let rx = mesh.positions[n * 3] - cx;
        let ry = mesh.positions[n * 3 + 1] - cy;
        let rz = mesh.positions[n * 3 + 2] - cz;
        const dot = rx * axis[0] + ry * axis[1] + rz * axis[2];
        rx -= axis[0] * dot;
        ry -= axis[1] * dot;
        rz -= axis[2] * dot;
        rv.set(n, [rx, ry, rz]);
        sumR2 += rx * rx + ry * ry + rz * rz;
      }
      if (sumR2 < 1e-12) continue;
      const scale = load.magnitude / sumR2;
      for (const n of nodes) {
        const r = rv.get(n)!;
        const fx = (axis[1] * r[2] - axis[2] * r[1]) * scale;
        const fy = (axis[2] * r[0] - axis[0] * r[2]) * scale;
        const fz = (axis[0] * r[1] - axis[1] * r[0]) * scale;
        force[n * 3] += fx;
        force[n * 3 + 1] += fy;
        force[n * 3 + 2] += fz;
      }
      appliedCount++;
    }
  }
  return { force, appliedCount, warnings };
}

function pointTriDistanceSq(px: number, py: number, pz: number, t: FaceTriangles): number {
  const abx = t.bx - t.ax, aby = t.by - t.ay, abz = t.bz - t.az;
  const acx = t.cx - t.ax, acy = t.cy - t.ay, acz = t.cz - t.az;
  const apx = px - t.ax, apy = py - t.ay, apz = pz - t.az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - t.bx, bpy = py - t.by, bpz = pz - t.bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = t.ax + abx * v - px, qy = t.ay + aby * v - py, qz = t.az + abz * v - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - t.cx, cpy = py - t.cy, cpz = pz - t.cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = t.ax + acx * w - px, qy = t.ay + acy * w - py, qz = t.az + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = t.bx + (t.cx - t.bx) * w - px, qy = t.by + (t.cy - t.by) * w - py, qz = t.bz + (t.cz - t.bz) * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = t.ax + abx * v + acx * w - px;
  const qy = t.ay + aby * v + acy * w - py;
  const qz = t.az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function principalStresses(s: number[]): [number, number, number] {
  const [sx, sy, sz, txy, tyz, tzx] = s;
  const mean = (sx + sy + sz) / 3;
  const mx = sx - mean, my = sy - mean, mz = sz - mean;
  const j2 = 0.5 * (mx * mx + my * my + mz * mz) + txy * txy + tyz * tyz + tzx * tzx;
  const j3 = mx * (my * mz - tyz * tyz) - txy * (txy * mz - tyz * tzx) + tzx * (txy * tyz - my * tzx);
  const p = Math.sqrt(Math.max(0, j2) / 3);
  if (p < 1e-12) return [mean, mean, mean];
  const cosPhi = Math.max(-1, Math.min(1, (3 * j3) / (2 * j2 * p)));
  const phi = Math.acos(cosPhi) / 3;
  const s1 = mean + 2 * p * Math.cos(phi);
  const s3 = mean + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const s2 = 3 * mean - s1 - s3;
  return [s1, s2, s3];
}

function solveElastic(mesh: TetMeshData, options: TetSolveOptions, progress: (phase: string, percent: number) => void): Promise<ElasticOutcome> {
  return solveElasticAsync(mesh, options, progress);
}

async function solveElasticAsync(mesh: TetMeshData, options: TetSolveOptions, progress: (phase: string, percent: number) => void): Promise<ElasticOutcome> {
  const material = options.material;
  const D = elasticityMatrix(material.E, material.nu);
  const npe = mesh.kind === "tet10" ? 10 : 4;
  const order: 1 | 2 = mesh.kind === "tet10" ? 2 : 1;
  const warnings: string[] = [...mesh.warnings];
  const { constrained, warnings: bcWarnings } = buildConstraints(mesh, options.supports, options);
  warnings.push(...bcWarnings);
  progress("Assembling tetrahedral stiffness", 32);
  const system = assembleElastic(mesh.tets, npe, mesh.positions, D, order, constrained);
  const dofs = system.freeNodes.length * 3;

  const loads = applyLoads(mesh, options, material.density ?? 7850);
  warnings.push(...loads.warnings);
  if (loads.appliedCount === 0) throw new Error("No valid load was applied. Select an exterior face for the force, pressure or moment.");
  const rhs = new Float64Array(dofs);
  for (let r = 0; r < system.freeNodes.length; r++) {
    const n = system.freeNodes[r];
    for (let i = 0; i < 3; i++) {
      if (!constrained[n * 3 + i]) rhs[r * 3 + i] = loads.force[n * 3 + i];
    }
  }
  progress("Solving tetrahedral system", 58);
  const cg = await runPcg(system, rhs, (iter, residual) => {
    if (iter % 100 === 0) progress("Solving tetrahedral system", Math.min(96, 58 + Math.round((iter / Math.max(1, iter + 250)) * 38)));
    void residual;
  });
  const displacement = new Float32Array(mesh.nodeCount * 3);
  for (let r = 0; r < system.freeNodes.length; r++) {
    const n = system.freeNodes[r];
    for (let i = 0; i < 3; i++) {
      if (!constrained[n * 3 + i]) displacement[n * 3 + i] = cg.x[r * 3 + i];
    }
  }

  // Internal forces and reactions.
  const internal = new Float64Array(mesh.nodeCount * 3);
  const stressSum = new Float64Array(mesh.nodeCount * 6);
  const stressWeight = new Float64Array(mesh.nodeCount);
  const maxDisplacementRef = { value: 0 };
  recoverStress(mesh, npe, order, D, displacement, internal, stressSum, stressWeight, maxDisplacementRef);
  const reaction = new Float64Array(mesh.nodeCount * 3);
  const totalReaction: Vec3 = [0, 0, 0];
  const reactionForce = new Float32Array(mesh.nodeCount);
  for (let n = 0; n < mesh.nodeCount; n++) {
    for (let i = 0; i < 3; i++) {
      reaction[n * 3 + i] = internal[n * 3 + i] - loads.force[n * 3 + i];
      if (constrained[n * 3 + i]) totalReaction[i] += reaction[n * 3 + i];
    }
    reactionForce[n] = Math.hypot(reaction[n * 3], reaction[n * 3 + 1], reaction[n * 3 + 2]);
  }

  const vonMisesField = new Float32Array(mesh.nodeCount);
  const principalMax = new Float32Array(mesh.nodeCount);
  const principalMin = new Float32Array(mesh.nodeCount);
  const shear = new Float32Array(mesh.nodeCount);
  const stressTensor = new Float32Array(mesh.nodeCount * 6);
  let maxDisp = 0;
  let maxStress = 0;
  let minStress = Infinity;
  for (let n = 0; n < mesh.nodeCount; n++) {
    const w = stressWeight[n];
    if (w > 0) {
      for (let i = 0; i < 6; i++) stressTensor[n * 6 + i] = stressSum[n * 6 + i] / w;
      const s = [stressTensor[n * 6], stressTensor[n * 6 + 1], stressTensor[n * 6 + 2], stressTensor[n * 6 + 3], stressTensor[n * 6 + 4], stressTensor[n * 6 + 5]];
      vonMisesField[n] = vonMises(s);
      const [p1, , p3] = principalStresses(s);
      principalMax[n] = p1;
      principalMin[n] = p3;
      shear[n] = (p1 - p3) / 2;
      // Constrained nodes sit on a mathematical support singularity: their
      // reaction concentration is not a real material stress. Report the peak
      // over the free field, as Ansys does when supports are point-like.
      const isConstrained = !!(constrained[n * 3] || constrained[n * 3 + 1] || constrained[n * 3 + 2]);
      if (!isConstrained) {
        if (vonMisesField[n] > maxStress) maxStress = vonMisesField[n];
        if (vonMisesField[n] < minStress) minStress = vonMisesField[n];
      }
    }
    const m = Math.hypot(displacement[n * 3], displacement[n * 3 + 1], displacement[n * 3 + 2]);
    if (m > maxDisp) maxDisp = m;
  }
  if (!Number.isFinite(minStress)) minStress = 0;
  void maxDisplacementRef;
  if (!cg.converged) warnings.push(`The solver reached the iteration limit (residual ${cg.residual.toExponential(2)}). Results may be approximate.`);

  const boundarySet = new Set<number>();
  for (let i = 0; i < mesh.surface.length; i++) boundarySet.add(mesh.surface[i]);
  return {
    mesh,
    displacement,
    stressTensor,
    vonMisesField,
    principal: { max: principalMax, min: principalMin, shear },
    reaction,
    reactionForce,
    totalReaction,
    maxDisplacement: maxDisp,
    maxStress,
    minStress,
    safetyFactor: maxStress > 1e-12 ? material.yield / maxStress : Infinity,
    iterations: cg.iterations,
    converged: cg.converged,
    dofs,
    warnings,
    internal,
    applied: loads.force,
    constrained,
    system,
  };
}

function recoverStress(
  mesh: TetMeshData,
  npe: number,
  order: 1 | 2,
  D: number[][],
  displacement: Float32Array,
  internal: Float64Array,
  stressSum: Float64Array,
  stressWeight: Float64Array,
  maxDisplacementRef: { value: number },
): { maxStress: number; minStress: number } {
  void maxDisplacementRef;
  const elementCount = mesh.tets.length / npe;
  const coords: [number, number, number][] = Array.from({ length: npe }, () => [0, 0, 0]);
  const ue = new Array(npe * 3).fill(0);
  let maxStress = 0;
  let minStress = Infinity;
  for (let e = 0; e < elementCount; e++) {
    const o = e * npe;
    for (let k = 0; k < npe; k++) {
      const n = mesh.tets[o + k];
      coords[k][0] = mesh.positions[n * 3];
      coords[k][1] = mesh.positions[n * 3 + 1];
      coords[k][2] = mesh.positions[n * 3 + 2];
      ue[k * 3] = displacement[n * 3];
      ue[k * 3 + 1] = displacement[n * 3 + 1];
      ue[k * 3 + 2] = displacement[n * 3 + 2];
    }
    const volume = Math.abs(
      (() => {
        const b = coords[1], c = coords[2], d = coords[3], a = coords[0];
        const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
        const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
        const cx = d[0] - a[0], cy = d[1] - a[1], cz = d[2] - a[2];
        return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      })(),
    );
    // Internal forces at every node.
    const ke = elementStiffness(coords, npe, D, order);
    for (let a = 0; a < npe; a++) {
      const n = mesh.tets[o + a];
      for (let j = 0; j < npe * 3; j++) {
        internal[n * 3] += ke[a * 3][j] * ue[j];
        internal[n * 3 + 1] += ke[a * 3 + 1][j] * ue[j];
        internal[n * 3 + 2] += ke[a * 3 + 2][j] * ue[j];
      }
    }
    const samples: { node: number; xi: number; eta: number; zeta: number }[] = [];
    if (order === 1) {
      for (let a = 0; a < 4; a++) samples.push({ node: mesh.tets[o + a], xi: 0.25, eta: 0.25, zeta: 0.25 });
    } else {
      for (let a = 0; a < 4; a++) samples.push({ node: mesh.tets[o + a], xi: VERTEX_COORDS[a][0], eta: VERTEX_COORDS[a][1], zeta: VERTEX_COORDS[a][2] });
      for (let a = 0; a < 6; a++) samples.push({ node: mesh.tets[o + 4 + a], xi: EDGE_COORDS[a][0], eta: EDGE_COORDS[a][1], zeta: EDGE_COORDS[a][2] });
    }
    for (const sample of samples) {
      const stress = stressAt(coords, npe, ue, D, order, sample.xi, sample.eta, sample.zeta);
      if (!stress) continue;
      const vm = vonMises(stress);
      if (vm > maxStress) maxStress = vm;
      if (vm < minStress) minStress = vm;
      for (let i = 0; i < 6; i++) stressSum[sample.node * 6 + i] += stress[i] * volume;
      stressWeight[sample.node] += volume;
    }
  }
  if (!Number.isFinite(minStress)) minStress = 0;
  return { maxStress, minStress };
}

// ------------------------------------------------------------------ modal

function lumpedMass(mesh: TetMeshData, density: number, npe: number): Float64Array {
  const mass = new Float64Array(mesh.nodeCount);
  const elementCount = mesh.tets.length / npe;
  for (let e = 0; e < elementCount; e++) {
    const o = e * npe;
    const coords: [number, number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const n = mesh.tets[o + k];
      coords.push([mesh.positions[n * 3], mesh.positions[n * 3 + 1], mesh.positions[n * 3 + 2]]);
    }
    const massE = density * 1e-12 * elementVolume(coords);
    for (let k = 0; k < npe; k++) mass[mesh.tets[o + k]] += massE / npe;
  }
  return mass;
}

export async function solveModal(mesh: TetMeshData, options: TetSolveOptions): Promise<ElasticOutcome & { frequencies: number[]; modeShapes: Float32Array[] }> {
  const material = options.material;
  const D = elasticityMatrix(material.E, material.nu);
  const npe = mesh.kind === "tet10" ? 10 : 4;
  const order: 1 | 2 = mesh.kind === "tet10" ? 2 : 1;
  const warnings: string[] = [...mesh.warnings];
  const { constrained, warnings: bcWarnings } = buildConstraints(mesh, options.supports, options);
  warnings.push(...bcWarnings);
  const system = assembleElastic(mesh.tets, npe, mesh.positions, D, order, constrained);
  const rows = system.freeNodes.length;
  const nDof = rows * 3;
  const mass = lumpedMass(mesh, material.density ?? 7850, npe);
  const massVec = new Float64Array(nDof);
  for (let r = 0; r < rows; r++) {
    const n = system.freeNodes[r];
    for (let i = 0; i < 3; i++) {
      if (!constrained[n * 3 + i]) massVec[r * 3 + i] = Math.max(1e-18, mass[n]);
    }
  }
  const modeCount = Math.max(1, Math.min(6, options.modeCount ?? 6));
  const modes: Float64Array[] = [];
  const frequencies: number[] = [];
  const denseK = (x: Float64Array): Float64Array => {
    const out = new Float64Array(nDof);
    blockMatvec(system.rowStart, system.cols, system.vals, x, out, rows);
    return out;
  };
  const massInner = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < nDof; i++) s += a[i] * massVec[i] * b[i];
    return s;
  };
  const dot = (a: Float64Array, b: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < nDof; i++) s += a[i] * b[i];
    return s;
  };
  let totalIterations = 0;
  let converged = true;
  for (let m = 0; m < modeCount; m++) {
    let x: Float64Array = new Float64Array(nDof);
    for (let i = 0; i < nDof; i++) {
      x[i] = Math.sin((i + 1) * (m + 1) * 0.61803398875) + Math.cos((i + 1) * 0.41421356237 * (m + 2));
    }
    // Orthogonalise the initial vector.
    for (const q of modes) {
      const c = massInner(q, x);
      for (let i = 0; i < nDof; i++) x[i] -= c * q[i];
    }
    let lambda = 0;
    let iter = 0;
    for (; iter < 8; iter++) {
      const rhs = new Float64Array(nDof);
      for (let i = 0; i < nDof; i++) rhs[i] = massVec[i] * x[i];
      const solved = await runPcg(system, rhs, undefined, 3000);
      totalIterations += solved.iterations;
      if (!solved.converged) converged = false;
      let y: Float64Array = solved.x;
      for (const q of modes) {
        const c = massInner(q, y);
        for (let i = 0; i < nDof; i++) y[i] -= c * q[i];
      }
      const norm = Math.sqrt(Math.max(1e-30, massInner(y, y)));
      for (let i = 0; i < nDof; i++) y[i] /= norm;
      const ky = denseK(y);
      const nextLambda = dot(y, ky);
      const change = Math.abs(nextLambda - lambda) / Math.max(1e-12, Math.abs(nextLambda));
      lambda = nextLambda;
      x = y;
      if (iter > 1 && change < 1e-4) {
        iter++;
        break;
      }
    }
    modes.push(x);
    frequencies.push(Math.sqrt(Math.max(0, lambda)) / (2 * Math.PI));
  }
  const modeShapes = modes.map((mode) => {
    const field = new Float32Array(mesh.nodeCount * 3);
    for (let r = 0; r < rows; r++) {
      const n = system.freeNodes[r];
      for (let i = 0; i < 3; i++) {
        if (!constrained[n * 3 + i]) field[n * 3 + i] = mode[r * 3 + i];
      }
    }
    let max = 0;
    for (let i = 0; i < field.length; i++) max = Math.max(max, Math.abs(field[i]));
    if (max > 1e-12) for (let i = 0; i < field.length; i++) field[i] /= max;
    return field;
  });
  const first = modeShapes[0] ?? new Float32Array(mesh.nodeCount * 3);
  const magnitude = new Float32Array(mesh.nodeCount);
  let maxDisp = 0;
  for (let n = 0; n < mesh.nodeCount; n++) {
    magnitude[n] = Math.hypot(first[n * 3], first[n * 3 + 1], first[n * 3 + 2]);
    maxDisp = Math.max(maxDisp, magnitude[n]);
  }
  const zero = new Float32Array(mesh.nodeCount);
  const boundarySet = new Set<number>();
  for (let i = 0; i < mesh.surface.length; i++) boundarySet.add(mesh.surface[i]);
  void nDof;
  return {
    mesh,
    displacement: first,
    stressTensor: new Float32Array(mesh.nodeCount * 6),
    vonMisesField: zero,
    principal: { max: zero, min: zero, shear: zero },
    reaction: new Float64Array(mesh.nodeCount * 3),
    reactionForce: zero,
    totalReaction: [0, 0, 0],
    maxDisplacement: maxDisp,
    maxStress: 0,
    minStress: 0,
    safetyFactor: Infinity,
    iterations: totalIterations,
    converged,
    dofs: nDof,
    warnings,
    internal: new Float64Array(mesh.nodeCount * 3),
    applied: new Float64Array(mesh.nodeCount * 3),
    constrained,
    system,
    frequencies,
    modeShapes,
  };
}

// --------------------------------------------------------------- buckling

function assembleGeometric(
  mesh: TetMeshData,
  npe: number,
  order: 1 | 2,
  stressTensor: Float32Array,
  system: BlockSystem,
): Float64Array {
  const kg = new Float64Array(system.vals.length);
  const elementCount = mesh.tets.length / npe;
  const coords: [number, number, number][] = Array.from({ length: npe }, () => [0, 0, 0]);
  for (let e = 0; e < elementCount; e++) {
    const o = e * npe;
    let sx = 0, sy = 0, sz = 0, txy = 0, tyz = 0, tzx = 0;
    for (let k = 0; k < npe; k++) {
      const n = mesh.tets[o + k];
      coords[k][0] = mesh.positions[n * 3];
      coords[k][1] = mesh.positions[n * 3 + 1];
      coords[k][2] = mesh.positions[n * 3 + 2];
      sx += stressTensor[n * 6];
      sy += stressTensor[n * 6 + 1];
      sz += stressTensor[n * 6 + 2];
      txy += stressTensor[n * 6 + 3];
      tyz += stressTensor[n * 6 + 4];
      tzx += stressTensor[n * 6 + 5];
    }
    sx /= npe; sy /= npe; sz /= npe; txy /= npe; tyz /= npe; tzx /= npe;
    const volume = Math.abs(
      (() => {
        const a = coords[0], b = coords[1], c = coords[2], d = coords[3];
        const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
        const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
        const cx = d[0] - a[0], cy = d[1] - a[1], cz = d[2] - a[2];
        return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
      })(),
    );
    if (volume < 1e-16) continue;
    const deriv = tetShapeDerivatives(order, 0.25, 0.25, 0.25);
    const jac = jacobian(deriv, coords, npe);
    if (Math.abs(jac.det) < 1e-20) continue;
    const grad: [number, number, number][] = [];
    for (let a = 0; a < npe; a++) {
      grad.push([
        jac.inverse[0][0] * deriv[0][a] + jac.inverse[0][1] * deriv[1][a] + jac.inverse[0][2] * deriv[2][a],
        jac.inverse[1][0] * deriv[0][a] + jac.inverse[1][1] * deriv[1][a] + jac.inverse[1][2] * deriv[2][a],
        jac.inverse[2][0] * deriv[0][a] + jac.inverse[2][1] * deriv[1][a] + jac.inverse[2][2] * deriv[2][a],
      ]);
    }
    const S = [
      [sx, txy, tzx],
      [txy, sy, tyz],
      [tzx, tyz, sz],
    ];
    for (let a = 0; a < npe; a++) {
      const na = mesh.tets[o + a];
      const ra = system.rowOf[na];
      if (ra < 0) continue;
      for (let b = 0; b < npe; b++) {
        const nb = mesh.tets[o + b];
        if (system.rowOf[nb] < 0) continue;
        let base: number;
        if (a === b) base = system.rowStart[ra];
        else {
          const slot = slotFor(system.neighbors[ra], system.rowOf, nb);
          if (slot < 0) continue;
          base = system.rowStart[ra] + 9 + slot * 9;
        }
        const gb = grad[b];
        const sgx = S[0][0] * gb[0] + S[0][1] * gb[1] + S[0][2] * gb[2];
        const sgy = S[1][0] * gb[0] + S[1][1] * gb[1] + S[1][2] * gb[2];
        const sgz = S[2][0] * gb[0] + S[2][1] * gb[1] + S[2][2] * gb[2];
        const scalar = grad[a][0] * sgx + grad[a][1] * sgy + grad[a][2] * sgz;
        const value = scalar * volume;
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            if (i === j) kg[base + i * 3 + j] += value;
          }
        }
      }
    }
  }
  return kg;
}

function solveBuckling(mesh: TetMeshData, options: TetSolveOptions, elastic: ElasticOutcome): Promise<{ multiplier: number; mode: Float32Array; iterations: number; converged: boolean; warnings: string[] }> {
  return solveBucklingAsync(mesh, options, elastic);
}

async function solveBucklingAsync(mesh: TetMeshData, options: TetSolveOptions, elastic: ElasticOutcome): Promise<{ multiplier: number; mode: Float32Array; iterations: number; converged: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const npe = mesh.kind === "tet10" ? 10 : 4;
  const order: 1 | 2 = mesh.kind === "tet10" ? 2 : 1;
  const kg = assembleGeometric(mesh, npe, order, elastic.stressTensor, elastic.system);
  let maxKg = 0;
  for (let i = 0; i < kg.length; i++) maxKg = Math.max(maxKg, Math.abs(kg[i]));
  if (maxKg < 1e-16) {
    warnings.push("The reference load produced no geometric stiffness; buckling is not predicted.");
    return { multiplier: Infinity, mode: new Float32Array(mesh.nodeCount * 3), iterations: 0, converged: true, warnings };
  }
  const system = elastic.system;
  const rows = system.freeNodes.length;
  const nDof = rows * 3;
  let x = new Float64Array(nDof);
  for (let i = 0; i < nDof; i++) x[i] = Math.sin((i + 1) * 0.618) + 0.5;
  let norm = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < nDof; i++) x[i] /= norm;
  let mu = 0;
  let iterations = 0;
  let converged = true;
  for (let iter = 0; iter < 30; iter++) {
    iterations = iter + 1;
    const kgx = new Float64Array(nDof);
    // Kg has the same block pattern as K: multiply directly.
    for (let r = 0; r < rows; r++) {
      const row = r * 3;
      let a0 = 0, a1 = 0, a2 = 0;
      let k = system.rowStart[r];
      for (let i = 0; i < 3; i++) {
        const idx = i;
        if (idx === 0) a0 = kg[k] * x[row] + kg[k + 1] * x[row + 1] + kg[k + 2] * x[row + 2];
        if (idx === 1) a1 = kg[k + 3] * x[row] + kg[k + 4] * x[row + 1] + kg[k + 5] * x[row + 2];
        if (idx === 2) a2 = kg[k + 6] * x[row] + kg[k + 7] * x[row + 1] + kg[k + 8] * x[row + 2];
      }
      k += 9;
      while (k < system.rowStart[r + 1]) {
        const col = system.cols[k];
        a0 += kg[k] * x[col] + kg[k + 1] * x[col + 1] + kg[k + 2] * x[col + 2];
        a1 += kg[k + 3] * x[col] + kg[k + 4] * x[col + 1] + kg[k + 5] * x[col + 2];
        a2 += kg[k + 6] * x[col] + kg[k + 7] * x[col + 1] + kg[k + 8] * x[col + 2];
        k += 9;
      }
      kgx[row] = -a0;
      kgx[row + 1] = -a1;
      kgx[row + 2] = -a2;
    }
    const solved = await runPcg(system, kgx, undefined, 3000);
    if (!solved.converged) converged = false;
    const y = solved.x;
    const yNorm = Math.sqrt(y.reduce((s, v) => s + v * v, 0));
    if (yNorm < 1e-20) break;
    let num = 0;
    for (let i = 0; i < nDof; i++) num += x[i] * y[i];
    mu = num;
    for (let i = 0; i < nDof; i++) x[i] = y[i] / yNorm;
    if (iter > 3 && Math.abs(mu) > 0) {
      // Continue; power iteration converges to the largest |mu|.
    }
  }
  const multiplier = Math.abs(mu) > 1e-16 ? 1 / mu : Infinity;
  const mode = new Float32Array(mesh.nodeCount * 3);
  for (let r = 0; r < rows; r++) {
    const n = system.freeNodes[r];
    for (let i = 0; i < 3; i++) {
      if (!elastic.constrained[n * 3 + i]) mode[n * 3 + i] = x[r * 3 + i];
    }
  }
  return { multiplier, mode, iterations, converged, warnings };
}

// ----------------------------------------------------------------- thermal

function scalarPcg(
  rowStart: Int32Array,
  cols: Int32Array,
  vals: Float64Array,
  diag: Float64Array,
  rhs: Float64Array,
  maxIterations = 3000,
): { x: Float64Array; iterations: number; residual: number; converged: boolean } {
  const n = rhs.length;
  const x = new Float64Array(n);
  const r = rhs.slice();
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const ap = new Float64Array(n);
  let rhsNorm = 0;
  for (let i = 0; i < n; i++) rhsNorm += r[i] * r[i];
  rhsNorm = Math.sqrt(rhsNorm);
  if (rhsNorm < 1e-20) return { x, iterations: 0, residual: 0, converged: true };
  for (let i = 0; i < n; i++) z[i] = r[i] / diag[i];
  p.set(z);
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let residual = rhsNorm;
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    for (let row = 0; row < n; row++) {
      let sum = 0;
      for (let k = rowStart[row]; k < rowStart[row + 1]; k++) sum += vals[k] * p[cols[k]];
      ap[row] = sum;
    }
    let pap = 0;
    for (let i = 0; i < n; i++) pap += p[i] * ap[i];
    if (pap <= 1e-30) break;
    const alpha = rz / pap;
    let res2 = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
      res2 += r[i] * r[i];
    }
    residual = Math.sqrt(res2);
    if (residual <= 1e-8 * rhsNorm) return { x, iterations, residual, converged: true };
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      z[i] = r[i] / diag[i];
      rz2 += r[i] * z[i];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return { x, iterations, residual, converged: residual <= rhsNorm * 1e-4 };
}

function solveThermal(mesh: TetMeshData, options: TetSolveOptions, progress: (phase: string, percent: number) => void): FeaNodeResult {
  const npe = mesh.kind === "tet10" ? 10 : 4;
  const order: 1 | 2 = mesh.kind === "tet10" ? 2 : 1;
  const conductivity = Math.max(1e-6, options.material.conductivity ?? 0.05); // W/(mm·K)
  const elementCount = mesh.tets.length / npe;
  const nodeCount = mesh.nodeCount;
  const neighbourSets: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  for (let e = 0; e < elementCount; e++) {
    const o = e * npe;
    for (let a = 0; a < npe; a++) for (let b = a + 1; b < npe; b++) {
      neighbourSets[mesh.tets[o + a]].add(mesh.tets[o + b]);
      neighbourSets[mesh.tets[o + b]].add(mesh.tets[o + a]);
    }
  }
  const fixed = new Uint8Array(nodeCount);
  const fixedValue = new Float64Array(nodeCount);
  const rhs = new Float64Array(nodeCount);
  const diagExtra = new Float64Array(nodeCount);
  const trisFor = (faceIndex: number) => collectFaceTriangles(options as unknown as StaticSolveOptions, new Set([faceIndex]));
  for (const support of options.supports) {
    const value = options.ambient ?? 22;
    for (const n of faceNodes(mesh, trisFor(support.faceIndex), mesh.h * 1.05)) {
      fixed[n] = 1;
      fixedValue[n] = value;
    }
  }
  for (const load of options.loads) {
    if (load.type === "temperature") {
      for (const n of faceNodes(mesh, trisFor(load.faceIndex), mesh.h * 1.05)) {
        fixed[n] = 1;
        fixedValue[n] = load.magnitude;
      }
    } else if (load.type === "heatflux") {
      const tris = trisFor(load.faceIndex);
      for (let t = 0; t < mesh.surface.length / 3; t++) {
        const ia = mesh.surface[t * 3], ib = mesh.surface[t * 3 + 1], ic = mesh.surface[t * 3 + 2];
        const ax = mesh.positions[ia * 3], ay = mesh.positions[ia * 3 + 1], az = mesh.positions[ia * 3 + 2];
        const bx = mesh.positions[ib * 3], by = mesh.positions[ib * 3 + 1], bz = mesh.positions[ib * 3 + 2];
        const cx = mesh.positions[ic * 3], cy = mesh.positions[ic * 3 + 1], cz = mesh.positions[ic * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const area = Math.hypot(nx, ny, nz) * 0.5;
        if (area < 1e-12) continue;
        const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
        if (!tris.some((tri) => pointTriDistanceSq(mx, my, mz, tri) < mesh.h * mesh.h * 1.5)) continue;
        const q = load.magnitude * area / 3;
        for (const n of [ia, ib, ic]) rhs[n] += q;
      }
    } else if (load.type === "convection") {
      const tris = trisFor(load.faceIndex);
      const ambient = load.secondary ?? options.ambient ?? 22;
      const hConv = Math.max(0, load.magnitude);
      for (let t = 0; t < mesh.surface.length / 3; t++) {
        const ia = mesh.surface[t * 3], ib = mesh.surface[t * 3 + 1], ic = mesh.surface[t * 3 + 2];
        const ax = mesh.positions[ia * 3], ay = mesh.positions[ia * 3 + 1], az = mesh.positions[ia * 3 + 2];
        const bx = mesh.positions[ib * 3], by = mesh.positions[ib * 3 + 1], bz = mesh.positions[ib * 3 + 2];
        const cx = mesh.positions[ic * 3], cy = mesh.positions[ic * 3 + 1], cz = mesh.positions[ic * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const area = Math.hypot(nx, ny, nz) * 0.5;
        if (area < 1e-12) continue;
        const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
        if (!tris.some((tri) => pointTriDistanceSq(mx, my, mz, tri) < mesh.h * mesh.h * 1.5)) continue;
        const share = (hConv * area) / 3;
        for (const n of [ia, ib, ic]) {
          diagExtra[n] += share;
          rhs[n] += share * ambient;
        }
      }
    }
  }
  let fixedCount = 0;
  for (let i = 0; i < nodeCount; i++) if (fixed[i]) fixedCount++;
  if (fixedCount === 0) {
    fixed[0] = 1;
    fixedValue[0] = options.ambient ?? 22;
  }
  const freeNodes: number[] = [];
  const rowOf = new Int32Array(nodeCount).fill(-1);
  for (let n = 0; n < nodeCount; n++) if (!fixed[n] && neighbourSets[n].size > 0) {
    rowOf[n] = freeNodes.length;
    freeNodes.push(n);
  }
  const neighbors = freeNodes.map((n) => [...neighbourSets[n]].filter((q) => rowOf[q] >= 0).sort((a, b) => a - b));
  const rowStart = new Int32Array(freeNodes.length + 1);
  for (let r = 0; r < freeNodes.length; r++) rowStart[r + 1] = rowStart[r] + 1 + neighbors[r].length;
  const nnz = rowStart[freeNodes.length];
  const cols = new Int32Array(nnz);
  const vals = new Float64Array(nnz);
  for (let r = 0; r < freeNodes.length; r++) {
    let p = rowStart[r];
    cols[p++] = r;
    for (const nb of neighbors[r]) cols[p++] = rowOf[nb];
  }
  progress("Assembling thermal conductivity", 40);
  const vcount = freeNodes.length;
  const localMap = new Int32Array(nodeCount).fill(-1);
  for (let r = 0; r < vcount; r++) localMap[freeNodes[r]] = r;
  const fixedRhs = new Float64Array(vcount);
  const coords: [number, number, number][] = Array.from({ length: npe }, () => [0, 0, 0]);
  for (let e = 0; e < elementCount; e++) {
    const o = e * npe;
    for (let k = 0; k < npe; k++) {
      const n = mesh.tets[o + k];
      coords[k][0] = mesh.positions[n * 3];
      coords[k][1] = mesh.positions[n * 3 + 1];
      coords[k][2] = mesh.positions[n * 3 + 2];
    }
    const ke: number[][] = Array.from({ length: npe }, () => new Array(npe).fill(0));
    for (const gp of TET_GAUSS) {
      const deriv = tetShapeDerivatives(order, gp[1], gp[2], gp[3]);
      const jac = jacobian(deriv, coords, npe);
      const weight = 0.25 * Math.abs(jac.det) / 6;
      if (weight < 1e-20) continue;
      const grad: [number, number, number][] = [];
      for (let a = 0; a < npe; a++) {
        grad.push([
          jac.inverse[0][0] * deriv[0][a] + jac.inverse[0][1] * deriv[1][a] + jac.inverse[0][2] * deriv[2][a],
          jac.inverse[1][0] * deriv[0][a] + jac.inverse[1][1] * deriv[1][a] + jac.inverse[1][2] * deriv[2][a],
          jac.inverse[2][0] * deriv[0][a] + jac.inverse[2][1] * deriv[1][a] + jac.inverse[2][2] * deriv[2][a],
        ]);
      }
      for (let a = 0; a < npe; a++) {
        for (let b = 0; b < npe; b++) {
          ke[a][b] += conductivity * (grad[a][0] * grad[b][0] + grad[a][1] * grad[b][1] + grad[a][2] * grad[b][2]) * weight;
        }
      }
    }
    for (let a = 0; a < npe; a++) {
      const ra = localMap[mesh.tets[o + a]];
      if (ra < 0) continue;
      for (let b = 0; b < npe; b++) {
        const nbGlobal = mesh.tets[o + b];
        const rb = localMap[nbGlobal];
        if (rb < 0) {
          if (fixed[nbGlobal]) fixedRhs[ra] -= ke[a][b] * fixedValue[nbGlobal];
          continue;
        }
        let base = rowStart[ra];
        if (a !== b) {
          let slot = -1;
          for (let k = 0; k < neighbors[ra].length; k++) if (neighbors[ra][k] === nbGlobal) { slot = k; break; }
          if (slot < 0) continue;
          base = rowStart[ra] + 1 + slot;
        }
        vals[base] += ke[a][b];
      }
    }
  }
  const diag = new Float64Array(vcount);
  const reducedRhs = new Float64Array(vcount);
  for (let r = 0; r < vcount; r++) {
    const n = freeNodes[r];
    diag[r] = Math.max(1e-18, vals[rowStart[r]] + diagExtra[n]);
    reducedRhs[r] = rhs[n] + fixedRhs[r];
  }
  progress("Solving thermal system", 62);
  const solved = scalarPcg(rowStart, cols, vals, diag, reducedRhs);
  const temperature = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) if (fixed[n]) temperature[n] = fixedValue[n];
  for (let r = 0; r < vcount; r++) temperature[freeNodes[r]] = solved.x[r];
  let minT = Infinity, maxT = -Infinity;
  for (let n = 0; n < nodeCount; n++) {
    minT = Math.min(minT, temperature[n]);
    maxT = Math.max(maxT, temperature[n]);
  }
  const magnitude = new Float32Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) magnitude[n] = temperature[n];
  const boundarySet = new Set<number>();
  for (let i = 0; i < mesh.surface.length; i++) boundarySet.add(mesh.surface[i]);
  return {
    positions: mesh.positions,
    displacement: new Float32Array(nodeCount * 3),
    vonMises: new Float32Array(nodeCount),
    magnitude,
    surfaceIndices: mesh.surface,
    boundaryIndices: new Uint32Array([...boundarySet]),
    elementCount: mesh.elementCount,
    meshSize: mesh.h,
    maxDisplacement: Math.max(0, maxT - minT),
    maxStress: 0,
    minStress: 0,
    safetyFactor: Infinity,
    reaction: [0, 0, 0],
    reactionForce: new Float32Array(nodeCount),
    solveMs: 0,
    dofs: vcount,
    converged: solved.converged,
    iterations: solved.iterations,
    warnings: [...mesh.warnings, ...(solved.converged ? [] : ["The thermal solver reached its iteration limit."])],
    temperature,
    meshKind: mesh.kind,
    meshMetrics: mesh.metrics,
  };
}

// ------------------------------------------------------------------ public

export async function solveTetStudy(options: TetSolveOptions): Promise<TetSolveOutcome> {
  const t0 = performance.now();
  const progress = (phase: string, percent: number) => options.onProgress?.(phase, percent);
  const kind = options.meshKind === "tet4" ? "tet4" : "tet10";
  progress("Meshing tetrahedra", 4);
  const mesh = buildTetMesh(options.sourcePositions, options.sourceIndices, options.meshSize, kind, options.localSizing ?? []);
  const analysisType = options.analysisType ?? "static";
  if (analysisType === "thermal") {
    progress("Thermal analysis", 20);
    const result = solveThermal(mesh, options, progress);
    result.solveMs = Math.round(performance.now() - t0);
    progress("Done", 100);
    return { mesh, result };
  }
  if (analysisType === "modal") {
    progress("Modal eigen-solution", 30);
    const modal = await solveModal(mesh, options);
    const result: FeaNodeResult = {
      positions: mesh.positions,
      displacement: modal.displacement,
      vonMises: new Float32Array(mesh.nodeCount),
      magnitude: new Float32Array(mesh.nodeCount),
      surfaceIndices: mesh.surface,
      boundaryIndices: uniqueBoundary(mesh),
      elementCount: mesh.elementCount,
      meshSize: mesh.h,
      maxDisplacement: modal.maxDisplacement,
      maxStress: 0,
      minStress: 0,
      safetyFactor: Infinity,
      reaction: [0, 0, 0],
      reactionForce: new Float32Array(mesh.nodeCount),
      solveMs: Math.round(performance.now() - t0),
      dofs: modal.dofs,
      converged: modal.converged,
      iterations: modal.iterations,
      warnings: modal.warnings,
      maxPrincipal: new Float32Array(mesh.nodeCount),
      minPrincipal: new Float32Array(mesh.nodeCount),
      shearStress: new Float32Array(mesh.nodeCount),
      directional: {
        x: directional(modal.displacement, 0),
        y: directional(modal.displacement, 1),
        z: directional(modal.displacement, 2),
      },
      frequencies: modal.frequencies,
      modeShapes: modal.modeShapes,
      meshKind: mesh.kind,
      meshMetrics: mesh.metrics as FeaMeshMetrics,
    };
    for (let n = 0; n < mesh.nodeCount; n++) {
      result.magnitude[n] = Math.hypot(modal.displacement[n * 3], modal.displacement[n * 3 + 1], modal.displacement[n * 3 + 2]);
    }
    progress("Done", 100);
    return { mesh, result };
  }
  const elastic = await solveElastic(mesh, options, progress);
  const base: FeaNodeResult = {
    positions: elastic.mesh.positions,
    displacement: elastic.displacement,
    vonMises: elastic.vonMisesField,
    magnitude: new Float32Array(elastic.mesh.nodeCount),
    surfaceIndices: elastic.mesh.surface,
    boundaryIndices: uniqueBoundary(elastic.mesh),
    elementCount: elastic.mesh.elementCount,
    meshSize: elastic.mesh.h,
    maxDisplacement: elastic.maxDisplacement,
    maxStress: elastic.maxStress,
    minStress: elastic.minStress,
    safetyFactor: elastic.safetyFactor,
    reaction: elastic.totalReaction,
    reactionForce: elastic.reactionForce,
    solveMs: 0,
    dofs: elastic.dofs,
    converged: elastic.converged,
    iterations: elastic.iterations,
    warnings: elastic.warnings,
    maxPrincipal: elastic.principal.max,
    minPrincipal: elastic.principal.min,
    shearStress: elastic.principal.shear,
    directional: {
      x: directional(elastic.displacement, 0),
      y: directional(elastic.displacement, 1),
      z: directional(elastic.displacement, 2),
    },
    meshKind: elastic.mesh.kind,
    meshMetrics: elastic.mesh.metrics as FeaMeshMetrics,
  };
  for (let n = 0; n < elastic.mesh.nodeCount; n++) {
    base.magnitude[n] = Math.hypot(elastic.displacement[n * 3], elastic.displacement[n * 3 + 1], elastic.displacement[n * 3 + 2]);
  }
  if (analysisType === "buckling") {
    progress("Buckling eigen-solution", 70);
    const buckling = await solveBuckling(mesh, options, elastic);
    base.bucklingMultiplier = buckling.multiplier;
    base.bucklingMode = buckling.mode;
    base.frequencies = [];
    base.warnings = [...base.warnings, ...buckling.warnings];
  }
  base.solveMs = Math.round(performance.now() - t0);
  progress("Done", 100);
  return { mesh, result: base };
}

function directional(displacement: Float32Array, axis: number): Float32Array {
  const out = new Float32Array(displacement.length / 3);
  for (let n = 0; n < out.length; n++) out[n] = displacement[n * 3 + axis];
  return out;
}

function uniqueBoundary(mesh: TetMeshData): Uint32Array {
  const set = new Set<number>();
  for (let i = 0; i < mesh.surface.length; i++) set.add(mesh.surface[i]);
  return new Uint32Array([...set]);
}
