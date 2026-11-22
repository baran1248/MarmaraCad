import { describe, expect, it } from "vitest";
import { solveTetStudy } from "../src/fea/tetSolver";

/** Closed box surface with outward-wound triangles. */
function boxMesh(L: number, H: number, W: number) {
  const positions = new Float32Array([
    0, 0, 0, L, 0, 0, L, H, 0, 0, H, 0,
    0, 0, W, L, 0, W, L, H, W, 0, H, W,
  ]);
  const faces: [number, number, number, number][] = [
    [0, 4, 7, 3],
    [1, 2, 6, 5],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 3, 2, 1],
    [4, 5, 6, 7],
  ];
  const indices: number[] = [];
  const triFaceIds: number[] = [];
  faces.forEach(([a, b, c, d], faceId) => {
    indices.push(a, b, c, a, c, d);
    triFaceIds.push(faceId, faceId);
  });
  return { positions, indices: new Uint32Array(indices), triFaceIds: new Uint32Array(triFaceIds) };
}

/** Plate with a circular through-hole, triangulated as a radial fan between the
 *  hole and the rectangular outer boundary. The surface is closed, so the
 *  voxel inside/outside parity test sees a real hole. */
function perforatedPlate(width: number, height: number, thickness: number, radius: number, segments = 64) {
  const positions: number[] = [];
  const indices: number[] = [];
  const triFaceIds: number[] = [];
  const push = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const innerBottom: number[] = [];
  const innerTop: number[] = [];
  const outerBottom: number[] = [];
  const outerTop: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    const scale = Math.min(width / 2 / Math.max(1e-9, Math.abs(cx)), height / 2 / Math.max(1e-9, Math.abs(cy)));
    innerBottom.push(push(cx * radius, cy * radius, 0));
    innerTop.push(push(cx * radius, cy * radius, thickness));
    outerBottom.push(push(cx * scale, cy * scale, 0));
    outerTop.push(push(cx * scale, cy * scale, thickness));
  }
  const quad = (a: number, b: number, c: number, d: number, faceId: number) => {
    indices.push(a, b, c, a, c, d);
    triFaceIds.push(faceId, faceId);
  };
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    // Top (+Z) and bottom (-Z) annular sectors.
    quad(innerTop[i], outerTop[i], outerTop[j], innerTop[j], 1);
    quad(innerBottom[i], innerBottom[j], outerBottom[j], outerBottom[i], 0);
    // Outer wall: split into the four rectangular sides so supports and loads
    // can target one edge of the plate.
    const mx = (positions[outerBottom[i] * 3] + positions[outerBottom[j] * 3]) / 2;
    const my = (positions[outerBottom[i] * 3 + 1] + positions[outerBottom[j] * 3 + 1]) / 2;
    const wallFace = Math.abs(mx) >= width / 2 - 1e-6 ? (mx < 0 ? 2 : 3) : my < 0 ? 4 : 5;
    quad(outerBottom[i], outerBottom[j], outerTop[j], outerTop[i], wallFace);
    // Hole wall (normal points into the hole).
    quad(innerBottom[i], innerTop[i], innerTop[j], innerBottom[j], 6);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    triFaceIds: new Uint32Array(triFaceIds),
  };
}

