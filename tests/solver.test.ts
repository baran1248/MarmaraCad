import { describe, expect, it } from "vitest";
import { hexStiffness, solveStatic } from "../src/fea/solver";
import { buildVoxelMesh } from "../src/fea/mesher";

/** Closed triangle surface of an axis-aligned box. Face ids: 1 = x min, 2 = x max, 0 = rest. */
function boxSurface(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, h: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const vertex = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number, faceId: number) => {
    indices.push(a, b, c, a, c, d);
    faceIds.push(faceId, faceId);
  };
  const nx = Math.max(1, Math.round((x1 - x0) / h));
  const ny = Math.max(1, Math.round((y1 - y0) / h));
  const nz = Math.max(1, Math.round((z1 - z0) / h));
  for (const [x, faceId] of [[x0, 1], [x1, 2]] as const) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const yA = y0 + ((y1 - y0) * j) / ny;
        const yB = y0 + ((y1 - y0) * (j + 1)) / ny;
        const zA = z0 + ((z1 - z0) * k) / nz;
        const zB = z0 + ((z1 - z0) * (k + 1)) / nz;
        const a = vertex(x, yA, zA);
        const b = vertex(x, yB, zA);
        const c = vertex(x, yB, zB);
        const d = vertex(x, yA, zB);
        quad(a, b, c, d, faceId);
      }
    }
  }
  for (const y of [y0, y1]) {
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const xA = x0 + ((x1 - x0) * i) / nx;
        const xB = x0 + ((x1 - x0) * (i + 1)) / nx;
        const zA = z0 + ((z1 - z0) * k) / nz;
        const zB = z0 + ((z1 - z0) * (k + 1)) / nz;
        const a = vertex(xA, y, zA);
        const b = vertex(xB, y, zA);
        const c = vertex(xB, y, zB);
        const d = vertex(xA, y, zB);
        quad(a, b, c, d, 0);
      }
    }
  }
  for (const z of [z0, z1]) {
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const xA = x0 + ((x1 - x0) * i) / nx;
        const xB = x0 + ((x1 - x0) * (i + 1)) / nx;
        const yA = y0 + ((y1 - y0) * j) / ny;
        const yB = y0 + ((y1 - y0) * (j + 1)) / ny;
        const a = vertex(xA, yA, z);
        const b = vertex(xB, yA, z);
        const c = vertex(xB, yB, z);
        const d = vertex(xA, yB, z);
        quad(a, b, c, d, 0);
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triFaceIds: new Uint32Array(faceIds),
  };
}

function boxCorners(size = 2): [number, number, number][] {
  return [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size],
    [0, size, size],
  ];
}

describe("hexahedral element", () => {
  it("is symmetric, positive definite and free of rigid-body forces", () => {
    const Ke = hexStiffness(boxCorners(2));
    let asymmetry = 0;
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 24; j++) asymmetry = Math.max(asymmetry, Math.abs(Ke[i][j] - Ke[j][i]));
    }
    expect(asymmetry).toBeLessThan(1e-6);
    // Translation along each axis must produce zero internal force.
    for (const axis of [0, 1, 2]) {
      const u = new Array(24).fill(0);
      for (let a = 0; a < 8; a++) u[a * 3 + axis] = 1;
      for (let i = 0; i < 24; i++) {
        let f = 0;
        for (let j = 0; j < 24; j++) f += Ke[i][j] * u[j];
        expect(Math.abs(f)).toBeLessThan(1e-6);
      }
    }
  });

  it("reproduces a uniaxial stretch exactly", () => {
    // A single brick pulled by a uniform traction must show sigma = F/A and
    // epsilon = sigma/E; the trilinear element is exact for this patch.
    const size = 10;
    const E = 200000;
    const nu = 0.3;
    const coords = boxCorners(size);
    const Ke = hexStiffness(coords, undefined);
    const area = size * size;
    // Apply F/A on the four nodes of the +Z face (z = size).
    const force = 1000;
    const nodal = force / 4;
    const rhs = new Array(24).fill(0);
    for (const a of [4, 5, 6, 7]) rhs[a * 3 + 2] = nodal;
    // Constrain the -Z face in z and one node in x/y to remove rigid modes.
    const fixed = new Set<number>();
    for (const a of [0, 1, 2, 3]) fixed.add(a * 3 + 2);
    fixed.add(0);
    fixed.add(1);
    fixed.add(3 * 3);
    const map = new Map<number, number>();
    const free: number[] = [];
    for (let i = 0; i < 24; i++) {
      if (fixed.has(i)) continue;
      map.set(i, free.length);
      free.push(i);
    }
    const n = free.length;
    const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const b: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      b[i] = rhs[free[i]];
      for (let j = 0; j < n; j++) A[i][j] = Ke[free[i]][free[j]];
    }
    // Gaussian elimination.
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
      [A[pivot], A[col]] = [A[col], A[pivot]];
      [b[pivot], b[col]] = [b[col], b[pivot]];
      const d = A[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = A[r][col] / d;
        for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
        b[r] -= f * b[col];
      }
    }
    const u = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let c = r + 1; c < n; c++) s -= A[r][c] * u[c];
      u[r] = s / A[r][r];
    }
    const topDisp = u[map.get(4 * 3 + 2)!];
    const analytic = (force / area) * size / E;
    expect(topDisp).toBeGreaterThan(0);
    expect(Math.abs(topDisp - analytic) / analytic).toBeLessThan(0.01);
  });
});

