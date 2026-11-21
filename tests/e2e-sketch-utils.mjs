/* Sketch utilities: For Construction, Trim, Offset Entities and Convert Entities. */
import { launch, openApp, newDocument, startSketch, sketchClick, setTool } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const state = () =>
  page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    return {
      entities: s.entities.map((e) => {
        if (e.kind === "line") {
          const a = pm.get(e.p1);
          const b = pm.get(e.p2);
          return {
            id: e.id,
            kind: e.kind,
            construction: !!e.construction,
            length: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null,
            a: a ? [a.x, a.y] : null,
            b: b ? [b.x, b.y] : null,
          };
        }
        return { id: e.id, kind: e.kind, construction: !!e.construction, radius: e.radius };
      }),
      dashed: window.__marmaracad.app.editor.group.children.filter((c) => c.userData?.dashed || c.userData?.construction).length,
    };
  });
const selectBy = (predicate) =>
  page.evaluate((source) => {
    const editor = window.__marmaracad.app.editor;
    const fn = new Function("e", `return (${source})(e);`);
    editor.selectedEntities.clear();
    for (const e of editor.sketch.entities) if (fn(e)) editor.selectedEntities.add(e.id);
    editor.render();
    return [...editor.selectedEntities];
  }, predicate.toString());

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 24);
  await setTool(page, "select");

  // --- For Construction.
  const before = await state();
  const target = await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    const id = editor.sketch.entities[0].id;
    editor.selectedEntities.clear();
    editor.selectedEntities.add(id);
    editor.render();
    return id;
  });
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="sketch-construction"]');
  await page.waitForTimeout(200);
  const after = await state();
  const converted = after.entities.find((e) => e.id === target);
  record(
    "For Construction converts the selected entity to dashed construction geometry",
    before.entities[0].construction === false &&
      converted?.construction === true &&
      after.entities.filter((e) => e.construction).length === 1,
    { target, construction: converted?.construction, constructionCount: after.entities.filter((e) => e.construction).length },
  );
  await page.click('[data-cmd-action="sketch-construction"]');
  await page.waitForTimeout(150);
  record(
    "Toggling For Construction again returns the entity to solid geometry",
    (await state()).entities.every((e) => !e.construction),
    { construction: (await state()).entities.map((e) => e.construction) },
  );

  // --- Definition state colours: under defined → fully defined → over defined.
  const sketchStatus = () =>
    page.evaluate(() => {
      const item = document.querySelector(".status-item.sketch-state");
      const first = [...window.__marmaracad.app.editor.group.children].find(
        (c) => c.type === "Line" && c.material && c.material.color,
      );
      return {
        text: (item?.textContent ?? "").replace(/\s+/g, " ").trim(),
        cls: item?.className ?? "",
        color: first ? first.material.color.getHexString() : null,
      };
    });
  await setTool(page, "select");
  const under = await sketchStatus();
  record(
    "Under defined sketch is blue and reported in the status bar",
    /Under defined/i.test(under.text) && /under/.test(under.cls) && under.color === "1565c0",
    under,
  );
  const fixed = await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    editor.selectedEntities.clear();
    editor.selectedPoints.clear();
    for (const p of editor.sketch.points) editor.selectedPoints.add(p.id);
    editor.render();
    return editor.applyConstraint("fix");
  });
  await page.waitForTimeout(200);
  const full = await sketchStatus();
  record(
    "Fix on every point makes the sketch fully defined and black",
    fixed === true && /Fully defined/i.test(full.text) && /full/.test(full.cls) && full.color === "1b2430",
    { fixed, ...full },
  );
  const conflict = await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    const line = editor.sketch.entities.find((e) => e.kind === "line");
    // Two driving dimensions on the same edge conflict, which SolidWorks marks
    // as an over-defined (yellow/red) sketch.
    editor.sketch.constraints.push({ id: "over1", type: "distance", entity: line.id, value: 10 });
    editor.sketch.constraints.push({ id: "over2", type: "distance", entity: line.id, value: 50 });
    editor.solve(false);
    editor.render();
    return editor.status.state;
  });
  await page.waitForTimeout(200);
  const over = await sketchStatus();
  record(
    "Conflicting dimensions mark the sketch over defined (amber/red)",
    conflict === "over" && /Over defined/i.test(over.text) && /over/.test(over.cls) && (over.color === "d08a12" || over.color === "d0342c"),
    { conflict, ...over },
  );
  await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    editor.sketch.constraints = editor.sketch.constraints.filter((c) => c.id !== "over1" && c.id !== "over2");
    editor.solve(false);
    editor.render();
  });

  // --- Trim: a vertical line crossing the rectangle is cut between its intersections.
  await setTool(page, "line");
  await sketchClick(page, 20, -10);
  await sketchClick(page, 20, 34);
  const beforeTrim = await state();
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="tool-trim"]');
  await sketchClick(page, 20, 12);
  const afterTrim = await state();
  const vertical = (s) => s.entities.filter((e) => e.kind === "line" && Math.abs((e.a?.[0] ?? -1) - 20) < 0.2 && Math.abs((e.b?.[0] ?? -1) - 20) < 0.2);
  const pieces = vertical(afterTrim);
  record(
    "Trim removes the picked section of a line between its intersections",
    beforeTrim.entities.length === 5 &&
      vertical(beforeTrim).length === 1 &&
      pieces.length === 2 &&
      pieces.every((p) => (p.length ?? 0) > 1 && (p.length ?? 0) < 30),
    { before: vertical(beforeTrim).length, after: pieces.length, lengths: pieces.map((p) => p.length) },
  );

  // --- Offset Entities: offset the rectangle outward by 3 mm.
  await setTool(page, "select");
  const perimeter = await selectBy((e) => e.kind === "line");
  const beforeOffset = await state();
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="sketch-offset"]');
  await page.waitForSelector("#prompt-value");
  await page.fill("#prompt-value", "3");
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(300);
  const afterOffset = await state();
  const offsetXs = afterOffset.entities
    .flatMap((e) => (e.a && e.b ? [e.a, e.b] : []))
    .map((p) => Math.round(p[0] * 100) / 100);
  record(
    "Offset Entities duplicates the selection at the requested distance",
    perimeter.length === beforeOffset.entities.length &&
      afterOffset.entities.length === beforeOffset.entities.length * 2 &&
      offsetXs.includes(3) &&
      offsetXs.includes(17) &&
      offsetXs.includes(37),
    {
      selected: perimeter.length,
      before: beforeOffset.entities.length,
      after: afterOffset.entities.length,
      xs: [...new Set(offsetXs)].sort((a, b) => a - b),
    },
  );

  // --- Convert Entities: project a 3D edge into a fresh sketch.
  // Clear the offset copies, keep a single rectangle and extrude it into a body.
  await setTool(page, "select");
  await page.evaluate(() => {
    const editor = window.__marmaracad.app.editor;
    editor.selectedEntities.clear();
    for (const e of editor.sketch.entities) editor.selectedEntities.add(e.id);
    editor.render();
  });
  await page.click('[data-sketch-action="delete"]');
  await page.waitForTimeout(150);
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 24);
  await setTool(page, "select");
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="exit-sketch"]');
  await page.waitForFunction(() => !window.__marmaracad.app.editor.isActive, null, { timeout: 30000 });
  await page.waitForTimeout(250);
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="extrude-boss"]');
  await page.waitForSelector("#pm-depth");
  await page.fill("#pm-depth", "10");
  await page.click("[data-pm-ok]");
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = api.meshes().get(doc.parts[0].id);
      return mesh && mesh.volume > 100;
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(400);

  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="new-sketch"]');
  await page.waitForSelector('[data-plane-kind="front"]');
  await page.click('[data-plane-kind="front"]');
  await page.waitForFunction(() => window.__marmaracad.app.editor.isActive, null, { timeout: 30000 });
  await page.waitForTimeout(450);
  const edgePoint = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const mesh = api.meshes().get(doc.parts[0].id);
    const vp = api.app.viewport;
    const rect = vp.renderer.domElement.getBoundingClientRect();
    const xSpan = (e) => Math.abs(e.points[0][0] - e.points[e.points.length - 1][0]);
    const zSpan = (e) => Math.abs(e.points[0][2] - e.points[e.points.length - 1][2]);
    const ySpan = (e) => Math.abs(e.points[0][1] - e.points[e.points.length - 1][1]);
    // An edge parallel to the Front plane at the nearest Z, so its projection is real.
    const front = [...mesh.edges]
      .filter((e) => xSpan(e) > 5 && zSpan(e) < 0.05 && ySpan(e) < 0.05)
      .sort((a, b) => b.points[0][2] - a.points[0][2])[0];
    const p = front.points[Math.floor(front.points.length / 2)];
    const s = vp.projectToScreen(p);
    return { x: rect.left + s.x, y: rect.top + s.y, span: xSpan(front), z: p[2] };
  });
  await page.click('[data-cmd-tab="sketch"]');
  await page.click('[data-cmd-action="tool-convert"]');
  await page.mouse.click(edgePoint.x, edgePoint.y);
  await page.waitForTimeout(350);
  const convert = await page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    const lines = s.entities.filter((e) => e.kind === "line");
    const lengths = lines.map((e) => {
      const a = pm.get(e.p1);
      const b = pm.get(e.p2);
      return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
    });
    return { entities: s.entities.length, lines: lines.length, longest: Math.max(0, ...lengths) };
  });
  record(
    "Convert Entities projects the picked 3D edge into the sketch",
    convert.entities > 0 && convert.lines >= 1 && convert.longest > 5,
    { convert, edge: edgePoint },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
