import type { FeaNodeResult, Vec3 } from "../model/types";
import { buildVoxelMesh, hexVolume, tetVolume, type VoxelMeshData } from "./mesher";

export interface FeaLoadSpec {
  type: "force" | "pressure";
  faceIndex: number;
  magnitude: number;
  direction?: Vec3;
}

export interface StaticSolveOptions {
  material: { E: number; nu: number; yield: number };
  sourcePositions: Float32Array;
  sourceIndices: Uint32Array;
  sourceTriFaceIds: Uint32Array;
  supportFaces: number[];
  loads: FeaLoadSpec[];
  meshSize: number;
  onProgress?: (phase: string, percent: number) => void;
}

interface FaceTriangles {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  nx: number; ny: number; nz: number;
  min: [number, number, number];
  max: [number, number, number];
  area: number;
}

/** Natural coordinates of the eight hexahedron corners. */
export const HEX_SIGNS: [number, number, number][] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

const GAUSS = 1 / Math.sqrt(3);
/** 2x2x2 Gauss points in the same corner order. */
const GAUSS_POINTS: [number, number, number][] = HEX_SIGNS.map(([a, b, c]) => [a * GAUSS, b * GAUSS, c * GAUSS]);

export function solveStatic(options: StaticSolveOptions): { mesh: VoxelMeshData; result: FeaNodeResult } {
  const t0 = performance.now();
  const progress = (phase: string, percent: number) => options.onProgress?.(phase, percent);
  progress("Meshing", 2);
  const mesh = buildVoxelMesh(options.sourcePositions, options.sourceIndices, options.meshSize);

  const supportTris = collectFaceTriangles(options, new Set(options.supportFaces));
  if (supportTris.length === 0) throw new Error("The fixed support does not reference any valid face.");
  const capture = mesh.h * 0.85;
  const fixedNodes = nodesNearTriangles(mesh, supportTris, capture);
  const fixedCount = countFlags(fixedNodes);
  if (fixedCount === 0) {
    throw new Error("The fixed support captured no mesh nodes. Use a finer mesh size and try again.");
  }
  progress("Boundary conditions", 25);

  const surfaceNodes = new Uint8Array(mesh.nodeCount);
  for (let i = 0; i < mesh.surface.length; i++) surfaceNodes[mesh.surface[i]] = 1;

  const fullForce = new Float64Array(mesh.nodeCount * 3);
  let appliedLoads = 0;
  for (const load of options.loads) {
    const tris = collectFaceTriangles(options, new Set([load.faceIndex]));
    if (tris.length === 0) continue;
    if (load.type === "force") {
      const nodes: number[] = [];
      for (let n = 0; n < mesh.nodeCount; n++) {
        if (!surfaceNodes[n]) continue;
        if (pointNearTriangles(mesh.positions, n, tris, capture)) nodes.push(n);
      }
      if (nodes.length === 0) continue;
      let dir: Vec3 = load.direction ?? [0, 0, -1];
      const dl = Math.hypot(dir[0], dir[1], dir[2]);
      if (dl < 1e-9) {
        const nrm = averageNormal(tris);
        dir = [-nrm[0], -nrm[1], -nrm[2]];
      } else dir = [dir[0] / dl, dir[1] / dl, dir[2] / dl];
      const force = load.magnitude / nodes.length;
      for (const n of nodes) {
        fullForce[n * 3] += dir[0] * force;
        fullForce[n * 3 + 1] += dir[1] * force;
        fullForce[n * 3 + 2] += dir[2] * force;
      }
      appliedLoads++;
    } else {
      // Consistent nodal loads from pressure over the boundary triangles near this face.
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
        const inv = 1 / (area * 2);
        nx *= inv;
        ny *= inv;
        nz *= inv;
        const mx = (ax + bx + cx) / 3;
        const my = (ay + by + cy) / 3;
        const mz = (az + bz + cz) / 3;
        const near = nearestTriangleNormal(mx, my, mz, tris, mesh.h * 1.1);
        if (!near) continue;
        if (near.nx * nx + near.ny * ny + near.nz * nz < 0.15) continue;
        const p = load.magnitude;
        const fnx = -nx * p * area / 3;
        const fny = -ny * p * area / 3;
        const fnz = -nz * p * area / 3;
        for (const node of [ia, ib, ic]) {
          fullForce[node * 3] += fnx;
          fullForce[node * 3 + 1] += fny;
          fullForce[node * 3 + 2] += fnz;
        }
        count++;
      }
      if (count > 0) appliedLoads++;
    }
  }
  if (appliedLoads === 0) throw new Error("No valid loads were applied. Select a face on the outside of the part and apply a force or pressure.");
  progress("Assembling stiffness", 35);

  const freeMap = new Int32Array(mesh.nodeCount).fill(-1);
  const freeNodes: number[] = [];
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (!fixedNodes[n]) {
      freeMap[n] = freeNodes.length;
      freeNodes.push(n);
    }
  }
  if (freeNodes.length === 0) throw new Error("Every node is fixed. Remove a fixed support or use a larger model.");

  const neighborSets: Set<number>[] = Array.from({ length: freeNodes.length }, () => new Set<number>());
  const elementCount = mesh.hexes.length / 8;
  for (let e = 0; e < elementCount; e++) {
    const o = e * 8;
    for (let a = 0; a < 8; a++) {
      const ra = freeMap[mesh.hexes[o + a]];
      if (ra < 0) continue;
      for (let b = a + 1; b < 8; b++) {
        const rb = freeMap[mesh.hexes[o + b]];
        if (rb < 0) continue;
        neighborSets[ra].add(rb);
        neighborSets[rb].add(ra);
      }
    }
  }
  const neighbors: number[][] = neighborSets.map((set) => [...set].sort((x, y) => x - y));
  const rowStart = new Int32Array(freeNodes.length + 1);
  for (let r = 0; r < freeNodes.length; r++) {
    // One 3x3 diagonal block plus one 3x3 block per neighbour.
    rowStart[r + 1] = rowStart[r] + 9 + neighbors[r].length * 9;
  }
  const nnz = rowStart[freeNodes.length];
  const cols = new Int32Array(nnz);
  const vals = new Float64Array(nnz);
  for (let r = 0; r < freeNodes.length; r++) {
    let p = rowStart[r];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) cols[p++] = r * 3 + j;
    }
    for (const nb of neighbors[r]) {
      for (let i = 0; i < 3; i++) {
        cols[p++] = nb * 3;
        cols[p++] = nb * 3 + 1;
        cols[p++] = nb * 3 + 2;
      }
    }
  }

  const coords: [number, number, number][] = HEX_SIGNS.map(() => [0, 0, 0]);
  const D = elasticityMatrix(options.material.E, options.material.nu);
  for (let e = 0; e < elementCount; e++) {
    const o = e * 8;
    for (let k = 0; k < 8; k++) {
      const n = mesh.hexes[o + k];
      coords[k][0] = mesh.positions[n * 3];
      coords[k][1] = mesh.positions[n * 3 + 1];
      coords[k][2] = mesh.positions[n * 3 + 2];
    }
    const ke = hexStiffness(coords, D);
    for (let a = 0; a < 8; a++) {
      const ga = mesh.hexes[o + a];
      const ra = freeMap[ga];
      if (ra < 0) continue;
      for (let b = 0; b < 8; b++) {
        const gb = mesh.hexes[o + b];
        const rb = freeMap[gb];
        if (rb < 0) continue;
        let base: number;
        if (a === b) base = rowStart[ra];
        else {
          const slot = slotFor(neighbors[ra], rb);
          if (slot < 0) continue;
          base = rowStart[ra] + 9 + slot * 9;
        }
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            vals[base + i * 3 + j] += ke[a * 3 + i][b * 3 + j];
          }
        }
      }
    }
    if (e % 800 === 0) {
      progress("Assembling stiffness", 35 + Math.round((e / elementCount) * 20));
    }
  }
  progress("Solving system", 58);

  const nDof = freeNodes.length * 3;
  const rhs = new Float64Array(nDof);
  for (let r = 0; r < freeNodes.length; r++) {
    const n = freeNodes[r];
    rhs[r * 3] = fullForce[n * 3];
    rhs[r * 3 + 1] = fullForce[n * 3 + 1];
    rhs[r * 3 + 2] = fullForce[n * 3 + 2];
  }
  const diag = new Float64Array(nDof);
  for (let r = 0; r < freeNodes.length; r++) {
    const base = rowStart[r];
    for (let i = 0; i < 3; i++) {
      const d = vals[base + i * 3 + i];
      diag[r * 3 + i] = Math.abs(d) > 1e-30 ? d : 1;
    }
  }
  const cg = pcg(rowStart, cols, vals, diag, rhs, (iter, residual) => {
    if (iter % 100 === 0) progress("Solving system", Math.min(96, 58 + Math.round((iter / Math.max(1, iter + 200)) * 38)));
    void residual;
  });

  const displacement = new Float32Array(mesh.nodeCount * 3);
  for (let r = 0; r < freeNodes.length; r++) {
    const n = freeNodes[r];
    displacement[n * 3] = cg.x[r * 3];
    displacement[n * 3 + 1] = cg.x[r * 3 + 1];
    displacement[n * 3 + 2] = cg.x[r * 3 + 2];
  }
  progress("Computing stresses", 97);

  // Stress recovery: evaluate at the 2x2x2 Gauss points, then extrapolate to the
  // nodes with the trilinear shape functions (sum(N_i) = 1 over the Gauss set).
  const vmSum = new Float64Array(mesh.nodeCount);
  const vmWeight = new Float64Array(mesh.nodeCount);
  const reaction: Vec3 = [0, 0, 0];
  const ue = new Array(24);
  let maxStress = 0;
  let minStress = Infinity;

  for (let e = 0; e < elementCount; e++) {
    const o = e * 8;
    for (let k = 0; k < 8; k++) {
      const n = mesh.hexes[o + k];
      coords[k][0] = mesh.positions[n * 3];
      coords[k][1] = mesh.positions[n * 3 + 1];
      coords[k][2] = mesh.positions[n * 3 + 2];
      ue[k * 3] = displacement[n * 3];
      ue[k * 3 + 1] = displacement[n * 3 + 1];
      ue[k * 3 + 2] = displacement[n * 3 + 2];
    }
    const volume = hexVolume(coords);

    // Nodal stress evaluation. The trilinear displacement field has a trilinear
    // strain field, so evaluating B at the element corners recovers the true
    // outer-fibre stress; Gauss points at ±0.577 would miss it by ~13 % and make
    // the reported peak depend on the element count.
    for (let a = 0; a < 8; a++) {
      const np = HEX_SIGNS[a];
      const derivatives = hexShapeDerivatives(np[0], np[1], np[2]);
      const jac = hexJacobian(derivatives, coords);
      if (Math.abs(jac.det) < 1e-18) continue;
      const B = strainMatrixHex(derivatives, jac.inverse);
      const strain = new Array(6).fill(0);
      for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let j = 0; j < 24; j++) s += B[i][j] * ue[j];
        strain[i] = s;
      }
      const stress = new Array(6).fill(0);
      for (let i = 0; i < 6; i++) {
        let s = 0;
        for (let j = 0; j < 6; j++) s += D[i][j] * strain[j];
        stress[i] = s;
      }
      const vm = vonMises(stress);
      const n = mesh.hexes[o + a];
      // Volume-weighted averaging over the elements sharing the node.
      vmSum[n] += vm * volume;
      vmWeight[n] += volume;
    }

    // Internal nodal forces at every fixed node give the support reaction.
    // One hexStiffness per element is enough; all constrained corners of that
    // element must be summed, otherwise the reaction is under-counted.
    let fixedHere = false;
    for (let a = 0; a < 8; a++) {
      if (fixedNodes[mesh.hexes[o + a]]) {
        fixedHere = true;
        break;
      }
    }
    if (fixedHere) {
      const ke = hexStiffness(coords, D);
      for (let a = 0; a < 8; a++) {
        const n = mesh.hexes[o + a];
        if (!fixedNodes[n]) continue;
        for (let j = 0; j < 24; j++) {
          reaction[0] += ke[a * 3][j] * ue[j];
          reaction[1] += ke[a * 3 + 1][j] * ue[j];
          reaction[2] += ke[a * 3 + 2][j] * ue[j];
        }
      }
    }
  }

  const vonMisesField = new Float32Array(mesh.nodeCount);
  let nodalMax = 0;
  let nodalMin = Infinity;
  for (let n = 0; n < mesh.nodeCount; n++) {
    const v = vmWeight[n] > 0 ? vmSum[n] / vmWeight[n] : 0;
    vonMisesField[n] = v;
    if (v > nodalMax) nodalMax = v;
    if (v < nodalMin) nodalMin = v;
  }
  if (!Number.isFinite(nodalMin)) nodalMin = 0;
  // Nodal extrapolation recovers the outer-fibre stress, which the Gauss points
  // (at ±0.577 of the element) only sample inside the element.
  maxStress = nodalMax;
  minStress = nodalMin;

  const magnitude = new Float32Array(mesh.nodeCount);
  let maxDisplacement = 0;
  for (let n = 0; n < mesh.nodeCount; n++) {
    const m = Math.hypot(displacement[n * 3], displacement[n * 3 + 1], displacement[n * 3 + 2]);
    magnitude[n] = m;
    if (m > maxDisplacement) maxDisplacement = m;
  }
  const boundarySet = new Set<number>();
  for (let i = 0; i < mesh.surface.length; i++) boundarySet.add(mesh.surface[i]);
  const boundaryIndices = new Uint32Array([...boundarySet]);

  const warnings = [...mesh.warnings];
  if (!cg.converged) warnings.push(`The solver reached the iteration limit (residual ${cg.residual.toExponential(2)}). Results may be approximate.`);
  if (fixedCount < 3) warnings.push("Only a few nodes are fixed; the model may be insufficiently constrained.");

  const result: FeaNodeResult = {
    positions: mesh.positions,
    displacement,
    vonMises: vonMisesField,
    magnitude,
    surfaceIndices: mesh.surface,
    boundaryIndices,
    elementCount,
    meshSize: mesh.h,
    maxDisplacement,
    maxStress,
    minStress,
    safetyFactor: maxStress > 1e-12 ? options.material.yield / maxStress : Infinity,
    reaction,
    solveMs: Math.round(performance.now() - t0),
    dofs: nDof,
    converged: cg.converged,
    iterations: cg.iterations,
    warnings,
  };
  progress("Done", 100);
  return { mesh, result };
}

