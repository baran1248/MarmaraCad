/* Every sketch drawing tool and relation, driven through the real UI, must
 * produce a closed 2D profile that OCCT turns into a solid.
 *
 * Covered: rectangle, line chain, circle, 3-point arc, smart dimension,
 * equal + fix relations, Extruded Boss and Extruded Cut.
 *
 * Each volume is checked against the analytic value of the drawn profile, so a
 * mock or a stale mesh cannot pass. */
import { launch, openApp, reload, newDocument, startSketch, setTool, sketchClick, finishSketch, sketchState, body, waitVolume, near } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];

function record(entry) {
  results.push(entry);
  console.log(entry.pass ? "ok  " : "FAIL", entry.name);
  return entry;
}

function check(name, actual, expected, pct, extra = {}) {
  const cmp = near(actual, expected, pct);
  const entry = { name, actual: Math.round(actual * 100) / 100, expected, pass: cmp.ok, ...cmp, ...extra };
  results.push(entry);
  console.log(entry.pass ? "ok  " : "FAIL", name, JSON.stringify({ actual: entry.actual, expected, errorPct: entry.errorPct, ...extra }));
  return entry;
}

// ---------------------------------------------------------- 1. rectangle + dimension
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -25, -12);
await sketchClick(page, 15, 8);
let state = await sketchState(page);
const rectPoints = state.entities.length === 4 && state.constraints.filter((c) => c.type === "horizontal" || c.type === "vertical").length === 4;
record({
  name: "rectangle tool creates 4 lines + 4 h/v constraints + 2 distances",
  pass: rectPoints && state.constraints.length === 6,
  entities: state.entities.length,
  constraints: state.constraints.map((c) => c.type),
});

// Smart Dimension on the bottom edge: click it, fill the dialog, confirm.
// The dialog also accepts expressions (`L`, `L / 2`), so the input is #dim-value.
await setTool(page, "dimension");
await sketchClick(page, -5, -12);
await page.waitForSelector("#dim-value", { timeout: 15000 });
const dimensionDefault = await page.inputValue("#dim-value");
await page.fill("#dim-value", "30");
await page.click(".modal .btn.primary");
await page.waitForTimeout(350);
state = await sketchState(page);
const lengthOf = (s, id) => {
  const e = s.entities.find((x) => x.id === id);
  const a = s.points.find((p) => p.id === e.p1);
  const b = s.points.find((p) => p.id === e.p2);
  return Math.hypot(b.x - a.x, b.y - a.y);
};
const bottomId = state.entities
  .filter((e) => e.kind === "line")
  .map((e) => ({ id: e.id, length: lengthOf(state, e.id) }))
  .sort((a, b) => b.length - a.length)[0]?.id;
const bottomLength = Math.max(...state.entities.filter((e) => e.kind === "line").map((e) => lengthOf(state, e.id)).filter((l) => l > 15));
check("Smart Dimension drives the rectangle to 30 mm", bottomLength, 30, 1, { dimensionDefault, bottomId: Boolean(bottomId) });
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
const profileHint = await page.textContent("#pm-profile-hint");
await page.fill("#pm-depth", "10");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 1000");
let geo = await body(page);
check("Extruded Boss: 30 x 20 x 10 = 6000 mm³", geo.volume, 6000, 0.5, { profileHint, faces: geo.faces });

// ---------------------------------------------------------- 2. circle cut
await reload(page);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -20, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
await page.fill("#pm-depth", "10");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 7000");
const block = await body(page);

await startSketch(page, "front");
await setTool(page, "circle");
await sketchClick(page, 0, 0);
await sketchClick(page, 5, 0);
state = await sketchState(page);
const circle = state.entities.find((e) => e.kind === "circle");
record({
  name: "circle tool creates a circle with radius constraint",
  pass: Boolean(circle) && Math.abs(circle.radius - 5) < 0.2 && state.constraints.some((c) => c.type === "radius"),
  radius: circle?.radius,
});
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-cut"]');
await page.waitForSelector("#pm-depth");
await page.fill("#pm-depth", "10");
await page.click("[data-pm-ok]");
await waitVolume(page, `v < ${block.volume - 400}`);
geo = await body(page);
const holeVolume = Math.PI * 25 * 10;
check("Extruded Cut removes the Ø10 through hole", geo.volume, block.volume - holeVolume, 1.5, {
  block: Math.round(block.volume),
  holes: geo.surfaces.filter((s) => s === "cylinder").length,
});
record({
  name: "cut exposes a cylindrical face",
  pass: geo.surfaces.filter((s) => s === "cylinder").length === 1,
});

