/* Object snaps (OSnap) + inference.
 *
 * Endpoint / Midpoint / Origin markers, alignment guides, and the automatic
 * Horizontal / Vertical / Perpendicular relations shown as clickable badges. */
import { launch, openApp, newDocument, startSketch, sketchClick, sketchMove, setTool } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const marker = () =>
  page.evaluate(() => {
    const el = document.querySelector(".snap-marker");
    if (!el) return null;
    return {
      symbol: el.querySelector(".snap-symbol")?.textContent ?? "",
      text: el.querySelector(".snap-text")?.textContent ?? "",
    };
  });
const state = () =>
  page.evaluate(() => {
    const s = window.__marmaracad.app.editor.sketch;
    const pm = new Map(s.points.map((p) => [p.id, p]));
    return {
      points: s.points.map((p) => ({ id: p.id, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 })),
      lines: s.entities
        .filter((e) => e.kind === "line")
        .map((e) => {
          const a = pm.get(e.p1);
          const b = pm.get(e.p2);
          return { id: e.id, p1: e.p1, p2: e.p2, length: a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null };
        }),
      constraints: s.constraints.map((c) => ({ id: c.id, t: c.type, a: c.a, b: c.b, entity: c.entity })),
      guides: window.__marmaracad.app.editor.guideGroup.children.length,
      badges: [...document.querySelectorAll(".relation-badge")].map((b) => ({ id: b.dataset.relation, title: b.title })),
    };
  });

try {
  await newDocument(page);
  await startSketch(page, "front");
  await setTool(page, "line");
  await sketchClick(page, 10, 10);
  await sketchClick(page, 50, 10);
  await setTool(page, "select");

  const first = await state();
  record(
    "Horizontal line is inferred automatically",
    first.lines.length === 1 && first.constraints.some((c) => c.t === "horizontal" && c.entity === first.lines[0].id),
    { constraints: first.constraints },
  );

  // Midpoint snap marker.
  await sketchMove(page, 30.4, 10.3);
  const mid = await marker();
  record("Midpoint snap marker and label appear", mid?.text === "Midpoint" && mid?.symbol === "△", { marker: mid });

  // Start a line exactly on the snapped midpoint and check the shared point.
  await setTool(page, "line");
  await sketchClick(page, 30.4, 10.3);
  await sketchClick(page, 30.4, 38.4);
  const afterVertical = await state();
  const vertical = afterVertical.lines[1];
  const shared = afterVertical.points.filter((p) => Math.abs(p.x - 30) < 0.6 && Math.abs(p.y - 10) < 0.6).length;
  record(
    "Line started on the midpoint reuses the snapped point",
    afterVertical.lines.length === 2 && shared === 1,
    { sharedMidpointPoints: shared, points: afterVertical.points },
  );
  record(
    "Vertical + perpendicular relations are inferred",
    afterVertical.constraints.some((c) => c.t === "vertical" && c.entity === vertical?.id) &&
      afterVertical.constraints.some((c) => c.t === "perpendicular" && c.a === first.lines[0].id && c.b === vertical?.id),
    { constraints: afterVertical.constraints },
  );

  // The chain continues from (30, 38); moving sideways aligns with the existing
  // endpoints and draws dashed tracking guides.
  await sketchMove(page, 50.4, 38.3);
  const guided = await state();
  record("Dashed alignment guides follow the cursor", guided.guides > 0, { guides: guided.guides });

  await setTool(page, "select");
  // Endpoint snap.
  await sketchMove(page, 50.4, 10.3);
  const endpoint = await marker();
  record("Endpoint snap marker and label appear", endpoint?.text === "Endpoint" && endpoint?.symbol === "□", { marker: endpoint });

  // Origin snap.
  await sketchMove(page, 0.3, 0.3);
  const origin = await marker();
  record("Origin snap marker and label appear", origin?.text === "Origin" && origin?.symbol === "⊕", { marker: origin });

  // Snap can be toggled off from the status bar.
  await page.click("#snap-toggle");
  await sketchMove(page, 30.4, 10.3);
  const off = await marker();
  const toggleOff = await page.evaluate(() => document.getElementById("snap-toggle")?.classList.contains("active"));
  await page.click("#snap-toggle");
  await sketchMove(page, 30.4, 10.3);
  const backOn = await marker();
  record(
    "Snap toggle disables and restores object snaps",
    off === null && toggleOff === false && (backOn?.text === "Endpoint" || backOn?.text === "Midpoint"),
    { off, toggleOff, backOn },
  );

  // Green relation badges are clickable and delete the relation.
  const badges = (await state()).badges;
  const horizontal = badges.find((b) => /horizontal/.test(b.title));
  record("Relations are shown as clickable green badges", badges.length >= 2 && !!horizontal, { badges });
  if (horizontal) {
    await page.click(`[data-relation="${horizontal.id}"]`);
    await page.waitForTimeout(150);
    const after = await state();
    record(
      "Clicking a relation badge deletes that constraint",
      !after.constraints.some((c) => c.id === horizontal.id),
      { remaining: after.constraints.map((c) => c.t) },
    );
  }

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