function vonMises(stress: number[]): number {
  return Math.sqrt(
    0.5 * ((stress[0] - stress[1]) ** 2 + (stress[1] - stress[2]) ** 2 + (stress[2] - stress[0]) ** 2) +
      3 * (stress[3] ** 2 + stress[4] ** 2 + stress[5] ** 2),
  );
}

/** Trilinear shape function for corner `a` at natural coordinates (xi, eta, zeta). */
export function shapeValue(a: number, xi: number, eta: number, zeta: number): number {
  const [sa, sb, sc] = HEX_SIGNS[a];
  return ((1 + sa * xi) * (1 + sb * eta) * (1 + sc * zeta)) / 8;
}

/** Derivatives of the eight shape functions with respect to natural coordinates. */
export function hexShapeDerivatives(xi: number, eta: number, zeta: number): [number[], number[], number[]] {
  const dXi: number[] = new Array(8);
  const dEta: number[] = new Array(8);
  const dZeta: number[] = new Array(8);
  for (let a = 0; a < 8; a++) {
    const [sa, sb, sc] = HEX_SIGNS[a];
    dXi[a] = (sa * (1 + sb * eta) * (1 + sc * zeta)) / 8;
    dEta[a] = (sb * (1 + sa * xi) * (1 + sc * zeta)) / 8;
    dZeta[a] = (sc * (1 + sa * xi) * (1 + sb * eta)) / 8;
  }
  return [dXi, dEta, dZeta];
}

