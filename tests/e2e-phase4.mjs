/* Phase 4 regression: Shapr3D navigation, direct Push/Pull, sheet metal,
 * configurations, live assembly drag and the persistence of the new data.
 *
 * Everything goes through the real UI or the real pointer event paths; the
 * checks recompute the geometry/constraints from the live document instead of
 * trusting a status message. */
import fs from "node:fs";
import * as THREE from "three";
import {
  launch,
  openApp,
  newDocument,
  startSketch,
  setTool,
  sketchClick,
  finishSketch,
  extrude,
  featureCount,
  waitFeatureCount,
  waitVolume,
  near,
  runCmd,
} from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser, { width: 1440, height: 900 });
const results = [];
function record(name, pass, details = {}) {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
}
function check(name, actual, expected, pct, details = {}) {
  const cmp = near(actual, expected, pct);
  record(name, cmp.ok, { actual: Math.round(actual * 1000) / 1000, expected, errorPct: cmp.errorPct, ...details });
}

const control = () =>
  page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    return { state: vp.getControlState(), debug: { ...vp.debugControl } };
  });

const canvasBox = async () => {
  const box = await page.locator(".viewport-canvas").boundingBox();
  if (!box) throw new Error("Viewport canvas is missing.");
  return box;
};

const dispatchWheel = (init) =>
  page.evaluate((options) => {
    const canvas = document.querySelector(".viewport-canvas");
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...options }));
  }, init);

const dispatchPointer = (type, init) =>
  page.evaluate(
    ({ type, init }) => {
      const canvas = document.querySelector(".viewport-canvas");
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: init.pointerId ?? 1,
          pointerType: init.pointerType ?? "mouse",
          isPrimary: init.isPrimary ?? true,
          clientX: rect.left + (init.x ?? rect.width / 2),
          clientY: rect.top + (init.y ?? rect.height / 2),
          button: init.button ?? 0,
          buttons: init.buttons ?? (type === "pointerup" ? 0 : 1),
          ctrlKey: init.ctrlKey ?? false,
          shiftKey: init.shiftKey ?? false,
        }),
      );
    },
    { type, init },
  );

/** Three-finger horizontal swipe on the canvas (negative = undo). */
async function threeFingerSwipe(dx) {
  const p = (x, y) => ({ x, y });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 41, ...p(480, 420) });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 42, isPrimary: false, ...p(600, 420) });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 43, isPrimary: false, ...p(720, 420) });
  for (let i = 1; i <= 3; i++) {
    const shift = (dx * i) / 3;
    await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 41, ...p(480 + shift, 420) });
    await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 42, isPrimary: false, ...p(600 + shift, 420) });
    await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 43, isPrimary: false, ...p(720 + shift, 420) });
  }
  await dispatchPointer("pointerup", { pointerType: "touch", pointerId: 41, buttons: 0, ...p(480 + dx, 420) });
  await dispatchPointer("pointerup", { pointerType: "touch", pointerId: 42, isPrimary: false, buttons: 0, ...p(600 + dx, 420) });
  await dispatchPointer("pointerup", { pointerType: "touch", pointerId: 43, isPrimary: false, buttons: 0, ...p(720 + dx, 420) });
  await page.waitForTimeout(120);
}

/** Select the extrusion cap (planar face furthest along its own normal). */
const selectCap = (pick) =>
  page.evaluate((usePick) => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    const n = part.sketches[0].plane.n;
    let best = null;
    mesh.faces.forEach((face, index) => {
      if (face.surface !== "plane") return;
      const dot = face.normal[0] * n[0] + face.normal[1] * n[1] + face.normal[2] * n[2];
      if (dot < 0.99) return;
      const proj = face.point[0] * n[0] + face.point[1] * n[1] + face.point[2] * n[2];
      if (!best || proj > best.proj) best = { index, proj };
    });
    if (!best) return null;
    const face = mesh.faces[best.index];
    // FaceInfo has no area: sum the underlying triangles of this face.
    let area = 0;
    for (let t = face.triStart; t < face.triStart + face.triCount; t++) {
      const ia = mesh.indices[t * 3];
      const ib = mesh.indices[t * 3 + 1];
      const ic = mesh.indices[t * 3 + 2];
      const ax = mesh.positions[ia * 3], ay = mesh.positions[ia * 3 + 1], az = mesh.positions[ia * 3 + 2];
      const bx = mesh.positions[ib * 3], by = mesh.positions[ib * 3 + 1], bz = mesh.positions[ib * 3 + 2];
      const cx = mesh.positions[ic * 3], cy = mesh.positions[ic * 3 + 1], cz = mesh.positions[ic * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    const facePick = { componentId: null, partId: part.id, faceIndex: face.index, face };
    if (usePick) app.app.handleFacePick(facePick);
    return { faceIndex: face.index, point: face.point, normal: face.normal, partId: part.id, area };
  }, pick);

/** Drag the active face gizmo by an exact millimetre distance. */
async function dragFaceGizmo(distanceMm) {
  const geom = await page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    const g = vp.gizmo;
    if (!g || g.kind !== "face") return null;
    const knob = g.object.children[2];
    const along = knob ? knob.position.y : 0;
    const world = [g.origin.x + g.dir.x * along, g.origin.y + g.dir.y * along, g.origin.z + g.dir.z * along];
    const p = vp.projectToScreen(world);
    const s0 = vp.projectToScreen([g.origin.x, g.origin.y, g.origin.z]);
    const s1 = vp.projectToScreen([g.origin.x + g.dir.x * 10, g.origin.y + g.dir.y * 10, g.origin.z + g.dir.z * 10]);
    const rawX = s1.x - s0.x;
    const rawY = s1.y - s0.y;
    const len = Math.hypot(rawX, rawY) || 1;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + p.x,
      y: rect.top + p.y,
      pxPerMm: Math.max(0.05, len / 10),
      dirX: rawX / len,
      dirY: rawY / len,
      debug: { ...vp.debugControl },
    };
  });
  if (!geom) throw new Error("No face gizmo is visible to drag.");
  const steps = 8;
  const tx = geom.dirX * distanceMm * geom.pxPerMm;
  const ty = geom.dirY * distanceMm * geom.pxPerMm;
  await page.mouse.move(geom.x, geom.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(geom.x + (tx * i) / steps, geom.y + (ty * i) / steps);
    await page.waitForTimeout(25);
  }
  const label = await page.evaluate(() => window.__marmaracad.app.viewport.gizmo?.label.textContent ?? null);
  const debug = await page.evaluate(() => ({ ...window.__marmaracad.app.viewport.debugControl }));
  await page.mouse.up();
  return { label, drags: debug.gizmoDrags - geom.debug.gizmoDrags, pxPerMm: geom.pxPerMm };
}

