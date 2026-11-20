import type { MeshData, RebuildPart } from "../model/types";
import type { ExportResponse, ImportResponse, KernelResponse, RebuildResponse } from "./protocol";

export interface RebuildResult {
  parts: Record<string, MeshData>;
  errors: Record<string, Record<string, string>>;
  kernelMs: number;
}

type Waiter = {
  types: KernelResponse["type"][];
  resolve: (r: KernelResponse) => void;
  reject: (e: Error) => void;
  timer: number;
};

export class CadClient {
  private worker: Worker;
  private readyPromise: Promise<number>;
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private bootMs = 0;
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL("./cad.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<KernelResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(`Geometry worker error: ${e.message || "unknown"}`);
      if (this.waiter) {
        window.clearTimeout(this.waiter.timer);
        this.waiter.reject(err);
        this.waiter = null;
      }
    };
    this.readyPromise = this.send<{ type: "ready"; bootMs: number }>({ type: "boot" }, ["ready"]).then((r) => {
      this.bootMs = r.bootMs;
      return r.bootMs;
    });
  }

  get bootTime(): number {
    return this.bootMs;
  }

  private onMessage(msg: KernelResponse): void {
    if (msg.type === "error") {
      if (this.waiter) {
        window.clearTimeout(this.waiter.timer);
        this.waiter.reject(new Error(msg.message));
        this.waiter = null;
      }
      return;
    }
    if (!this.waiter) return;
    if (!this.waiter.types.includes(msg.type)) return;
    window.clearTimeout(this.waiter.timer);
    this.waiter.resolve(msg);
    this.waiter = null;
  }

  private send<T extends KernelResponse>(req: unknown, types: KernelResponse["type"][]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("Kernel is closed."));
        return;
      }
      if (this.waiter) {
        reject(new Error("Kernel request overlap."));
        return;
      }
      const timer = window.setTimeout(() => {
        this.waiter = null;
        reject(new Error("The geometry kernel timed out. Try simplifying the model."));
      }, 300000);
      this.waiter = {
        types,
        resolve: (r) => resolve(r as T),
        reject,
        timer,
      };
      this.worker.postMessage(req);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async ready(): Promise<number> {
    return this.readyPromise;
  }

  rebuild(parts: RebuildPart[], quality = 0.12): Promise<RebuildResult> {
    return this.enqueue(async () => {
      await this.readyPromise;
      const res = await this.send<RebuildResponse>({ type: "rebuild", parts, quality }, ["rebuild"]);
      return { parts: res.parts, errors: res.errors, kernelMs: res.kernelMs };
    });
  }

  importFile(partId: string, format: "step" | "iges", data: ArrayBuffer, rev: string): Promise<ImportResponse> {
    return this.enqueue(async () => {
      await this.readyPromise;
      return this.send<ImportResponse>({ type: "import", partId, format, data, rev }, ["import"]);
    });
  }

  exportCAD(
    format: "step" | "iges",
    targets: { partId: string; matrix?: number[] }[],
    filename: string,
  ): Promise<Uint8Array> {
    return this.enqueue(async () => {
      await this.readyPromise;
      const res = await this.send<ExportResponse>({ type: "export", format, targets, filename }, ["export"]);
      if (res.error || !res.bytes) throw new Error(res.error || "Export failed.");
      return res.bytes;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
  }
}

let singleton: CadClient | null = null;
export function cadClient(): CadClient {
  if (!singleton) singleton = new CadClient();
  return singleton;
}
