/* Ansys-style analysis state strip (FeatureManager header).
 *
 * Checks the five pills (Geometry / Material / Mesh / Loads / Results) and the
 * MMGS Â· NMM unit label through the lifecycle: fresh part, missing material,
 * ready-to-solve, solved, and stale after geometry changes. */
import { launch, openApp, newDocument, startSketch, sketchClick, setTool, finishSketch, extrude, waitVolume } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const strip = () =>
  page.evaluate(() => {
    const host = document.querySelector(".analysis-status-grid");
    if (!host) return null;
    const units = document.querySelector(".analysis-units")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return {
      units,
      pills: [...host.querySelectorAll(".status-pill")].map((p) => ({
        label: p.querySelector(".label")?.textContent?.trim() ?? "",
        state: p.querySelector(".state")?.textContent?.trim() ?? "",
        cls: p.className,
      })),
    };
  });
const study = () =>
  page.evaluate(() => {
    const s = window.__marmaracad.doc().analyses[0];
    return s ? { status: s.status, stale: !!s.stale, materialId: s.materialId } : null;
  });

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 20);
  await setTool(page, "select");
  await finishSketch(page);
  await extrude(page, { depth: 20 });
  await waitVolume(page, "Math.abs(v - 16000) < 1");

  // --- Study created on a part without a material: Material/Results are "Input required".
  await page.click('[data-cmd-tab="analysis"]');
  await page.click('[data-cmd-action="new-study"]');
  await page.waitForSelector("#pm-study-material", { timeout: 20000 });
  await page.click("[data-pm-ok]");
  await page.waitForFunction(() => window.__marmaracad.doc().analyses.length === 1, null, { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.click('[data-tree-action="analysis"]').catch(() => undefined);
  await page.waitForTimeout(300);
  const created = await strip();
  record(
    "The analysis strip lists Geometry / Material / Mesh / Loads / Results in MMGS Â· NMM",
    !!created &&
      created.pills.map((p) => p.label).join("|") === "Geometry|Material|Mesh|Loads|Results" &&
      /MMGS/.test(created.units) &&
      /NMM/.test(created.units),
    created ?? {},
  );
  const materialPill = created?.pills.find((p) => p.label === "Material");
  const resultsPill = created?.pills.find((p) => p.label === "Results");
  record(
    "A new study asks for the material and a solve",
    materialPill?.state === "Input required" && resultsPill?.state === "Solve required",
    { material: materialPill, results: resultsPill },
  );

  // --- Assign AISI 1020 â†’ Material becomes Current.
  await page.evaluate(() => {
    const doc = window.__marmaracad.doc();
    doc.parts[0].materialId = "aisi1020";
    const s = doc.analyses[0];
    s.materialId = "aisi1020";
    window.__marmaracad.app.refreshTree();
  });
  await page.waitForTimeout(350);
  const withMaterial = await strip();
  record(
    "Assigning a material turns the Material pill green",
    withMaterial?.pills.find((p) => p.label === "Material")?.state === "Current",
    { pills: withMaterial?.pills },
  );

  // --- Boundary conditions + mesh + solve.
  await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[0];
    const mesh = api.meshes().get(part.id);
    const app = api.app;
    const s = doc.analyses[0];
    const bottom = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9);
    const top = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9);
    s.supports = [{ id: "sup1", faceIndex: bottom, face: { faceIndex: bottom, surface: "plane", point: mesh.faces[bottom].point, normal: mesh.faces[bottom].normal } }];
    s.loads = [
      {
        id: "load1",
        type: "force",
        faceIndex: top,
        face: { faceIndex: top, surface: "plane", point: mesh.faces[top].point, normal: mesh.faces[top].normal },
        magnitude: 500,
        direction: [0, 0, -1],
        label: "Force 500 N",
      },
    ];
    app.invalidateStudy?.(s);
    app.refreshTree();
    app.refreshPickLists?.(s);
  });
  await page.dblclick('[data-key^="study:"]');
  await page.waitForSelector("#pm-study-mesh", { timeout: 15000 });
  await page.fill("#pm-study-mesh", "4");
  await page.evaluate(() => document.getElementById("pm-study-mesh")?.dispatchEvent(new Event("change", { bubbles: true })));
  await page.waitForSelector('[data-study-action="mesh"]', { timeout: 20000 });
  await page.click('[data-study-action="mesh"]');
  await page.waitForFunction(() => Boolean(window.__marmaracad.doc().analyses[0].meshStats), null, { timeout: 180000 });
  // Close the study PropertyManager so the FeatureManager (with the strip) is visible.
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(500);
  const meshed = await strip();
  record(
    "Mesh turns Current once the mesh exists and Results still needs a solve",
    meshed?.pills.find((p) => p.label === "Mesh")?.state === "Current" &&
      meshed?.pills.find((p) => p.label === "Loads")?.state === "Current" &&
      meshed?.pills.find((p) => p.label === "Results")?.state === "Solve required",
    { pills: meshed?.pills },
  );

  await page.dblclick('[data-key^="study:"]');
  await page.waitForSelector('[data-study-action="solve"]', { timeout: 20000 });
  await page.click('[data-study-action="solve"]');
  await page.waitForFunction(() => window.__marmaracad.doc().analyses[0].status === "solved", null, { timeout: 300000 });
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(800);
  const solvedStrip = await strip();
  record(
    "Results reads Current after the solve",
    solvedStrip?.pills.find((p) => p.label === "Results")?.state === "Current",
    { pills: solvedStrip?.pills, study: await study() },
  );

  // --- Editing the extrude depth through the PropertyManager makes results stale.
  // Switch back to Part mode so the model tree (features) is visible.
  await page.click('[data-mode="part"]');
  await page.waitForTimeout(400);
  const extrudeId = await page.evaluate(
    () => window.__marmaracad.doc().parts[0].features.find((f) => f.type === "extrude").id,
  );
  await page.dblclick(`[data-key="feature:${extrudeId}"]`);
  await page.waitForSelector("#pm-depth", { timeout: 20000 });
  await page.fill("#pm-depth", "25");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "Math.abs(v - 20000) < 1");
  await page.click('[data-mode="analysis"]');
  await page.waitForTimeout(500);
  const staleStrip = await strip();
  const staleStudy = await study();
  record(
    "Changing geometry marks Mesh/Results as Stale",
    staleStudy.stale === true &&
      staleStrip?.pills.find((p) => p.label === "Results")?.cls.includes("stale") &&
      /Stale/.test(staleStrip?.pills.find((p) => p.label === "Results")?.state ?? ""),
    { stale: staleStudy, pills: staleStrip?.pills },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