/** Drag the active edge gizmo by an exact millimetre distance (R positive). */
async function dragEdgeGizmo(distanceMm) {
  const geom = await page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    const g = vp.gizmo;
    if (!g || g.kind !== "edge") return null;
    const p = vp.projectToScreen([g.origin.x, g.origin.y, g.origin.z]);
    const s1 = vp.projectToScreen([g.origin.x + g.dir.x * 10, g.origin.y + g.dir.y * 10, g.origin.z + g.dir.z * 10]);
    const len = Math.hypot(s1.x - p.x, s1.y - p.y) || 1;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y, pxPerMm: Math.max(0.05, len / 10) };
  });
  if (!geom) throw new Error("No edge gizmo is visible to drag.");
  // Edge handles read (dx - dy), so a pure horizontal drag is enough.
  const dx = distanceMm * geom.pxPerMm;
  await page.mouse.move(geom.x, geom.y);
  await page.mouse.down();
  await page.mouse.move(geom.x + dx, geom.y, { steps: 6 });
  await page.waitForTimeout(60);
  const label = await page.evaluate(() => window.__marmaracad.app.viewport.gizmo?.label.textContent ?? null);
  await page.mouse.up();
  return { label };
}

/** File > Save As: prompt, then read the downloaded .mcad.json. */
async function saveProjectAs(name) {
  await page.click('[data-menu="file"]');
  const wait = page.waitForEvent("download", { timeout: 60000 });
  await page.click('[data-menu-action="save-as"]');
  await page.waitForSelector("#prompt-name", { timeout: 15000 });
  await page.fill("#prompt-name", name);
  await page.click(".modal-foot .btn.primary");
  const download = await wait;
  const filePath = await download.path();
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

try {
  // ------------------------------------------------------------------ 1. nav
  await newDocument(page);
  await page.click('[data-control-mode="trackpad"]');
  await page.waitForTimeout(120);
  const navStart = await control();

  await dispatchWheel({ deltaX: 120, deltaY: 10 });
  await page.waitForTimeout(160);
  const navHorizontal = await control();
  record(
    "trackpad: horizontal two-finger scroll orbits (old pan hijack removed)",
    navHorizontal.debug.orbits > navStart.debug.orbits && navHorizontal.debug.pans === navStart.debug.pans,
    { orbits: [navStart.debug.orbits, navHorizontal.debug.orbits], pans: [navStart.debug.pans, navHorizontal.debug.pans] },
  );

  await dispatchWheel({ deltaX: 12, deltaY: 90 });
  await page.waitForTimeout(160);
  const navVertical = await control();
  record("trackpad: vertical two-finger scroll orbits too", navVertical.debug.orbits > navHorizontal.debug.orbits, {
    before: navHorizontal.debug.orbits,
    after: navVertical.debug.orbits,
  });

  await dispatchWheel({ deltaX: -60, deltaY: -40, shiftKey: true });
  await page.waitForTimeout(160);
  const navShift = await control();
  record("trackpad: Shift + two fingers pans", navShift.debug.pans > navVertical.debug.pans, {
    before: navVertical.debug.pans,
    after: navShift.debug.pans,
  });

  await dispatchWheel({ deltaY: -140, ctrlKey: true });
  await page.waitForTimeout(140);
  const navPinch = await control();
  record(
    "trackpad: Ctrl + wheel pinch-zooms at the cursor",
    navPinch.debug.zooms > navShift.debug.zooms && navPinch.debug.pinches > navShift.debug.pinches,
    { zooms: [navShift.debug.zooms, navPinch.debug.zooms], pinches: [navShift.debug.pinches, navPinch.debug.pinches] },
  );

  // Optional Shapr3D scheme: two fingers pan, Shift + two fingers orbit.
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="ns-trackpad"][value="pan"]');
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const panSchemeStart = await control();
  await dispatchWheel({ deltaX: 30, deltaY: 70 });
  await page.waitForTimeout(200);
  const panScheme = await control();
  record(
    "trackpad: Pan scheme makes two fingers pan",
    panScheme.debug.pans > panSchemeStart.debug.pans &&
      panScheme.debug.orbits === panSchemeStart.debug.orbits &&
      panScheme.state.nav.trackpadScheme === "pan",
    { pans: [panSchemeStart.debug.pans, panScheme.debug.pans], orbits: [panSchemeStart.debug.orbits, panScheme.debug.orbits] },
  );
  await page.waitForTimeout(900);
  const panShiftStart = await control();
  await dispatchWheel({ deltaX: 30, deltaY: 70, shiftKey: true });
  await page.waitForTimeout(200);
  const panShift = await control();
  record(
    "trackpad: Pan scheme + Shift orbits",
    panShift.debug.orbits > panShiftStart.debug.orbits && panShift.debug.pans === panShiftStart.debug.pans,
    { pans: [panShiftStart.debug.pans, panShift.debug.pans], orbits: [panShiftStart.debug.orbits, panShift.debug.orbits] },
  );
  await page.evaluate(() => {
    const radio = document.querySelector('input[name="ns-trackpad"][value="orbit"]');
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // Two-finger pan + pinch through the real touch pointer path.
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 21, x: 500, y: 400 });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 22, isPrimary: false, x: 700, y: 400 });
  await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 21, x: 470, y: 470 });
  await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 22, isPrimary: false, x: 760, y: 470 });
  await page.waitForTimeout(120);
  const touchGesture = await control();
  record(
    "touch: two fingers pan and pinch together",
    touchGesture.debug.pans > navPinch.debug.pans && touchGesture.debug.pinches > navPinch.debug.pinches,
    { pans: [navPinch.debug.pans, touchGesture.debug.pans], pinches: [navPinch.debug.pinches, touchGesture.debug.pinches] },
  );
  await dispatchPointer("pointerup", { pointerType: "touch", pointerId: 21, buttons: 0, x: 470, y: 470 });
  await dispatchPointer("pointerup", { pointerType: "touch", pointerId: 22, isPrimary: false, buttons: 0, x: 760, y: 470 });

  // Pen: dead-zone, no camera movement, selection still works.
  await page.click('[data-control-mode="pen"]');
  await page.waitForTimeout(120);
  const penStart = await control();
  await dispatchPointer("pointerdown", { pointerType: "pen", x: 420, y: 330 });
  await dispatchPointer("pointermove", { pointerType: "pen", x: 422, y: 332 });
  const penDead = await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.penArmed));
  await dispatchPointer("pointermove", { pointerType: "pen", x: 520, y: 400 });
  const penArmed = await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.penArmed));
  await dispatchPointer("pointerup", { pointerType: "pen", buttons: 0, x: 520, y: 400 });
  await page.waitForTimeout(100);
  const penAfter = await control();
  record(
    "pen: 4 px dead-zone, drag never orbits the camera",
    penDead === false && penArmed === true && penAfter.debug.orbits === penStart.debug.orbits && penAfter.debug.penDown > penStart.debug.penDown,
    { penDead, penArmed, orbits: [penStart.debug.orbits, penAfter.debug.orbits], penDown: penAfter.debug.penDown },
  );

  // Navigation preferences survive a reload (speed + inverted orbit X).
  await page.evaluate(() => {
    const speed = document.querySelector("#ns-speed");
    speed.value = "1.6";
    speed.dispatchEvent(new Event("input", { bubbles: true }));
    const invert = document.querySelector("#ns-invert-x");
    invert.checked = true;
    invert.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const storedNav = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("marmaracad.navigation") ?? "null");
    } catch {
      return null;
    }
  });
  record("navigation: settings are written to localStorage", Boolean(storedNav) && Math.abs(storedNav.speed - 1.6) < 1e-9 && storedNav.invertOrbitX === true, {
    storedNav,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__marmaracad?.app?.editor), null, { timeout: 180000 });
  await page.waitForTimeout(500);
  const restoredNav = await page.evaluate(() => window.__marmaracad.app.viewport.getNavigationSettings());
  record(
    "navigation: speed, damping and invert flags survive the reload",
    Math.abs(restoredNav.speed - 1.6) < 1e-9 && restoredNav.invertOrbitX === true && restoredNav.trackpadScheme === "orbit",
    restoredNav,
  );
  await page.evaluate(() => {
    const speed = document.querySelector("#ns-speed");
    speed.value = "1";
    speed.dispatchEvent(new Event("input", { bubbles: true }));
    const invert = document.querySelector("#ns-invert-x");
    invert.checked = false;
    invert.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(150);

  // ------------------------------------------------------------ 2. push/pull
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, -40, -30);
  await sketchClick(page, 40, 30);
  await finishSketch(page);
  await extrude(page, { depth: 20, operation: "new" });
  await waitVolume(page, "v > 90000");
  const baseVolume = await page.evaluate(() => window.__marmaracad.meshes().get(window.__marmaracad.doc().parts[0].id).volume);
  check("push/pull block is 80 x 60 x 20", baseVolume, 80 * 60 * 20, 0.5);

  // Pen selects the cap without orbiting (Shapr3D tap-to-select).
  const cap = await selectCap(false);
  await page.evaluate((c) => {
    const vp = window.__marmaracad.app.viewport;
    vp.normalTo(c.point, c.normal);
  }, cap);
  await page.waitForTimeout(600);
  const capScreen = await page.evaluate((c) => {
    const vp = window.__marmaracad.app.viewport;
    // dispatchPointer adds the canvas rect itself, so keep this canvas-local.
    return vp.projectToScreen(c.point);
  }, cap);
  const penOrbitsBefore = (await control()).debug.orbits;
  await dispatchPointer("pointerdown", { pointerType: "pen", x: capScreen.x, y: capScreen.y });
  await dispatchPointer("pointerup", { pointerType: "pen", buttons: 0, x: capScreen.x, y: capScreen.y });
  await page.waitForTimeout(200);
  const penPick = await page.evaluate(() => {
    const app = window.__marmaracad;
    return { faces: app.selections().faces.length, gizmo: app.app.viewport.getActiveGizmo(), orbits: app.app.viewport.debugControl.orbits };
  });
  record(
    "pen: tapping a planar face selects it and shows the push/pull arrow",
    penPick.faces === 1 && penPick.gizmo?.kind === "face" && penPick.orbits === penOrbitsBefore,
    { faces: penPick.faces, gizmoKind: penPick.gizmo?.kind, orbits: [penOrbitsBefore, penPick.orbits] },
  );

  // Drag +15 mm in the isometric view.
  await page.evaluate(() => window.__marmaracad.app.viewport.setView("iso", false));
  await page.waitForTimeout(350);
  const gizmoExists = await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.gizmo));
  if (!gizmoExists) await page.evaluate((c) => window.__marmaracad.app.handleFacePick({ componentId: null, partId: c.partId, faceIndex: c.faceIndex, face: window.__marmaracad.meshes().get(c.partId).faces.find((f) => f.index === c.faceIndex) }), cap);
  const pull = await dragFaceGizmo(15);
  record("push/pull: live label reports +15 mm", /\+\s?1[45](\.\d)?\s*mm/.test(pull.label ?? ""), {
    label: pull.label,
    dragFrames: pull.drags,
  });
  await waitVolume(page, "v > 160000 && v < 176000");
  const pulled = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    return {
      volume: mesh.volume,
      faces: mesh.faces.length,
      features: part.features.map((f) => ({ type: f.type, depth: f.params.depth, pushPull: f.params.pushPull, direction: f.params.direction })),
      sketches: part.sketches.length,
    };
  });
  check("push/pull +15 mm adds 80 x 60 x 15 of volume", pulled.volume, baseVolume + 80 * 60 * 15, 0.6);
  record(
    "push/pull becomes a parametric boss feature on the tree",
    pulled.features.length === 2 && pulled.features[1].pushPull === true && Math.abs(pulled.features[1].depth - 15) < 0.2,
    pulled.features,
  );

  // Three-finger swipe: undo / redo the pull.
  await threeFingerSwipe(-150);
  await waitVolume(page, "v < 100000");
  const afterSwipeUndo = await featureCount(page);
  await threeFingerSwipe(150);
  await waitVolume(page, "v > 160000");
  const afterSwipeRedo = await featureCount(page);
  record("touch: three-finger swipe left/right undoes and redoes", afterSwipeUndo === 1 && afterSwipeRedo === 2, {
    afterUndo: afterSwipeUndo,
    afterRedo: afterSwipeRedo,
  });

  // Inward drag = cut. The boolean may have split the pulled cap into coplanar
  // faces, so the exact cut volume follows the picked face's area.
  const cap2 = await selectCap(true);
  await page.waitForTimeout(200);
  const cut = await dragFaceGizmo(-5);
  const expectedCut = pulled.volume - cap2.area * 5;
  record("push/pull: dragging inwards previews a negative distance", /-\s?[45](\.\d)?\s*mm/.test(cut.label ?? ""), { label: cut.label });
  await waitVolume(page, `Math.abs(v - ${expectedCut}) < ${Math.max(400, expectedCut * 0.01)}`);
  const cutState = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    const last = part.features[part.features.length - 1];
    return { volume: mesh.volume, type: last.type, depth: last.params.depth, direction: last.params.direction, pushPull: last.params.pushPull };
  });
  check("push/pull -5 mm cuts the picked face area", cutState.volume, expectedCut, 0.8, { faceArea: cap2.area });
  record("push/pull inward creates a cut feature", cutState.type === "cut" && cutState.direction === -1 && cutState.pushPull === true, cutState);

  // Enter-by-value path.
  await page.keyboard.press("Control+z");
  await waitVolume(page, "v > 160000");
  await page.keyboard.press("Control+z");
  await waitVolume(page, "v < 100000");
  const undoneVolume = await page.evaluate(() => window.__marmaracad.meshes().get(window.__marmaracad.doc().parts[0].id).volume);
  const undoneFeatures = await featureCount(page);
  record("Ctrl+Z twice restores the block", undoneFeatures === 1 && Math.abs(undoneVolume - baseVolume) < 400, {
    features: undoneFeatures,
    volume: undoneVolume,
  });

  await selectCap(true);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));
  await page.keyboard.press("Enter");
  await page.waitForSelector("#pm-pushpull-distance", { timeout: 15000 });
  await page.fill("#pm-pushpull-distance", "5");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "v > 115000 && v < 125000");
  check("enter value: +5 mm boss from the keyboard", await page.evaluate(() => window.__marmaracad.meshes().get(window.__marmaracad.doc().parts[0].id).volume), baseVolume + 80 * 60 * 5, 0.6);
  await page.keyboard.press("Control+z");
  await waitVolume(page, "v < 100000");

  // Edge handle: fillet / chamfer by dragging the blue knob.
  const edgeInfo = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    const n = part.sketches[0].plane.n;
    let best = -1;
    let bestScore = -1;
    mesh.edges.forEach((edge, index) => {
      if (edge.points.length < 2) return;
      const a = edge.points[0];
      const b = edge.points[edge.points.length - 1];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const along = Math.abs((dx * n[0] + dy * n[1] + dz * n[2]) / len);
      if (along < 0.99 || Math.abs(len - 20) > 0.2) return;
      const score = Math.abs(a[0]) + Math.abs(a[1]);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best < 0) return null;
    app.app.handleEdgePick({ componentId: null, partId: part.id, edgeIndex: best, edge: mesh.edges[best] });
    return { index: best, length: mesh.edges[best].length };
  });
  await page.waitForTimeout(250);
  const edgeGizmoKind = await page.evaluate(() => window.__marmaracad.app.viewport.getActiveGizmo()?.kind ?? null);
  record("edge handle: selecting a vertical edge shows the fillet knob", edgeInfo !== null && edgeGizmoKind === "edge", { edgeInfo, edgeGizmoKind });
  const filletDrag = await dragEdgeGizmo(6);
  record("edge handle: dragging previews R6", /R\s?6(\.\d)?/.test(filletDrag.label ?? ""), { label: filletDrag.label });
  await waitFeatureCount(page, 2);
  await waitVolume(page, "v > 95200 && v < 96000");
  const filletState = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const last = part.features[part.features.length - 1];
    return { volume: app.meshes().get(part.id).volume, type: last.type, radius: last.params.radius };
  });
  check("edge handle: R6 fillet removes (r² - πr²/4) · 20 mm³", filletState.volume, baseVolume - (36 - Math.PI * 9) * 20, 0.6);
  record("edge handle: the drag creates a parametric fillet feature", filletState.type === "fillet" && Math.abs(filletState.radius - 6) < 0.2, filletState);

  // ---------------------------------------------------------- 3. sheet metal
  await newDocument(page);
  await startSketch(page, "top");
  await setTool(page, "rectangle");
  await sketchClick(page, -60, -40);
  await sketchClick(page, 60, 40);
  await finishSketch(page);

  await page.click('[data-cmd-tab="sheetmetal"]');
  const tabActive = await page.evaluate(() => document.querySelector('[data-cmd-tab="sheetmetal"]')?.classList.contains("active") ?? false);
  record("sheet metal: CommandManager tab exists and activates", tabActive);
  await page.click('[data-cmd-action="base-flange"]');
  await page.waitForSelector("#pm-sheet-thickness", { timeout: 20000 });
  await page.fill("#pm-sheet-thickness", "2");
  await page.fill("#pm-sheet-radius", "2");
  await page.fill("#pm-sheet-k", "0.44");
  await page.click("[data-pm-ok]");
  await waitFeatureCount(page, 1);
  await waitVolume(page, "v > 18000");
  const baseFlange = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    return {
      volume: app.meshes().get(part.id).volume,
      sheetMetal: part.sheetMetal,
      features: part.features.map((f) => f.type),
    };
  });
  check("base flange: 120 x 80 plate at t = 2", baseFlange.volume, 120 * 80 * 2, 0.5);
  record(
    "base flange stores t = 2, R = 2, K = 0.44",
    baseFlange.sheetMetal.thickness === 2 && baseFlange.sheetMetal.radius === 2 && Math.abs(baseFlange.sheetMetal.kFactor - 0.44) < 1e-9 && baseFlange.features[0] === "baseFlange",
    { sheetMetal: baseFlange.sheetMetal, features: baseFlange.features },
  );

  const edgeIndex = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    const maxX = mesh.bbox.max[0];
    const maxY = mesh.bbox.max[1];
    return mesh.edges.findIndex((e) => e.points.every((p) => Math.abs(p[0] - maxX) < 0.05 && Math.abs(p[1] - maxY) < 0.05));
  });
  record("sheet metal: right-hand top edge found", edgeIndex >= 0, { edgeIndex });
  await page.evaluate((index) => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    app.app.handleEdgePick({ componentId: null, partId: part.id, edgeIndex: index, edge: mesh.edges[index] });
  }, edgeIndex);
  await page.waitForTimeout(150);

  await page.click('[data-cmd-tab="sheetmetal"]');
  await page.click('[data-cmd-action="edge-flange"]');
  await page.waitForSelector("#pm-flange-angle", { timeout: 20000 });
  await page.fill("#pm-flange-angle", "90");
  await page.fill("#pm-flange-length", "20");
  await page.fill("#pm-flange-radius", "2");
  await page.fill("#pm-flange-k", "0.44");
  await page.click("[data-pm-ok]");
  await waitFeatureCount(page, 2);
  await page.waitForTimeout(600);
  const bent = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    return { volume: mesh.volume, sheetMetal: part.sheetMetal, features: part.features.map((f) => f.type) };
  });
  const flange = bent.sheetMetal.flanges[0];
  record(
    "edge flange: 90 deg, 20 mm, R2 is stored with its blank placement",
    flange && flange.angle === 90 && flange.length === 20 && flange.side === "right" && Math.abs(flange.from + 40) < 0.05 && Math.abs(flange.to - 40) < 0.05,
    { flange, features: bent.features },
  );
  record("edge flange adds material to the bent body", bent.volume > baseFlange.volume + 1000, { base: baseFlange.volume, bent: bent.volume });

  // K-factor flat pattern: BA = (pi/180) * 90 * (R + K t).
  const BA = (Math.PI / 180) * 90 * (2 + 0.44 * 2);
  const expectedFlat = (120 * 80 + (20 + BA) * 80) * 2;
  await page.click('[data-cmd-tab="sheetmetal"]');
  await runCmd(page, "flatten");
  await page.waitForFunction(() => window.__marmaracad.doc().parts[0].sheetMetal.flattened === true, null, { timeout: 30000 });
  await waitVolume(page, `Math.abs(v - ${expectedFlat}) < 60`);
  const flat = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const vp = app.app.viewport;
    const line = vp.bendGroup?.children?.[0];
    return {
      volume: app.meshes().get(part.id).volume,
      bendLines: vp.hasBendLines(),
      bendVertices: line?.geometry?.attributes?.position?.count ?? 0,
      material: line?.material?.type ?? null,
    };
  });
  check("flatten: developed volume uses BA = (pi/180) * theta * (R + K t)", flat.volume, expectedFlat, 0.6);
  record(
    "flatten: bend lines are drawn as dashed segments (WebGPU-safe)",
    flat.bendLines === true && flat.bendVertices > 20 && flat.material === "LineBasicMaterial",
    flat,
  );

  // DXF download.
  const dxfWait = page.waitForEvent("download", { timeout: 60000 });
  await page.click('[data-cmd-tab="sheetmetal"]');
  await page.click('[data-cmd-action="export-dxf"]');
  const dxfDownload = await dxfWait;
  const dxfPath = await dxfDownload.path();
  const dxf = fs.readFileSync(dxfPath, "utf8");
  const developedMaxX = (60 + 20 + BA).toFixed(4);
  const dxfChecks = {
    name: dxfDownload.suggestedFilename(),
    bytes: dxf.length,
    header: dxf.startsWith("0\r\nSECTION"),
    version: dxf.includes("AC1009"),
    outline: dxf.includes("OUTLINE"),
    bendLayer: dxf.includes("BEND") && dxf.includes("DASHED"),
    developedMaxX,
    hasDevelopedExtent: dxf.includes(developedMaxX),
    lines: (dxf.match(/\r\nLINE\r\n/g) ?? []).length,
    eof: dxf.trimEnd().endsWith("EOF"),
    sectionsBalanced: (dxf.match(/SECTION/g) ?? []).length === (dxf.match(/ENDSEC/g) ?? []).length,
    ascii: /^[\x09\x0A\x0D\x20-\x7E]*$/.test(dxf),
  };
  record(
    "DXF: valid R12 file with developed outline and bend lines",
    dxfChecks.name.endsWith("-flat.dxf") &&
      dxfChecks.header &&
      dxfChecks.version &&
      dxfChecks.outline &&
      dxfChecks.bendLayer &&
      dxfChecks.hasDevelopedExtent &&
      dxfChecks.lines >= 9 &&
      dxfChecks.eof &&
      dxfChecks.sectionsBalanced &&
      dxfChecks.ascii,
    dxfChecks,
  );

  const sheetFile = await saveProjectAs("SheetMetalPhase4");
  const savedPart = sheetFile.document.parts[0];
  record(
    ".mcad.json keeps the sheet-metal state and flanges",
    savedPart.sheetMetal?.thickness === 2 &&
      savedPart.sheetMetal?.flanges?.length === 1 &&
      Math.abs(savedPart.sheetMetal.kFactor - 0.44) < 1e-9 &&
      savedPart.features.some((f) => f.type === "baseFlange") &&
      savedPart.features.some((f) => f.type === "edgeFlange"),
    { sheetMetal: savedPart.sheetMetal, features: savedPart.features.map((f) => f.type) },
  );

  // ---------------------------------------------------------- 3b. AI bridge
  await newDocument(page);
  await startSketch(page, "top");
  await setTool(page, "rectangle");
  await sketchClick(page, -50, -30);
  await sketchClick(page, 50, 30);
  await finishSketch(page);
  const aiSheet = await page.evaluate(async () => {
    const app = window.__marmaracad.app;
    await app.applyAiCommands(
      [{ action: "sheet-metal-flange", params: { thickness: 1.5, radius: 2, kFactor: 0.4, angle: 90, length: 12, width: 30 } }],
      "AI sheet metal",
    );
    const part = window.__marmaracad.doc().parts[0];
    const mesh = window.__marmaracad.meshes().get(part.id);
    return {
      features: part.features.map((f) => ({ type: f.type, error: f.error ?? null })),
      flanges: part.sheetMetal?.flanges.length ?? 0,
      thickness: part.sheetMetal?.thickness,
      volume: mesh?.volume ?? 0,
    };
  });
  record(
    "AI: sheet-metal-flange builds a base flange plus a 90° edge flange",
    aiSheet.features[0]?.type === "baseFlange" &&
      aiSheet.features.some((f) => f.type === "edgeFlange") &&
      aiSheet.flanges === 1 &&
      aiSheet.thickness === 1.5 &&
      aiSheet.features.every((f) => !f.error) &&
      aiSheet.volume > 9000,
    aiSheet,
  );
  const aiFlat = await page.evaluate(async () => {
    await window.__marmaracad.app.applyAiCommands([{ action: "flatten", params: { enabled: true } }], "AI flatten");
    const app = window.__marmaracad;
    return {
      flattened: app.doc().parts[0].sheetMetal?.flattened,
      bendLines: app.app.viewport.hasBendLines(),
      volume: app.meshes().get(app.doc().parts[0].id)?.volume ?? 0,
    };
  });
  record("AI: flatten toggles the K-factor flat pattern with dashed bend lines", aiFlat.flattened === true && aiFlat.bendLines === true, aiFlat);

  // ------------------------------------------------------- 4. configurations
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, -40, -30);
  await sketchClick(page, 40, 30);
  await finishSketch(page);
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="extrude-boss"]');
  await page.waitForSelector("#pm-depth", { timeout: 20000 });
  await page.fill("#pm-depth", "10");
  await page.fill("#pm-depth-expression", "D");
  await page.click("[data-pm-ok]");
  await waitFeatureCount(page, 1);
  await waitVolume(page, "v > 45000 && v < 51000");

  await page.click('[data-tree-action="configuration-add"]');
  await page.waitForSelector("#pm-config-vars", { timeout: 15000 });
  await page.fill("#pm-config-vars", "D = 10");
  await page.click("[data-pm-ok]");
  await page.waitForFunction(() => window.__marmaracad.doc().parts[0].configurations?.length === 1, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const configDefault = await page.evaluate(() => {
    const part = window.__marmaracad.doc().parts[0];
    return { configs: part.configurations, active: part.activeConfigurationId, volume: window.__marmaracad.meshes().get(part.id).volume };
  });
  check("configurations: Default keeps D = 10", configDefault.volume, 48000, 0.6);
  record("configurations: Default is a named variant", configDefault.configs[0].name === "Default" && configDefault.configs[0].variables.D === "10", configDefault.configs[0]);

  await page.click('[data-tree-action="configuration-add"]');
  await page.waitForSelector("#pm-config-vars", { timeout: 15000 });
  await page.click("[data-config-add]");
  await page.waitForFunction(() => window.__marmaracad.doc().parts[0].configurations?.length === 2, null, { timeout: 30000 });
  await page.waitForSelector("#pm-config-vars", { timeout: 15000 });
  await page.fill("#pm-config-vars", "D = 30");
  await page.click("[data-pm-ok]");
  await waitVolume(page, "v > 140000");
  const longConfig = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    return {
      volume: app.meshes().get(part.id).volume,
      active: part.activeConfigurationId,
      configs: part.configurations.map((c) => ({ id: c.id, name: c.name, variables: c.variables })),
      depth: part.features[0].params.depth,
      mass: document.getElementById("mass-card")?.textContent ?? "",
    };
  });
  check("configurations: D = 30 rebuilds the model to 144000 mm3", longConfig.volume, 144000, 0.6);
  record(
    "configurations: activation rewrites the global variable and the feature depth",
    Math.abs(longConfig.depth - 30) < 0.01 && longConfig.configs.length === 2,
    { depth: longConfig.depth, configs: longConfig.configs },
  );
  record("configurations: Mass Properties follow the active variant", /144000|144 000/.test(longConfig.mass), { mass: longConfig.mass.slice(0, 200) });

  // Double-click the Default row in the tree: back to D = 10.
  const defaultId = longConfig.configs.find((c) => c.name === "Default").id;
  const longId = longConfig.configs.find((c) => c.name !== "Default").id;
  await page.dblclick(`[data-key="configuration:${defaultId}"]`);
  await waitVolume(page, "v < 55000");
  const backToDefault = await page.evaluate(() => ({ volume: window.__marmaracad.meshes().get(window.__marmaracad.doc().parts[0].id).volume, active: window.__marmaracad.doc().parts[0].activeConfigurationId }));
  record("configurations: double-clicking Default rebuilds to the short variant", backToDefault.active === defaultId && Math.abs(backToDefault.volume - 48000) < 400, backToDefault);

  await page.dblclick(`[data-key="configuration:${longId}"]`);
  await waitVolume(page, "v > 140000");
  const backToLong = await page.evaluate(() => ({ volume: window.__marmaracad.meshes().get(window.__marmaracad.doc().parts[0].id).volume, active: window.__marmaracad.doc().parts[0].activeConfigurationId }));
  record("configurations: double-clicking the long variant restores 144000 mm3", backToLong.active === longId && Math.abs(backToLong.volume - 144000) < 600, backToLong);

  const configFile = await saveProjectAs("ConfigurationsPhase4");
  const savedConfigs = configFile.document.parts[0];
  record(
    ".mcad.json stores every configuration with its variables",
    savedConfigs.configurations?.length === 2 &&
      savedConfigs.activeConfigurationId === longId &&
      savedConfigs.configurations.every((c) => typeof c.variables.D === "string"),
    { configurations: savedConfigs.configurations?.map((c) => ({ name: c.name, variables: c.variables })), active: savedConfigs.activeConfigurationId },
  );

  // AI bridge: configuration and push-pull actions reuse the same logic.
  const aiConfig = await page.evaluate(async () => {
    const app = window.__marmaracad.app;
    await app.applyAiCommands([{ action: "configuration", params: { name: "AI 24", copyFrom: "Default", variables: { D: "24" } } }], "AI configuration");
    const doc = window.__marmaracad.doc();
    const part = doc.parts[0];
    return {
      volume: window.__marmaracad.meshes().get(part.id)?.volume ?? 0,
      active: part.configurations?.find((c) => c.id === part.activeConfigurationId)?.name,
      count: part.configurations?.length ?? 0,
      depth: part.features[0]?.params.depth,
    };
  });
  check("AI: configuration creates and activates a variant", aiConfig.volume, 80 * 60 * 24, 0.6, aiConfig);
  record("AI: the new configuration is named and active", aiConfig.active === "AI 24" && aiConfig.count === 3 && Math.abs(aiConfig.depth - 24) < 0.01, aiConfig);

  const aiPush = await page.evaluate(async () => {
    const app = window.__marmaracad.app;
    const part = window.__marmaracad.doc().parts[0];
    const before = part.features.length;
    const volBefore = window.__marmaracad.meshes().get(part.id)?.volume ?? 0;
    await app.applyAiCommands([{ action: "push-pull", params: { distance: 5 } }], "AI push pull");
    const after = window.__marmaracad.doc().parts[0];
    const last = after.features[after.features.length - 1];
    return {
      before,
      after: after.features.length,
      volBefore,
      volAfter: window.__marmaracad.meshes().get(after.id)?.volume ?? 0,
      type: last.type,
      pushPull: last.params.pushPull === true,
      depth: last.params.depth,
      error: last.error ?? null,
    };
  });
  record(
    "AI: push-pull adds a direct-edit feature and more volume",
    aiPush.after === aiPush.before + 1 && aiPush.pushPull && aiPush.volAfter > aiPush.volBefore + 100 && !aiPush.error,
    aiPush,
  );

  // ----------------------------------------------------- 5. live assembly drag
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "circle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 10, 0);
  await finishSketch(page);
  await extrude(page, { depth: 50, operation: "new" });
  await waitVolume(page, "v > 15000");

  await page.click('[data-cmd-tab="assembly"]');
  await page.click('[data-cmd-action="insert-component"]');
  await page.waitForSelector("#insert-qty", { timeout: 15000 });
  await page.fill("#insert-qty", "2");
  await page.click(".modal-foot .btn.primary");
  await page.waitForFunction(() => window.__marmaracad.doc().components.length === 2, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const components = await page.evaluate(() => window.__marmaracad.doc().components.map((c) => ({ id: c.id, fixed: c.fixed })));
  const movingId = components.find((c) => !c.fixed).id;

  // Separate B along the cylinder axis, then mate it concentric with A.
  await page.dblclick(`[data-key="component:${movingId}"]`);
  await page.waitForSelector("#pm-tz", { timeout: 15000 });
  await page.fill("#pm-tx", "0");
  await page.fill("#pm-ty", "0");
  await page.fill("#pm-tz", "100");
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(400);

  const faceIndices = await page.evaluate(() => {
    const app = window.__marmaracad;
    const part = app.doc().parts[0];
    const mesh = app.meshes().get(part.id);
    return {
      partId: part.id,
      cylinder: mesh.faces.findIndex((f) => f.surface === "cylinder"),
      faces: mesh.faces.map((f, i) => ({ i, surface: f.surface, normal: f.normal, point: f.point })),
    };
  });
  await page.click('[data-cmd-tab="assembly"]');
  await page.click('[data-cmd-action="mate-concentric"]');
  await page.waitForSelector("#pm-mate-picks", { timeout: 20000 });
  const fixedId = components.find((c) => c.fixed).id;
  for (const componentId of [fixedId, movingId]) {
    await page.evaluate(
      ({ faceIndex, partId, componentId }) => {
        const mesh = window.__marmaracad.meshes().get(partId);
        window.__marmaracad.app.command.onFace({ componentId, partId, faceIndex, face: mesh.faces[faceIndex] });
      },
      { faceIndex: faceIndices.cylinder, partId: faceIndices.partId, componentId },
    );
  }
  await page.waitForTimeout(200);
  await page.click("[data-pm-ok]");
  await page.waitForFunction(() => window.__marmaracad.doc().mates.length === 1, null, { timeout: 30000 });
  await page.waitForTimeout(500);

  const mate = await page.evaluate(() => window.__marmaracad.doc().mates[0]);
  const worldFace = (component, ref) => {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((component.rotation[0] * Math.PI) / 180, (component.rotation[1] * Math.PI) / 180, (component.rotation[2] * Math.PI) / 180, "XYZ"),
    );
    return {
      point: new THREE.Vector3(...ref.point).applyQuaternion(q).add(new THREE.Vector3(...component.position)),
      axis: new THREE.Vector3(...(ref.axis ?? ref.normal)).applyQuaternion(q).normalize(),
    };
  };
  const radialResidual = (mateRef, componentList) => {
    const byId = new Map(componentList.map((c) => [c.id, c]));
    const a = worldFace(byId.get(mateRef.a.componentId), mateRef.a);
    const b = worldFace(byId.get(mateRef.b.componentId), mateRef.b);
    const delta = b.point.clone().sub(a.point);
    return {
      axisCross: new THREE.Vector3().crossVectors(a.axis, b.axis).length(),
      radial: delta.clone().sub(a.axis.clone().multiplyScalar(delta.dot(a.axis))).length(),
    };
  };
  const initial = await page.evaluate(() => window.__marmaracad.doc().components);
  const initialResidual = radialResidual(mate, initial);
  record("live drag: concentric mate is solved before the drag", initialResidual.axisCross < 1e-3 && initialResidual.radial < 0.1, initialResidual);

  // Front-facing cylinder point on the moving component.
  const dragPoint = await page.evaluate(
    ({ movingId: id, faces }) => {
      const app = window.__marmaracad;
      const vp = app.app.viewport;
      vp.setView("iso", false);
      const component = app.doc().components.find((c) => c.id === id);
      const camera = vp.camera.position;
      let best = null;
      for (const face of faces) {
        if (face.surface !== "cylinder") continue;
        const world = [component.position[0] + face.point[0], component.position[1] + face.point[1], component.position[2] + face.point[2]];
        const toCamera = [camera.x - world[0], camera.y - world[1], camera.z - world[2]];
        const score = face.normal[0] * toCamera[0] + face.normal[1] * toCamera[1] + face.normal[2] * toCamera[2];
        if (!best || score > best.score) best = { score, world };
      }
      const p = vp.projectToScreen(best.world);
      const rect = vp.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + p.x, y: rect.top + p.y, world: best.world, score: best.score };
    },
    { movingId, faces: faceIndices.faces },
  );
  await page.waitForTimeout(350);

  const startPosition = await page.evaluate((id) => [...window.__marmaracad.doc().components.find((c) => c.id === id).position], movingId);
  await page.mouse.move(dragPoint.x, dragPoint.y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  const dragStarted = await page.evaluate(() => Boolean(window.__marmaracad.app.viewport.dragComponent));
  const samples = [];
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(dragPoint.x + (90 * i) / 6, dragPoint.y + (60 * i) / 6);
    await page.waitForTimeout(45);
    const state = await page.evaluate(() => window.__marmaracad.doc().components);
    samples.push({ ...radialResidual(mate, state), position: state.find((c) => !c.fixed).position });
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const finalState = await page.evaluate(() => {
    const app = window.__marmaracad;
    return { components: app.doc().components, mates: app.doc().mates, mode: app.doc().mode };
  });
  const finalResidual = radialResidual(mate, finalState.components);
  const moved = (() => {
    const position = finalState.components.find((c) => c.id === movingId).position;
    return Math.hypot(position[0] - startPosition[0], position[1] - startPosition[1], position[2] - startPosition[2]);
  })();
  const worstRadial = Math.max(...samples.map((s) => s.radial));
  const worstCross = Math.max(...samples.map((s) => s.axisCross));
  record("live drag: component drag path starts on a real pointerdown", dragStarted === true, { dragStarted });
  record("live drag: concentric mate holds every frame (radial residual)", worstRadial < 0.15 && worstCross < 1e-3, {
    worstRadial,
    worstCross,
    samples: samples.map((s) => Math.round(s.radial * 1000) / 1000),
  });
  record("live drag: the free component still moves along the free DOF", moved > 0.5 && finalResidual.radial < 0.15, {
    moved: Math.round(moved * 100) / 100,
    finalRadial: finalResidual.radial,
    finalCross: finalResidual.axisCross,
  });

  record("phase 4: no console or page errors", errors.length === 0, { errors: errors.slice(0, 6) });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`RESULT ${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
  for (const failure of failed) console.log("  failed:", failure.name);
  await browser.close();
  if (failed.length) process.exit(1);
}
