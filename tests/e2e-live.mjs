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
console.log("BOOT", JSON.stringify({ ms: Date.now() - started }));

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

console.log("ERRORS", errors.length ? JSON.stringify(errors, null, 2) : "none");
const ok =
  sample.volume === 98507 &&
  bytes > 30000 &&
  Boolean(fea.converged) &&
  Number(fea.maxDeformation) > 0 &&
  Number(fea.maxStress) > 0 &&
  fea.colorbarVisible === true &&
  errors.length === 0;
console.log("RESULT", ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
