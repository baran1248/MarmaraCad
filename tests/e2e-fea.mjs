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

await page.goto("http://localhost:5173/MarmaraCad/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const boot = document.getElementById("boot");
  return !boot || boot.classList.contains("hidden");
}, null, { timeout: 240000 });

await page.click('[data-tree-action="sample"]');
await page.waitForFunction(() => window.__marmaracad?.doc?.()?.parts?.[0]?.features?.length === 3, null, { timeout: 120000 });
await page.waitForFunction(() => {
  const app = window.__marmaracad;
  const doc = app?.doc?.();
  const mesh = doc && app.meshes().get(doc.parts[0].id);
  return Boolean(mesh && mesh.volume > 50000);
}, null, { timeout: 120000 });

// --- create a static study ---
await page.click('[data-cmd-tab="analysis"]');
await page.click('[data-cmd-action="new-study"]');
await page.waitForSelector("#pm-study-material", { timeout: 30000 });
await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1, null, { timeout: 30000 });
const studyId = await page.evaluate(() => window.__marmaracad.doc().analyses[0].id);

const study = await page.evaluate(() => {
  const s = window.__marmaracad.doc().analyses[0];
  return { name: s.name, materialId: s.materialId, meshSize: s.meshSize, status: s.status, mode: window.__marmaracad.doc().mode };
});
console.log("STUDY", JSON.stringify(study));

// --- fixed support on the bottom face ---
await page.click('[data-study-action="support"]');
await page.waitForSelector("#pm-support-list", { timeout: 15000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const bottom = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: bottom, face: mesh.faces[bottom] });
});
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].supports.length === 1, null, { timeout: 15000 });
await page.click("[data-pm-ok]");

// --- force on the top face ---
await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector('[data-study-action="force"]', { timeout: 15000 });
await page.click('[data-study-action="force"]');
await page.waitForSelector("#pm-load-list", { timeout: 15000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const top = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: top, face: mesh.faces[top] });
});
await page.waitForSelector("#force-mag", { timeout: 15000 });
await page.fill("#force-mag", "1000");
await page.selectOption("#force-dir", "down");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].loads.length === 1, null, { timeout: 15000 });
await page.click("[data-pm-ok]");

// --- mesh ---
await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector('#pm-study-mesh', { timeout: 15000 });
await page.fill("#pm-study-mesh", "3");
await page.evaluate(() => {
  const el = document.getElementById("pm-study-mesh");
  el?.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForSelector('[data-study-action="mesh"]', { timeout: 15000 });
await page.click('[data-study-action="mesh"]');
await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 180000 });
const meshed = await page.evaluate(() => {
  const s = window.__marmaracad.doc().analyses[0];
  return { status: s.status, meshStats: s.meshStats };
});
console.log("MESH", JSON.stringify(meshed));

// --- solve ---
await page.waitForSelector('[data-study-action="solve"]', { timeout: 15000 });
await page.click('[data-study-action="solve"]');
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 240000 });
await page.waitForTimeout(1200);

const solved = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const s = window.__marmaracad.doc().analyses[0];
  const r = app.feaResults.get(s.id);
  return {
    status: s.status,
    error: s.error,
    maxDeformation: r?.maxDisplacement,
    maxStress: r?.maxStress,
    safetyFactor: r?.safetyFactor,
    dofs: r?.dofs,
    iterations: r?.iterations,
    converged: r?.converged,
    colorbar: document.getElementById("colorbar")?.innerText,
    colorbarVisible: document.getElementById("colorbar")?.classList.contains("visible"),
    toolbar: document.getElementById("result-toolbar")?.innerText,
    studyPanel: document.querySelector(".panel-body")?.innerText?.slice(0, 600),
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("SOLVED", JSON.stringify(solved, null, 2));

// --- switch to deformation result ---
await page.click('[data-result-mode="deformation"]');
await page.waitForTimeout(500);
const deformation = await page.evaluate(() => ({
  colorbar: document.getElementById("colorbar")?.innerText,
  active: document.querySelector('[data-result-mode="deformation"]')?.classList.contains("active"),
}));
console.log("DEFORMATION", JSON.stringify(deformation));

console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
