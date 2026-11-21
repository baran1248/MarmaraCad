/* SolidWorks-style shortcuts and the viewport context menu.
 *
 * Covers Normal To (N and Ctrl+8), F = zoom fit, right-click Hide / Show with
 * undo, Sketch on Face, and Esc dismissing an open PropertyManager. */
import { launch, openApp, waitForRebuild } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};

const selectFace = (pick) =>
  page.evaluate((source) => {
    const api = window.__marmaracad;
    const app = api.app;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const wanted = new Function("f", `return (${source})(f);`);
    const index = mesh.faces.findIndex(wanted);
    const face = mesh.faces[index];
    app.selFaces = [{ componentId: null, partId: doc.parts[0].id, faceIndex: index, face }];
    app.selectedFace = app.selFaces[0];
    app.syncSelection();
    return { index, normal: face.normal, point: face.point };
  }, pick.toString());

const cameraAxis = () =>
  page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    const d = vp.camera.position.clone().sub(vp.controls.target);
    const l = d.length() || 1;
    return { dir: [d.x / l, d.y / l, d.z / l], distance: l };
  });

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

try {
  await page.click('[data-tree-action="sample"]');
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

  // --- N: Normal To the selected face.
  const top = await selectFace((f) => f.surface === "plane" && f.normal[2] > 0.9);
  await page.keyboard.press("n");
  await page.waitForTimeout(350);
  const nAxis = await cameraAxis();
  record("N looks normal to the selected face", Math.abs(dot(nAxis.dir, top.normal)) > 0.995, {
    face: top.index,
    normal: top.normal,
    dir: nAxis.dir.map((v) => Math.round(v * 1000) / 1000),
  });

  // --- Ctrl+8 on a side face.
  const side = await selectFace((f) => f.surface === "plane" && Math.abs(f.normal[0]) > 0.9);
  await page.keyboard.press("Control+8");
  await page.waitForTimeout(350);
  const cAxis = await cameraAxis();
  record("Ctrl+8 is Normal To as well", Math.abs(dot(cAxis.dir, side.normal)) > 0.995, {
    face: side.index,
    normal: side.normal,
    dir: cAxis.dir.map((v) => Math.round(v * 1000) / 1000),
  });

  // --- F: zoom fit puts the whole body inside the canvas.
  const beforeFit = (await cameraAxis()).distance;
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  const fitted = await page.evaluate(() => {
    const api = window.__marmaracad;
    const app = api.app;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const vp = app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const { min, max } = mesh.bbox;
    let inside = 0;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) {
          const s = vp.projectToScreen([x, y, z]);
          if (s.visible && s.x >= 0 && s.x <= rect.width && s.y >= 0 && s.y <= rect.height) inside++;
        }
    const d = vp.camera.position.clone().sub(vp.controls.target).length();
    return { inside, distance: d, width: rect.width, height: rect.height };
  });
  record("F zooms to fit the whole body", fitted.inside === 8, { ...fitted, beforeFit });

  // --- Right-click Hide / Show, then undo.
  // Return to a top view first so the click lands on the top face again.
  await selectFace((f) => f.surface === "plane" && f.normal[2] > 0.9);
  await page.keyboard.press("n");
  await page.waitForTimeout(300);
  const topScreen = await page.evaluate((p) => {
    const vp = window.__marmaracad.app.viewport;
    const s = vp.projectToScreen(p);
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  }, top.point);
  await page.mouse.click(topScreen.x, topScreen.y, { button: "right" });
  await page.waitForSelector("#viewport-context.visible", { timeout: 5000 });
  await page.click('#viewport-context .ctx-item:has-text("Hide / Show")');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => window.__marmaracad.doc().parts[0].visible !== true);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => window.__marmaracad.doc().parts[0].visible !== false);
  record("Right-click Hide / Show toggles visibility and Ctrl+Z restores it", hidden && restored, { hidden, restored });

  // --- Right-click Sketch on Face opens a sketch on that face.
  // Scan a few pixels around the face centre until the ray lands on a planar face,
  // so the test does not depend on the centre hitting a hole rim.
  const planar = await page.evaluate((p) => {
    const vp = window.__marmaracad.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const s = vp.projectToScreen(p);
    const base = { x: rect.left + s.x, y: rect.top + s.y };
    for (const r of [0, 12, 24, 40, 60, 90]) {
      for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        const x = base.x + dx;
        const y = base.y + dy;
        if (vp.pickVertex(x, y)) continue;
        vp.raycastFaceAt(x, y);
        if (vp.pickEdge()) continue;
        const pick = vp.raycastFaceAt(x, y);
        if (pick && pick.face.surface === "plane" && Math.abs(pick.face.normal[2]) > 0.9) {
          return { x, y, index: pick.faceIndex, normal: pick.face.normal, dx, dy };
        }
      }
    }
    return null;
  }, top.point);
  record("A planar top face is pickable near its centre", !!planar, planar ?? {});
  await page.mouse.click(planar.x, planar.y, { button: "right" });
  await page.waitForSelector("#viewport-context.visible", { timeout: 5000 });
  const menuItems = await page.locator("#viewport-context .ctx-item").allInnerTexts();
  await page.click('#viewport-context .ctx-item:has-text("Sketch on Face")');
  await page.waitForFunction(() => window.__marmaracad.app.editor.isActive, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const onFace = await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    return {
      active: editor.isActive,
      normal: editor.sketch?.plane?.n ?? null,
      kind: editor.sketch?.plane?.kind ?? null,
      faceIndex: editor.sketch?.plane?.faceIndex ?? null,
    };
  });
  record(
    "Sketch on Face starts a sketch on the picked face",
    onFace.active && onFace.kind === "face" && onFace.faceIndex === planar.index,
    { ...onFace, menu: menuItems.filter((t) => /Sketch|Normal|Measure/.test(t)) },
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !window.__marmaracad.app.editor.isActive, null, { timeout: 20000 });
  await page.waitForTimeout(250);

  // --- Mouse wheel zooms towards the cursor (the point under it stays put).
  const anchor = await page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const x = rect.left + rect.width * 0.32;
    const y = rect.top + rect.height * 0.68;
    // World point under the cursor on the plane through the orbit target: the
    // wheel handler keeps exactly this point fixed while the camera closes in.
    vp.updatePointerAt(x, y);
    vp.raycaster.setFromCamera(vp.pointer, vp.camera);
    const normal = vp.camera.position.clone().sub(vp.controls.target).normalize();
    const ro = vp.raycaster.ray.origin;
    const rd = vp.raycaster.ray.direction;
    const t = normal.dot(vp.controls.target.clone().sub(ro)) / normal.dot(rd);
    const world = ro.clone().addScaledVector(rd, t);
    const s = vp.projectToScreen([world.x, world.y, world.z]);
    const distance = vp.camera.position.distanceTo(vp.controls.target);
    return { x, y, world: [world.x, world.y, world.z], screen: { x: s.x, y: s.y }, distance };
  });
  await page.mouse.move(anchor.x, anchor.y);
  for (let i = 0; i < 4; i++) {
    await page.mouse.wheel(0, -220);
    await page.waitForTimeout(70);
  }
  await page.waitForTimeout(400);
  const zoomed = await page.evaluate((a) => {
    const vp = window.__marmaracad.app.viewport;
    const s = vp.projectToScreen(a.world);
    return { screen: { x: s.x, y: s.y }, distance: vp.camera.position.distanceTo(vp.controls.target) };
  }, anchor);
  const drift = Math.hypot(zoomed.screen.x - anchor.screen.x, zoomed.screen.y - anchor.screen.y);
  record(
    "Mouse wheel zooms towards the cursor",
    zoomed.distance < anchor.distance * 0.75 && drift < 24,
    { before: anchor.screen, after: zoomed.screen, drift, cameraDistance: { before: anchor.distance, after: zoomed.distance } },
  );

  // --- Display settings: the SolidWorks/Fusion mouse scheme can be swapped.
  await page.click('[data-panel="display"]');
  await page.waitForSelector("#display-nav", { timeout: 15000 });
  const defaultScheme = await page.inputValue("#display-nav");
  await page.selectOption("#display-nav", "legacy");
  await page.waitForTimeout(300);
  const legacy = await page.evaluate(() => ({
    app: window.__marmaracad.app.navScheme,
    viewport: window.__marmaracad.app.viewport.navScheme,
  }));
  await page.selectOption("#display-nav", "cad");
  await page.waitForTimeout(300);
  const backToCad = await page.evaluate(() => ({
    app: window.__marmaracad.app.navScheme,
    viewport: window.__marmaracad.app.viewport.navScheme,
  }));
  record(
    "Display settings switch between the SolidWorks/Fusion and legacy mouse schemes",
    defaultScheme === "cad" && legacy.app === "legacy" && legacy.viewport === "legacy" && backToCad.app === "cad" && backToCad.viewport === "cad",
    { defaultScheme, legacy, backToCad },
  );
  await page.click('[data-panel="tree"]');
  await page.waitForTimeout(200);

  // --- Esc closes an open PropertyManager (no feature is created).
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="fillet"]');
  await page.waitForSelector("#pm-fillet-radius", { timeout: 15000 });
  const panelOpen = await page.evaluate(() => !!document.querySelector("#pm-fillet-radius"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const panelClosed = await page.evaluate(() => !document.querySelector("#pm-fillet-radius"));
  record("Esc dismisses the open PropertyManager", panelOpen && panelClosed, { panelOpen, panelClosed });

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