describe("FEA analytics", () => {
  it("cantilever beam matches PL^3/3EI, reaction force, probe and 600 MPa bending stress", async () => {
    const box = boxMesh(100, 10, 10);
    const outcome = await solveTetStudy({
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850 },
      sourcePositions: box.positions,
      sourceIndices: box.indices,
      sourceTriFaceIds: box.triFaceIds,
      supports: [{ faceIndex: 0, kind: "fixed" }],
      loads: [{ type: "force", faceIndex: 1, magnitude: 1000, direction: [0, -1, 0] }],
      meshSize: 2.5,
      meshKind: "tet10",
      analysisType: "static",
    });
    const result = outcome.result;
    const analytical = (1000 * 100 ** 3) / (3 * 200000 * ((10 * 10 ** 3) / 12));
    expect(analytical).toBeCloseTo(2, 9);
    expect(Math.abs(result.maxDisplacement - analytical) / analytical).toBeLessThan(0.02);
    expect(Math.abs(result.reaction[1] - 1000)).toBeLessThan(10);
    expect(Math.abs(result.reaction[0])).toBeLessThan(5);

    // Bending stress is linear along the beam. Fit the top-surface envelope
    // away from the fixed-end singularity and extrapolate to x = 0; this is the
    // nominal root stress used by beam theory (600 MPa).
    const positions = result.positions;
    const top = outcome.mesh.bounds.max[1];
    const perSection = new Map<number, number>();
    let probeNode = -1;
    let probeDistance = Infinity;
    const boundary = new Set(result.boundaryIndices);
    for (const node of boundary) {
      if (Math.abs(positions[node * 3 + 1] - top) > 1e-3) continue;
      const x = positions[node * 3];
      if (x >= 10 && x <= 90) {
        const key = Math.round(x * 2) / 2;
        perSection.set(key, Math.max(perSection.get(key) ?? 0, result.vonMises[node]));
      }
      const distance = Math.hypot(positions[node * 3] - 50, positions[node * 3 + 1] - top, positions[node * 3 + 2]);
      if (distance < probeDistance) {
        probeDistance = distance;
        probeNode = node;
      }
    }
    const xs = [...perSection.keys()];
    const ys = xs.map((x) => perSection.get(x)!);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < xs.length; i++) {
      numerator += (xs[i] - meanX) * (ys[i] - meanY);
      denominator += (xs[i] - meanX) ** 2;
    }
    const slope = numerator / denominator;
    const rootStress = meanY - slope * meanX;
    expect(Math.abs(rootStress - 600) / 600).toBeLessThan(0.02);
    expect(probeNode).toBeGreaterThanOrEqual(0);
    const probeStress = result.vonMises[probeNode];
    // At mid-span the bending moment is half the root value: 300 MPa.
    expect(Math.abs(probeStress - 300) / 300).toBeLessThan(0.08);
    expect(result.maxDisplacement).toBeGreaterThan(0);
    expect(result.meshMetrics?.avgJacobian ?? 0).toBeGreaterThan(0.05);
  }, 240000);

  it("Tet10 is less stiff than Tet4 on the same perforated plate and captures stress concentration", async () => {
    const plate = perforatedPlate(100, 40, 4, 10, 56);
    const support = { faceIndex: 2, kind: "fixed" as const };
    const load = { type: "force" as const, faceIndex: 3, magnitude: 8000, direction: [1, 0, 0] as [number, number, number] };
    const common = {
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850 },
      sourcePositions: plate.positions,
      sourceIndices: plate.indices,
      sourceTriFaceIds: plate.triFaceIds,
      supports: [support],
      loads: [load],
      meshSize: 2,
      analysisType: "static" as const,
    };
    const tet10 = await solveTetStudy({ ...common, meshKind: "tet10" });
    const tet4 = await solveTetStudy({ ...common, meshKind: "tet4" });
    const nominal = 8000 / ((40 - 20) * 4);
    const kt10 = tet10.result.maxStress / nominal;
    expect(kt10).toBeGreaterThan(2);
    expect(kt10).toBeLessThan(5);
    expect(tet10.result.maxDisplacement).toBeGreaterThan(tet4.result.maxDisplacement);
    expect(tet10.mesh.metrics.avgJacobian).toBeGreaterThan(0.05);
    expect(tet10.mesh.elementCount).toBe(tet4.mesh.elementCount);
  }, 240000);

  it("modal f1 follows the Euler-Bernoulli cantilever formula", async () => {
    const box = boxMesh(100, 10, 10);
    const outcome = await solveTetStudy({
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850 },
      sourcePositions: box.positions,
      sourceIndices: box.indices,
      sourceTriFaceIds: box.triFaceIds,
      supports: [{ faceIndex: 0, kind: "fixed" }],
      loads: [],
      meshSize: 5,
      meshKind: "tet10",
      analysisType: "modal",
      modeCount: 4,
    });
    const E = 200000;
    const I = (10 * 10 ** 3) / 12;
    const rho = 7850 * 1e-12;
    const A = 100;
    const f1 = ((1.875104068711961 ** 2) / (2 * Math.PI)) * Math.sqrt((E * I) / (rho * A * 100 ** 4));
    const frequencies = outcome.result.frequencies ?? [];
    expect(frequencies.length).toBe(4);
    expect(Math.abs(frequencies[0] - f1) / f1).toBeLessThan(0.06);
    expect(frequencies[1]).toBeGreaterThan(frequencies[0]);
  }, 240000);

  it("steady-state thermal analysis gives a linear 1D temperature distribution", async () => {
    const box = boxMesh(100, 10, 10);
    const outcome = await solveTetStudy({
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850, conductivity: 0.05 },
      sourcePositions: box.positions,
      sourceIndices: box.indices,
      sourceTriFaceIds: box.triFaceIds,
      supports: [],
      loads: [
        { type: "temperature", faceIndex: 0, magnitude: 100 },
        { type: "temperature", faceIndex: 1, magnitude: 0 },
      ],
      meshSize: 10,
      meshKind: "tet10",
      analysisType: "thermal",
      ambient: 22,
    });
    const temperature = outcome.result.temperature!;
    let best = 0;
    let bestDistance = Infinity;
    for (let n = 0; n < temperature.length; n++) {
      const distance = Math.abs(outcome.mesh.positions[n * 3] - 50);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = n;
      }
    }
    expect(bestDistance).toBeLessThan(5);
    expect(Math.abs(temperature[best] - 50)).toBeLessThan(0.5);
    expect(Math.max(...temperature)).toBeCloseTo(100, 4);
    expect(Math.min(...temperature)).toBeCloseTo(0, 4);
  }, 240000);

  it("linear buckling multiplier matches pi^2 EI / (4 L^2) for a fixed-free column", async () => {
    const box = boxMesh(100, 10, 10);
    const outcome = await solveTetStudy({
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850 },
      sourcePositions: box.positions,
      sourceIndices: box.indices,
      sourceTriFaceIds: box.triFaceIds,
      supports: [{ faceIndex: 0, kind: "fixed" }],
      loads: [{ type: "force", faceIndex: 1, magnitude: 1000, direction: [-1, 0, 0] }],
      meshSize: 5,
      meshKind: "tet10",
      analysisType: "buckling",
    });
    const critical = (Math.PI ** 2 * 200000 * ((10 * 10 ** 3) / 12)) / (4 * 100 ** 2);
    const multiplier = outcome.result.bucklingMultiplier ?? 0;
    expect(critical).toBeGreaterThan(40000);
    expect(Number.isFinite(multiplier)).toBe(true);
    expect(Math.abs(multiplier * 1000 - critical) / critical).toBeLessThan(0.25);
  }, 240000);
});
