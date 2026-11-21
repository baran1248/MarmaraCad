/* Proves the sketch overlay really rasterises: capture the canvas while the
 * rectangle is being edited, finish the sketch (overlay hides), capture again
 * and count the pixels that changed. A blank canvas would show ~0 changes. */
import { launch, openApp, newDocument, startSketch, setTool, sketchClick, finishSketch } from "./e2e-lib.mjs";
import { imageStats } from "./pngstats.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
await newDocument(page);
await startSketch(page, "front");
await setTool(page, "rectangle");
await sketchClick(page, -40, -25);
await sketchClick(page, 40, 25);
await setTool(page, "select");
await page.waitForTimeout(500);

const box = await page.locator(".viewport-canvas").boundingBox();
const during = await page.screenshot({ clip: box, animations: "disabled" });
const statsDuring = imageStats(during);

// Renderer-agnostic proof: the sketch overlay disappears when the sketch ends,
// so the pixels it painted must change between the two captures.
await finishSketch(page);
await page.waitForTimeout(600);
const after = await page.screenshot({ clip: box, animations: "disabled" });
const statsAfter = imageStats(after);

const changed = await page.evaluate(
  async ({ a, b }) => {
    const load = (b64) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve(c.getContext("2d").getImageData(0, 0, c.width, c.height).data);
        };
        img.src = `data:image/png;base64,${b64}`;
      });
    const [p, q] = await Promise.all([load(a), load(b)]);
    let n = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 18) n++;
    }
    return { changed: n, total: p.length / 4, pct: (100 * n) / (p.length / 4) };
  },
  { a: during.toString("base64"), b: after.toString("base64") },
);

const labels = await page.evaluate(() =>
  [...document.querySelectorAll(".sketch-dimension")].map((el) => el.textContent),
);
console.log(JSON.stringify({ statsDuring, statsAfter, diffPixels: changed, labels, errors }, null, 2));
console.log("RESULT", changed.pct > 0.15 && errors.length === 0 ? "PASS" : "FAIL");
await browser.close();
