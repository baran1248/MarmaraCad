import type { AnalysisType, FeaMeshKind, FeaMeshMetrics, FeaNodeResult } from "../model/types";
import type { FeaLoadSpec } from "./solver";
import type { TetSupportSpec } from "./tetSolver";

export interface FeaMeshPayload {
  positions: Float32Array;
  indices: Uint32Array;
  meshSize: number;
  meshKind?: FeaMeshKind;
}

export interface FeaSolvePayload extends FeaMeshPayload {
  material: { E: number; nu: number; yield: number; density?: number; conductivity?: number };
  triFaceIds: Uint32Array;
  supportFaces: number[];
  supports?: TetSupportSpec[];
  loads: FeaLoadSpec[];
  analysisType?: AnalysisType;
  localSizing?: { faceIndex: number; size: number }[];
  modeCount?: number;
  ambient?: number;
}

export interface FeaMeshStats {
  nodes: number;
  elements: number;
  h: number;
  warnings: string[];
  kind?: FeaMeshKind;
  metrics?: FeaMeshMetrics;
}

export interface FeaSolveOutcome {
  result: FeaNodeResult;
  nodes: number;
  elements: number;
  h: number;
  meshMs: number;
}

type Reply =
  | { type: "progress"; phase: string; percent: number }
  | { type: "mesh-done"; stats: FeaMeshStats }
  | { type: "solve-done"; nodes: number; elements: number; h: number; result: FeaNodeResult; meshMs: number }
  | { type: "error"; message: string };

export type FeaProgress = (phase: string, percent: number) => void;

export class FeaClient {
  private worker: Worker;
  private busy = false;
  private disposed = false;
  private progress: FeaProgress | null = null;
  private waiter: {
    resolve: (reply: Extract<Reply, { type: "mesh-done" | "solve-done" }>) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    this.worker = new Worker(new URL("./fea.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<Reply>) => this.onMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(`FEA worker error: ${event.message || "unknown"}`);
      this.finishWithError(error);
    };
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private onMessage(reply: Reply): void {
    if (reply.type === "progress") {
      this.progress?.(reply.phase, reply.percent);
      return;
    }
    if (reply.type === "error") {
      this.finishWithError(new Error(reply.message));
      return;
    }
    const waiter = this.waiter;
    this.waiter = null;
    this.busy = false;
    this.progress = null;
    waiter?.resolve(reply);
  }

  private finishWithError(error: Error): void {
    const waiter = this.waiter;
    this.waiter = null;
    this.busy = false;
    this.progress = null;
    waiter?.reject(error);
  }

  private run<T extends Extract<Reply, { type: "mesh-done" | "solve-done" }>>(
    request: unknown,
    onProgress: FeaProgress | null,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("The FEA solver is closed."));
    if (this.busy) return Promise.reject(new Error("The FEA solver is already running."));
    this.busy = true;
    this.progress = onProgress;
    return new Promise<T>((resolve, reject) => {
      this.waiter = {
        resolve: (reply) => resolve(reply as T),
        reject,
      };
      this.worker.postMessage(request);
    });
  }

  mesh(payload: FeaMeshPayload, onProgress?: FeaProgress): Promise<FeaMeshStats> {
    return this.run<Extract<Reply, { type: "mesh-done" }>>({ type: "mesh", ...payload }, onProgress ?? null).then(
      (reply) => reply.stats,
    );
  }

  solve(payload: FeaSolvePayload, onProgress?: FeaProgress): Promise<FeaSolveOutcome> {
    return this.run<Extract<Reply, { type: "solve-done" }>>({ type: "solve", ...payload }, onProgress ?? null).then(
      (reply) => ({
        result: reply.result,
        nodes: reply.nodes,
        elements: reply.elements,
        h: reply.h,
        meshMs: reply.meshMs,
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}
