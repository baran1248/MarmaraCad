/* The shipped templates: Cantilever Beam and L-Bracket.
 *
 * Beam: 120 × 12 × 20 mm with AISI 1020 and a static study; L-Bracket:
 * 60 × 40 mm L profile extruded 30 mm, volume = (60·8 + 8·32) · 30 mm³. */
import { launch, openApp, waitForRebuild } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const openTemplates = async () => {
  await page.click('[data-menu="file"]');
  await page.click('[data-menu-action="templates"]');
  await page.waitForSelector('[data-template="beam"]', { timeout: 20000 });
};
const applyTemplate = async (id) => {
  await openTemplates();
  await page.click(`[data-template="${id}"]`);
  await page.click(".modal .btn.primary");
  await waitForRebuild(page);
  if (id !== "blank") {
    await page.waitForFunction(
      () => {
        const api = window.__marmaracad;
        const doc = api.doc();
        const mesh = doc.parts[0] && api.meshes().get(doc.parts[0].id);
        return Boolean(mesh && mesh.volume > 100);
      },
      null,
      { timeout: 180000 },
    );
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[0];
    const mesh = api.meshes().get(part.id);
    return {
      name: doc.name,
      partName: part.name,
      materialId: part.materialId ?? null,
      features: part.features.map((f) => f.type),
      variables: (doc.variables ?? []).map((v) => ({ name: v.name, value: v.value })),
      analyses: doc.analyses.map((s) => ({ name: s.name, materialId: s.materialId, meshSize: s.meshSize })),
      volume: mesh?.volume ?? null,
      bbox: mesh?.bbox ?? null,
    };
  });
};

try {
  // --- Cantilever beam.
  const beam = await applyTemplate("beam");
    record(
    "Cantilever Beam template builds a 120 × 20 × 12 mm beam with a static study",
    beam.name === "Cantilever Beam" &&
      beam.partName === "Beam" &&
      Math.abs(beam.volume - 120 * 20 * 12) < 1 &&
      beam.materialId === "aisi1020" &&
      beam.analyses.length === 1 &&
      beam.analyses[0].materialId === "aisi1020" &&
      Math.abs((beam.variables[0]?.value ?? 0) - 100) < 1e-6,
    beam,
  );
  const beamLength = beam.bbox ? Math.max(beam.bbox.max[0] - beam.bbox.min[0], beam.bbox.max[2] - beam.bbox.min[2]) : 0;
  record("Beam spans 120 mm along its axis at 20 × 12 mm", Math.abs(beamLength - 120) < 0.2 && !!beam.bbox && Math.abs(beam.bbox.max[1] - beam.bbox.min[1] - 20) < 0.2 && Math.abs(beam.bbox.max[0] - beam.bbox.min[0] - 12) < 0.2, { length: beamLength, bbox: beam.bbox });

  // --- L-bracket.
  const bracket = await applyTemplate("bracket");
  const expected = (60 * 8 + 8 * 32) * 30;
  record(
    "L-Bracket template builds a 60 × 40 mm L profile, 30 mm deep (22,080 mm³)",
    bracket.name === "L-Bracket" &&
      Math.abs(bracket.volume - expected) < 2 &&
      bracket.materialId === "aisi1020" &&
      bracket.features.includes("extrude"),
    { volume: bracket.volume, expected, bbox: bracket.bbox, features: bracket.features },
  );
  record(
    "L-Bracket profile fills its 60 × 40 mm outline and is 30 mm thick",
    !!bracket.bbox &&
      Math.abs(bracket.bbox.max[0] - bracket.bbox.min[0] - 60) < 0.2 &&
      Math.abs(bracket.bbox.max[1] - bracket.bbox.min[1] - 40) < 0.2 &&
      Math.abs(bracket.bbox.max[2] - bracket.bbox.min[2] - 30) < 0.2,
    { bbox: bracket.bbox },
  );

  // --- Blank part clears everything back to an empty document.
  const blank = await applyTemplate("blank");
  record(
    "Blank Part template starts an empty part",
    blank.features.length === 0 && blank.materialId === null && blank.analyses.length === 0,
    { features: blank.features, materialId: blank.materialId, analyses: blank.analyses.length },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
