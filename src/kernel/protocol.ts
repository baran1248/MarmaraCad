import type { MeshData, RebuildPart } from "../model/types";

export interface RebuildRequest {
  type: "rebuild";
  parts: RebuildPart[];
  quality?: number;
}

export interface RebuildResponse {
  type: "rebuild";
  parts: Record<string, MeshData>;
  errors: Record<string, Record<string, string>>;
  kernelMs: number;
}

export interface ImportRequest {
  type: "import";
  partId: string;
  format: "step" | "iges";
  data: ArrayBuffer;
  rev: string;
}

export interface ImportResponse {
  type: "import";
  partId: string;
  mesh: MeshData | null;
  error?: string;
}

export interface ExportTarget {
  partId: string;
  matrix?: number[]; // column-major 4x4
}

export interface ExportRequest {
  type: "export";
  format: "step" | "iges";
  targets: ExportTarget[];
  filename: string;
}

export interface ExportResponse {
  type: "export";
  bytes: Uint8Array | null;
  filename: string;
  error?: string;
}

export interface ReadyResponse {
  type: "ready";
  bootMs: number;
}

export interface ErrorResponse {
  type: "error";
  message: string;
  stack?: string;
}

export type KernelResponse = RebuildResponse | ImportResponse | ExportResponse | ReadyResponse | ErrorResponse;
