/** Web Worker entry for FEA meshing and the linear-static solve.
 *  Runs off the main thread so the UI keeps painting while the CG solve iterates. */

import type { Vec3 } from "../model/types";
import { solveStatic, type FeaLoadSpec } from "./solver";
import { buildTetMesh } from "./mesher";

interface MeshRequest {
  type: "mesh";
  positions: Float32Array;
  indices: Uint32Array;
  meshSize: number;
}

interface SolveRequest {
  type: "solve";
  material: { E: number; nu: number; yield: number };
  positions: Float32Array;
  indices: Uint32Array;
  triFaceIds: Uint32Array;
  supportFaces: number[];
  loads: FeaLoadSpec[];
  meshSize: number;
}

type WorkerRequest = MeshRequest | SolveRequest;

type Reply =
  | { type: "progress"; phase: string; percent: number }
  | { type: "mesh-done"; stats: { nodes: number; elements: number; h: number; warnings: string[] } }
  | { type: "solve-done"; nodes: number; elements: number; h: number; result: unknown; meshMs: number }
  | { type: "error"; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: Reply) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "mesh") {
      const mesh = buildTetMesh(req.positions, req.indices, req.meshSize);
      scope.postMessage({
        type: "mesh-done",
        stats: { nodes: mesh.nodeCount, elements: mesh.elementCount, h: mesh.h, warnings: mesh.warnings },
      });
      return;
    }

    const t0 = performance.now();
    const solveLoads = req.loads.map((load): FeaLoadSpec => ({
      type: load.type,
      faceIndex: load.faceIndex,
      magnitude: load.magnitude,
      direction: load.direction as Vec3 | undefined,
    }));
    const outcome = solveStatic({
      material: req.material,
      sourcePositions: req.positions,
      sourceIndices: req.indices,
      sourceTriFaceIds: req.triFaceIds,
      supportFaces: req.supportFaces,
      loads: solveLoads,
      meshSize: req.meshSize,
      onProgress: (phase, percent) => scope.postMessage({ type: "progress", phase, percent }),
    });
    scope.postMessage({
      type: "solve-done",
      nodes: outcome.mesh.nodeCount,
      elements: outcome.mesh.elementCount,
      h: outcome.mesh.h,
      result: outcome.result,
      meshMs: Math.round(performance.now() - t0),
    });
  } catch (error) {
    scope.postMessage({ type: "error", message: errorMessage(error) });
  }
};