export function hexJacobian(
  derivatives: [number[], number[], number[]],
  coords: [number, number, number][],
): { det: number; inverse: number[][] } {
  const [dXi, dEta, dZeta] = derivatives;
  const j: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let a = 0; a < 8; a++) {
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
  const det = j[0][0] * (j[1][1] * j[2][2] - j[1][2] * j[2][1]) - j[0][1] * (j[1][0] * j[2][2] - j[1][2] * j[2][0]) + j[0][2] * (j[1][0] * j[2][1] - j[1][1] * j[2][0]);
  const s = Math.abs(det) > 1e-18 ? 1 / det : 0;
  const inverse = [
    [(j[1][1] * j[2][2] - j[1][2] * j[2][1]) * s, (j[0][2] * j[2][1] - j[0][1] * j[2][2]) * s, (j[0][1] * j[1][2] - j[0][2] * j[1][1]) * s],
    [(j[1][2] * j[2][0] - j[1][0] * j[2][2]) * s, (j[0][0] * j[2][2] - j[0][2] * j[2][0]) * s, (j[0][2] * j[1][0] - j[0][0] * j[1][2]) * s],
    [(j[1][0] * j[2][1] - j[1][1] * j[2][0]) * s, (j[0][1] * j[2][0] - j[0][0] * j[2][1]) * s, (j[0][0] * j[1][1] - j[0][1] * j[1][0]) * s],
  ];
  return { det, inverse };
}

