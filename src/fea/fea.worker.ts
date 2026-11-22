/** Web Worker entry for FEA meshing and the linear-static solve.
 *  Runs off the main thread so the UI keeps painting while the CG solve iterates.
 *  Conformal Tet4/Tet10 studies use `tetSolver`; the legacy voxel hex mesher
 *  stays available as a fast preview/fallback. */

import type { AnalysisType, FeaMeshKind, Vec3 } from "../model/types";
import { solveStatic, type FeaLoadSpec } from "./solver";
import { buildVoxelMesh, buildTetMesh } from "./mesher";
import { solveTetStudy, type TetLoadSpec, type TetSupportSpec } from "./tetSolver";

interface MeshRequest {
  type: "mesh";
  positions: Float32Array;
  indices: Uint32Array;
  meshSize: number;
  meshKind?: FeaMeshKind;
}

interface SolveRequest {
  type: "solve";
  material: { E: number; nu: number; yield: number; density?: number; conductivity?: number };
  positions: Float32Array;
  indices: Uint32Array;
  triFaceIds: Uint32Array;
  supportFaces: number[];
  supports?: TetSupportSpec[];
  loads: FeaLoadSpec[];
  meshSize: number;
  meshKind?: FeaMeshKind;
  analysisType?: AnalysisType;
  localSizing?: { faceIndex: number; size: number }[];
  modeCount?: number;
  ambient?: number;
}

type WorkerRequest = MeshRequest | SolveRequest;

type Reply =
  | { type: "progress"; phase: string; percent: number }
  | {
      type: "mesh-done";
      stats: { nodes: number; elements: number; h: number; warnings: string[]; kind?: FeaMeshKind; metrics?: unknown };
    }
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

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === "mesh") {
      if (req.meshKind === "tet4" || req.meshKind === "tet10") {
        const tet = buildTetMesh(req.positions, req.indices, req.meshSize, req.meshKind);
        scope.postMessage({
          type: "mesh-done",
          stats: { nodes: tet.nodeCount, elements: tet.elementCount, h: tet.h, warnings: tet.warnings, kind: tet.kind, metrics: tet.metrics },
        });
        return;
      }
      const mesh = buildVoxelMesh(req.positions, req.indices, req.meshSize);
      scope.postMessage({
        type: "mesh-done",
        stats: { nodes: mesh.nodeCount, elements: mesh.elementCount, h: mesh.h, warnings: mesh.warnings, kind: "hex" },
      });
      return;
    }

    const t0 = performance.now();
    const meshKind = req.meshKind ?? "hex";
    const analysisType = req.analysisType ?? "static";
    const useTetrahedra = meshKind === "tet4" || meshKind === "tet10" || analysisType !== "static";
    if (useTetrahedra) {
      const supports: TetSupportSpec[] = req.supports?.length
        ? req.supports
        : req.supportFaces.map((faceIndex) => ({ faceIndex, kind: "fixed" as const }));
      const tetLoads: TetLoadSpec[] = req.loads.map((load) => ({
        type: load.type,
        faceIndex: load.faceIndex,
        magnitude: load.magnitude,
        direction: load.direction as Vec3 | undefined,
        secondary: (load as { secondary?: number }).secondary,
      }));
      const outcome = await solveTetStudy({
        material: req.material,
        sourcePositions: req.positions,
        sourceIndices: req.indices,
        sourceTriFaceIds: req.triFaceIds,
        supports,
        loads: tetLoads,
        meshSize: req.meshSize,
        meshKind: meshKind === "tet4" ? "tet4" : "tet10",
        localSizing: req.localSizing ?? [],
        analysisType,
        modeCount: req.modeCount,
        ambient: req.ambient,
        onProgress: (phase, percent) => scope.postMessage({ type: "progress", phase, percent }),
      });
      scope.postMessage({
        type: "solve-done",
        nodes: outcome.mesh.nodeCount,
        elements: outcome.mesh.elementCount,
        h: outcome.mesh.h,
        result: { ...outcome.result, meshMetrics: outcome.mesh.metrics },
        meshMs: Math.round(performance.now() - t0),
      });
      return;
    }

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
