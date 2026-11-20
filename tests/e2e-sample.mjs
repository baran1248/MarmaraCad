import { chromium } from "playwright-core";

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

const BASE = process.env.MARMARACAD_URL || "http://localhost:5173/MarmaraCad/";
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const boot = document.getElementById("boot");
  return !boot || boot.classList.contains("hidden");
}, null, { timeout: 240000 });

await page.click('[data-tree-action="sample"]');
await page.waitForFunction(() => {
  const doc = window.__marmaracad?.doc?.();
  const mesh = doc && window.__marmaracad.meshes().get(doc.parts[0].id);
  return doc?.parts?.[0]?.features?.length === 3 && mesh && mesh.volume > 50000;
}, null, { timeout: 120000 });
await page.waitForTimeout(500);

const sample = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return {
    name: doc.name,
    features: doc.parts[0].features.map((f) => f.name),
    sketches: doc.parts[0].sketches.length,
    volume: Math.round(mesh.volume),
    area: Math.round(mesh.area),
    faces: mesh.faces.length,
    edges: mesh.edges.length,
    triangles: mesh.indices.length / 3,
    warnings: mesh.warnings,
    bodies: app.app.viewport.bodyCount,
    mass: document.getElementById("mass-card")?.innerText,
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("SAMPLE", JSON.stringify(sample, null, 2));

// --- sketch interaction on the Top Plane ---
await page.click('[data-cmd-tab="sketch"]');
await page.click('[data-cmd-action="toggle-planes"]');
await page.click('[data-key="plane:top"]');
await page.click('[data-cmd-action="new-sketch"]');
await page.waitForSelector(".sketch-labels.visible", { timeout: 15000 });
await page.waitForTimeout(500);
await page.click('[data-sketch-tool="line"]');
const box = await page.locator("#viewport").boundingBox();
if (!box) throw new Error("viewport missing");
await page.mouse.click(box.x + box.width * 0.38, box.y + box.height * 0.38);
await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.38);
await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.58);
await page.mouse.click(box.x + box.width * 0.38, box.y + box.height * 0.58);
await page.mouse.click(box.x + box.width * 0.38, box.y + box.height * 0.38);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const duringSketch = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  const sketch = doc.parts[0].sketches[doc.parts[0].sketches.length - 1];
  return {
    sketchCount: doc.parts[0].sketches.length,
    entities: sketch?.entities.length,
    points: sketch?.points.length,
    panelText: document.querySelector("#panel-body")?.innerText?.slice(0, 500),
    hint: document.getElementById("selection-hint")?.textContent,
    cursor: document.getElementById("status-cursor")?.textContent,
  };
});
console.log("SKETCH-EDIT", JSON.stringify(duringSketch, null, 2));

await page.click("[data-pm-ok]");
await page.waitForFunction(() => !document.querySelector(".sketch-labels.visible"), null, { timeout: 15000 });
await page.waitForTimeout(800);
const afterSketch = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  const sketch = doc.parts[0].sketches[doc.parts[0].sketches.length - 1];
  return {
    sketches: doc.parts[0].sketches.length,
    entities: sketch?.entities.length,
    tree: document.querySelector(".panel-body")?.innerText?.slice(0, 700),
    status: document.getElementById("status-msg")?.textContent,
    undoDisabled: document.querySelector('[data-title-action="undo"]')?.hasAttribute("disabled"),
  };
});
console.log("SKETCH-SAVED", JSON.stringify(afterSketch, null, 2));

// --- extrude the new sketch ---
const sketchId = await page.evaluate(() => {
  const s = window.__marmaracad.doc().parts[0].sketches;
  return s[s.length - 1].id;
});
await page.click(`[data-key="sketch:${sketchId}"]`);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth", { timeout: 15000 });
await page.fill("#pm-depth", "8");
const beforeExtrude = await page.evaluate(() => {
  const d = window.__marmaracad.doc();
  return d.parts[0].features.length;
});
await page.click("[data-pm-ok]");
await page.waitForFunction(
  (n) => window.__marmaracad.doc()?.parts?.[0]?.features?.length === n + 1,
  beforeExtrude,
  { timeout: 60000 },
);
await page.waitForTimeout(1500);
const extrude = await page.evaluate(() => {
  const app = window.__marmaracad;
  const d = app.doc();
  const mesh = app.meshes().get(d.parts[0].id);
  return {
    features: d.parts[0].features.map((f) => `${f.name}:${f.type}`),
    errors: d.parts[0].features.filter((f) => f.error).map((f) => f.error),
    volume: Math.round(mesh.volume),
    warnings: mesh.warnings,
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("EXTRUDE", JSON.stringify(extrude, null, 2));

console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
