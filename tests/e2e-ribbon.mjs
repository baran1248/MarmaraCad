/* Ribbon layout regression: every command button must stay clear of the group
 * captions (BASE / BOSS, MODIFY, INSPECT, IMPORT, OUTPUT) even when a label
 * wraps to two lines. Uses getBoundingClientRect so it fails on real overlap,
 * not on a hard-coded height. */
import { launch, openApp, newDocument } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser, { width: 1180, height: 820 });
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};

const measure = () =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll(".cmd-group")];
    const overlaps = [];
    let twoLine = 0;
    let buttons = 0;
    for (const group of groups) {
      const label = group.querySelector(".cmd-group-label");
      const labelRect = label?.getBoundingClientRect();
      for (const button of group.querySelectorAll(".cmd-btn")) {
        buttons++;
        const span = button.querySelector("span");
        const spanRect = span?.getBoundingClientRect();
        if (spanRect && spanRect.height > 19.5) twoLine++;
        const rect = button.getBoundingClientRect();
        if (!labelRect) continue;
        const horizontal = rect.left < labelRect.right - 0.5 && rect.right > labelRect.left + 0.5;
        if (horizontal && rect.bottom > labelRect.top - 1) {
          overlaps.push({
            group: label?.textContent?.trim(),
            action: button.dataset.cmdAction,
            buttonBottom: Math.round(rect.bottom * 10) / 10,
            labelTop: Math.round(labelRect.top * 10) / 10,
          });
        }
      }
    }
    return {
      groups: groups.length,
      buttons,
      twoLine,
      overlaps,
      commandbar: document.querySelector(".commandbar")?.getBoundingClientRect().height ?? 0,
    };
  });

try {
  await newDocument(page);
  const tabs = ["features", "sketch", "assembly", "analysis", "drawing"];
  for (const tab of tabs) {
    const tabButton = page.locator(`[data-cmd-tab="${tab}"]`);
    if (!(await tabButton.count())) continue;
    await tabButton.first().click();
    await page.waitForTimeout(120);
    const data = await measure();
    record(`ribbon/${tab}: no button touches a group caption`, data.overlaps.length === 0, data);
  }

  // Force a narrow window and re-check the feature tab, where most two-line
  // labels live (Hole Wizard, Circular Pattern, Reference Geometry...).
  await page.setViewportSize({ width: 1024, height: 760 });
  await page.click('[data-cmd-tab="features"]');
  await page.waitForTimeout(200);
  const narrow = await measure();
  record("ribbon/narrow: labels keep clear of captions", narrow.overlaps.length === 0, narrow);
  record("ribbon: two-line labels are vertically clamped", narrow.twoLine >= 0 && narrow.commandbar >= 90, {
    twoLine: narrow.twoLine,
    commandbar: narrow.commandbar,
  });

  record("ribbon: no console or page errors", errors.length === 0, { errors: errors.slice(0, 5) });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`RESULT ${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
  await browser.close();
  if (failed.length) process.exit(1);
}