describe("static FEA solver", () => {
  it("builds a hex mesh for the test bar", () => {
    const surface = boxSurface(0, 40, 0, 10, 0, 10, 2);
    const mesh = buildVoxelMesh(surface.positions, surface.indices, 2);
    expect(mesh.elementCount).toBeGreaterThan(0);
    expect(mesh.hexes.length).toBe(mesh.elementCount * 8);
    expect(mesh.surface.length % 3).toBe(0);
  });

  it("stretches a bar under an axial force", () => {
    const surface = boxSurface(0, 40, 0, 10, 0, 10, 2);
    const outcome = solveStatic({
      material: { E: 200000, nu: 0.3, yield: 250 },
      sourcePositions: surface.positions,
      sourceIndices: surface.indices,
      sourceTriFaceIds: surface.triFaceIds,
      supportFaces: [1],
      loads: [{ type: "force", faceIndex: 2, magnitude: 1000, direction: [1, 0, 0] }],
      meshSize: 2,
    });
    const result = outcome.result;
    // FL / (AE) = 1000 * 40 / (100 * 200000) = 0.002 mm
    expect(result.converged).toBe(true);
    expect(result.maxDisplacement).toBeGreaterThan(0.0015);
    expect(result.maxDisplacement).toBeLessThan(0.0025);
    // Uniform axial stress is F/A = 1000/100 = 10 MPa away from the clamped end;
    // the clamp itself concentrates stress, so inspect the mid-span nodes instead
    // of the global maximum.
    const midSpan: number[] = [];
    for (let n = 0; n < outcome.mesh.nodeCount; n++) {
      const x = outcome.mesh.positions[n * 3];
      if (Math.abs(x - 20) < 1.01) midSpan.push(result.vonMises[n]);
    }
    midSpan.sort((a, b) => a - b);
    const median = midSpan[Math.floor(midSpan.length / 2)];
    expect(median).toBeGreaterThan(9);
    expect(median).toBeLessThan(11);
    expect(result.maxStress).toBeLessThan(60);
    expect(result.safetyFactor).toBeGreaterThan(1);
  });

  it("matches Euler-Bernoulli beam theory for a cantilever", () => {
    // 100 x 10 x 10 mm steel cantilever, 1000 N tip load.
    // I = 10*10^3/12 = 833.33 mm^4, delta = FL^3/(3EI) = 2.000 mm,
    // sigma_root = M*c/I = 100000*5/833.33 = 600 MPa.
    const surface = boxSurface(0, 100, 0, 10, 0, 10, 2);
    const outcome = solveStatic({
      material: { E: 200000, nu: 0.3, yield: 250 },
      sourcePositions: surface.positions,
      sourceIndices: surface.indices,
      sourceTriFaceIds: surface.triFaceIds,
      supportFaces: [1],
      loads: [{ type: "force", faceIndex: 2, magnitude: 1000, direction: [0, 0, -1] }],
      meshSize: 1.25,
    });
    const result = outcome.result;
    const analyticDeflection = 2.0;
    const analyticStress = 600;
    const dError = Math.abs(result.maxDisplacement - analyticDeflection) / analyticDeflection;
    const sError = Math.abs(result.maxStress - analyticStress) / analyticStress;
    console.log("BEAM", {
      deflection: result.maxDisplacement,
      stress: result.maxStress,
      dErrorPct: Math.round(dError * 1000) / 10,
      sErrorPct: Math.round(sError * 1000) / 10,
      iterations: result.iterations,
      dofs: result.dofs,
    });
    expect(result.converged).toBe(true);
    expect(dError).toBeLessThan(0.03);
    expect(sError).toBeLessThan(0.05);
    // Global equilibrium: the support must carry the whole 1000 N tip load.
    expect(Math.abs(result.reaction[2] - 1000)).toBeLessThan(50);
  });

  it("produces a non-zero pressure field", () => {
    const surface = boxSurface(0, 20, 0, 10, 0, 10, 2);
    const outcome = solveStatic({
      material: { E: 70000, nu: 0.33, yield: 275 },
      sourcePositions: surface.positions,
      sourceIndices: surface.indices,
      sourceTriFaceIds: surface.triFaceIds,
      supportFaces: [1],
      loads: [{ type: "pressure", faceIndex: 2, magnitude: 1 }],
      meshSize: 2,
    });
    expect(outcome.result.converged).toBe(true);
    expect(outcome.result.maxDisplacement).toBeGreaterThan(0);
    expect(outcome.result.maxStress).toBeGreaterThan(0);
  });
});
