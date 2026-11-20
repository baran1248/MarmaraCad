import { chromium } from "playwright-core";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const tmpDir = "C:\\Users\\MBB\\AppData\\Local\\Temp\\opencode\\marmaracad-e2e";
await mkdir(tmpDir, { recursive: true });
const stepPath = join(tmpDir, "roundtrip.step");

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

const boot = async () => {
  await page.goto("http://localhost:5173/MarmaraCad/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => {
      const el = document.getElementById("boot");
      return !el || el.classList.contains("hidden");
    },
    null,
    { timeout: 240000 },
  );
};

await boot();
await page.click('[data-tree-action="sample"]');
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app?.doc?.();
    const mesh = doc && app.meshes().get(doc.parts[0].id);
    return Boolean(mesh && mesh.volume > 50000);
  },
  null,
  { timeout: 120000 },
);

// export the sample and save it under a real .step name
await page.click('[data-cmd-tab="evaluate"]');
const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
await page.click('[data-cmd-action="export-step"]');
const download = await downloadPromise;
await download.saveAs(stepPath);
const exported = await stat(stepPath);
console.log("EXPORT", JSON.stringify({ suggested: download.suggestedFilename(), bytes: exported.size }));

// import it back through the command manager
await page.click('[data-cmd-tab="features"]');
const chooserPromise = page.waitForEvent("filechooser", { timeout: 30000 });
await page.click('[data-cmd-action="import-cad"]');
const chooser = await chooserPromise;
await chooser.setFiles(stepPath);
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app?.doc?.();
    if (!doc || doc.parts.length < 2) return false;
    const mesh = app.meshes().get(doc.parts[1].id);
    return Boolean(mesh && mesh.volume > 50000);
  },
  null,
  { timeout: 180000 },
);
const imported = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const part = doc.parts[1];
  const mesh = app.meshes().get(part.id);
  return {
    parts: doc.parts.length,
    name: part.name,
    assetFormat: part.asset?.format,
    volume: Math.round(mesh.volume),
    faces: mesh.faces.length,
    edges: mesh.edges.length,
    warnings: mesh.warnings,
    status: document.getElementById("status-msg")?.textContent,
    toasts: Array.from(document.querySelectorAll(".toast")).map((t) => t.textContent?.trim()),
  };
});
console.log("IMPORT", JSON.stringify(imported, null, 2));

// the imported body must also survive the project round-trip
const projectDownload = page.waitForEvent("download", { timeout: 60000 });
await page.click('[data-title-action="save"]');
const saved = await projectDownload;
const savedPath = join(tmpDir, "roundtrip.mcad.json");
await saved.saveAs(savedPath);
const projectBytes = await stat(savedPath);
const json = JSON.parse(await (await import("node:fs/promises")).readFile(savedPath, "utf8"));
console.log(
  "PROJECT",
  JSON.stringify({
    bytes: projectBytes.size,
    parts: json.document?.parts?.length,
    importedAsset: json.document?.parts?.[1]?.asset ? json.document.parts[1].asset.size : null,
  }),
);

// reopen the saved project through File > Open Project
await page.click('[data-menu="file"]');
const openChooserPromise = page.waitForEvent("filechooser", { timeout: 30000 });
await page.click('[data-menu-action="open-project"]');
const openChooser = await openChooserPromise;
await openChooser.setFiles(savedPath);
await page.waitForFunction(
  () => {
    const app = window.__marmaracad;
    const doc = app?.doc?.();
    if (!doc || doc.parts.length !== 2) return false;
    const mesh = app.meshes().get(doc.parts[1].id);
    return Boolean(mesh && mesh.volume > 50000);
  },
  null,
  { timeout: 180000 },
);
const reopened = await page.evaluate(() => {
  const app = window.__marmaracad;
  const doc = app.doc();
  const mesh = app.meshes().get(doc.parts[1].id);
  return {
    name: doc.name,
    parts: doc.parts.length,
    features: doc.parts[0].features.length,
    importedName: doc.parts[1].name,
    importedVolume: Math.round(mesh.volume),
    importedFaces: mesh.faces.length,
    status: document.getElementById("status-msg")?.textContent,
  };
});
console.log("REOPEN", JSON.stringify(reopened, null, 2));

const volumeOk = Math.abs(imported.volume - 98507) < 50;
const reopenOk = reopened.parts === 2 && Math.abs(reopened.importedVolume - 98507) < 50;
console.log("RESULT", volumeOk && reopenOk && imported.parts === 2 && errors.length === 0 ? "PASS" : "FAIL");
if (errors.length) console.log("ERRORS", JSON.stringify(errors, null, 2));
await browser.close();
await unlink(stepPath).catch(() => undefined);
await unlink(savedPath).catch(() => undefined);
