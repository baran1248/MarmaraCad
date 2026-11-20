// OpenCascade.js (OCCT) WASM loader. The stock package entry imports the
// .wasm file without Vite's ?url suffix, which Vite rejects, so we load the
// glue module and wasm asset explicitly.
// @ts-ignore - upstream package has no ESM type declarations for this path
import opencascadeFactory from "opencascade.js/dist/opencascade.wasm.js";
// @ts-ignore - Vite asset URL import
import occtWasmUrl from "opencascade.js/dist/opencascade.wasm.wasm?url";
import { loadCachedWasm } from "./wasmCache";

export interface OcctProgress {
  phase: string;
  percent: number;
  fromCache: boolean;
  bytes: number;
}

let occtPromise: Promise<any> | null = null;
let cachedBytes = 0;
let loadedFromCache = false;

export function occtCacheInfo(): { bytes: number; fromCache: boolean } {
  return { bytes: cachedBytes, fromCache: loadedFromCache };
}

export function getOcct(onProgress?: (progress: OcctProgress) => void): Promise<any> {
  if (!occtPromise) {
    occtPromise = (async () => {
      const cached = await loadCachedWasm(occtWasmUrl, (p) => {
        cachedBytes = p.total || p.loaded;
        loadedFromCache = p.fromCache;
        onProgress?.({
          phase:
            p.phase === "cached"
              ? "Kernel restored from the browser cache…"
              : p.phase === "checking"
                ? "Checking the kernel cache…"
                : `Downloading CAD kernel · ${(p.loaded / 1048576).toFixed(1)} / ${p.total ? (p.total / 1048576).toFixed(1) : "?"} MB`,
          percent: p.phase === "cached" ? 40 : 6 + Math.min(1, p.total ? p.loaded / p.total : 0) * 34,
          fromCache: p.fromCache,
          bytes: p.total || p.loaded,
        });
      });
      cachedBytes = cached.bytes;
      loadedFromCache = cached.fromCache;
      onProgress?.({
        phase: cached.fromCache ? "Starting the cached CAD kernel…" : "Starting the CAD kernel…",
        percent: 44,
        fromCache: cached.fromCache,
        bytes: cached.bytes,
      });
      const oc = await opencascadeFactory({
        locateFile: (path: string) => (path.endsWith(".wasm") ? cached.url : path),
        print: () => {},
        printErr: () => {},
      });
      // The bytes are instantiated now; release the 66 MB blob handle.
      try {
        URL.revokeObjectURL(cached.url);
      } catch {
        /* ignore */
      }
      onProgress?.({ phase: "CAD kernel ready", percent: 55, fromCache: cached.fromCache, bytes: cached.bytes });
      return oc;
    })().catch((err) => {
      occtPromise = null;
      throw err;
    });
  }
  return occtPromise;
}
