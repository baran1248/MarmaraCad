/* Revolve, Fillet and Chamfer through the real UI, plus parametric edits from
 * the FeatureManager: changing a value must rebuild the OCCT solid, not just the
 * panel. Every volume is compared with the analytic formula. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, body, featureCount, waitVolume, extrude, revolve, pickEdges, near, runCmd } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];

function record(entry) {
  results.push(entry);
  console.log(entry.pass ? "ok  " : "FAIL", entry.name, JSON.stringify(entry.details ?? {}));
  return entry;
}

function check(name, actual, expected, pct, details = {}) {
  const cmp = near(actual, expected, pct);
  return record({ name, pass: cmp.ok, details: { actual: Math.round(actual * 100) / 100, expected, errorPct: cmp.errorPct, ...details } });
}

async function doubleClickFeature(page, index) {
  const id = await page.evaluate((i) => window.__marmaracad.doc().parts[0].features[i].id, index);
  await page.dblclick(`[data-key="feature:${id}"]`);
  await page.waitForTimeout(300);
  return id;
}

// ------------------------------------------------------------- revolve + parametric angle
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, 10, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await revolve(page, { angle: 360, axisMode: "v", operation: "new" });
await waitVolume(page, "v > 15000");
let geo = await body(page);
// Hollow cylinder: pi * (20^2 - 10^2) * 20 = 18849.56 mm^3
check("Revolve 360° of a 10 x 20 profile = hollow cylinder", geo.volume, Math.PI * 300 * 20, 1, {
  surfaces: geo.surfaces,
});
record({
  name: "Revolve creates inner and outer cylindrical faces",
  pass: geo.surfaces.filter((s) => s === "cylinder").length === 2,
  details: { surfaces: geo.surfaces.filter((s) => s === "cylinder").length },
});

await doubleClickFeature(page, 0);
await page.waitForSelector("#pm-angle", { timeout: 15000 });
await page.fill("#pm-angle", "180");
await page.click("[data-pm-ok]");
await waitVolume(page, "v < 12000");
geo = await body(page);
check("parametric edit: revolve angle 360° → 180° halves the volume", geo.volume, (Math.PI * 300 * 20) / 2, 1);
record({
  name: "revolve feature params persist the new angle",
  pass: Math.abs(geo.features[0].params.angle - 180) < 0.01,
  details: { params: geo.features[0].params },
});

// ------------------------------------------------------------- fillet + parametric radius
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -20, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await extrude(page, { depth: 25, operation: "new" });
await waitVolume(page, "v > 19000");
const block = await body(page);
check("base block for the fillet is 40 x 20 x 25", block.volume, 20000, 0.3);

// Parametric edit of the extrude depth before any downstream feature exists.
await doubleClickFeature(page, 0);
await page.waitForSelector("#pm-depth", { timeout: 15000 });
await page.fill("#pm-depth", "30");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 23000");
geo = await body(page);
check("parametric edit: extrude depth 25 → 30 rebuilds the solid", geo.volume, 40 * 20 * 30, 0.3, {
  depth: geo.features[0].params.depth,
});

const depth = 30;
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="fillet"]');
await page.waitForSelector("#pm-fillet-radius", { timeout: 15000 });
const vertical = await pickEdges(
  page,
  "(edge) => { const xs = edge.points.map(p => p[0]), ys = edge.points.map(p => p[1]), zs = edge.points.map(p => p[2]); const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys), dz = Math.max(...zs) - Math.min(...zs); return dx < 0.2 && dy < 0.2 && dz > 5; }",
);
record({ name: "picked the four vertical box edges", pass: vertical.length === 4, details: { edges: vertical } });
await page.fill("#pm-fillet-radius", "2");
await page.click("[data-pm-ok]");
await waitVolume(page, "v < 23900");
geo = await body(page);
const filletLoss2 = 4 * (1 - Math.PI / 4) * 4 * depth;
check("fillet r=2 on 4 vertical edges removes the analytic corner volume", geo.volume, 24000 - filletLoss2, 1, {
  removed: Math.round((24000 - geo.volume) * 100) / 100,
  expectedRemoved: Math.round(filletLoss2 * 100) / 100,
});

const filletIndex = geo.features.findIndex((f) => f.type === "fillet");
await doubleClickFeature(page, filletIndex);
await page.waitForSelector("#pm-fillet-radius", { timeout: 15000 });
await page.fill("#pm-fillet-radius", "4");
await page.click("[data-pm-ok]");
await waitVolume(page, "v < 23700");
geo = await body(page);
const filletLoss4 = 4 * (1 - Math.PI / 4) * 16 * depth;
check("parametric edit: fillet radius 2 → 4 rebuilds the solid", geo.volume, 24000 - filletLoss4, 1, {
  removed: Math.round((24000 - geo.volume) * 100) / 100,
  expectedRemoved: Math.round(filletLoss4 * 100) / 100,
});
record({
  name: "fillet feature params persist the new radius",
  pass: Math.abs(geo.features[filletIndex].params.radius - 4) < 0.01,
  details: { params: geo.features[filletIndex].params },
});

// ------------------------------------------------------------- chamfer
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -20, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await extrude(page, { depth: 10, operation: "new" });
await waitVolume(page, "v > 7000");

await page.click('[data-cmd-tab="features"]');
await runCmd(page, "chamfer");
await page.waitForSelector("#pm-chamfer-distance", { timeout: 15000 });
const vertical2 = await pickEdges(
  page,
  "(edge) => { const xs = edge.points.map(p => p[0]), ys = edge.points.map(p => p[1]), zs = edge.points.map(p => p[2]); const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys), dz = Math.max(...zs) - Math.min(...zs); return dx < 0.2 && dy < 0.2 && dz > 5; }",
);
await page.fill("#pm-chamfer-distance", "2");
await page.click("[data-pm-ok]");
await waitVolume(page, "v < 7990");
geo = await body(page);
const chamferLoss = 4 * (4 / 2) * 10;
check("chamfer 2 mm on 4 vertical edges = 80 mm³ removed", geo.volume, 8000 - chamferLoss, 1, {
  edges: vertical2,
  removed: Math.round((8000 - geo.volume) * 100) / 100,
  expectedRemoved: chamferLoss,
});

const failed = results.filter((r) => !r.pass);
console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ errors }, null, 2));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
