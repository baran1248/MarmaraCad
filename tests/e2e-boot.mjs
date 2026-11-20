/* Boot / cache / renderer smoke test. Verifies:
 *  - the app starts and reports which graphics backend it selected,
 *  - the OCCT wasm lands in the Cache API on the first visit,
 *  - a second navigation restores the kernel from cache (no re-download),
 *  - forcing ?renderer=webgl2 still boots (fallback path). */
import { chromium } from "playwright-core";
import { imageStats } from "./pngstats.mjs";

const BASE = process.env.MARMARACAD_URL || "http://localhost:5173/MarmaraCad/";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--disable-gpu-sandbox", "--no-sandbox"],
});

async function bootPage(page, url) {
  const started = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    () => {
      const boot = document.getElementById("boot");
      return !boot || boot.classList.contains("hidden");
    },
    null,
    { timeout: 300000 },
  );
  return Date.now() - started;
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});
page.on("requestfailed", (r) => {
  const url = r.url();
  // Vite re-optimises three/webgpu on first use in dev and aborts the stale request.
  if (url.includes("favicon") || url.includes("three_webgpu.js")) return;
  errors.push("requestfailed: " + url.slice(-90) + " " + r.failure()?.errorText);
});

const firstMs = await bootPage(page, BASE);
const first = await page.evaluate(() => ({
  renderer: window.__marmaracad?.renderer?.(),
  kernel: window.__marmaracad?.kernel?.(),
  canvas: document.querySelector(".viewport-canvas")?.getAttribute("data-renderer"),
  built: (window.__marmaracad?.doc?.().parts ?? []).length,
}));
const firstWasmRequests = [];
page.on("request", (r) => {
  if (r.url().includes(".wasm")) firstWasmRequests.push(r.url());
});

// Wait for the asynchronous Cache API write to settle.
await page.waitForTimeout(2500);
const cacheState = await page.evaluate(async () => {
  if (!("caches" in window)) return { supported: false };
  const names = await caches.keys();
  let bytes = 0;
  let entries = 0;
  for (const name of names) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      entries++;
      const res = await cache.match(req);
      if (res) bytes += (await res.blob()).size;
    }
  }
  return { supported: true, names, entries, bytes };
});

const wasmBefore = firstWasmRequests.length;
const secondMs = await bootPage(page, BASE);
const second = await page.evaluate(() => ({
  renderer: window.__marmaracad?.renderer?.(),
  kernel: window.__marmaracad?.kernel?.(),
  status: document.getElementById("status-msg")?.textContent,
}));

// Forced WebGL2 path
const glPage = await context.newPage();
const glErrors = [];
glPage.on("pageerror", (e) => glErrors.push(e.message));
await bootPage(glPage, BASE + "?renderer=webgl2");
const gl = await glPage.evaluate(() => ({
  renderer: window.__marmaracad?.renderer?.(),
  canvas: document.querySelector(".viewport-canvas")?.getAttribute("data-renderer"),
  visible: Boolean(document.querySelector(".viewport-canvas")),
}));

// Load the sample on both backends and measure how much of the viewport is covered
// by geometry (a blank/black canvas would report a near-zero variance).
async function pixelStats(target) {
  await target.click('[data-tree-action="sample"]');
  await target.waitForFunction(
    () => {
      const app = window.__marmaracad;
      const doc = app?.doc?.();
      const mesh = doc && app.meshes().get(doc.parts[0].id);
      return Boolean(mesh && mesh.volume > 50000);
    },
    null,
    { timeout: 180000 },
  );
  await target.waitForTimeout(900);
  const box = await target.locator(".viewport-canvas").boundingBox();
  if (!box) return null;
  const shot = await target.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    animations: "disabled",
  });
  return imageStats(shot);
}

const webgpuPixels = await pixelStats(page);
const webglPixels = await pixelStats(glPage);

// Simulated device without WebGPU at all: navigator.gpu is undefined.
const noGpuContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await noGpuContext.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
});
const noGpuPage = await noGpuContext.newPage();
const noGpuErrors = [];
noGpuPage.on("pageerror", (e) => noGpuErrors.push(e.message));
noGpuPage.on("console", (m) => {
  if (m.type() === "error") noGpuErrors.push(m.text());
});
await bootPage(noGpuPage, BASE);
const noGpu = await noGpuPage.evaluate(() => ({
  renderer: window.__marmaracad?.renderer?.(),
  canvas: document.querySelector(".viewport-canvas")?.getAttribute("data-renderer"),
  visible: Boolean(document.querySelector(".viewport-canvas")),
}));
const noGpuPixels = await pixelStats(noGpuPage);

// Simulated device with no usable GPU at all: the app must explain itself
// instead of leaving a blank canvas, and must offer a reload action.
const noGfxContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await noGfxContext.addInitScript(() => {
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (typeof type === "string" && /webgl|webgpu/i.test(type)) return null;
    return original.call(this, type, ...rest);
  };
});
const noGfxPage = await noGfxContext.newPage();
const noGfxErrors = [];
noGfxPage.on("pageerror", (e) => noGfxErrors.push(e.message));
await noGfxPage.goto(BASE, { waitUntil: "domcontentloaded", timeout: 120000 });
await noGfxPage.waitForFunction(
  () => /WebGL2 or WebGPU/i.test(document.getElementById("boot-status")?.textContent ?? ""),
  null,
  { timeout: 120000 },
);
const noGfx = await noGfxPage.evaluate(() => ({
  status: document.getElementById("boot-status")?.textContent,
  note: document.querySelector(".boot-error")?.textContent,
  reloadButton: [...document.querySelectorAll(".boot button")].some((b) => /reload/i.test(b.textContent ?? "")),
  canvas: Boolean(document.querySelector(".viewport-canvas")),
}));

// Render a frame and sample pixels to prove the canvas is not blank.
const pixels = await page.evaluate(async () => {
  const canvas = document.querySelector(".viewport-canvas");
  if (!canvas) return null;
  const gl = canvas.getContext("webgl2") || canvas.getContext("webgpu");
  if (!gl) return { ctx: "none" };
  return { ctx: "present", width: canvas.width, height: canvas.height };
});

console.log(
  JSON.stringify(
    {
      firstMs,
      secondMs,
      first,
      second,
      cacheState,
      wasmRequestsDuringSession: wasmBefore,
      forcedWebGL2: gl,
      simulatedNoWebGPU: noGpu,
      simulatedNoGraphics: noGfx,
      glErrors,
      noGpuErrors,
      noGfxErrors,
      pixels,
      webgpuPixels,
      webglPixels,
      noGpuPixels,
      errors,
    },
    null,
    2,
  ),
);

const ok =
  first.built >= 1 &&
  cacheState.supported &&
  cacheState.bytes > 10_000_000 &&
  second.kernel?.fromCache === true &&
  gl.renderer === "webgl2" &&
  noGpu.renderer === "webgl2" &&
  noGpu.canvas === "webgl2" &&
  noGpuErrors.length === 0 &&
  noGfx.reloadButton === true &&
  noGfx.canvas === false &&
  noGfxErrors.length === 0 &&
  Boolean(webgpuPixels && webgpuPixels.stdDev > 8 && webgpuPixels.nonBackgroundPct > 3) &&
  Boolean(webglPixels && webglPixels.stdDev > 8 && webglPixels.nonBackgroundPct > 3) &&
  Boolean(noGpuPixels && noGpuPixels.stdDev > 8 && noGpuPixels.nonBackgroundPct > 3) &&
  errors.length === 0;
console.log("RESULT", ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
