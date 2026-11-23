/* Read-only checks for the visual-QA follow-ups: legend labels, toast overlap,
 * mass-card numbers, command-ribbon label size, and how much of the viewport
 * the FEA result actually covers. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume, zoomOut, runCmd } from "./e2e-lib.mjs";
import { imageStats } from "./pngstats.mjs";

const browser = await launch();
const { page } = await openApp(browser);
const out = {};

await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -20, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await extrude(page, { depth: 12, operation: "new" });
await waitVolume(page, "v > 9000");

for (const x of [-8, 8]) {
  await startSketch(page, "front");
  await setTool(page, "circle");
  await sketchClick(page, x, 0);
  await sketchClick(page, x + 4, 0);
  await finishSketch(page);
  await page.click('[data-cmd-tab="features"]');
  await runCmd(page, "extrude-cut");
  await page.waitForSelector("#pm-depth");
  await page.fill("#pm-depth", "12");
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(1200);
}
await page.waitForFunction(() => {
  const app = window.__marmaracad;
  const mesh = app.meshes().get(app.doc().parts[0].id);
  return mesh && mesh.faces.filter((f) => f.surface === "cylinder").length === 2;
}, null, { timeout: 60000 });

out.massCard = await page.textContent("#mass-card");
out.commandLabels = await page.evaluate(() =>
  [...document.querySelectorAll(".cmd-group-label")].map((el) => ({
    text: el.textContent,
    size: getComputedStyle(el).fontSize,
    color: getComputedStyle(el).color,
  })),
);

// ---------------------------------------------------------------- FEA
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
await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1);
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
await page.waitForTimeout(900);

out.legend = await page.evaluate(() => {
  const bar = document.getElementById("colorbar");
  const spans = [...bar.querySelectorAll(".cb-labels span")];
  const labels = spans.map((s) => s.textContent);
  const clipped = spans.filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent);
  const rect = bar.getBoundingClientRect();
  const toasts = [...document.querySelectorAll(".toast")].map((t) => t.getBoundingClientRect());
  const overlap = toasts.some((t) => !(t.right < rect.left || t.left > rect.right || t.bottom < rect.top || t.top > rect.bottom));
  return {
    labels,
    clipped,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    zIndex: getComputedStyle(bar).zIndex,
    titleLines: Math.round(bar.querySelector(".cb-title").getBoundingClientRect().height / 12),
    toasts: toasts.length,
    overlap,
  };
});

// Result coverage: sample the viewport screenshot and count non-background pixels.
const box = await page.locator(".viewport-canvas").boundingBox();
const shot = await page.screenshot({ clip: box, animations: "disabled" });
out.resultPixels = imageStats(shot);

console.log(JSON.stringify(out, null, 2));
await browser.close();
