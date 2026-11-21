/* HUD layout regression test.
 *
 * The view tools (top-left), selection filter bar (second row, left), view badge
 * (top centre), confirmation corner (top-right) and the view cube (below the
 * corner) are absolutely positioned overlays. None of them may cover another,
 * with the confirmation corner open, at the default 1440 × 900 viewport. */
import { launch, openApp } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};

try {
  // Open the confirmation corner with its real OK / Cancel buttons.
  await page.evaluate(() => {
    window.__marmaracad.app.shell.showConfirmationCorner(
      () => undefined,
      () => undefined,
    );
  });
  await page.waitForTimeout(200);

  const layout = await page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        display: style.display,
        visibility: style.visibility,
      };
    };
    return {
      tools: rect(".view-tools"),
      filters: rect(".selection-filters"),
      badge: rect(".view-badge"),
      corner: rect(".confirmation-corner"),
      cube: rect(".viewcube"),
      cornerVisible: document.getElementById("confirmation-corner")?.classList.contains("visible") === true,
    };
  });

  const overlaps = (a, b) =>
    !!a &&
    !!b &&
    a.display !== "none" &&
    b.display !== "none" &&
    a.right > b.left + 0.5 &&
    b.right > a.left + 0.5 &&
    a.bottom > b.top + 0.5 &&
    b.bottom > a.top + 0.5;
  const pairs = [
    ["view tools", layout.tools, "selection filters", layout.filters],
    ["view tools", layout.tools, "view badge", layout.badge],
    ["view tools", layout.tools, "confirmation corner", layout.corner],
    ["view tools", layout.tools, "view cube", layout.cube],
    ["selection filters", layout.filters, "view badge", layout.badge],
    ["selection filters", layout.filters, "confirmation corner", layout.corner],
    ["selection filters", layout.filters, "view cube", layout.cube],
    ["view badge", layout.badge, "confirmation corner", layout.corner],
    ["view badge", layout.badge, "view cube", layout.cube],
    ["confirmation corner", layout.corner, "view cube", layout.cube],
  ];
  const collisions = pairs
    .filter(([, a, , b]) => overlaps(a, b))
    .map(([aName, , bName]) => `${aName} × ${bName}`);

  record(
    "HUD overlays do not overlap with the confirmation corner open",
    layout.cornerVisible &&
      Boolean(layout.tools && layout.filters && layout.badge && layout.corner && layout.cube) &&
      collisions.length === 0,
    { collisions, layout },
  );

  record(
    "Selection filters sit below the view tool row and the cube below the corner",
    layout.tools != null &&
      layout.filters != null &&
      layout.corner != null &&
      layout.cube != null &&
      layout.filters.top >= layout.tools.bottom &&
      layout.cube.top >= layout.corner.bottom,
    {
      toolsBottom: layout.tools?.bottom,
      filtersTop: layout.filters?.top,
      cornerBottom: layout.corner?.bottom,
      cubeTop: layout.cube?.top,
    },
  );

  // The CSS should also keep these offsets on a narrower window (the filters
  // share the left edge with the tools, the cube stays under the corner).
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(200);
  const narrow = await page.evaluate(() => {
    const rect = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    return {
      tools: rect(".view-tools"),
      filters: rect(".selection-filters"),
      corner: rect(".confirmation-corner"),
      cube: rect(".viewcube"),
    };
  });
  const narrowOverlaps = overlaps(narrow.tools, narrow.filters) || overlaps(narrow.corner, narrow.cube);
  record(
    "HUD rows keep their spacing at 1180 px width",
    !narrowOverlaps &&
      !!narrow.tools &&
      !!narrow.filters &&
      narrow.filters.top >= narrow.tools.bottom &&
      narrow.cube.top >= narrow.corner.bottom,
    narrow,
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