/** Strain-displacement matrix (6x24) for a hexahedron at one Gauss point. */
export function strainMatrixHex(derivatives: [number[], number[], number[]], inverse: number[][]): number[][] {
  const [dXi, dEta, dZeta] = derivatives;
  const B: number[][] = Array.from({ length: 6 }, () => new Array(24).fill(0));
  for (let a = 0; a < 8; a++) {
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

/** 24x24 hexahedron stiffness matrix with 2x2x2 Gauss integration. */
export function hexStiffness(coords: [number, number, number][], D?: number[][]): number[][] {
  const material = D ?? elasticityMatrix(200000, 0.3);
  const Ke: number[][] = Array.from({ length: 24 }, () => new Array(24).fill(0));
  for (let g = 0; g < 8; g++) {
    const gp = GAUSS_POINTS[g];
    const derivatives = hexShapeDerivatives(gp[0], gp[1], gp[2]);
    const jac = hexJacobian(derivatives, coords);
    const weight = Math.abs(jac.det);
    if (weight < 1e-18) continue;
    const B = strainMatrixHex(derivatives, jac.inverse);
    const DB: number[][] = Array.from({ length: 6 }, () => new Array(24).fill(0));
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 24; j++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += material[i][k] * B[k][j];
        DB[i][j] = s;
      }
    }
    for (let a = 0; a < 24; a++) {
      for (let b = 0; b < 24; b++) {
        let s = 0;
        for (let k = 0; k < 6; k++) s += B[k][a] * DB[k][b];
        Ke[a][b] += s * weight;
      }
    }
  }
  return Ke;
}

