/* "Box + Lid" template scenario.
 *
 * Builds the shipped enclosure template, checks the shelled box and lid
 * volumes, verifies the assembly placement, the absence of interference and
 * the material-driven mass properties. */
import { launch, openApp, newDocument, waitForRebuild, near } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const parts = () =>
  page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    return {
      mode: doc.mode,
      name: doc.name,
      parts: doc.parts.map((p) => {
        const mesh = api.meshes().get(p.id);
        return {
          id: p.id,
          name: p.name,
          material: p.materialId,
          features: p.features.map((f) => ({ type: f.type, params: f.params })),
          volume: mesh ? mesh.volume : null,
          area: mesh ? mesh.area : null,
          bbox: mesh ? { min: mesh.bbox.min, max: mesh.bbox.max } : null,
        };
      }),
      components: doc.components.map((c) => ({ name: c.name, partId: c.partId, position: c.position })),
    };
  });

try {
  await newDocument(page);
  await page.click('[data-menu="file"]');
  await page.click('[data-menu-action="templates"]');
  await page.waitForSelector('[data-template="box-lid"]');
  await page.click('[data-template="box-lid"]');
  await page.click(".modal .btn.primary");
  await waitForRebuild(page);
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const doc = api.doc();
      return doc.parts.length === 2 && doc.parts.every((p) => (api.meshes().get(p.id)?.volume ?? 0) > 1000);
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(400);

  const info = await parts();
  const box = info.parts.find((p) => p.name === "Box");
  const lid = info.parts.find((p) => p.name === "Lid");
  record(
    "Template creates an assembly with Box + Lid components",
    info.mode === "assembly" && info.parts.length === 2 && info.components.length === 2 && /Box \+ Lid/i.test(info.name),
    { mode: info.mode, name: info.name, components: info.components },
  );
  record(
    "Box is shelled to a 2 mm constant wall",
    box?.features.some((f) => f.type === "shell" && Math.abs((f.params.thickness ?? 0) - 2) < 1e-6) &&
      near(box.volume, 15552, 1).ok,
    { volume: box?.volume, features: box?.features.map((f) => f.type) },
  );
  record("Lid is a 64 × 44 × 3 mm plate", lid ? near(lid.volume, 8448, 1).ok : false, { volume: lid?.volume });
  const lidTop = lid?.bbox ? lid.bbox.min[1] + (info.components.find((c) => c.partId === lid.id)?.position[1] ?? 0) : null;
  record(
    "Lid sits on the box opening (y = 30 mm)",
    lidTop !== null && Math.abs(lidTop - 30) < 1e-6,
    { lidLocalMinY: lid?.bbox?.min[1], componentY: info.components.find((c) => c.partId === lid?.id)?.position[1], lidTop },
  );
  record(
    "Both parts carry the AISI 1020 material",
    box?.material === "aisi1020" && lid?.material === "aisi1020",
    { box: box?.material, lid: lid?.material },
  );

  // Interference detection: the lid touches but does not overlap the box.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="interference"]');
  await page.waitForSelector(".modal");
  const interferenceText = await page.locator(".modal .modal-body").innerText();
  record(
    "Interference detection reports the box + lid as clear",
    /No interference detected/i.test(interferenceText) && !/interference ·/i.test(interferenceText),
    { text: interferenceText.split("\n").slice(0, 3) },
  );
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(150);

  // Positive case: drop the lid 5 mm into the box and detect the overlap.
  await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const doc = window.__marmaracad.doc();
    const lid = doc.components.find((c) => /Lid/i.test(c.name));
    lid.position = [0, 25, 0];
    app.refreshScene();
    app.refreshTree();
  });
  await page.waitForTimeout(400);
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="interference"]');
  await page.waitForSelector(".modal");
  const overlapText = await page.locator(".modal .modal-body").innerText();
  const overlapVolume = Number((overlapText.match(/≈\s*([\d.,]+)\s*mm³/) ?? [])[1]?.replace(",", ".") ?? 0);
  record(
    "Interference detection finds the lid pushed 5 mm into the box (≈1,152 mm³)",
    /interference/i.test(overlapText) &&
      !/No interference detected/i.test(overlapText) &&
      Math.abs(overlapVolume - 1152) < 120,
    { volume: overlapVolume, text: overlapText.split("\n").slice(0, 3) },
  );
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(150);
  // Put the lid back on top for the mass checks.
  await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const lid = window.__marmaracad.doc().components.find((c) => /Lid/i.test(c.name));
    lid.position = [0, 30, 0];
    app.refreshScene();
    app.refreshTree();
  });
  await page.waitForTimeout(300);

  // Mass properties combine both components with the material density.
  await page.click('[data-cmd-tab="evaluate"]');
  await page.click('[data-cmd-action="mass-props"]');
  await page.waitForSelector(".modal");
  const massText = await page.locator(".modal .modal-body").innerText();
  await page.click(".modal .btn.primary");
  const totalVolume = (box?.volume ?? 0) + (lid?.volume ?? 0);
  const expectedMass = totalVolume * 7850 * 1e-9;
  record(
    "Mass properties total volume + mass come from the FEA material density",
    massText.includes("24000") && /0\.18[0-9]{1,3} kg/.test(massText),
    { totalVolume, expectedMass, text: massText.split("\n").slice(0, 8) },
  );

  // FeatureManager material row in part mode.
  await page.click('[data-mode="part"]');
  await page.waitForTimeout(250);
  const materialRow = await page.locator(".tree-material").first().innerText().catch(() => "");
  record(
    "FeatureManager shows the assigned material above the features",
    /AISI 1020/i.test(materialRow),
    { materialRow: materialRow.replace(/\s+/g, " ").trim() },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
