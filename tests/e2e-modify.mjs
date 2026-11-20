import { chromium } from "playwright-core";
import { stat } from "node:fs/promises";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--disable-gpu-sandbox", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url().slice(-100)} ${r.failure()?.errorText}`));

await page.goto("http://localhost:5173/MarmaraCad/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const boot = document.getElementById("boot");
  return !boot || boot.classList.contains("hidden");
}, null, { timeout: 240000 });
await page.click('[data-tree-action="sample"]');
await page.waitForFunction(() => {
  const app = window.__marmaracad;
  const doc = app?.doc?.();
  const mesh = doc && app.meshes().get(doc.parts[0].id);
  return Boolean(mesh && mesh.volume > 50000);
}, null, { timeout: 120000 });

const base = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return { features: doc.parts[0].features.length, volume: Math.round(mesh.volume), faces: mesh.faces.length, edges: mesh.edges.length };
});
console.log("BASE", JSON.stringify(base));

// --- fillet a vertical outer edge ---
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="fillet"]');
await page.waitForSelector("#pm-fillet-radius", { timeout: 15000 });
const edgePick = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const index = mesh.edges.findIndex((e) => {
    const a = e.points[0];
    const b = e.points[e.points.length - 1];
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) > 8;
  });
  if (index < 0) throw new Error("no vertical edge found");
  app.command.onEdge({ componentId: null, partId: part.id, edgeIndex: index, edge: mesh.edges[index] });
  return { index, length: mesh.edges[index].length };
});
console.log("EDGE", JSON.stringify(edgePick));
await page.fill("#pm-fillet-radius", "1.5");
await page.click("[data-pm-ok]");
await page.waitForFunction((n) => window.__marmaracad.doc().parts[0].features.length === n + 1, base.features, { timeout: 120000 });
await page.waitForFunction(
  (baseFaces) => {
    const app = window.__marmaracad;
    const doc = app.doc();
    const mesh = doc && app.meshes().get(doc.parts[0].id);
    const status = document.getElementById("status-msg")?.textContent ?? "";
    return Boolean(mesh && mesh.faces.length > baseFaces && status.startsWith("Rebuilt"));
  },
  base.faces,
  { timeout: 120000 },
);
const filleted = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  const f = doc.parts[0].features[doc.parts[0].features.length - 1];
  return {
    feature: f.name,
    type: f.type,
    radius: f.params.radius,
    error: f.error,
    volume: Math.round(mesh.volume),
    faces: mesh.faces.length,
    warnings: mesh.warnings,
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("FILLET", JSON.stringify(filleted, null, 2));

// --- undo / redo ---
await page.click('[data-title-action="undo"]');
await page.waitForFunction((n) => window.__marmaracad.doc().parts[0].features.length === n, base.features, { timeout: 60000 });
const undone = await page.evaluate(() => ({
  features: window.__marmaracad.doc().parts[0].features.length,
  redoDisabled: document.querySelector('[data-title-action="redo"]')?.hasAttribute("disabled"),
}));
await page.click('[data-title-action="redo"]');
await page.waitForFunction((n) => window.__marmaracad.doc().parts[0].features.length === n + 1, base.features, { timeout: 60000 });
const redone = await page.evaluate(() => window.__marmaracad.doc().parts[0].features.length);
console.log("UNDO", JSON.stringify(undone), "REDO", redone);

// --- export STEP through the command manager ---
await page.click('[data-cmd-tab="evaluate"]');
const downloadPromise = page.waitForEvent("download", { timeout: 180000 });
await page.click('[data-cmd-action="export-step"]');
const download = await downloadPromise;
const downloadPath = await download.path();
const size = downloadPath ? (await stat(downloadPath)).size : 0;
console.log("STEP", JSON.stringify({ suggested: download.suggestedFilename(), bytes: size, target: downloadPath?.split("\\").slice(-2).join("/") }));
await page.waitForTimeout(800);

// --- autosave + reload ---
await page.waitForTimeout(1800);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const boot = document.getElementById("boot");
  return !boot || boot.classList.contains("hidden");
}, null, { timeout: 240000 });
await page.waitForTimeout(800);
const restored = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  return {
    name: doc.name,
    features: doc.parts[0]?.features?.length,
    sketches: doc.parts[0]?.sketches?.length,
    toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent?.trim()),
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("RESTORED", JSON.stringify(restored, null, 2));

console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