function countFlags(flags: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) n++;
  return n;
}

function collectFaceTriangles(options: StaticSolveOptions, faces: Set<number>): FaceTriangles[] {
  const out: FaceTriangles[] = [];
  const p = options.sourcePositions;
  const idx = options.sourceIndices;
  for (let t = 0; t < options.sourceTriFaceIds.length; t++) {
    if (!faces.has(options.sourceTriFaceIds[t])) continue;
    const ia = idx[t * 3] * 3;
    const ib = idx[t * 3 + 1] * 3;
    const ic = idx[t * 3 + 2] * 3;
    const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
    const bx = p[ib], by = p[ib + 1], bz = p[ib + 2];
    const cx = p[ic], cy = p[ic + 1], cz = p[ic + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    out.push({
      ax, ay, az, bx, by, bz, cx, cy, cz,
      nx, ny, nz,
      min: [Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz)],
      max: [Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz)],
      area: len * 0.5,
    });
  }
  return out;
}

function averageNormal(tris: FaceTriangles[]): Vec3 {
  let x = 0, y = 0, z = 0;
  let w = 0;
  for (const t of tris) {
    x += t.nx * t.area;
    y += t.ny * t.area;
    z += t.nz * t.area;
    w += t.area;
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

function nodesNearTriangles(mesh: VoxelMeshData, tris: FaceTriangles[], capture: number): Uint8Array {
  const flags = new Uint8Array(mesh.nodeCount);
  const p = mesh.positions;
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (pointNearTriangles(p, n, tris, capture)) flags[n] = 1;
  }
  return flags;
}

function pointNearTriangles(positions: Float32Array, node: number, tris: FaceTriangles[], capture: number): boolean {
  const px = positions[node * 3], py = positions[node * 3 + 1], pz = positions[node * 3 + 2];
  const capture2 = capture * capture;
  for (const t of tris) {
    if (
      px < t.min[0] - capture || px > t.max[0] + capture ||
      py < t.min[1] - capture || py > t.max[1] + capture ||
      pz < t.min[2] - capture || pz > t.max[2] + capture
    ) continue;
    if (pointTriangleDistanceSq(px, py, pz, t) <= capture2) return true;
  }
  return false;
}

function pointTriangleDistanceSq(px: number, py: number, pz: number, t: FaceTriangles): number {
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
    const qx = t.bx + (t.cx - t.bx) * w - px;
    const qy = t.by + (t.cy - t.by) * w - py;
    const qz = t.bz + (t.cz - t.bz) * w - pz;
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

function nearestTriangleNormal(px: number, py: number, pz: number, tris: FaceTriangles[], maxDist: number): FaceTriangles | null {
  let best: FaceTriangles | null = null;
  let bestD = maxDist * maxDist;
  for (const t of tris) {
    if (px < t.min[0] - maxDist || px > t.max[0] + maxDist || py < t.min[1] - maxDist || py > t.max[1] + maxDist || pz < t.min[2] - maxDist || pz > t.max[2] + maxDist) continue;
    const d = pointTriangleDistanceSq(px, py, pz, t);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function slotFor(neighbors: number[], target: number): number {
  let lo = 0;
  let hi = neighbors.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (neighbors[mid] === target) return mid;
    if (neighbors[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function pcg(
  rowStart: Int32Array,
  cols: Int32Array,
  vals: Float64Array,
  diag: Float64Array,
  rhs: Float64Array,
  onIter?: (iter: number, residual: number) => void,
): { x: Float64Array; iterations: number; residual: number; converged: boolean } {
  const n = rhs.length;
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
  const tol = 1e-8 * rhsNorm;
  let iterations = 0;
  let residual = rhsNorm;
  const maxIter = Math.min(12000, Math.max(300, n * 2));
  const blockRows = n / 3;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    for (let r = 0; r < blockRows; r++) {
      const row = r * 3;
      ap[row] = 0;
      ap[row + 1] = 0;
      ap[row + 2] = 0;
      let k = rowStart[r];
      for (let i = 0; i < 3; i++) {
        ap[row + i] += vals[k + i * 3] * p[row] + vals[k + i * 3 + 1] * p[row + 1] + vals[k + i * 3 + 2] * p[row + 2];
      }
      k += 9;
      const end = rowStart[r + 1];
      while (k < end) {
        const col = cols[k];
        for (let i = 0; i < 3; i++) {
          ap[row + i] += vals[k + i * 3] * p[col] + vals[k + i * 3 + 1] * p[col + 1] + vals[k + i * 3 + 2] * p[col + 2];
        }
        k += 9;
      }
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
    onIter?.(iterations, residual);
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
  return { x, iterations, residual, converged: residual <= Math.max(tol * 10, rhsNorm * 1e-6) };
}

export function elasticityMatrix(E: number, nu: number): number[][] {
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const mu = E / (2 * (1 + nu));
  return [
    [lam + 2 * mu, lam, lam, 0, 0, 0],
    [lam, lam + 2 * mu, lam, 0, 0, 0],
    [lam, lam, lam + 2 * mu, 0, 0, 0],
    [0, 0, 0, mu, 0, 0],
    [0, 0, 0, 0, mu, 0],
    [0, 0, 0, 0, 0, mu],
  ];
}

/** Constant-strain tetrahedron stiffness matrix (12x12), kept for reference tests. */
export function tetStiffness(coords: [number, number, number][], E: number, nu: number): number[][] {
  const B = strainMatrixTet(coords);
  const D = elasticityMatrix(E, nu);
  const vol = Math.abs(tetVolume(coords[0], coords[1], coords[2], coords[3]));
  const Ke: number[][] = Array.from({ length: 12 }, () => new Array(12).fill(0));
  const DB: number[][] = Array.from({ length: 6 }, () => new Array(12).fill(0));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 12; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += D[i][k] * B[k][j];
      DB[i][j] = s;
    }
  }
  for (let a = 0; a < 12; a++) {
    for (let b = 0; b < 12; b++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += B[k][a] * DB[k][b];
      Ke[a][b] = s * vol;
    }
  }
  return Ke;
}

export function strainMatrixTet(coords: [number, number, number][]): number[][] {
  const [p0, p1, p2, p3] = coords;
  const j11 = p1[0] - p0[0], j12 = p2[0] - p0[0], j13 = p3[0] - p0[0];
  const j21 = p1[1] - p0[1], j22 = p2[1] - p0[1], j23 = p3[1] - p0[1];
  const j31 = p1[2] - p0[2], j32 = p2[2] - p0[2], j33 = p3[2] - p0[2];
  const det = j11 * (j22 * j33 - j23 * j32) - j12 * (j21 * j33 - j23 * j31) + j13 * (j21 * j32 - j22 * j31);
  const invDet = 1 / (det || 1e-15);
  const i11 = (j22 * j33 - j23 * j32) * invDet;
  const i12 = (j13 * j32 - j12 * j33) * invDet;
  const i13 = (j12 * j23 - j13 * j22) * invDet;
  const i21 = (j23 * j31 - j21 * j33) * invDet;
  const i22 = (j11 * j33 - j13 * j31) * invDet;
  const i23 = (j13 * j21 - j11 * j23) * invDet;
  const i31 = (j21 * j32 - j22 * j31) * invDet;
  const i32 = (j12 * j31 - j11 * j32) * invDet;
  const i33 = (j11 * j22 - j12 * j21) * invDet;
  const gx = [-i11 - i21 - i31, i11, i21, i31];
  const gy = [-i12 - i22 - i32, i12, i22, i32];
  const gz = [-i13 - i23 - i33, i13, i23, i33];
  const B: number[][] = Array.from({ length: 6 }, () => new Array(12).fill(0));
  for (let k = 0; k < 4; k++) {
    B[0][k * 3] = gx[k];
    B[1][k * 3 + 1] = gy[k];
    B[2][k * 3 + 2] = gz[k];
    B[3][k * 3] = gy[k];
    B[3][k * 3 + 1] = gx[k];
    B[4][k * 3 + 1] = gz[k];
    B[4][k * 3 + 2] = gy[k];
    B[5][k * 3] = gz[k];
    B[5][k * 3 + 2] = gx[k];
  }
  return B;
}

/** Backwards-compatible alias for the previous tetrahedral strain matrix export. */
export const strainMatrix = strainMatrixTet;
