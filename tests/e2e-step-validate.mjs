/* STEP (AP214) export validation and geometric round trip.
 *
 * Builds a 40 x 20 x 10 plate with a Ø10 through hole, exports through the real
 * File > Export menu, then inspects the text: ISO-10303-21 envelope, AP214
 * schema, and a genuine B-Rep body (MANIFOLD_SOLID_BREP + CLOSED_SHELL +
 * ADVANCED_FACE + CYLINDRICAL_SURFACE). Finally it re-imports the file and
 * compares volume, face count and the hole radius. */
import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume, body, near, runCmd } from "./e2e-lib.mjs";

const TMP = "C:\\Users\\MBB\\AppData\\Local\\Temp\\opencode\\marmaracad-e2e";
const stepPath = join(TMP, "plate-with-hole.step");

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
function record(name, pass, details = {}) {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
}

await newDocument(page);

// ------------------------------------------------------------------ build the part
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -20, -10);
await sketchClick(page, 20, 10);
await finishSketch(page);
await extrude(page, { depth: 10, operation: "new" });
await waitVolume(page, "v > 7000");

await startSketch(page, "front");
await setTool(page, "circle");
await sketchClick(page, 0, 0);
await sketchClick(page, 5, 0);
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await runCmd(page, "extrude-cut");
await page.waitForSelector("#pm-depth");
await page.fill("#pm-depth", "10");
await page.click("[data-pm-ok]");
await waitVolume(page, "v < 7300");
const source = await body(page);
record(
  "source plate: 40 x 20 x 10 with a Ø10 hole",
  Math.abs(source.volume - (8000 - Math.PI * 250)) < 10 && source.surfaces.filter((s) => s === "cylinder").length === 1,
  { volume: source.volume, faces: source.faces, surfaces: source.surfaces },
);

// ------------------------------------------------------------------ export
const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
await page.click('[data-cmd-tab="evaluate"]');
await page.click('[data-cmd-action="export-step"]');
const download = await downloadPromise;
await download.saveAs(stepPath);
const info = await stat(stepPath);
const text = await readFile(stepPath, "utf8");
record("STEP file downloaded", info.size > 2000, { bytes: info.size, suggested: download.suggestedFilename() });

// ------------------------------------------------------------------ header + B-Rep structure
const head = text.slice(0, 4000);
const headerChecks = {
  isoEnvelope: text.startsWith("ISO-10303-21;") && /END-ISO-10303-21;/.test(text),
  fileDescription: /FILE_DESCRIPTION\s*\(/.test(head),
  fileName: /FILE_NAME\s*\(/.test(head),
  fileNameValue: (head.match(/FILE_NAME\s*\(\s*'([^']*)'/) ?? [])[1] ?? null,
  schema: (head.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/) ?? [])[1] ?? null,
};
record("ISO-10303-21 envelope and FILE_* header present", headerChecks.isoEnvelope && headerChecks.fileDescription && headerChecks.fileName, headerChecks);
record(
  "FILE_SCHEMA declares an AP214 / AP242 schema",
  /AP214|AP242|AUTOMOTIVE_DESIGN|CONFIG_CONTROL_DESIGN/.test(headerChecks.schema ?? ""),
  { schema: headerChecks.schema },
);

const count = (re) => (text.match(re) ?? []).length;
const brep = {
  manifoldSolidBrep: count(/MANIFOLD_SOLID_BREP/g),
  closedShell: count(/CLOSED_SHELL/g),
  advancedFace: count(/ADVANCED_FACE/g),
  cylindricalSurface: count(/CYLINDRICAL_SURFACE/g),
  cartesianPoint: count(/CARTESIAN_POINT/g),
  edgeCurve: count(/EDGE_CURVE/g),
};
record(
  "STEP body contains a real B-Rep solid with the hole surface",
  brep.manifoldSolidBrep >= 1 && brep.closedShell >= 1 && brep.advancedFace >= 7 && brep.cylindricalSurface >= 1 && brep.edgeCurve >= 12,
  brep,
);

// ------------------------------------------------------------------ re-import into a new document
await newDocument(page);
const chooserPromise = page.waitForEvent("filechooser", { timeout: 30000 });
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="import-cad"]');
const chooser = await chooserPromise;
await chooser.setFiles(stepPath);
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app.doc();
    return doc.parts.some((part) => {
      const mesh = app.meshes().get(part.id);
      return Boolean(mesh && mesh.volume > 1000);
    });
  },
  null,
  { timeout: 180000 },
);
const importedIndex = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  let index = 0;
  doc.parts.forEach((part, i) => {
    const mesh = app.meshes().get(part.id);
    if (mesh && mesh.volume > 1000) index = i;
  });
  return index;
});
const imported = await body(page, importedIndex);
const volumeCmp = near(imported.volume, source.volume, 0.5);
record(
  "round trip preserves the volume",
  volumeCmp.ok && imported.volume > 0,
  { source: Math.round(source.volume * 100) / 100, imported: Math.round(imported.volume * 100) / 100, errorPct: volumeCmp.errorPct },
);
record(
  "round trip preserves the face count and the cylindrical hole",
  imported.faces === source.faces && imported.surfaces.filter((s) => s === "cylinder").length === 1,
  { sourceFaces: source.faces, importedFaces: imported.faces, importedSurfaces: imported.surfaces },
);

const holeFace = await page.evaluate((index) => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[index].id);
  const face = mesh.faces.find((f) => f.surface === "cylinder");
  return face ? { radius: face.radius, axis: face.axis } : null;
}, importedIndex);
record("imported hole has the Ø10 radius", holeFace !== null && Math.abs((holeFace.radius ?? 0) - 5) < 0.05, holeFace ?? {});

const failed = results.filter((r) => !r.pass);
console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ errors }, null, 2));
await browser.close();
await unlink(stepPath).catch(() => undefined);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
