/* Phase-3 multiphysics: modal frequencies, steady-state thermal distribution
 * and linear buckling, all driven through the study panel. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume, near, zoomOut } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, details = {}) => {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
};

const setStudyType = async (type) => {
  await page.waitForSelector("#pm-study-type");
  await page.selectOption("#pm-study-type", type);
  await page.waitForTimeout(200);
};
const study = () => page.evaluate(() => window.__marmaracad.doc().analyses[0]);
const result = () =>
  page.evaluate(() => {
    const app = window.__marmaracad.app;
    const s = window.__marmaracad.doc().analyses[0];
    const r = app.feaResults.get(s.id);
    if (!r) return null;
    return {
      frequencies: r.frequencies ?? [],
      temperature: r.temperature ? Array.from(r.temperature) : null,
      positions: Array.from(r.positions),
      bucklingMultiplier: r.bucklingMultiplier ?? null,
      maxStress: r.maxStress,
      maxDisplacement: r.maxDisplacement,
      converged: r.converged,
      meshKind: r.meshKind,
      status: s.status,
      error: s.error ?? null,
    };
  });
const solve = async () => {
  await page.waitForSelector('[data-study-action="solve"]');
  await page.click('[data-study-action="solve"]');
  await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 600000 });
  await page.waitForTimeout(500);
};
const openStudyPanel = async () => {
  await page.evaluate(() => window.__marmaracad.app.openStudyPanel());
  await page.waitForSelector("#pm-study-type", { timeout: 20000 });
  await page.waitForTimeout(150);
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
  await page.selectOption("#pm-study-mesh-kind", "tet10");
  await page.waitForSelector("#pm-study-mesh");
  await page.fill("#pm-study-mesh", "10");
  await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));

  // Fixed support on the clamped end.
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

  // ---------------------------------------------------------------- modal
  await openStudyPanel();
  await setStudyType("modal");
  await page.waitForSelector("#pm-study-modes");
  await page.fill("#pm-study-modes", "4");
  await page.evaluate(() => document.getElementById("pm-study-modes")?.dispatchEvent(new Event("change", { bubbles: true })));
  await solve();
  const modal = await result();
  const analytic = ((1.875104068711961 ** 2) / (2 * Math.PI)) * Math.sqrt((200000 * (10 * 10 ** 3) / 12) / (7850e-12 * 100 * 100 ** 4));
  record("modal: four frequencies solved", modal?.frequencies.length === 4 && modal.converged === true, { frequencies: modal?.frequencies });
  record(
    "modal: f1 matches the Euler-Bernoulli cantilever",
    Boolean(modal) && near(modal.frequencies[0], analytic, 8).ok,
    { measured: modal?.frequencies[0], analytic, errorPct: modal ? near(modal.frequencies[0], analytic, 8).errorPct : null },
  );
  const modeBar = await page.evaluate(() => document.querySelector(".result-toolbar")?.innerText ?? "");
  record("modal: mode-shape result is shown", /Mode Shape/.test(modeBar) && /Hz/.test(modeBar), { modeBar: modeBar.slice(0, 200) });

  // -------------------------------------------------------------- thermal
  await openStudyPanel();
  await setStudyType("thermal");
  await page.click('[data-study-action="clear-loads"]');
  await page.waitForTimeout(200);
  const addTemperature = async (normalSign, value) => {
    await page.waitForSelector('[data-study-action="temperature"]');
    await page.click('[data-study-action="temperature"]');
    await page.waitForSelector("#pm-load-list");
    await page.evaluate((sign) => {
      const app = window.__marmaracad.app;
      const part = window.__marmaracad.doc().parts[0];
      const mesh = window.__marmaracad.meshes().get(part.id);
      const faceIndex = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] * sign > 0.9);
      app.command.onFace({ componentId: null, partId: part.id, faceIndex, face: mesh.faces[faceIndex] });
    }, normalSign);
    await page.waitForSelector("#pm-number-input, .modal input[type=number]", { timeout: 15000 });
    await page.fill(".modal input[type=number]", String(value));
    await page.click(".modal-foot .btn.primary");
    await page.waitForTimeout(400);
    const close = page.locator("[data-pm-ok]");
    if (await close.count()) await close.first().click();
    await page.waitForTimeout(200);
  };
  await addTemperature(-1, 100);
  await openStudyPanel();
  await addTemperature(1, 0);
  await openStudyPanel();
  await solve();
  const thermal = await result();
  let mid = null;
  if (thermal?.temperature) {
    let best = Infinity;
    for (let i = 0; i < thermal.temperature.length; i++) {
      const d = Math.abs(thermal.positions[i * 3] - 50);
      if (d < best) {
        best = d;
        mid = thermal.temperature[i];
      }
    }
  }
  record("thermal: steady-state solve converged", thermal?.converged === true && thermal.temperature !== null, { converged: thermal?.converged });
  record("thermal: mid-span temperature is the linear average", mid !== null && Math.abs(mid - 50) < 3, { mid, meshSize: 10 });
  const thermalBar = await page.evaluate(() => document.getElementById("colorbar")?.innerText ?? "");
  record("thermal: temperature result bar is in °C", /°C|C/.test(thermalBar), { thermalBar });

  // -------------------------------------------------------------- buckling
  await openStudyPanel();
  await setStudyType("buckling");
  await page.click('[data-study-action="clear-loads"]');
  await page.waitForTimeout(200);
  // Clear All removes supports as well, so re-add the clamp before the load.
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
  await openStudyPanel();
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
  await page.selectOption("#force-dir", "normal");
  await page.click(".modal-foot .btn.primary");
  await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].loads.length === 1);
  await page.click("[data-pm-ok]");
  await openStudyPanel();
  await solve();
  const buckling = await result();
  const critical = (Math.PI ** 2 * 200000 * ((10 * 10 ** 3) / 12)) / (4 * 100 ** 2);
  const multiplier = buckling?.bucklingMultiplier ?? 0;
  record(
    "buckling: load multiplier matches pi^2 EI / (4 L^2)",
    Number.isFinite(multiplier) && Math.abs(multiplier * 1000 - critical) / critical < 0.3,
    { multiplier, criticalLoad: critical, predicted: multiplier * 1000 },
  );
  const bucklingBar = await page.evaluate(() => document.getElementById("colorbar")?.innerText ?? "");
  record("buckling: mode shape is displayed", await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.scene.getObjectByName("fea-result-mesh"))) && Boolean(bucklingBar), { bucklingBar });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ errors: errors.slice(0, 5) }, null, 2));
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
}
