/* Control-mode regression: Mouse (SolidWorks / Fusion / Ansys), Trackpad and
 * Pen. Verifies the persisted mode, the mouse presets and the pointer paths
 * through the live viewport debug counters. */
import { launch, openApp, newDocument, reload } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser, { width: 1440, height: 900 });
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const control = () =>
  page.evaluate(() => {
    const vp = window.__marmaracad.app.viewport;
    return {
      state: vp.getControlState(),
      debug: { ...vp.debugControl },
      storedMode: localStorage.getItem("marmaracad.controlMode"),
      storedPreset: localStorage.getItem("marmaracad.mousePreset"),
      stored: window.__marmaracad.control ? window.__marmaracad.control() : null,
      active: document.querySelector("[data-control-mode].active")?.dataset.controlMode ?? null,
    };
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
      const event = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: init.pointerId ?? 1,
        pointerType: init.pointerType ?? "mouse",
        isPrimary: init.isPrimary ?? true,
        clientX: rect.left + (init.x ?? rect.width / 2),
        clientY: rect.top + (init.y ?? rect.height / 2),
        button: init.button ?? 0,
        buttons: init.buttons ?? 1,
        ctrlKey: init.ctrlKey ?? false,
        shiftKey: init.shiftKey ?? false,
      });
      canvas.dispatchEvent(event);
    },
    { type, init },
  );

try {
  await newDocument(page);
  await page.waitForTimeout(300);

  // --- Mouse, SolidWorks -----------------------------------------------------
  await page.click('[data-control-mode="mouse"]');
  await page.selectOption("#mouse-preset", "solidworks");
  const box = await canvasBox();
  const before = await control();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await page.waitForTimeout(120);
  const afterOrbit = await control();
  record("mouse/solidworks: middle drag orbits", afterOrbit.debug.orbits > before.debug.orbits, {
    before: before.debug.orbits,
    after: afterOrbit.debug.orbits,
  });

  await page.keyboard.down("Control");
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + box.width / 2 - 50, box.y + box.height / 2 - 20, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  await page.keyboard.up("Control");
  await page.waitForTimeout(120);
  const afterPan = await control();
  record("mouse/solidworks: Ctrl+middle drag pans", afterPan.debug.pans > afterOrbit.debug.pans, {
    before: afterOrbit.debug.pans,
    after: afterPan.debug.pans,
  });

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(120);
  const afterZoom = await control();
  record("mouse: wheel zooms", afterZoom.debug.zooms > afterPan.debug.zooms, {
    before: afterPan.debug.zooms,
    after: afterZoom.debug.zooms,
  });

  // --- Mouse preset persistence --------------------------------------------
  await page.selectOption("#mouse-preset", "fusion");
  await page.waitForTimeout(80);
  const fusion = await control();
  record("mouse/fusion: preset saved", fusion.state.preset === "fusion" && fusion.storedPreset === "fusion", fusion.state);
  await page.selectOption("#mouse-preset", "ansys");
  await page.waitForTimeout(80);
  const ansys = await control();
  record("mouse/ansys: preset saved", ansys.state.preset === "ansys" && ansys.storedPreset === "ansys", ansys.state);

  // --- Trackpad -------------------------------------------------------------
  await page.click('[data-control-mode="trackpad"]');
  await page.waitForTimeout(100);
  const trackpadStart = await control();
  record("trackpad: mode selected and stored", trackpadStart.state.mode === "trackpad" && trackpadStart.storedMode === "trackpad", trackpadStart.state);
  await dispatchWheel({ deltaY: -120 });
  await page.waitForTimeout(80);
  const orbitWheel = await control();
  record("trackpad: two-finger scroll orbits", orbitWheel.debug.orbits > trackpadStart.debug.orbits, {
    before: trackpadStart.debug.orbits,
    after: orbitWheel.debug.orbits,
  });
  await dispatchWheel({ deltaY: -100, shiftKey: true });
  await page.waitForTimeout(80);
  const panWheel = await control();
  record("trackpad: Shift+scroll pans", panWheel.debug.pans > orbitWheel.debug.pans, {
    before: orbitWheel.debug.pans,
    after: panWheel.debug.pans,
  });
  await dispatchWheel({ deltaY: -80, ctrlKey: true });
  await page.waitForTimeout(80);
  const pinch = await control();
  record("trackpad: Ctrl+wheel pinch-zooms at the cursor", pinch.debug.zooms > panWheel.debug.zooms && pinch.debug.pinches > panWheel.debug.pinches, {
    zooms: [panWheel.debug.zooms, pinch.debug.zooms],
    pinches: [panWheel.debug.pinches, pinch.debug.pinches],
  });

  // --- Pen ------------------------------------------------------------------
  await page.click('[data-control-mode="pen"]');
  await page.waitForTimeout(100);
  const penStart = await control();
  await dispatchPointer("pointerdown", { pointerType: "pen", x: 400, y: 300 });
  await dispatchPointer("pointerup", { pointerType: "pen", x: 400, y: 300, buttons: 0 });
  await page.waitForTimeout(80);
  const penAfter = await control();
  record("pen: pen contact is tracked", penAfter.state.mode === "pen" && penAfter.debug.penDown > penStart.debug.penDown, {
    before: penStart.debug.penDown,
    after: penAfter.debug.penDown,
  });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 11, x: 500, y: 320 });
  await dispatchPointer("pointerdown", { pointerType: "touch", pointerId: 12, isPrimary: false, x: 620, y: 360 });
  await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 11, x: 470, y: 300 });
  await dispatchPointer("pointermove", { pointerType: "touch", pointerId: 12, isPrimary: false, x: 660, y: 380 });
  await page.waitForTimeout(80);
  const touch = await control();
  record("pen: two-finger touch orbit/pan/pinch path is live", touch.debug.touches >= 2, { touches: touch.debug.touches });

  // --- Persistence across reload -------------------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__marmaracad?.app?.editor), null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const restored = await control();
  record("persistence: pen mode survives reload", restored.state.mode === "pen" && restored.storedMode === "pen" && restored.active === "pen", {
    state: restored.state,
    stored: restored.storedMode,
    active: restored.active,
  });
  record("persistence: mouse preset survives reload", restored.state.preset === "ansys" && restored.storedPreset === "ansys", {
    state: restored.state,
    stored: restored.storedPreset,
  });

  record("control modes: no console or page errors", errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`RESULT ${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
  await browser.close();
  if (failed.length) process.exit(1);
}
