/* Does the sketch canvas actually draw the profile, grid and dimension label? */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch, extrude } from "./e2e-lib.mjs";
import { imageStats } from "./pngstats.mjs";

const browser = await launch();
const { page } = await openApp(browser);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -30, -20);
await sketchClick(page, 30, 20);
await setTool(page, "dimension");
await sketchClick(page, 0, -20);
await page.waitForSelector("#prompt-value", { timeout: 15000 });
await page.fill("#prompt-value", "60");
await page.click(".modal-foot .btn.primary");
await page.waitForTimeout(600);

const box = await page.locator(".viewport-canvas").boundingBox();
const shot = await page.screenshot({ clip: box, animations: "disabled" });
const stats = imageStats(shot);
const labels = await page.evaluate(() =>
  [...document.querySelectorAll(".sketch-dimension")].map((el) => ({
    text: el.textContent,
    visible: getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0,
    box: el.getBoundingClientRect().toJSON(),
  })),
);
const overlay = await page.evaluate(() => {
  const scene = window.__marmaracad.app.viewport.scene;
  const group = scene.getObjectByName("sketch-overlay");
  const count = (node) => node.children.reduce((n, c) => n + 1 + count(c), 0);
  return { present: Boolean(group), children: group ? count(group) : 0 };
});
console.log(JSON.stringify({ stats, labels, overlay }, null, 2));
await browser.close();
