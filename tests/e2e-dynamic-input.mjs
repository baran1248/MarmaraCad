/* Dynamic Input (SolidWorks style).
 *
 * While a drawing tool is armed the numeric boxes track the pointer; typing a
 * value, Tab to the next box and Enter must draw exactly those dimensions and
 * leave driving dimensions/constraints behind. */
import { launch, openApp, newDocument, startSketch, sketchClick, sketchMove, setTool } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const sketch = () =>
  page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    return {
      points: s.points.map((p) => ({ id: p.id, x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })),
      lines: s.entities
        .filter((e) => e.kind === "line")
        .map((e) => {
          const a = pm.get(e.p1);
          const b = pm.get(e.p2);
          return {
            id: e.id,
            length: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null,
            angle: a && b ? (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI : null,
          };
        }),
      circles: s.entities.filter((e) => e.kind === "circle").map((e) => ({ id: e.id, radius: e.radius })),
      constraints: s.constraints.map((c) => ({ t: c.type, v: c.value, entity: c.entity })),
    };
  });
const dyn = () =>
  page.evaluate(() => {
    const root = document.querySelector(".dyn-input");
    if (!root || root.style.display === "none") return null;
    return {
      visible: true,
      fields: [...root.querySelectorAll(".dyn-field")].map((f) => ({
        label: f.querySelector(".dyn-label")?.textContent,
        value: f.querySelector(".dyn-value")?.textContent,
        unit: f.querySelector(".dyn-unit")?.textContent,
        active: f.classList.contains("active"),
      })),
    };
  });

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "line");

  // Line: 100 mm at 0°.
  await sketchClick(page, 0, 0);
  await sketchMove(page, 62, 31);
  const lineDyn = await dyn();
  record("Line tool shows live length/angle boxes", !!lineDyn && lineDyn.fields.length === 2, lineDyn ?? {});
  await page.keyboard.type("100");
  await page.keyboard.press("Tab");
  await page.keyboard.type("0");
  const typedBoxes = await dyn();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const afterLine = await sketch();
  const firstLine = afterLine.lines.at(-1);
  record(
    "Typed 100 / Tab / 0 draws an exact 100 mm horizontal line",
    afterLine.lines.length === 1 && Math.abs(firstLine.length - 100) < 1e-3 && Math.abs(firstLine.angle) < 1e-6,
    { line: firstLine, boxes: typedBoxes?.fields },
  );
  record(
    "Typed line gets driving distance + angle constraints",
    afterLine.constraints.some((c) => c.t === "distance" && Math.abs((c.v ?? 0) - 100) < 1e-3) &&
      afterLine.constraints.some((c) => c.t === "angle" && Math.abs((c.v ?? 0)) < 1e-6),
    { constraints: afterLine.constraints },
  );

  // The chain keeps drawing from the typed endpoint; finish the line chain.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Rectangle: 40 × 25 with typed values.
  await setTool(page, "rectangle");
  await sketchClick(page, 0, -20);
  await sketchMove(page, 23, -8);
  const rectDyn = await dyn();
  record("Rectangle tool shows width/height boxes", !!rectDyn && rectDyn.fields.length === 2 && rectDyn.fields[0].label === "W", rectDyn ?? {});
  await page.keyboard.type("40");
  await page.keyboard.press("Tab");
  await page.keyboard.type("25");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const afterRect = await sketch();
  const rectLines = afterRect.lines.slice(1);
  const rectWidth = rectLines.length === 4 ? Math.abs(rectLines[0].length ?? 0) : 0;
  const rectHeight = rectLines.length === 4 ? Math.abs(rectLines[1].length ?? 0) : 0;
  const distances = afterRect.constraints.filter((c) => c.t === "distance").map((c) => Math.abs(c.v ?? 0));
  record(
    "Typed 40 / Tab / 25 draws a 40 × 25 rectangle",
    afterRect.lines.length === 5 &&
      Math.abs(rectWidth - 40) < 1e-3 &&
      Math.abs(rectHeight - 25) < 1e-3 &&
      distances.some((d) => Math.abs(d - 40) < 1e-3) &&
      distances.some((d) => Math.abs(d - 25) < 1e-3),
    { width: rectWidth, height: rectHeight, lines: afterRect.lines.length, distances },
  );

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Circle: typed diameter becomes the radius constraint.
  await setTool(page, "circle");
  const center = await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const s = app.viewport.projectToScreen([30, 25, 0]);
    const rect = app.viewport.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + s.x, y: rect.top + s.y };
  });
  await page.mouse.click(center.x, center.y);
  await page.mouse.move(center.x + 70, center.y + 45);
  await page.keyboard.type("24");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const afterCircle = await sketch();
  const circle = afterCircle.circles.at(-1);
  record(
    "Typed 24 in the circle box creates an R12 circle",
    !!circle && Math.abs(circle.radius - 12) < 1e-3 && afterCircle.constraints.some((c) => c.t === "radius" && Math.abs((c.v ?? 0) - 12) < 1e-3),
    { circle },
  );

  // Esc hides the boxes and keeps the geometry.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const hidden = await dyn();
  record("Escape hides the dynamic input", hidden === null, { hidden });

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
