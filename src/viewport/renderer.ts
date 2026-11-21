import * as THREE from "three";

/** Minimal renderer surface used by the viewport. Both Three's WebGLRenderer and
 *  the experimental WebGPURenderer satisfy it, which lets the app pick the best
 *  backend at runtime and fall back without touching viewport code. */
export interface RendererLike {
  domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  setAnimationLoop(callback: (() => void) | null): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  dispose(): void;
  outputColorSpace: string;
  toneMapping: number;
  toneMappingExposure: number;
  localClippingEnabled?: boolean;
}

export type RendererBackend = "webgpu" | "webgl2";

export interface RendererChoice {
  renderer: RendererLike;
  backend: RendererBackend;
  label: string;
  reason?: string;
}

function webgl2Available(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

/** Capability probe so the app can report a useful message instead of a blank canvas. */
export async function detectGraphics(): Promise<{ webgpu: boolean; webgl2: boolean; adapter?: string }> {
  const webgl2 = webgl2Available();
  let webgpu = false;
  let adapter: string | undefined;
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  if (gpu && typeof gpu.requestAdapter === "function") {
    try {
      const a = (await gpu.requestAdapter()) as { info?: { vendor?: string; architecture?: string; device?: string } } | null;
      if (a) {
        webgpu = true;
        const info = a.info;
        adapter = [info?.vendor, info?.architecture, info?.device].filter(Boolean).join(" ") || "available";
      }
    } catch {
      webgpu = false;
    }
  }
  return { webgpu, webgl2, adapter };
}

function configure(renderer: RendererLike, backend: RendererBackend): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.classList.add("viewport-canvas");
  // A descriptive attribute helps bug reports and the visual QA tooling.
  renderer.domElement.dataset.renderer = backend;
}

/** Create the best available renderer.
 *
 *  WebGPU is used when the browser exposes a working adapter; any failure
 *  (no adapter, unsupported feature, context loss during init) falls back to
 *  WebGL2, and finally surfaces a readable error when neither backend exists.
 *  `?renderer=webgl2` forces the compatibility path for diagnosis. */
export async function createBestRenderer(): Promise<RendererChoice> {
  const params = new URLSearchParams(window.location.search);
  const forced = params.get("renderer");
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  const webgl2 = webgl2Available();

  if (forced !== "webgl2" && forced !== "webgl" && gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        const mod = (await import("three/webgpu")) as unknown as {
          WebGPURenderer: new (options: Record<string, unknown>) => RendererLike & { init(): Promise<void> };
        };
        const renderer = new mod.WebGPURenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
        await renderer.init();
        configure(renderer, "webgpu");
        return { renderer, backend: "webgpu", label: "WebGPU" };
      }
    } catch (error) {
      // Never let an experimental backend prevent the app from opening.
      console.warn("WebGPU renderer unavailable, using WebGL2:", error);
      if (!webgl2) {
        throw new Error("This browser could not start WebGPU or WebGL2 rendering.");
      }
      return createWebGL2(`WebGPU init failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return createWebGL2(forced === "webgl2" ? "Forced by ?renderer=webgl2" : undefined);
}

function createWebGL2(reason?: string): RendererChoice {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (error) {
    throw new Error(
      `MarmaraCad needs WebGL2 or WebGPU. Enable hardware acceleration in your browser. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!renderer.getContext()) {
    renderer.dispose();
    throw new Error("MarmaraCad needs WebGL2 or WebGPU. Enable hardware acceleration in your browser.");
  }
  configure(renderer, "webgl2");
  return { renderer, backend: "webgl2", label: "WebGL2", reason };
}
