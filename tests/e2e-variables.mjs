/* Parametric variables (Equations): L = 100, W = L / 2, and a dimension bound to L.
 *
 * A rectangle is drawn with its width driven by the expression `L`; changing L to
 * 160 re-solves the sketch, rebuilds the extrude and reports the new volume. */
import { launch, openApp, newDocument, startSketch, sketchClick, setTool, finishSketch, extrude, waitVolume } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const variables = () =>
  page.evaluate(() =>
    (window.__marmaracad.doc().variables ?? []).map((v) => ({ name: v.name, expression: v.expression, value: v.value })),
  );
const addVariable = async (name, expression) => {
  await page.fill("#eq-name", "");
  await page.fill("#eq-expr", "");
  await page.fill("#eq-name", name);
  await page.fill("#eq-expr", expression);
  await page.click("#eq-add");
  await page.waitForTimeout(250);
};
const dims = () =>
  page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    if (!s) return null;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    const xs = s.points.map((p) => Math.round(p.x * 1000) / 1000);
    const ys = s.points.map((p) => Math.round(p.y * 1000) / 1000);
    return {
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      constraints: s.constraints.map((c) => ({ t: c.type, v: c.value ?? null, e: c.expression ?? null })),
      points: pm.size,
    };
  });

try {
  await newDocument(page);

  // --- Equations panel: two variables where the second references the first.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="equations"]');
  await page.waitForSelector("#eq-name", { timeout: 15000 });
  await addVariable("L", "100");
  await addVariable("W", "L / 2");
  const vars = await variables();
  record(
    "Equations evaluate L = 100 and W = L / 2",
    vars.length === 2 && vars[0].value === 100 && vars[1].value === 50,
    { vars },
  );

  // Changing L updates W automatically (declaration order).
  const lInput = await page.evaluate(() => (window.__marmaracad.doc().variables ?? []).find((v) => v.name === "L")?.id);
  await page.fill(`[data-var-expr="${lInput}"]`, "160");
  await page.waitForTimeout(300);
  const linked = await variables();
  record(
    "Editing L propagates to W = L / 2",
    linked[0].value === 160 && linked[1].value === 80,
    { linked },
  );
  // Put L back to 100 and apply, so the sketch below is driven by 100.
  await page.fill(`[data-var-expr="${lInput}"]`, "100");
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(600);
  const reset = await variables();
  record("Apply writes the edited variable back to the model", reset[0].value === 100 && reset[1].value === 50, { reset });

  // --- A rectangle whose existing width dimension is bound to the expression `L`.
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 30, 20);
  await setTool(page, "select");
  const beforeDim = await dims();
  const widthDim = await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    const s = editor.sketch;
    const horizontal = s.entities.find((e) => {
      if (e.kind !== "line") return false;
      const a = s.points.find((p) => p.id === e.p1);
      const b = s.points.find((p) => p.id === e.p2);
      return a && b && Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 10;
    });
    const c = s.constraints.find((x) => x.type === "distance" && x.entity === horizontal?.id);
    return c ? { id: c.id, value: c.value, entity: c.entity } : null;
  });
  record("A plain rectangle has a driving width dimension to edit", !!widthDim, { widthDim, before: beforeDim.width });
  await page.dblclick(`[data-dimension="${widthDim.id}"]`);
  await page.waitForSelector("#dim-value", { timeout: 15000 });
  await page.fill("#dim-value", "L");
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(500);
  const afterDim = await dims();
  record(
    "A width dimension accepts the expression L and solves to 100 mm",
    afterDim.constraints.some((c) => c.t === "distance" && c.e === "L") && Math.abs(afterDim.width - 100) < 0.05,
    { before: beforeDim.width, after: afterDim },
  );

  // --- Extrude, then change L to 160 and rebuild.
  await finishSketch(page);
  await extrude(page, { depth: 10 });
  await waitVolume(page, "Math.abs(v - 20000) < 1");
  const volume100 = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    return api.meshes().get(doc.parts[0].id).volume;
  });
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="equations"]');
  await page.waitForSelector("#eq-name", { timeout: 15000 });
  const lId = await page.evaluate(() => window.__marmaracad.doc().variables.find((v) => v.name === "L").id);
  await page.fill(`[data-var-expr="${lId}"]`, "160");
  await page.waitForTimeout(300);
  await page.click(".modal .modal-foot .btn.primary");
  await page.waitForTimeout(600);
  await waitVolume(page, "Math.abs(v - 32000) < 1", 180000);
  const volume160 = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    return { volume: api.meshes().get(doc.parts[0].id).volume, box: api.meshes().get(doc.parts[0].id).bbox };
  });
  record(
    "Changing L to 160 re-solves the sketch and rebuilds the extrude",
    Math.abs(volume100 - 20000) < 1 &&
      Math.abs(volume160.volume - 32000) < 1 &&
      Math.abs(volume160.box.max[0] - volume160.box.min[0] - 160) < 0.1,
    { volume100, volume160, width: volume160.box.max[0] - volume160.box.min[0] },
  );

  // --- Deleting a variable keeps the document valid (dangling expression → kept value).
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="equations"]');
  await page.waitForSelector("#eq-name", { timeout: 15000 });
  const wId = await page.evaluate(() => window.__marmaracad.doc().variables.find((v) => v.name === "W").id);
  await page.click(`[data-var-del="${wId}"]`);
  await page.waitForTimeout(300);
  const afterDelete = await variables();
  record(
    "Deleting W leaves L intact",
    afterDelete.length === 1 && afterDelete[0].name === "L" && afterDelete[0].value === 160,
    { afterDelete },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
