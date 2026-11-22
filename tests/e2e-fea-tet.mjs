/* Phase-3 FEA result surface: Tet10 beam solve from the UI, Ansys-style result
 * modes, probe, min/max flags, animation, undeformed wireframe and the
 * reaction-force readout. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume, near, zoomOut } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, details = {}) => {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
};

try {
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
  const studyId = await page.evaluate(() => window.__marmaracad.doc().analyses[0].id);

  // Tet10 + modal-capable study panel controls.
  await page.selectOption("#pm-study-mesh-kind", "tet10");
  await page.waitForSelector("#pm-study-mesh-kind");
  const panel = await page.evaluate(() => ({
    typeOptions: [...document.querySelectorAll("#pm-study-type option")].map((o) => o.value),
    meshOptions: [...document.querySelectorAll("#pm-study-mesh-kind option")].map((o) => o.value),
    actions: [...document.querySelectorAll("[data-study-action]")].map((b) => b.dataset.studyAction),
  }));
  record("study panel exposes all four analysis types", ["static", "modal", "buckling", "thermal"].every((t) => panel.typeOptions.includes(t)), panel);
  record("study panel exposes Tet4 and Tet10", panel.meshOptions.includes("tet4") && panel.meshOptions.includes("tet10"), panel);
  record(
    "boundary-condition buttons cover displacement, frictionless, cylindrical, moment and gravity",
    ["displacement", "frictionless", "cylindrical", "moment", "gravity"].every((a) => panel.actions.includes(a)),
    { actions: panel.actions },
  );

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

  // A coarse quadratic mesh keeps the browser test quick while still proving
  // the conformal Tet10 path end to end.
  await page.dblclick(`[data-key="study:${studyId}"]`);
  await page.waitForSelector("#pm-study-mesh");
  await page.fill("#pm-study-mesh", "5");
  await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));
  await page.waitForSelector("#pm-study-mesh-kind");
  await page.selectOption("#pm-study-mesh-kind", "tet10");
  await page.waitForSelector('[data-study-action="mesh"]');
  await page.click('[data-study-action="mesh"]');
  await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 300000 });
  const meshStats = await page.evaluate(() => window.__marmaracad.doc().analyses[0].meshStats);
  const metrics = await page.evaluate(() => window.__marmaracad.doc().analyses[0].meshMetrics ?? null);
  record("conformal Tet10 mesh generated", Boolean(meshStats) && meshStats.elements > 500, { ...meshStats, metrics });
  record("mesh quality metrics are reported", Boolean(metrics) && metrics.avgJacobian > 0 && metrics.minAspect > 0, metrics ?? {});

  await page.click('[data-study-action="solve"]');
  await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 300000 });
  await page.waitForTimeout(700);
  const analysis = await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const study = window.__marmaracad.doc().analyses[0];
    const r = app.feaResults.get(study.id);
    return {
      meshKind: r.meshKind,
      maxDisplacement: r.maxDisplacement,
      maxStress: r.maxStress,
      reaction: r.reaction,
      reactionForce: r.reactionForce ? r.reactionForce.length : 0,
      converged: r.converged,
      hasPrincipal: Boolean(r.maxPrincipal && r.minPrincipal && r.shearStress),
      hasDirectional: Boolean(r.directional),
      toolbar: document.querySelector(".result-toolbar")?.innerText ?? "",
    };
  });
  record("Tet10 solve converged", analysis.converged === true && analysis.meshKind === "tet10", { meshKind: analysis.meshKind });
  const deflection = near(analysis.maxDisplacement, 2.0, 10);
  record("Tet10 tip deflection is within 10% of FL^3/3EI", deflection.ok, { measured: analysis.maxDisplacement, errorPct: deflection.errorPct });
  record("reaction balances the applied 1000 N", Math.abs(Math.abs(analysis.reaction[2]) - 1000) < 80, { reaction: analysis.reaction });
  record("nodal reaction-force field is exposed", analysis.reactionForce > 0, { length: analysis.reactionForce });
  record("principal, shear and directional fields exist", analysis.hasPrincipal && analysis.hasDirectional, {});
  record(
    "result toolbar lists every Ansys-style result mode",
    ["Deformation", "UX", "UY", "UZ", "von Mises", "Max Principal", "Min Principal", "Shear", "Safety", "Reaction", "Probe"].every((label) =>
      analysis.toolbar.includes(label),
    ),
    { toolbar: analysis.toolbar.slice(0, 400) },
  );

  // Probe pins a node and prints its values.
  await page.click("[data-result-probe]");
  const canvas = await page.locator(".viewport-canvas").boundingBox();
  await page.mouse.click(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.5);
  await page.waitForTimeout(400);
  const probe = await page.evaluate(() => {
    const app = window.__marmaracad.app;
    return {
      marker: Boolean(app.viewport.scene.getObjectByName("fea-result-markers")?.children.length),
      text: document.getElementById("rt-probe-value")?.textContent ?? "",
    };
  });
  record("probe pins a node and reports its value", probe.marker && /mm/.test(probe.text), probe);

  // Animation toggles and the undeformed wireframe appears.
  await page.click("[data-result-animate]");
  await page.waitForTimeout(350);
  const animated = await page.evaluate(() => window.__marmaracad.app.resultView.getAnimationState());
  record("deformation animation runs", animated.active === true, animated);
  await page.click("[data-result-animate]");
  await page.waitForTimeout(150);
  const paused = await page.evaluate(() => window.__marmaracad.app.resultView.getAnimationState());
  record("deformation animation pauses", paused.active === false, paused);

  await page.click("[data-result-undeformed]");
  await page.waitForTimeout(150);
  const wire = await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.scene.getObjectByName("fea-undeformed-wireframe")));
  record("undeformed wireframe overlays the result", wire === true, { wire });

  await page.click("[data-result-minmax]");
  await page.waitForTimeout(200);
  const minmax = await page.evaluate(() => {
    const view = window.__marmaracad.app.resultView;
    return { visible: view.isMinMaxVisible(), extrema: view.getFieldExtrema() };
  });
  record("min/max flags mark the field extrema", minmax.visible && minmax.extrema.max >= minmax.extrema.min, minmax);

  // Reaction mode through the toolbar.
  await page.click('[data-result-mode="reaction"]');
  await page.waitForTimeout(250);
  const reactionView = await page.evaluate(() => document.getElementById("colorbar")?.innerText ?? "");
  record("reaction result mode shows the colour bar", /N/.test(reactionView), { reactionView });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ errors: errors.slice(0, 5) }, null, 2));
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
}
