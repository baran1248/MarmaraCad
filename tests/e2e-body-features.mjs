/* Body-level features: Linear Pattern and Mirror.
 *
 * A 40 × 20 × 10 box is patterned 3 × 50 mm along X (24,000 mm³ in one solid),
 * and a box offset 10 mm from the Right Plane is mirrored across it
 * (16,000 mm³, bbox −30…30). */
import { launch, openApp, newDocument, startSketch, sketchClick, setTool, finishSketch, extrude, waitVolume } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const mesh = () =>
  page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const m = api.meshes().get(doc.parts[0].id);
    const feature = doc.parts[0].features.at(-1);
    return m
      ? { volume: m.volume, bbox: m.bbox, type: feature?.type ?? null, name: feature?.name ?? null, params: feature?.params ?? null }
      : null;
  });

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 20);
  await setTool(page, "select");
  await finishSketch(page);
  await extrude(page, { depth: 10 });
  await waitVolume(page, "Math.abs(v - 8000) < 1");
  const base = await mesh();
  record("Base box is 40 × 20 × 10 mm", Math.abs(base.volume - 8000) < 1, { volume: base.volume });

  // --- Linear Pattern: 3 copies spaced 50 mm along X.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="linear-pattern"]');
  await page.waitForSelector("#pm-pattern-count", { timeout: 15000 });
  await page.selectOption("#pm-pattern-axis", "x");
  await page.fill("#pm-pattern-count", "3");
  await page.fill("#pm-pattern-spacing", "50");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "Math.abs(v - 24000) < 1");
  const patterned = await mesh();
  record(
    "Linear Pattern repeats the body 3 × 50 mm along X",
    patterned.type === "pattern" &&
      Math.abs(patterned.volume - 24000) < 1 &&
      Math.abs(patterned.bbox.min[0] - 0) < 0.05 &&
      Math.abs(patterned.bbox.max[0] - 140) < 0.05,
    { volume: patterned.volume, bbox: patterned.bbox, params: patterned.params, name: patterned.name },
  );

  // --- Mirror: a box 10…30 mm from the Right Plane mirrored across it.
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 10, 0);
  await sketchClick(page, 30, 20);
  await setTool(page, "select");
  await finishSketch(page);
  await extrude(page, { depth: 10 });
  await waitVolume(page, "Math.abs(v - 4000) < 1");
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="mirror"]');
  await page.waitForSelector("#pm-mirror-plane", { timeout: 15000 });
  await page.selectOption("#pm-mirror-plane", "right");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "Math.abs(v - 8000) < 1");
  const mirrored = await mesh();
  record(
    "Mirror about the Right Plane fuses a mirrored copy (−30…30 mm)",
    mirrored.type === "mirror" &&
      Math.abs(mirrored.volume - 8000) < 1 &&
      Math.abs(mirrored.bbox.min[0] + 30) < 0.05 &&
      Math.abs(mirrored.bbox.max[0] - 30) < 0.05,
    { volume: mirrored.volume, bbox: mirrored.bbox, params: mirrored.params, name: mirrored.name },
  );

  // --- Both features can be deleted from the tree, restoring the base body.
  const mirrorId = await page.evaluate(() => window.__marmaracad.doc().parts[0].features.at(-1).id);
  await page.click(`[data-key="feature:${mirrorId}"]`);
  await page.keyboard.press("Delete");
  await page.waitForSelector(".modal .btn.danger", { timeout: 15000 });
  await page.click(".modal .btn.danger");
  await waitVolume(page, "Math.abs(v - 4000) < 1");
  const removed = await mesh();
  const remaining = await page.evaluate(() => window.__marmaracad.doc().parts[0].features.map((f) => f.type));
  record(
    "Deleting the Mirror feature restores the 4,000 mm³ body",
    Math.abs(removed.volume - 4000) < 1 && !remaining.includes("mirror"),
    { volume: removed.volume, features: remaining },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
