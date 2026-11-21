/* Non-visual UI audit: overflowing panels, unhydrated icons, tiny or clipped
 * text, and console errors. Complements the screenshot review. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude, waitVolume } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);

async function audit(label) {
  await page.waitForTimeout(350);
  const report = await page.evaluate(() => {
    const result = { overflow: [], unhydrated: [], tinyText: [], clipped: [] };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
    };
    // Icon placeholders that lucide never replaced.
    for (const el of document.querySelectorAll("i[data-lucide]")) {
      if (visible(el)) result.unhydrated.push(el.getAttribute("data-lucide"));
    }
    const containers = document.querySelectorAll(
      ".cmd-toolbar, .cmd-groups, .cmd-group, .panel-body, .mass-card, .status-bar, .title-bar, .modal, .colorbar, .result-toolbar, .tree-row, .cmd-btn",
    );
    for (const el of containers) {
      if (!visible(el)) continue;
      if (el.scrollWidth > el.clientWidth + 2) {
        result.overflow.push({
          cls: el.className,
          id: el.id,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          text: (el.textContent ?? "").trim().slice(0, 60),
        });
      }
    }
    // Text smaller than 9 px or lower than 3:1 contrast against its backdrop.
    for (const el of document.querySelectorAll("span, label, button, div, td, th")) {
      if (!visible(el) || el.children.length > 0) continue;
      const text = (el.textContent ?? "").trim();
      if (!text || text.length > 80) continue;
      const s = getComputedStyle(el);
      const size = parseFloat(s.fontSize);
      if (size < 9) result.tinyText.push({ text, size });
    }
    return result;
  });
  console.log(label, JSON.stringify(report, null, 2));
  return report;
}

await newDocument(page);
const empty = await audit("EMPTY");

await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -30, -20);
await sketchClick(page, 30, 20);
const sketch = await audit("SKETCH");
await finishSketch(page);
await page.click('[data-cmd-tab="features"]');
await page.click('[data-cmd-action="extrude-boss"]');
await page.waitForSelector("#pm-depth");
const panel = await audit("EXTRUDE-PANEL");
await page.fill("#pm-depth", "25");
await page.selectOption("#pm-operation", "new");
await page.click("[data-pm-ok]");
await waitVolume(page, "v > 20000");

await page.click('[data-cmd-tab="assembly"]');
await page.click('[data-cmd-action="insert-component"]');
await page.waitForSelector("#insert-qty");
await audit("INSERT-MODAL");
await page.fill("#insert-qty", "2");
await page.click(".modal-foot .btn.primary");
await page.waitForFunction(() => window.__marmaracad.doc().components.length === 2);
const assembly = await audit("ASSEMBLY");

await page.click('[data-cmd-tab="analysis"]');
await page.click('[data-cmd-action="new-study"]');
await page.waitForSelector("#pm-study-material");
const fea = await audit("FEA-PANEL");

const allOverflow = [...empty.overflow, ...sketch.overflow, ...panel.overflow, ...assembly.overflow, ...fea.overflow];
const allUnhydrated = [...empty.unhydrated, ...sketch.unhydrated, ...panel.unhydrated, ...assembly.unhydrated, ...fea.unhydrated];
const allTiny = [...empty.tinyText, ...sketch.tinyText, ...panel.tinyText, ...assembly.tinyText, ...fea.tinyText];const summary = {
  overflow: allOverflow,
  unhydrated: [...new Set(allUnhydrated)],
  tinyText: allTiny.slice(0, 20),
  errors,
};
console.log("SUMMARY", JSON.stringify(summary, null, 2));
console.log("RESULT", allUnhydrated.length === 0 && errors.length === 0 ? "PASS" : "FAIL");
await browser.close();
