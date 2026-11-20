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
await page.waitForFunction(() => window.__marmaracad?.doc?.()?.parts?.[0]?.features?.length === 3, null, { timeout: 120000 });
await page.waitForFunction(() => {
  const app = window.__marmaracad;
  const doc = app?.doc?.();
  const mesh = doc && app.meshes().get(doc.parts[0].id);
  return Boolean(mesh && mesh.volume > 50000);
}, null, { timeout: 120000 });

// --- insert two components ---
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="insert-component"]');
await page.waitForSelector("#insert-qty", { timeout: 15000 });
await page.fill("#insert-qty", "2");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().components.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(600);

const inserted = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  return {
    mode: doc.mode,
    components: doc.components.map((c) => ({ name: c.name, fixed: c.fixed, pos: c.position.map((v) => Math.round(v)) })),
    tree: document.querySelector(".panel-body")?.innerText?.slice(0, 400),
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("INSERT", JSON.stringify(inserted, null, 2));

// --- transform the second component through the tree double-click panel ---
const second = await page.evaluate(() => window.__marmaracad.doc().components[1].id);
await page.dblclick(`[data-key="component:${second}"]`);
await page.waitForSelector("#pm-ty", { timeout: 15000 });
await page.fill("#pm-ty", "12");
await page.click("[data-pm-ok]");
await page.waitForTimeout(400);
const transformed = await page.evaluate(() => {
  const c = window.__marmaracad.doc().components[1];
  return { pos: c.position.map((v) => Math.round(v)), rotation: c.rotation };
});
console.log("TRANSFORM", JSON.stringify(transformed, null, 2));

// --- coincident mate using two faces (programmatic picks through the live panel) ---
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="mate-coincident"]');
await page.waitForSelector("#pm-mate-picks", { timeout: 15000 });
const picked = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const a = doc.components[0];
  const b = doc.components[1];
  const mesh = window.__marmaracad.meshes().get(a.partId);
  // bottom planar face on A, top planar face on B
  const bottom = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9);
  const top = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9);
  app.command.onFace({ componentId: a.id, partId: a.partId, faceIndex: bottom, face: mesh.faces[bottom] });
  app.command.onFace({ componentId: b.id, partId: b.partId, faceIndex: top, face: mesh.faces[top] });
  return { bottom, top, surfaces: [mesh.faces[bottom]?.surface, mesh.faces[top]?.surface] };
});
console.log("PICKS", JSON.stringify(picked));
await page.waitForTimeout(200);
const pickList = await page.evaluate(() => document.getElementById("pm-mate-picks")?.innerText);
console.log("PICKLIST", JSON.stringify(pickList));
await page.click("[data-pm-ok]");
await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 1, null, { timeout: 30000 });
await page.waitForTimeout(600);

const mated = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  const b = doc.components[1];
  return {
    mates: doc.mates.map((m) => ({ type: m.type, name: m.name, a: m.a.faceIndex, b: m.b.faceIndex })),
    posB: b.position.map((v) => Math.round(v)),
    tree: document.querySelector(".panel-body")?.innerText?.slice(0, 500),
    toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent?.trim()),
  };
});
console.log("MATE", JSON.stringify(mated, null, 2));

console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 2) : "none");
await browser.close();
