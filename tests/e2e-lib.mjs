/* Shared Playwright helpers for the MarmaraCad e2e suites.
 *
 * The suites drive the real UI (clicks, panels, modal dialogs) and read the
 * resulting geometry from the live document store, so a passing test means the
 * feature actually built a body — not that a mock returned a canned number. */
import { chromium } from "playwright-core";

export const BASE = process.env.MARMARACAD_URL || "http://localhost:5173/MarmaraCad/";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export async function launch() {
  return chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-gpu-sandbox", "--no-sandbox"],
  });
}

export async function openApp(browser, { width = 1440, height = 900, query = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const url = r.url();
    if (url.includes("favicon") || url.includes("three_webgpu.js")) return;
    // Vite serves HMR/worker modules from blob: URLs; a teardown or hot reload
    // aborts them with ERR_ABORTED, which is not an application failure.
    if (url.startsWith("blob:") && /ERR_ABORTED/.test(r.failure()?.errorText ?? "")) return;
    errors.push(`requestfailed: ${url.slice(-100)} ${r.failure()?.errorText}`);
  });
  await page.goto(BASE + query, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(
    () => {
      const boot = document.getElementById("boot");
      return !boot || boot.classList.contains("hidden");
    },
    null,
    { timeout: 300000 },
  );
  await page.waitForFunction(() => Boolean(window.__marmaracad?.app?.editor), null, { timeout: 120000 });
  return { context, page, errors };
}

/** Fresh document by reloading the app (fast: the kernel is cached). */
export async function reload(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const boot = document.getElementById("boot");
      return !boot || boot.classList.contains("hidden");
    },
    null,
    { timeout: 300000 },
  );
  await page.waitForFunction(() => Boolean(window.__marmaracad?.app?.editor), null, { timeout: 120000 });
}

// ------------------------------------------------------------------ sketches

/** File > New Document, confirmed. Removes the previous model so each scenario
 *  starts from a clean part instead of an autosave-restored one. */
export async function newDocument(page) {
  await page.click('[data-menu="file"]');
  await page.click('[data-menu-action="new-document"]');
  await page.waitForSelector(".modal .btn.danger", { timeout: 15000 });
  await page.click(".modal .btn.danger");
  await page.waitForFunction(
    () => {
      const doc = window.__marmaracad.doc();
      return doc.parts.length === 1 && doc.parts[0].features.length === 0;
    },
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(200);
}

export async function startSketch(page, plane = "front") {
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="new-sketch"]');
  await page.waitForSelector(`[data-plane-kind="${plane}"]`, { timeout: 20000 });
  await page.click(`[data-plane-kind="${plane}"]`);
  await page.waitForFunction(() => window.__marmaracad.app.editor.isActive, null, { timeout: 30000 });
  // zoomFit animates for 260 ms; wait so projectToScreen matches the click frame.
  await page.waitForTimeout(450);
}

/** Click a ribbon command, opening its split dropdown when it lives there.
 *  The ribbon groups related tools under one labelled button (Extrude ▾ …),
 *  so a test must not assume every action is directly on the ribbon. */
export async function runCmd(page, action) {
  const target = page.locator(`[data-cmd-action="${action}"]`).first();
  if ((await target.count()) && (await target.isVisible())) {
    await target.click();
    return;
  }
  const owner = await page.evaluate((a) => {
    const item = document.querySelector(`[data-cmd-action="${a}"]`);
    return item?.closest("[data-cmd-menu-panel]")?.getAttribute("data-cmd-menu-panel") ?? null;
  }, action);
  if (!owner) throw new Error(`Command "${action}" is not available in the ribbon.`);
  await page.click(`[data-cmd-menu="${owner}"]`);
  await page.waitForSelector(`[data-cmd-menu-panel="${owner}"]:not([hidden])`, { timeout: 5000 });
  await page.click(`[data-cmd-menu-panel="${owner}"] [data-cmd-action="${action}"]`);
}

export async function setTool(page, tool) {
  if (tool === "select") {
    // Escape cancels the pending chain, then clears the selection, then leaves
    // the drawing tool; three presses guarantee the select tool is active.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    return;
  }
  await page.click('[data-cmd-tab="sketch"]');
  await runCmd(page, `tool-${tool}`);
  await page.waitForTimeout(80);
}

/** Client coordinates of a sketch-plane point (u, v). */
export async function sketchScreenPoint(page, x, y) {
  return page.evaluate(
    ({ x, y }) => {
      const app = window.__marmaracad.app;
      const plane = app.editor.sketch.plane;
      const world = [
        plane.origin[0] + plane.u[0] * x + plane.v[0] * y,
        plane.origin[1] + plane.u[1] * x + plane.v[1] * y,
        plane.origin[2] + plane.u[2] * x + plane.v[2] * y,
      ];
      const p = app.viewport.projectToScreen(world);
      const rect = app.viewport.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + p.x, y: rect.top + p.y, visible: p.visible };
    },
    { x, y },
  );
}

export async function sketchClick(page, x, y, { shift = false } = {}) {
  const p = await sketchScreenPoint(page, x, y);
  if (!p.visible) throw new Error(`Sketch point (${x}, ${y}) is outside the camera frustum.`);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.click(p.x, p.y);
  if (shift) await page.keyboard.up("Shift");
  await page.waitForTimeout(90);
}

export async function sketchMove(page, x, y) {
  const p = await sketchScreenPoint(page, x, y);
  await page.mouse.move(p.x, p.y);
}

