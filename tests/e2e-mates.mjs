/* Assembly mating on real geometry.
 *
 * Builds a Ø20 x 50 cylinder, inserts two components, misplaces the second one
 * (40 mm / 25 mm offset and a 30° tilt) and then applies a Coincident mate on the
 * end caps plus a Concentric mate on the cylindrical faces. The test recomputes
 * the world-space faces with Three.js and checks the residual itself — the mate
 * panel reporting "solved" is not enough. */
import * as THREE from "three";
import { launch, openApp, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];

function record(name, pass, details = {}) {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
}

await startSketch(page, "front");
await setTool(page, "circle");
await sketchClick(page, 0, 0);
await sketchClick(page, 10, 0);
await finishSketch(page);
await extrude(page, { depth: 50, operation: "new" });
await waitVolume(page, "v > 15000");
const cylinder = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return {
    volume: mesh.volume,
    cylinders: mesh.faces.filter((f) => f.surface === "cylinder").length,
    planes: mesh.faces.filter((f) => f.surface === "plane").length,
    bbox: mesh.bbox,
  };
});
record("Ø20 x 50 cylinder built", Math.abs(cylinder.volume - Math.PI * 100 * 50) < 50 && cylinder.cylinders === 1, cylinder);

// ---------------------------------------------------------------- insert two
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="insert-component"]');
await page.waitForSelector("#insert-qty", { timeout: 15000 });
await page.fill("#insert-qty", "2");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().components.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(400);
const inserted = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  return doc.components.map((c) => ({ id: c.id, name: c.name, fixed: c.fixed, position: c.position, rotation: c.rotation }));
});
record("two components inserted, one fixed", inserted.length === 2 && inserted[0].fixed === true, inserted);

// ---------------------------------------------------------------- misplace B
const secondId = inserted[1].id;
await page.dblclick(`[data-key="component:${secondId}"]`);
await page.waitForSelector("#pm-tx", { timeout: 15000 });
await page.fill("#pm-tx", "40");
await page.fill("#pm-ty", "25");
await page.fill("#pm-rx", "30");
await page.click("[data-pm-ok]");
await page.waitForTimeout(500);
const misplaced = await page.evaluate(() => {
  const c = window.__marmaracad.doc().components[1];
  return { position: c.position, rotation: c.rotation };
});
record("component B transformed away from the axis", Math.abs(misplaced.position[0] - 40) < 0.01 && Math.abs(misplaced.position[1] - 25) < 0.01 && Math.abs(misplaced.rotation[0] - 30) < 0.01, misplaced);

// ---------------------------------------------------------------- coincident mate
const faces = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[0].id);
  return {
    partId: doc.parts[0].id,
    bottom: mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] < -0.9),
    top: mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[2] > 0.9),
    cylinder: mesh.faces.findIndex((f) => f.surface === "cylinder"),
  };
});
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="mate-coincident"]');
await page.waitForSelector("#pm-mate-picks", { timeout: 15000 });
await page.evaluate(
  ({ faceIndex, partId, componentId }) => {
    const app = window.__marmaracad;
    const mesh = app.meshes().get(partId);
    app.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
  },
  { faceIndex: faces.bottom, partId: faces.partId, componentId: inserted[0].id },
);
await page.evaluate(
  ({ faceIndex, partId, componentId }) => {
    const app = window.__marmaracad;
    const mesh = app.meshes().get(partId);
    app.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
  },
  { faceIndex: faces.top, partId: faces.partId, componentId: secondId },
);
await page.waitForTimeout(200);
const pickText = await page.textContent("#pm-mate-picks");
await page.click("[data-pm-ok]");
await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 1, null, { timeout: 30000 });
await page.waitForTimeout(500);
record("Coincident mate created from two end-cap faces", /Face/.test(pickText ?? ""), { pickText });

// ---------------------------------------------------------------- concentric mate
await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="mate-concentric"]');
await page.waitForSelector("#pm-mate-picks", { timeout: 15000 });
await page.evaluate(
  ({ faceIndex, partId, componentId }) => {
    const app = window.__marmaracad;
    const mesh = app.meshes().get(partId);
    app.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
  },
  { faceIndex: faces.cylinder, partId: faces.partId, componentId: inserted[0].id },
);
await page.evaluate(
  ({ faceIndex, partId, componentId }) => {
    const app = window.__marmaracad;
    const mesh = app.meshes().get(partId);
    app.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
  },
  { faceIndex: faces.cylinder, partId: faces.partId, componentId: secondId },
);
await page.waitForTimeout(200);
await page.click("[data-pm-ok]");
await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 2, null, { timeout: 30000 });
await page.waitForTimeout(600);

const assembly = await page.evaluate(() => {
  const doc = window.__marmaracad.doc();
  return {
    mode: doc.mode,
    mates: doc.mates.map((m) => ({ type: m.type, error: m.error ?? null, a: m.a, b: m.b })),
    components: doc.components.map((c) => ({ id: c.id, fixed: c.fixed, position: c.position, rotation: c.rotation })),
    status: document.getElementById("status-msg")?.textContent,
    toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent?.trim()),
  };
});

// Recompute the world-space faces exactly like the app does.
function worldFace(component, ref) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      (component.rotation[0] * Math.PI) / 180,
      (component.rotation[1] * Math.PI) / 180,
      (component.rotation[2] * Math.PI) / 180,
      "XYZ",
    ),
  );
  return {
    point: new THREE.Vector3(...ref.point).applyQuaternion(q).add(new THREE.Vector3(...component.position)),
    normal: new THREE.Vector3(...ref.normal).applyQuaternion(q).normalize(),
    axis: new THREE.Vector3(...(ref.axis ?? ref.normal)).applyQuaternion(q).normalize(),
  };
}

const byId = new Map(assembly.components.map((c) => [c.id, c]));
const concentric = assembly.mates.find((m) => m.type === "concentric");
const coincident = assembly.mates.find((m) => m.type === "coincident");
const a = worldFace(byId.get(concentric.a.componentId), concentric.a);
const b = worldFace(byId.get(concentric.b.componentId), concentric.b);
const axisCross = new THREE.Vector3().crossVectors(a.axis, b.axis).length();
const delta = b.point.clone().sub(a.point);
const radial = delta.clone().sub(a.axis.clone().multiplyScalar(delta.dot(a.axis))).length();
record(
  "Concentric mate aligns the cylinder axes",
  axisCross < 1e-3 && radial < 0.08 && !concentric.error,
  { axisCross, radial, error: concentric.error, positionB: byId.get(secondId).position, rotationB: byId.get(secondId).rotation },
);

const ca = worldFace(byId.get(coincident.a.componentId), coincident.a);
const cb = worldFace(byId.get(coincident.b.componentId), coincident.b);
const planeGap = Math.abs(cb.point.clone().sub(ca.point).dot(ca.normal));
const normalDot = ca.normal.dot(cb.normal);
record(
  "Coincident mate puts the end caps in the same plane",
  planeGap < 0.08 && normalDot < -0.999 && !coincident.error,
  { planeGap, normalDot, error: coincident.error, positionB: byId.get(secondId).position },
);

record(
  "mate errors are surfaced in the tree",
  assembly.mates.every((m) => m.error === null),
  { mates: assembly.mates.map((m) => m.type) },
);

const failed = results.filter((r) => !r.pass);
console.log("RESULT", failed.length === 0 && errors.length === 0 ? "PASS" : "FAIL", JSON.stringify({ assembly: { mode: assembly.mode, toasts: assembly.toasts }, errors }, null, 2));
await browser.close();
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
