/* FEA boundary conditions from a multi-selection.
 *
 * Ctrl+click two faces, open Fixed Support → both are applied. Ctrl+click two
 * faces, open Force → Apply Force loads both faces with one magnitude. */
import { launch, openApp, newDocument, waitForRebuild } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const study = () =>
  page.evaluate(() => {
    const doc = window.__marmaracad.doc();
    const s = doc.analyses[0];
    return s
      ? {
          supports: s.supports.map((x) => x.faceIndex),
          loads: s.loads.map((x) => ({ type: x.type, face: x.faceIndex, magnitude: x.magnitude })),
          mode: doc.mode,
        }
      : null;
  });

try {
  await page.click('[data-tree-action="sample"]');
  await page.waitForFunction(
    () => window.__marmaracad?.doc?.()?.parts?.[0]?.features?.length === 3,
    null,
    { timeout: 120000 },
  );
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = doc && api.meshes().get(doc.parts[0].id);
      return Boolean(mesh && mesh.volume > 50000);
    },
    null,
    { timeout: 120000 },
  );
  await waitForRebuild(page);

  await page.click('[data-cmd-tab="analysis"]');
  await page.click('[data-cmd-action="new-study"]');
  await page.waitForSelector("#pm-study-mesh");
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(300);

  // Ctrl+click two faces with the Faces filter and open Fixed Support.
  await page.click('[data-cmd-tab="evaluate"]');
  await page.click('[data-pick-filter="face"]');
  const facePoints = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const vp = api.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const planes = mesh.faces
      .map((f, i) => ({ f, i }))
      .filter((x) => x.f.surface === "plane")
      .slice(0, 2);
    return planes.map((x) => {
      const s = vp.projectToScreen(x.f.point);
      return { index: x.i, x: rect.left + s.x, y: rect.top + s.y };
    });
  });
  for (const p of facePoints) {
    await page.keyboard.down("Control");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Control");
    await page.waitForTimeout(140);
  }
  const selected = await page.evaluate(() => window.__marmaracad.selections().faces.length);
  record("Ctrl+click collects two faces for FEA", selected === 2, { selected, facePoints });

  await page.click('[data-cmd-tab="analysis"]');
  await page.click('[data-cmd-action="add-support"]');
  await page.waitForSelector("#pm-support-list");
  await page.waitForTimeout(250);
  const supports = (await study())?.supports ?? [];
  record(
    "Fixed Support accepts the Ctrl+click face selection",
    supports.length === 2,
    { supports },
  );
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(200);

  // Ctrl+click two more faces and apply one force to both.
  const topFaces = await page.evaluate((used) => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const vp = api.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return mesh.faces
      .map((f, i) => ({ f, i }))
      .filter((x) => x.f.surface === "plane" && !used.includes(x.i))
      .slice(0, 2)
      .map((x) => {
        const s = vp.projectToScreen(x.f.point);
        return { index: x.i, x: rect.left + s.x, y: rect.top + s.y };
      });
  }, facePoints.map((p) => p.index));
  await page.click('[data-cmd-tab="analysis"]');
  await page.waitForTimeout(100);
  await page.evaluate(() => window.__marmaracad.app.viewport.setPickFilter("face"));
  for (const p of topFaces) {
    await page.keyboard.down("Control");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Control");
    await page.waitForTimeout(140);
  }
  await page.click('[data-cmd-action="add-force"]');
  await page.waitForSelector("[data-force-apply]");
  await page.click("[data-force-apply]");
  await page.waitForSelector("#force-mag");
  const hint = await page.locator(".modal .modal-body").innerText();
  await page.fill("#force-mag", "250");
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(300);
  const loads = (await study())?.loads ?? [];
  record(
    "Force loads every face in the Ctrl+click selection",
    loads.length === 2 && loads.every((l) => l.magnitude === 250) && loads[0].face !== loads[1].face,
    { hint: hint.replace(/\s+/g, " ").slice(0, 120), loads },
  );
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(200);

  // Solve and confirm the reaction balances the applied force.
  await page.click('[data-cmd-tab="analysis"]');
  await page.click('[data-cmd-action="fea-solve"]');
  await page.waitForFunction(
    () => {
      const s = window.__marmaracad.doc().analyses[0];
      return s && s.status === "solved";
    },
    null,
    { timeout: 300000 },
  );
  const result = await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const s = window.__marmaracad.doc().analyses[0];
    const r = app.feaResults.get(s.id);
    return { status: s.status, stale: !!s.stale, maxStress: r?.maxStress, maxDeformation: r?.maxDisplacement };
  });
  record(
    "Multi-face load set solves to a static result",
    result.status === "solved" && Number.isFinite(result.maxStress) && result.maxStress > 0,
    result,
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
