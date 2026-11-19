import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--disable-gpu-sandbox", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url().slice(-90), r.failure()?.errorText));
await page.goto("http://localhost:5173/MarmaraCad/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => window.__probeDone === true, null, { timeout: 240000 });
console.log(await page.locator("#out").innerText());
await browser.close();
