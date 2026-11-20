/* FEA analytical validation in the browser.
 *
 * 100 x 10 x 10 mm structural-steel cantilever, 1000 N at the free end:
 *   delta = F L^3 / (3 E I) = 2.000 mm
 *   sigma = M c / I        = 600 MPa
 *
 * Besides matching the textbook numbers, the test proves the result is a real
 * field solve, not painted colours:
 *   - the peak displacement sits on the loaded end face,
 *   - the peak stress sits on the clamped outer fibre,
 *   - halving the load halves displacement and stress (linearity),
 *   - vertex colours are a monotonic function of the von Mises values. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume, body, near, zoomOut } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
function record(name, pass, details = {}) {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
}

// ------------------------------------------------------------------ beam geometry
await newDocument(page);
await startSketch(page, "front");
await zoomOut(page, 2.2);
await setTool(page, "rectangle");
await sketchClick(page, 0, 0);
await sketchClick(page, 100, 10);
await finishSketch(page);
await extrude(page, { depth: 10, operation: "new" });
await waitVolume(page, "v > 9000");
const beam = await body(page);
record("beam is 100 x 10 x 10 mm", Math.abs(beam.volume - 10000) < 20, { volume: beam.volume, bbox: beam.bbox });

// ------------------------------------------------------------------ study + boundary conditions
await page.click('[data-cmd-tab="analysis"]');
await page.click('[data-cmd-action="new-study"]');
await page.waitForSelector("#pm-study-material", { timeout: 30000 });
await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1, null, { timeout: 30000 });
const studyId = await page.evaluate(() => window.__marmaracad.doc().analyses[0].id);
const material = await page.evaluate(() => {
  const s = window.__marmaracad.doc().analyses[0];
  return { materialId: s.materialId, meshSize: s.meshSize };
});
record("static study created with a material", Boolean(material.materialId), material);

await page.click('[data-study-action="support"]');
await page.waitForSelector("#pm-support-list", { timeout: 15000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const fixed = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] < -0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: fixed, face: mesh.faces[fixed] });
});
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].supports.length === 1, null, { timeout: 15000 });
await page.click("[data-pm-ok]");

await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector('[data-study-action="force"]', { timeout: 15000 });
await page.click('[data-study-action="force"]');
await page.waitForSelector("#pm-load-list", { timeout: 15000 });
await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const doc = window.__marmaracad.doc();
  const part = doc.parts[0];
  const mesh = window.__marmaracad.meshes().get(part.id);
  const tip = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] > 0.9);
  app.command.onFace({ componentId: null, partId: part.id, faceIndex: tip, face: mesh.faces[tip] });
});
await page.waitForSelector("#force-mag", { timeout: 15000 });
await page.fill("#force-mag", "1000");
await page.selectOption("#force-dir", "zdown");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].loads.length === 1, null, { timeout: 15000 });
await page.click("[data-pm-ok]");

// mesh size 1.25 mm -> 80 x 8 x 8 hexahedra
await page.dblclick(`[data-key="study:${studyId}"]`);
await page.waitForSelector("#pm-study-mesh", { timeout: 15000 });
await page.fill("#pm-study-mesh", "1.25");
await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));
await page.waitForSelector('[data-study-action="mesh"]', { timeout: 15000 });
await page.click('[data-study-action="mesh"]');
await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 240000 });
const meshStats = await page.evaluate(() => window.__marmaracad.doc().analyses[0].meshStats);
record("voxel hexahedral mesh generated", Boolean(meshStats) && meshStats.elements > 3000, meshStats ?? {});

await page.waitForSelector('[data-study-action="solve"]', { timeout: 15000 });
await page.click('[data-study-action="solve"]');
await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 300000 });
await page.waitForTimeout(800);

// ------------------------------------------------------------------ analytic comparison
const analysis = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const study = window.__marmaracad.doc().analyses[0];
  const r = app.feaResults.get(study.id);
  if (!r) return null;
  let maxDispNode = 0;
  let maxStressNode = 0;
  for (let i = 1; i < r.magnitude.length; i++) {
    if (r.magnitude[i] > r.magnitude[maxDispNode]) maxDispNode = i;
    if (r.vonMises[i] > r.vonMises[maxStressNode]) maxStressNode = i;
  }
  const node = (i) => ({
    x: r.positions[i * 3],
    y: r.positions[i * 3 + 1],
    z: r.positions[i * 3 + 2],
    magnitude: r.magnitude[i],
    vonMises: r.vonMises[i],
  });
  return {
    status: study.status,
    error: study.error ?? null,
    maxDisplacement: r.maxDisplacement,
    maxStress: r.maxStress,
    safetyFactor: r.safetyFactor,
    reaction: r.reaction,
    dofs: r.dofs,
    iterations: r.iterations,
    converged: r.converged,
    nodes: r.magnitude.length,
    maxDispNode: node(maxDispNode),
    maxStressNode: node(maxStressNode),
    colorbar: document.getElementById("colorbar")?.innerText,
  };
});
record("solver converged", analysis?.converged === true && analysis?.error === null, { dofs: analysis?.dofs, iterations: analysis?.iterations, nodes: analysis?.nodes });

const deflection = near(analysis.maxDisplacement, 2.0, 5);
record(
  "tip deflection matches delta = FL^3/3EI = 2.000 mm",
  deflection.ok,
  { measured: Math.round(analysis.maxDisplacement * 10000) / 10000, analytic: 2.0, errorPct: deflection.errorPct },
);
const stress = near(analysis.maxStress, 600, 5);
record(
  "root stress matches sigma = Mc/I = 600 MPa",
  stress.ok,
  { measured: Math.round(analysis.maxStress * 100) / 100, analytic: 600, errorPct: stress.errorPct },
);
record(
  "peak displacement is on the free end (x = 100)",
  Math.abs(analysis.maxDispNode.x - 100) < 1.5 && analysis.maxDispNode.magnitude > 1.9,
  analysis.maxDispNode,
);
record(
  "peak stress is at the clamped outer fibre (x ~ 0, z ~ 0 or 10)",
  analysis.maxStressNode.x < 12 && (Math.abs(analysis.maxStressNode.z) < 1.2 || Math.abs(analysis.maxStressNode.z - 10) < 1.2),
  analysis.maxStressNode,
);
record(
  "reaction balances the 1000 N applied load",
  Math.abs(analysis.reaction[2] + 1000) < 60 || Math.abs(analysis.reaction[2] - 1000) < 60,
  { reaction: analysis.reaction },
);
record(
  "colorbar shows the computed peak stress in MPa",
  /MPa/.test(analysis.colorbar ?? "") && Math.abs(Number((analysis.colorbar ?? "").match(/[\d.]+/)?.[0] ?? "0") - 600) < 60,
  { colorbar: analysis.colorbar },
);

// ------------------------------------------------------------------ colours follow the field
const colourCheck = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const scene = app.viewport.scene;
  const mesh = scene.getObjectByName("fea-result-mesh");
  if (!mesh) return { found: false };
  const colors = mesh.geometry.getAttribute("color");
  const study = window.__marmaracad.doc().analyses[0];
  const r = app.feaResults.get(study.id);
  let maxI = 0;
  let minI = 0;
  for (let i = 1; i < r.vonMises.length; i++) {
    if (r.vonMises[i] > r.vonMises[maxI]) maxI = i;
    if (r.vonMises[i] < r.vonMises[minI]) minI = i;
  }
  const rgb = (i) => [colors.getX(i), colors.getY(i), colors.getZ(i)];
  // Rank correlation between von Mises and "warmth" (red minus blue) over a sample.
  const sample = [];
  for (let i = 0; i < r.vonMises.length; i += Math.max(1, Math.floor(r.vonMises.length / 400))) {
    sample.push({ v: r.vonMises[i], warm: colors.getX(i) - colors.getZ(i) });
  }
  const meanV = sample.reduce((s, p) => s + p.v, 0) / sample.length;
  const meanW = sample.reduce((s, p) => s + p.warm, 0) / sample.length;
  let cov = 0;
  let varV = 0;
  let varW = 0;
  for (const p of sample) {
    cov += (p.v - meanV) * (p.warm - meanW);
    varV += (p.v - meanV) ** 2;
    varW += (p.warm - meanW) ** 2;
  }
  const correlation = cov / Math.sqrt(varV * varW || 1);
  return {
    found: true,
    maxColor: rgb(maxI),
    minColor: rgb(minI),
    correlation,
    maxStress: r.vonMises[maxI],
    minStress: r.vonMises[minI],
  };
});
record(
  "vertex colours are a monotonic function of von Mises stress",
  colourCheck.found && colourCheck.correlation > 0.9 && colourCheck.maxColor[0] > colourCheck.maxColor[2] && colourCheck.minColor[2] > colourCheck.minColor[0],
  colourCheck,
);

// ------------------------------------------------------------------ linearity check
await page.evaluate(() => {
  window.__marmaracad.doc().analyses[0].loads[0].magnitude = 500;
});
await page.waitForSelector('[data-study-action="solve"]', { timeout: 15000 });
await page.click('[data-study-action="solve"]');
await page.waitForFunction(
  () => {
    const app = window.__marmaracad.app;
    const study = window.__marmaracad.doc().analyses[0];
    const r = app.feaResults.get(study.id);
    return study.status === "solved" && r && r.maxDisplacement < 1.6;
  },
  null,
  { timeout: 300000 },
);
await page.waitForTimeout(500);
const half = await page.evaluate(() => {
  const app = window.__marmaracad.app;
  const r = app.feaResults.get(window.__marmaracad.doc().analyses[0].id);
  return { maxDisplacement: r.maxDisplacement, maxStress: r.maxStress };
});
record(
  "halving the load halves deflection and stress (linear system)",
  Math.abs(half.maxDisplacement / analysis.maxDisplacement - 0.5) < 0.02 && Math.abs(half.maxStress / analysis.maxStress - 0.5) < 0.03,
  { full: { d: analysis.maxDisplacement, s: analysis.maxStress }, half },
);

const failed = results.filter((r) => !r.pass);
console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ errors }, null, 2));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