/** Dolly the orbit camera out so long sketches stay inside the canvas. */
export async function zoomOut(page, factor = 2) {
  await page.evaluate((f) => {
    const vp = window.__marmaracad.app.viewport;
    const dir = vp.camera.position.clone().sub(vp.controls.target);
    vp.camera.position.copy(vp.controls.target).addScaledVector(dir, f);
    vp.controls.update();
  }, factor);
  await page.waitForTimeout(150);
}

export async function finishSketch(page) {
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="exit-sketch"]');
  await page.waitForFunction(() => !window.__marmaracad.app.editor.isActive, null, { timeout: 30000 });
  await page.waitForTimeout(250);
}

export async function sketchState(page) {
  return page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    if (!s) return null;
    return {
      points: s.points.map((p) => ({ id: p.id, x: p.x, y: p.y, fixed: Boolean(p.fixed) })),
      entities: s.entities.map((e) => ({ ...e })),
      constraints: s.constraints.map((c) => ({ ...c })),
    };
  });
}

export async function closePanel(page) {
  const cancel = page.locator(".modal-foot .btn.plain, [data-pm-cancel]").first();
  if (await cancel.count()) await cancel.click();
  await page.waitForTimeout(120);
}

// ------------------------------------------------------------------ features

export async function extrude(page, { depth = 10, operation = "new", symmetric = false, cut = false } = {}) {
  const before = await featureCount(page);
  await page.click('[data-cmd-tab="features"]');
  await page.click(`[data-cmd-action="${cut ? "extrude-cut" : "extrude-boss"}"]`);
  await page.waitForSelector("#pm-depth", { timeout: 20000 });
  await page.fill("#pm-depth", String(depth));
  if (!cut && (await page.locator("#pm-operation").count())) await page.selectOption("#pm-operation", operation);
  if (symmetric) await page.check("#pm-symmetric");
  await page.click("[data-pm-ok]");
  await waitFeatureCount(page, before + 1);
}

export async function revolve(page, { angle = 360, axisMode = "v", operation = "new" } = {}) {
  const before = await featureCount(page);
  await page.click('[data-cmd-tab="features"]');
  await runCmd(page, "revolve");
  await page.waitForSelector("#pm-angle", { timeout: 20000 });
  await page.fill("#pm-angle", String(angle));
  await page.selectOption("#pm-axis-mode", axisMode);
  if (await page.locator("#pm-revolve-op").count()) await page.selectOption("#pm-revolve-op", operation);
  await page.click("[data-pm-ok]");
  await waitFeatureCount(page, before + 1);
}

export async function featureCount(page) {
  return page.evaluate(() => window.__marmaracad.doc().parts[0]?.features.length ?? 0);
}

export async function waitFeatureCount(page, count, timeout = 30000) {
  await page.waitForFunction(
    (n) => (window.__marmaracad.doc().parts[0]?.features.length ?? 0) >= n,
    count,
    { timeout },
  );
  await page.waitForTimeout(120);
}

export async function pickEdges(page, predicate) {
  return page.evaluate((source) => {
    const fn = new Function("edge", `return (${source})(edge);`);
    const app = window.__marmaracad;
    const doc = app.doc();
    const part = doc.parts[0];
    const mesh = app.meshes().get(part.id);
    const picked = [];
    mesh.edges.forEach((edge, edgeIndex) => {
      if (fn(edge)) {
        app.app.command.onEdge({ componentId: null, partId: part.id, edgeIndex, edge });
        picked.push(edgeIndex);
      }
    });
    return picked;
  }, predicate);
}

export async function waitForRebuild(page, timeout = 180000) {
  await page.waitForFunction(
    () => {
      const status = document.getElementById("status-msg")?.textContent ?? "";
      return /Rebuilt in/.test(status);
    },
    null,
    { timeout },
  );
  await page.waitForTimeout(150);
}

// ------------------------------------------------------------------ geometry

export async function body(page, index = 0) {
  return page.evaluate((i) => {
    const app = window.__marmaracad;
    const doc = app.doc();
    const part = doc.parts[i];
    if (!part) return null;
    const mesh = app.meshes().get(part.id);
    return {
      id: part.id,
      name: part.name,
      volume: mesh ? mesh.volume : 0,
      area: mesh ? mesh.area : 0,
      faces: mesh ? mesh.faces.length : 0,
      surfaces: mesh ? mesh.faces.map((f) => f.surface) : [],
      edges: mesh ? mesh.edges.length : 0,
      bbox: mesh ? mesh.bbox : null,
      shapeType: mesh ? mesh.shapeType : null,
      warnings: mesh ? mesh.warnings : [],
      features: part.features.map((f) => ({ id: f.id, type: f.type, name: f.name, params: f.params })),
      sketches: part.sketches.length,
    };
  }, index);
}

export async function waitVolume(page, predicate, timeout = 180000) {
  await page.waitForFunction(
    (src) => {
      const app = window.__marmaracad;
      const doc = app.doc();
      const mesh = doc.parts[0] ? app.meshes().get(doc.parts[0].id) : null;
      const volume = mesh ? mesh.volume : 0;
      return new Function("v", `return (${src});`)(volume);
    },
    predicate,
    { timeout },
  );
  await page.waitForTimeout(150);
}

export function near(actual, expected, tolerancePct) {
  const error = Math.abs(actual - expected) / Math.max(1e-9, Math.abs(expected));
  return { ok: error <= tolerancePct / 100, errorPct: Math.round(error * 10000) / 100 };
}

export async function report(name, payload) {
  const ok = payload.pass;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, JSON.stringify(payload, null, 2));
  return ok;
}