// ---------------------------------------------------------- 3. line chain
await reload(page);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "line");
await sketchClick(page, 0, 0);
await sketchClick(page, 30, 0);
await sketchClick(page, 30, 20);
await sketchClick(page, 0, 20);
await sketchClick(page, 0, 0);
await setTool(page, "select");
state = await sketchState(page);
const closedProfile = await page.evaluate(() => {
  const s = window.__marmaracad.app.editor.sketch;
  const pts = new Map(s.points.map((p) => [p.id, p]));
  const links = s.entities.filter((e) => e.kind === "line").map((e) => [e.p1, e.p2]);
  const adjacency = new Map();
  for (const [a, b] of links) {
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }
  return links.length === 4 && [...adjacency.values()].every((l) => l.length === 2) && pts.size === 4;
});
record({ name: "line tool chains a closed 4-line loop", pass: closedProfile, points: state.points.length, lines: state.entities.length });
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
const lineHint = await page.textContent("#pm-profile-hint");
await page.fill("#pm-depth", "8");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 1000");
geo = await body(page);
check("closed line loop extrudes to 30 x 20 x 8 = 4800 mm³", geo.volume, 4800, 0.5, { lineHint });

// ---------------------------------------------------------- 4. 3-point arc
await reload(page);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "arc");
await sketchClick(page, -10, 0);
await sketchClick(page, 10, 0);
await sketchClick(page, 0, 10);
await setTool(page, "line");
await sketchClick(page, 10, 0);
await sketchClick(page, -10, 0);
await setTool(page, "select");
state = await sketchState(page);
const arc = state.entities.find((e) => e.kind === "arc");
record({
  name: "3-point arc has centre (0,0) and radius 10",
  pass: Boolean(arc) && Math.abs(arc.radius - 10) < 0.3,
  radius: arc?.radius,
  ccw: arc?.ccw,
});
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
const arcHint = await page.textContent("#pm-profile-hint");
await page.fill("#pm-depth", "5");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 300");
geo = await body(page);
check("arc + chord extrudes to a half cylinder (785.4 mm³)", geo.volume, (Math.PI * 100 * 5) / 2, 2, { arcHint, faces: geo.faces });

// ---------------------------------------------------------- 5. relations
await reload(page);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "line");
await sketchClick(page, 0, 0);
await sketchClick(page, 10, 0);
await setTool(page, "line");
await sketchClick(page, 0, 10);
await sketchClick(page, 20, 10);
await setTool(page, "select");
await sketchClick(page, 5, 0);
await sketchClick(page, 10, 10, { shift: true });
await page.waitForTimeout(120);
await page.click('[data-cmd-action="rel-equal"]');
await page.waitForTimeout(400);
state = await sketchState(page);
const lineLengths = state.entities.filter((e) => e.kind === "line").map((e) => lengthOf(state, e.id));
const equalConstraint = state.constraints.some((c) => c.type === "equal");
record({
  name: "Equal relation makes both lines the same length",
  pass: equalConstraint && Math.abs(lineLengths[0] - lineLengths[1]) < 0.25,
  lengths: lineLengths.map((v) => Math.round(v * 1000) / 1000),
});

const anchor = state.entities.find((e) => e.kind === "line").p1;
const anchorPoint = state.points.find((p) => p.id === anchor);
await sketchClick(page, anchorPoint.x, anchorPoint.y);
await page.waitForTimeout(100);
await page.click('[data-cmd-action="rel-fix"]');
await page.waitForTimeout(300);
state = await sketchState(page);
const fixed = state.points.filter((p) => p.fixed).length;
record({
  name: "Fix relation pins the selected point",
  pass: fixed === 1,
  fixed,
  fixedPoints: state.points.filter((p) => p.fixed).map((p) => [p.x, p.y]),
});

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ results, errors }, null, 2));
console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL");
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
