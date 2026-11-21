import { launch, openApp, newDocument, startSketch, sketchClick, setTool, finishSketch, extrude, waitVolume, near } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const screenAt = (world) =>
  page.evaluate((w) => {
    const vp = window.__marmaracad.app.viewport;
    const s = vp.projectToScreen(w);
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y, visible: s.visible };
  }, world);
const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(180);
};

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 20);
  await setTool(page, "select");

  // Sketch window selection: left→right selects entities fully inside.
  const canvas = await page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    const r = vp.renderer.domElement.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  });
  await drag({ x: canvas.l + 6, y: canvas.t + 6 }, { x: canvas.r - 6, y: canvas.b - 6 });
  const sketchWindow = await page.evaluate(() => {
    const e = window.__marmaracad.app.editor;
    return { entities: e.selectedEntities.size, points: e.selectedPoints.size };
  });
  record("sketch window selection (left→right) selects all four lines", sketchWindow.entities === 4 && sketchWindow.points === 4, sketchWindow);

  // Sketch crossing selection: right→left selects anything touched.
  const mid = await screenAt([20, 10, 0]);
  await page.mouse.click(mid.x + 220, mid.y - 220);
  await drag({ x: mid.x + 60, y: mid.y - 120 }, { x: canvas.l + 20, y: mid.y + 120 });
  const sketchCrossing = await page.evaluate(() => window.__marmaracad.app.editor.selectedEntities.size);
  record("sketch crossing selection (right→left) selects touched lines", sketchCrossing > 0 && sketchCrossing < 4, { entities: sketchCrossing });

  await setTool(page, "select");
  await finishSketch(page);
  await extrude(page, { depth: 25 });
  await waitVolume(page, "Math.abs(v - 20000) < 1");

  const vertical = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const vp = api.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return mesh.edges
      .map((e, i) => {
        const a = e.points[0];
        const b = e.points[e.points.length - 1];
        const s = vp.projectToScreen([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
        return { i, dx: Math.abs(a[0] - b[0]), dy: Math.abs(a[1] - b[1]), dz: Math.abs(a[2] - b[2]), x: rect.left + s.x, y: rect.top + s.y };
      })
      .filter((e) => e.dx < 0.2 && e.dy < 0.2 && e.dz > 5);
  });
  await page.click('[data-pick-filter="edge"]');
  for (const edge of vertical.slice(0, 3)) {
    await page.keyboard.down("Control");
    await page.mouse.click(edge.x, edge.y);
    await page.keyboard.up("Control");
    await page.waitForTimeout(120);
  }
  let selected = await page.evaluate(() => window.__marmaracad.selections().edges.map((e) => e.edgeIndex));
  record("Ctrl+click collects three edges for a bulk operation", selected.length === 3, { selected });

  // Ctrl+click an already selected edge removes it, then adds it back.
  await page.keyboard.down("Control");
  await page.mouse.click(vertical[0].x, vertical[0].y);
  await page.keyboard.up("Control");
  await page.waitForTimeout(120);
  const afterRemove = await page.evaluate(() => window.__marmaracad.selections().edges.length);
  await page.keyboard.down("Control");
  await page.mouse.click(vertical[0].x, vertical[0].y);
  await page.keyboard.up("Control");
  await page.waitForTimeout(120);
  const afterReAdd = await page.evaluate(() => window.__marmaracad.selections().edges.length);
  record("Ctrl+click toggles a selected edge off and back on", afterRemove === 2 && afterReAdd === 3, { afterRemove, afterReAdd });

  // Measure accepts the multi-selection.
  await page.click('[data-cmd-tab="evaluate"]');
  await page.click('[data-cmd-action="measure"]');
  await page.waitForSelector("#pm-measure");
  const measureRows = await page.locator(".measure-row").count();
  record("Measure accepts the three selected edges", measureRows === 3, { rows: measureRows });
  await page.click("[data-pm-cancel]");
  await page.waitForTimeout(150);

  // Bulk fillet from the Ctrl+click selection.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="fillet"]');
  await page.waitForSelector("#pm-fillet-radius");
  const panelText = await page.locator(".panel-body").innerText();
  await page.fill("#pm-fillet-radius", "2");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "Math.abs(v - 19935.62) < 0.5");
  const fillet = await page.evaluate(() => {
    const doc = window.__marmaracad.doc();
    const feature = doc.parts[0].features.at(-1);
    const mesh = window.__marmaracad.meshes().get(doc.parts[0].id);
    return { type: feature.type, edges: feature.params.edgeIndices, volume: mesh.volume };
  });
  const expected = 20000 - 3 * (4 - Math.PI / 4) * 0 + 0;
  void expected;
  record("Fillet uses all three selected edges", fillet.type === "fillet" && fillet.edges.length === 3 && /3 EDGE/i.test(panelText), { panelText: panelText.split("\n").slice(0, 3), ...fillet });
  record("Bulk fillet volume matches three R2 corners", near(fillet.volume, 19935.62, 0.1).ok, { volume: fillet.volume });

  // Faces filter picks a planar face.
  await page.click('[data-pick-filter="face"]');
  const facePoint = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const face = mesh.faces.find((f) => f.surface === "plane" && f.normal[2] > 0.9) ?? mesh.faces[0];
    const vp = api.app.viewport;
    const s = vp.projectToScreen(face.point);
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  });
  await page.mouse.click(facePoint.x, facePoint.y);
  await page.waitForTimeout(150);
  const faceSel = await page.evaluate(() => window.__marmaracad.selections().faces.length);
  record("Faces filter selects a face", faceSel >= 1, { faces: faceSel });

  // Vertices filter picks a box corner.
  await page.click('[data-pick-filter="vertex"]');
  const corner = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const edge = mesh.edges[0];
    const p = edge.points[0];
    const vp = api.app.viewport;
    const s = vp.projectToScreen(p);
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  });
  await page.mouse.click(corner.x, corner.y);
  await page.waitForTimeout(150);
  const vertexSel = await page.evaluate(() => window.__marmaracad.selections().vertices.length);
  record("Vertices filter selects a corner vertex", vertexSel === 1, { vertices: vertexSel });

  // 3D window selection with the edge filter.
  await page.click('[data-pick-filter="edge"]');
  await page.mouse.click(canvas.l + 40, canvas.t + 40);
  await drag({ x: canvas.l + 6, y: canvas.t + 6 }, { x: canvas.r - 6, y: canvas.b - 6 });
  const boxEdges = await page.evaluate(() => window.__marmaracad.selections().edges.length);
  record("3D window selection selects every visible edge", boxEdges >= 9, { edges: boxEdges });

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
