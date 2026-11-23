import type { AnalysisType, FeaMeshKind, FeaMeshMetrics, FeaNodeResult } from "../model/types";
import type { FeaLoadSpec } from "./solver";
import type { TetSupportSpec } from "./tetSolver";
import { collectTransferables } from "./transfer";
import type { MeshBudget } from "./mesher";

export interface FeaMeshPayload {
  positions: Float32Array;
  indices: Uint32Array;
  meshSize: number;
  meshKind?: FeaMeshKind;
  /** Hand the buffers to the worker instead of cloning them. Only set this when
   *  the caller no longer needs the arrays (a one-shot sweep, a test). */
  transferBuffers?: boolean;
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
  budget?: MeshBudget;
}

export interface FeaSolveOutcome {
  result: FeaNodeResult;
  nodes: number;
  elements: number;
  h: number;
  meshMs: number;
  /** Typed arrays that were moved rather than cloned (worker -> UI). */
  transferred?: number;
  /** Set when the browser RAM budget resized the requested mesh. */
  budget?: MeshBudget;
}

type Reply =
  | { type: "progress"; phase: string; percent: number }
  | { type: "mesh-done"; stats: FeaMeshStats; transferred?: number }
  | { type: "solve-done"; nodes: number; elements: number; h: number; result: FeaNodeResult; meshMs: number; transferred?: number }
  | { type: "error"; message: string };

export type FeaProgress = (phase: string, percent: number) => void;

export interface FeaTransferStats {
  /** ArrayBuffers moved (not cloned) in the last worker reply. */
  lastReplyBuffers: number;
  /** ArrayBuffers handed to the worker in the last request. */
  lastRequestBuffers: number;
  /** Total buffers moved since the client started. */
  totalBuffers: number;
}

export class FeaClient {
  private worker: Worker;
  private busy = false;
  private disposed = false;
  private progress: FeaProgress | null = null;
  private waiter: {
    resolve: (reply: Extract<Reply, { type: "mesh-done" | "solve-done" }>) => void;
    reject: (error: Error) => void;
  } | null = null;
  readonly transfer: FeaTransferStats = { lastReplyBuffers: 0, lastRequestBuffers: 0, totalBuffers: 0 };

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
    const moved = Number(reply.transferred) || 0;
    this.transfer.lastReplyBuffers = moved;
    this.transfer.totalBuffers += moved;
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
    transferBuffers = false,
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
      // Only the mesh inputs can be moved: loads/supports are plain JSON. The
      // caller owns the arrays, so this is opt-in (the document keeps its mesh
      // for rendering and later studies).
      const transfer = transferBuffers ? collectTransferables(request) : [];
      this.transfer.lastRequestBuffers = transfer.length;
      this.transfer.totalBuffers += transfer.length;
      this.worker.postMessage(request, transfer);
    });
  }

  mesh(payload: FeaMeshPayload, onProgress?: FeaProgress): Promise<FeaMeshStats> {
    return this.run<Extract<Reply, { type: "mesh-done" }>>(
      { type: "mesh", ...payload },
      onProgress ?? null,
      payload.transferBuffers === true,
    ).then((reply) => reply.stats);
  }

  solve(payload: FeaSolvePayload, onProgress?: FeaProgress): Promise<FeaSolveOutcome> {
    return this.run<Extract<Reply, { type: "solve-done" }>>(
      { type: "solve", ...payload },
      onProgress ?? null,
      payload.transferBuffers === true,
    ).then((reply) => ({
      result: reply.result,
      nodes: reply.nodes,
      elements: reply.elements,
      h: reply.h,
      meshMs: reply.meshMs,
      transferred: reply.transferred,
      budget: (reply.result as { meshBudget?: MeshBudget }).meshBudget,
    }));
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}
