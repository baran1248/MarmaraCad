import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  args: ["--disable-gpu-sandbox", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url().slice(-100)} ${r.failure()?.errorText}`));

await page.goto("http://localhost:5173/MarmaraCad/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const boot = document.getElementById("boot");
  return !boot || boot.classList.contains("hidden");
}, null, { timeout: 240000 });
await page.waitForTimeout(1200);

const state = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app?.doc?.();
  return {
    title: document.title,
    bootGone: !document.getElementById("boot"),
    docName: doc?.name,
    parts: doc?.parts?.length,
    mode: doc?.mode,
    bodies: app?.app?.viewport?.bodyCount,
    tabLabels: [...document.querySelectorAll("[data-cmd-tab]")].map((b) => b.textContent?.trim()),
    treeText: document.querySelector(".panel-body")?.innerText?.slice(0, 300),
    status: document.getElementById("status-msg")?.textContent,
    mass: document.getElementById("mass-card")?.innerText,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log("ERRORS:", errors.length ? JSON.stringify(errors, null, 2) : "none");

await browser.close();
