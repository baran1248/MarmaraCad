/* Capture the four main workspaces for visual QA. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  launch,
  openApp,
  newDocument,
  startSketch,
  setTool,
  sketchClick,
  finishSketch,
  extrude,
  waitVolume,
  zoomOut,
} from "./e2e-lib.mjs";

const OUT = "C:\\Users\\MBB\\AppData\\Local\\Temp\\opencode\\marmaracad-qa2";
await mkdir(OUT, { recursive: true });
const browser = await launch();
const { page, errors } = await openApp(browser);
const shots = [];
const shot = async (name) => {
  await page.waitForTimeout(500);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  shots.push(path);
};

// ------------------------------------------------------------- 1. sketch workspace
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -30, -20);
await sketchClick(page, 30, 20);
await setTool(page, "dimension");
await sketchClick(page, 0, -20);
await page.waitForSelector("#prompt-value", { timeout: 15000 });
await page.fill("#prompt-value", "60");
await page.click(".modal-foot .btn.primary");
await page.waitForTimeout(300);
await setTool(page, "select");
await shot("01-sketch");

// ------------------------------------------------------------- 2. features workspace
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
await page.fill("#pm-depth", "12");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 20000");

for (const x of [-20, 20]) {
  await startSketch(page, "front");
  await setTool(page, "circle");
  await sketchClick(page, x, 0);
  await sketchClick(page, x + 6, 0);
  await finishSketch(page);
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="extrude-cut"]');
  await page.waitForSelector("#pm-depth");
  await page.fill("#pm-depth", "12");
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(1500);
}
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app.doc();
    const mesh = app.meshes().get(doc.parts[0].id);
    return Boolean(mesh && mesh.faces.filter((f) => f.surface === "cylinder").length === 2);
  },
  null,
  { timeout: 60000 },
);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="isometric"]');
await shot("02-features");

// ------------------------------------------------------------- 3. assembly workspace
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "circle");
await sketchClick(page, 0, 0);
await sketchClick(page, 15, 0);
await finishSketch(page);
await extrude(page, { depth: 60, operation: "new" });
await waitVolume(page, "v > 40000");
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="insert-component"]');
await page.waitForSelector("#insert-qty");
await page.fill("#insert-qty", "2");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().components.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(400);
const ids = await page.evaluate(() => window.__marmaracad.doc().components.map((c) => c.id));
await page.dblclick(`[data-key="component:${ids[1]}"]`);
await page.waitForSelector("#pm-ty");
await page.fill("#pm-ty", "70");
await page.fill("#pm-tz", "120");
await page.click("[data-pm-ok]");
await page.waitForTimeout(400);
const faces = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return {
    partId: doc.parts[0].id,
    bottom: mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9),
    top: mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9),
    cylinder: mesh.faces.findIndex((f) => f.surface === "cylinder"),
  };
});
const pick = async (componentId, faceIndex) =>
  page.evaluate(
    ({ componentId, faceIndex, partId }) => {
      const app = window.__marmaracad;
      const mesh = app.meshes().get(partId);
      app.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
    },
    { componentId, faceIndex, partId: faces.partId },
  );
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="mate-coincident"]');
await page.waitForSelector("#pm-mate-picks");
await pick(ids[0], faces.top);
await pick(ids[1], faces.bottom);
await page.click("[data-pm-ok]");
await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 1, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="mate-concentric"]');
await page.waitForSelector("#pm-mate-picks");
await pick(ids[0], faces.cylinder);
await pick(ids[1], faces.cylinder);
await page.click("[data-pm-ok]");
await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 2, null, { timeout: 30000 });
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="zoom-fit"]');
await shot("03-assembly");

// ------------------------------------------------------------- 4. FEA result
await newDocument(page);
await startSketch(page, "front");
await zoomOut(page, 2.2);
await setTool(page, "rectangle");
await sketchClick(page, 0, 0);
await sketchClick(page, 100, 10);
await finishSketch(page);
await extrude(page, { depth: 10, operation: "new" });
await waitVolume(page, "v > 9000");
await page.click('[data-cmd-tab="analysis"]');
await page.click('[data-cmd-action="new-study"]');
await page.waitForSelector("#pm-study-material", { timeout: 30000 });
await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1, null, { timeout: 30000 });
const studyId = await page.evaluate(() => window.__marmaracad.doc().analyses[0].id);
await page.click('[data-study-action="support"]');
await page.waitForSelector("#pm-support-list");
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const part = window.__marmaracad.doc().parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const fixed = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] < -0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: fixed, face: mesh.faces[fixed] });
});
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].supports.length === 1);
await page.click("[data-pm-ok]");
await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector('[data-study-action="force"]');
await page.click('[data-study-action="force"]');
await page.waitForSelector("#pm-load-list");
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const part = window.__marmaracad.doc().parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const tip = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] > 0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: tip, face: mesh.faces[tip] });
});
await page.waitForSelector("#force-mag");
await page.fill("#force-mag", "1000");
await page.selectOption("#force-dir", "zdown");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].loads.length === 1);
await page.click("[data-pm-ok]");
await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector("#pm-study-mesh");
await page.fill("#pm-study-mesh", "2");
await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));
await page.waitForSelector('[data-study-action="mesh"]');
await page.click('[data-study-action="mesh"]');
await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 240000 });
await page.waitForSelector('[data-study-action="solve"]');
await page.click('[data-study-action="solve"]');
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 300000 });
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="isometric"]');
await shot("04-fea");

console.log(JSON.stringify({ shots, errors }, null, 2));
await browser.close();
