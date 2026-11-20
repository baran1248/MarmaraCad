import { describe, expect, it } from "vitest";
import { solveStatic } from "../src/fea/solver";
import { buildTetMesh } from "../src/fea/mesher";

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
  // Subdivide the long sides so the voxel ray-cast has small enough triangles.
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
  for (const [y] of [[y0], [y1]] as const) {
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
  for (const [z] of [[z0], [z1]] as const) {
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

describe("static FEA solver", () => {
  it("builds a tet mesh for the test bar", () => {
    const surface = boxSurface(0, 40, 0, 10, 0, 10, 2);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < surface.positions.length; i += 3) {
      minX = Math.min(minX, surface.positions[i]);
      maxX = Math.max(maxX, surface.positions[i]);
      minY = Math.min(minY, surface.positions[i + 1]);
      maxY = Math.max(maxY, surface.positions[i + 1]);
      minZ = Math.min(minZ, surface.positions[i + 2]);
      maxZ = Math.max(maxZ, surface.positions[i + 2]);
    }
    console.log("SURFACE", { verts: surface.positions.length / 3, tris: surface.indices.length / 3, minX, maxX, minY, maxY, minZ, maxZ });
    const mesh = buildTetMesh(surface.positions, surface.indices, 2);
    console.log("MESH", mesh.nodeCount, mesh.elementCount, mesh.warnings);
    expect(mesh.elementCount).toBeGreaterThan(0);
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
    console.log("RESULT", {
      converged: result.converged,
      iterations: result.iterations,
      maxDisplacement: result.maxDisplacement,
      maxStress: result.maxStress,
      safety: result.safetyFactor,
      dofs: result.dofs,
    });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBeGreaterThan(0);
    // FL / (AE) = 1000 * 40 / (100 * 200000) = 0.002 mm
    expect(result.maxDisplacement).toBeGreaterThan(0.0005);
    expect(result.maxDisplacement).toBeLessThan(0.02);
    expect(result.maxStress).toBeGreaterThan(0.5);
    expect(result.maxStress).toBeLessThan(40);
    expect(result.safetyFactor).toBeGreaterThan(1);
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
