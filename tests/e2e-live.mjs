/* Live-deployment smoke test: boots the published GitHub Pages app, loads the
 * sample, exports STEP and checks that the deployed kernel workers are healthy.
 * Run with: node tests/e2e-live.mjs [url] */
import { chromium } from "playwright-core";

const url = process.argv[2] || process.env.MARMARACAD_URL || "https://baran1248.github.io/MarmaraCad/";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--disable-gpu-sandbox", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => {
  if (!r.url().includes("favicon")) errors.push(`requestfailed: ${r.url().slice(-110)} ${r.failure()?.errorText}`);
});

console.log("URL", url);
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
const bootMs = Date.now() - started;
const bootInfo = await page.evaluate(() => ({
  renderer: window.__marmaracad?.renderer?.(),
  canvasRenderer: document.querySelector(".viewport-canvas")?.getAttribute("data-renderer"),
  kernel: window.__marmaracad?.kernel?.(),
}));
console.log("BOOT", JSON.stringify({ ms: bootMs, ...bootInfo }));

await page.click('[data-tree-action="sample"]');
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app?.doc?.();
    const mesh = doc && app.meshes().get(doc.parts[0].id);
    return Boolean(mesh && mesh.volume > 50000);
  },
  null,
  { timeout: 180000 },
);
const sample = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return {
    name: doc.name,
    features: doc.parts[0].features.length,
    volume: Math.round(mesh.volume),
    faces: mesh.faces.length,
    edges: mesh.edges.length,
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("SAMPLE", JSON.stringify(sample));

await page.click('[data-cmd-tab="evaluate"]');
const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
await page.click('[data-cmd-action="export-step"]');
const download = await downloadPromise;
const path = await download.path();
const bytes = path ? (await (await import("node:fs/promises")).stat(path)).size : 0;
console.log("STEP", JSON.stringify({ suggested: download.suggestedFilename(), bytes }));

// exercise the FEA worker on the deployed build
await page.click('[data-cmd-tab="analysis"]');
await page.click('[data-cmd-action="new-study"]');
await page.waitForSelector("#pm-study-material", { timeout: 60000 });
await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1, null, { timeout: 30000 });
const studyId = await page.evaluate(() => window.__marmaracad.doc().analyses[0].id);

await page.click('[data-study-action="support"]');
await page.waitForSelector("#pm-support-list", { timeout: 30000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const bottom = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: bottom, face: mesh.faces[bottom] });
});
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].supports.length === 1, null, { timeout: 30000 });
await page.click("[data-pm-ok]");

await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector('[data-study-action="force"]', { timeout: 30000 });
await page.click('[data-study-action="force"]');
await page.waitForSelector("#pm-load-list", { timeout: 30000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const top = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: top, face: mesh.faces[top] });
});
await page.waitForSelector("#force-mag", { timeout: 30000 });
await page.fill("#force-mag", "1000");
await page.selectOption("#force-dir", "down");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].loads.length === 1, null, { timeout: 30000 });
await page.click("[data-pm-ok]");

await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector("#pm-study-mesh", { timeout: 30000 });
await page.fill("#pm-study-mesh", "3");
await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));
await page.waitForSelector('[data-study-action="mesh"]', { timeout: 30000 });
await page.click('[data-study-action="mesh"]');
await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 240000 });
await page.waitForSelector('[data-study-action="solve"]', { timeout: 30000 });
await page.click('[data-study-action="solve"]');
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 300000 });
await page.waitForTimeout(1200);
const fea = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const s = window.__marmaracad.doc().analyses[0];
  const r = app.feaResults.get(s.id);
  return {
    meshStats: s.meshStats,
    maxDeformation: r?.maxDisplacement,
    maxStress: r?.maxStress,
    safetyFactor: r?.safetyFactor,
    converged: r?.converged,
    iterations: r?.iterations,
    colorbarVisible: document.getElementById("colorbar")?.classList.contains("visible"),
  };
});
console.log("FEA", JSON.stringify(fea));

// Phase 5 surfaces on the deployed build: RAII counters, the material browser
// and the Ctrl+K palette must all exist in the published bundle.
const phase5 = await page.evaluate(async () => {
  const application = window.__marmaracad.app;
  const part = window.__marmaracad.doc().parts[0];
  const feature = part.features.find((f) => f.type === "extrude" || f.type === "cut");
  for (let i = 0; i < 6; i++) {
    if (feature) feature.params.depth = 10 + (i % 2) * 4;
    await application.rebuild();
  }
  const memory = window.__marmaracad.kernelMemory();
  application.openMaterialDialog();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const rows = document.querySelectorAll(".mat-browser [data-material]").length;
  const fields = ["mat-E", "mat-G", "mat-conductivity", "mat-specificHeat", "mat-cte", "mat-metalness"]
    .filter((id) => document.getElementById(id)).length;
  document.querySelector(".modal-head .close")?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const palette = !document.getElementById("cmd-palette-layer").hidden;
  const input = document.getElementById("cp-input");
  if (input) {
    input.value = "açınım";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const trHit = [...document.querySelectorAll(".cp-row")].some((r) => r.dataset.cpAction === "flatten");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return {
    occt: memory.occt,
    env: Boolean(application.viewport.scene.environment),
    ground: application.viewport.groundGroup.children.length,
    materialRows: rows,
    materialFields: fields,
    palette,
    trHit,
    transfer: application.fea.transfer,
  };
});
console.log("PHASE5", JSON.stringify(phase5));

console.log("ERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
const ok =
  sample.volume === 98507 &&
  bytes > 30000 &&
  (bootInfo.renderer === "webgpu" || bootInfo.renderer === "webgl2") &&
  bootInfo.canvasRenderer === bootInfo.renderer &&
  Number(bootInfo.kernel?.bytes) > 10_000_000 &&
  Boolean(fea.converged) &&
  Number(fea.maxDeformation) > 0 &&
  Number(fea.maxStress) > 0 &&
  fea.colorbarVisible === true &&
  phase5.occt?.leaked === 0 &&
  phase5.occt?.untracked === 0 &&
  phase5.occt?.created > 0 &&
  phase5.env === true &&
  phase5.ground >= 2 &&
  phase5.materialRows >= 45 &&
  phase5.materialFields === 6 &&
  phase5.palette === true &&
  phase5.trHit === true &&
  Number(phase5.transfer?.totalBuffers) > 0 &&
  errors.length === 0;
console.log("RESULT", ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
