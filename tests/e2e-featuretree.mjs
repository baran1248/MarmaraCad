/* SolidWorks-style FeatureManager: consumed sketches nest under their feature,
 * inline quick actions (Edit Feature / Edit Sketch / Suppress / Hide) appear on
 * hover or selection, and FeatureTree-owned labels follow the TR interface. */
import { launch, openApp, newDocument } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};

const depthOf = () => {
  const rows = [...document.querySelectorAll(".tree-row[data-kind='sketch']")];
  return rows.map((r) => ({ label: r.querySelector(".label")?.textContent, depth: r.style.getPropertyValue("--depth") }));
};

try {
  await newDocument(page);
  await page.click('[data-tree-action="sample"]');
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const part = api.doc().parts[0];
      const mesh = part && api.meshes().get(part.id);
      return !!mesh && Math.abs(mesh.volume - 98507) < 2;
    },
    null,
    { timeout: 240000 },
  );
  await page.waitForTimeout(400);

  // --- Consumed sketches are no longer a separate top-level list.
  const before = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".tree-row")];
    const features = rows
      .filter((r) => r.dataset.kind === "feature")
      .map((r) => r.querySelector(".label")?.textContent ?? "");
    const sketches = rows
      .filter((r) => r.dataset.kind === "sketch")
      .map((r) => ({ label: r.querySelector(".label")?.textContent, depth: r.style.getPropertyValue("--depth") }));
    const boss = rows.find((r) => r.dataset.kind === "feature" && (r.querySelector(".label")?.textContent ?? "").includes("Boss-Extrude1"));
    return { features, sketches, bossHasTwisty: !!boss?.querySelector(".twisty") };
  });
  record(
    "Consumed sketches are hidden from the top level until their feature is expanded",
    before.features.includes("Boss-Extrude1") && before.features.includes("Cut-Extrude1") && before.sketches.length === 0 && before.bossHasTwisty,
    before,
  );

  // --- Expanding Boss-Extrude1 reveals Sketch1 as a depth-2 child.
  const bossRow = () => page.locator('.tree-row[data-kind="feature"]', { hasText: "Boss-Extrude1" }).first();
  await bossRow().locator(".twisty").click();
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll(".tree-row")];
      const sketch = rows.find((r) => r.dataset.kind === "sketch" && r.querySelector(".label")?.textContent === "Sketch1");
      return !!sketch && sketch.style.getPropertyValue("--depth") === "2";
    },
    null,
    { timeout: 15000 },
  );
  const nested = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".tree-row")];
    const bossIndex = rows.findIndex((r) => r.dataset.kind === "feature" && (r.querySelector(".label")?.textContent ?? "").includes("Boss-Extrude1"));
    const sketchIndex = rows.findIndex((r) => r.dataset.kind === "sketch" && r.querySelector(".label")?.textContent === "Sketch1");
    const sketch = rows[sketchIndex];
    return {
      bossIndex,
      sketchIndex,
      depth: sketch?.style.getPropertyValue("--depth") ?? "",
      directlyBelow: sketchIndex === bossIndex + 1,
      quick: [...(sketch?.querySelectorAll(".row-quick button") ?? [])].map((b) => b.dataset.treeAction),
    };
  });
  record(
    "Boss-Extrude1 expands to its Sketch1 child with inline sketch actions",
    nested.directlyBelow && nested.depth === "2" && nested.quick.includes("sketch-edit") && nested.quick.includes("feature-edit"),
    nested,
  );

  // --- All four inline actions exist on the feature row.
  const featureQuick = await bossRow()
    .locator(".row-quick button")
    .evaluateAll((buttons) => buttons.map((b) => b.dataset.treeAction));
  record(
    "The feature row offers Edit Feature, Edit Sketch, Suppress and Hide on hover",
    ["feature-edit", "feature-edit-sketch", "feature-suppress", "feature-hide"].every((a) => featureQuick.includes(a)),
    { featureQuick },
  );

  // --- One click on Edit Sketch opens the child sketch in the sketch editor.
  await bossRow().hover();
  await bossRow().locator('[data-tree-action="feature-edit-sketch"]').click();
  await page.waitForFunction(() => window.__marmaracad.app.editor.isActive === true, null, { timeout: 30000 });
  const editing = await page.evaluate(() => ({
    active: window.__marmaracad.app.editor.isActive,
    sketchName: window.__marmaracad.app.editor.sketch?.name ?? "",
    status: document.querySelector(".status-bar")?.textContent ?? "",
  }));
  record("Edit Sketch opens Sketch1 in the sketch editor with one click", editing.active && editing.sketchName === "Sketch1", editing);
  await page.evaluate(() => window.__marmaracad.app.finishSketch());
  await page.waitForFunction(() => window.__marmaracad.app.editor.isActive === false, null, { timeout: 30000 });
  await page.waitForTimeout(400);

  // --- Suppress/Unsuppress quick action toggles the feature and rebuilds.
  await bossRow().hover();
  await bossRow().locator('[data-tree-action="feature-suppress"]').click();
  await page.waitForFunction(
    () => !!window.__marmaracad.doc().parts[0].features.find((f) => f.name === "Boss-Extrude1")?.suppressed,
    null,
    { timeout: 30000 },
  );
  const suppressed = await page.evaluate(() => {
    const feature = window.__marmaracad.doc().parts[0].features.find((f) => f.name === "Boss-Extrude1");
    const row = [...document.querySelectorAll(".tree-row[data-kind='feature']")].find((r) => (r.querySelector(".label")?.textContent ?? "").includes("Boss-Extrude1"));
    return { suppressed: !!feature?.suppressed, rowSuppressed: row?.classList.contains("suppressed") ?? false };
  });
  record("Suppress on the feature row flags the feature and greys its row", suppressed.suppressed && suppressed.rowSuppressed, suppressed);
  await bossRow().first().hover();
  await page.locator('.tree-row[data-kind="feature"] .row-quick [data-tree-action="feature-suppress"]').first().click();
  await page.waitForFunction(
    () => !window.__marmaracad.doc().parts[0].features.find((f) => f.name === "Boss-Extrude1")?.suppressed,
    null,
    { timeout: 60000 },
  );

  // --- TR labels owned by FeatureTree.
  await page.click(".lang-btn");
  await page.waitForFunction(
    () => /Malzemeyi Düzenle/.test(document.querySelector(".tree-material")?.textContent ?? ""),
    null,
    { timeout: 15000 },
  );
  const tr = await page.evaluate(() => {
    const notes = [...document.querySelectorAll(".tree-note")].map((n) => n.textContent ?? "");
    return {
      material: document.querySelector(".tree-material")?.textContent ?? "",
      section: document.querySelector(".tree-section-head")?.textContent ?? "",
      notes,
      english: /feature\(s\)/.test(document.getElementById("panel-body")?.textContent ?? ""),
    };
  });
  record(
    "FeatureManager labels are Turkish in TR mode",
    /Malzemeyi Düzenle/.test(tr.material) &&
      /Yapılandırmalar/.test(tr.section) &&
      tr.notes.some((n) => /Henüz yapılandırma yok/.test(n)) &&
      tr.notes.some((n) => /özellik ·/.test(n) && /eskiz/.test(n)) &&
      tr.english === false,
    tr,
  );
  await page.click(".lang-btn");
  await page.waitForFunction(
    () => /Edit Material/.test(document.querySelector(".tree-material")?.textContent ?? ""),
    null,
    { timeout: 15000 },
  );

  record("No console or page errors", errors.length === 0, { errors });
  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  console.error("SKETCH ROWS", await page.evaluate(depthOf).catch(() => []));
  process.exitCode = 1;
} finally {
  await browser.close();
}
