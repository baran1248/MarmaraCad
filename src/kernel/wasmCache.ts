/** Persistent browser caching for the OCCT WebAssembly binary.
 *
 *  The kernel is a 66 MB .wasm file. GitHub Pages serves it gzipped (~14 MB) but
 *  every cold navigation would otherwise re-download it. We keep the compiled
 *  bytes in the Cache API keyed by the hashed asset URL, so a new deployment
 *  automatically invalidates the entry while repeat visits load from disk.
 *
 *  The loader hands Emscripten a blob URL of the cached bytes, which keeps
 *  WebAssembly streaming instantiation available. */

const CACHE_NAME = "marmaracad-kernel-v1";

export interface WasmProgress {
  phase: "checking" | "download" | "cached" | "ready";
  percent: number;
  loaded: number;
  total: number;
  fromCache: boolean;
}

export interface CachedWasm {
  url: string;
  fromCache: boolean;
  bytes: number;
}

const canCache = (): boolean => typeof caches !== "undefined" && typeof Response !== "undefined";

/** Load `url` into a blob URL, preferring a Cache API copy when one exists. */
export async function loadCachedWasm(url: string, onProgress?: (p: WasmProgress) => void): Promise<CachedWasm> {
  const report = (phase: WasmProgress["phase"], percent: number, loaded: number, total: number, fromCache: boolean) =>
    onProgress?.({ phase, percent, loaded, total, fromCache });

  report("checking", 0, 0, 0, false);

  let cache: Cache | null = null;
  if (canCache()) {
    try {
      cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        const blob = await hit.blob();
        report("cached", 100, blob.size, blob.size, true);
        return { url: URL.createObjectURL(blob), fromCache: true, bytes: blob.size };
      }
    } catch {
      cache = null; // Private mode or a blocked Cache API must not break boot.
    }
  }

  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`The geometry kernel could not be downloaded (HTTP ${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const type = response.headers.get("content-type") ?? "application/wasm";

  let blob: Blob;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loaded += value.byteLength;
      report("download", total > 0 ? (loaded / total) * 100 : 0, loaded, total, false);
    }
    blob = new Blob(chunks as BlobPart[], { type });
  } else {
    blob = new Blob([await response.arrayBuffer()], { type });
  }
  report("download", 100, blob.size, blob.size, false);

  if (cache) {
    // Persist without blocking the first boot; blob.slice() shares the bytes.
    // Entries from previous deployments (different hashed URLs) are removed so
    // the cache never grows by 66 MB per release.
    const store = cache;
    void (async () => {
      try {
        const keys = await store.keys();
        await Promise.all(keys.filter((key) => key.url !== url).map((key) => store.delete(key)));
        await store.put(url, new Response(blob.slice(), { headers: { "content-type": type, "content-length": String(blob.size) } }));
      } catch {
        /* a full quota or a blocked cache must not break boot */
      }
    })();
  }

  return { url: URL.createObjectURL(blob), fromCache: false, bytes: blob.size };
}

/** Remove the cached kernel (used by Tools → Clear cached kernel). */
export async function clearKernelCache(): Promise<void> {
  if (!canCache()) return;
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
}

export async function kernelCacheSize(): Promise<number> {
  if (!canCache()) return 0;
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    let total = 0;
    for (const key of keys) {
      const res = await cache.match(key);
      if (res) total += (await res.blob()).size;
    }
    return total;
  } catch {
    return 0;
  }
}
