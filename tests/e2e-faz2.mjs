/* Phase-2 workspace features: material assignment, technical drawing/PDF,
 * section view, rollback bar, Toolbox fastener, language switch, view selector,
 * confirmation corner and the keyboard-shortcut help. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, openApp, newDocument, waitForRebuild } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};
const sample = () =>
  page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[0];
    const mesh = api.meshes().get(part.id);
    return {
      mode: doc.mode,
      material: part.materialId,
      features: part.features.length,
      rollback: part.rollbackIndex,
      volume: mesh ? mesh.volume : null,
      language: doc.language,
      section: api.app.viewport.getSection(),
    };
  });
const baseline = { volume: 0 };

try {
  await newDocument(page);
  await page.click('[data-tree-action="sample"]');
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = doc && api.meshes().get(doc.parts[0].id);
      return doc?.parts?.[0]?.features?.length === 3 && mesh && mesh.volume > 50000;
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(300);
  baseline.volume = (await sample()).volume ?? 0;

  // --- Material assignment drives the mass card and the drawing title block.
  await page.locator(".material-button").first().click();
  await page.waitForSelector('.mat-browser [data-material="al6061"]', { timeout: 15000 });
  await page.click('.mat-browser [data-material="al6061"]');
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(250);
  const material = await sample();
  const massCard = await page.locator("#mass-card").innerText().catch(() => "");
  const materialName = await page.locator(".material-button").first().innerText().catch(() => "");
  const grams = Math.round((material.volume ?? 0) * 2700 * 1e-6);
  record(
    "Material dialog assigns 6061-T6 to the part",
    material.material === "al6061" && /6061/.test(materialName) && massCard.includes(`${grams} g`),
    {
      material: material.material,
      materialName: materialName.replace(/\s+/g, " ").trim(),
      grams,
      massCard: massCard.replace(/\s+/g, " ").slice(0, 120),
    },
  );

  // --- Technical drawing with 4 views, dimensions and a title block.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="make-drawing"]');
  await page.waitForSelector(".drawing-preview svg", { timeout: 30000 });
  const drawing = await page.evaluate(() => {
    const svg = document.querySelector(".drawing-preview svg");
    return {
      text: svg?.textContent ?? "",
      paths: svg?.querySelectorAll("path").length ?? 0,
      lines: svg?.querySelectorAll("line").length ?? 0,
      texts: svg?.querySelectorAll("text").length ?? 0,
    };
  });
  record(
    "Drawing contains front/top/right/isometric views",
    ["FRONT", "TOP", "RIGHT", "ISOMETRIC"].every((v) => drawing.text.includes(v)) && drawing.paths >= 4 && drawing.lines >= 2,
    { paths: drawing.paths, lines: drawing.lines, texts: drawing.texts },
  );
  record(
    "Drawing title block carries part, material, scale and units",
    drawing.text.includes("Mounting Plate") && /6061/.test(drawing.text) && drawing.text.includes("1:1") && /UNITS[\s\S]{0,40}mm/.test(drawing.text),
    { excerpt: drawing.text.replace(/\s+/g, " ").slice(0, 260) },
  );

  // The width dimension must stay below the front view outline: the fit
  // transform flips Y, so the old p1.y + 32 landed inside tall parts.
  const dimLayout = await page.evaluate(() => {
    const svg = document.querySelector(".drawing-preview svg");
    if (!svg) return null;
    const paths = [...svg.querySelectorAll("path")].filter((p) => !p.closest("defs"));
    const front = paths[0]?.getBBox();
    const lines = [...svg.querySelectorAll("line")];
    const horizontal = lines.find((l) => {
      const a = l.getAttribute("marker-start");
      return a && Math.abs(Number(l.getAttribute("y1")) - Number(l.getAttribute("y2"))) < 0.01;
    });
    const vertical = lines.find((l) => {
      const a = l.getAttribute("marker-start");
      return a && Math.abs(Number(l.getAttribute("x1")) - Number(l.getAttribute("x2"))) < 0.01;
    });
    if (!front || !horizontal || !vertical) return null;
    const bottom = front.y + front.height;
    const right = front.x + front.width;
    return {
      front: { x: front.x, y: front.y, width: front.width, height: front.height },
      widthDimY: Number(horizontal.getAttribute("y1")),
      widthGap: Number(horizontal.getAttribute("y1")) - bottom,
      heightDimX: Number(vertical.getAttribute("x1")),
      heightGap: Number(vertical.getAttribute("x1")) - right,
      slotBottom: 96 + 300 - 28,
    };
  });
  record(
    "Width dimension sits just below the front view, not inside the part",
    !!dimLayout && dimLayout.widthGap >= 0 && dimLayout.widthGap <= 30 && dimLayout.widthDimY <= dimLayout.slotBottom + 0.5,
    dimLayout ?? {},
  );
  record(
    "Height dimension sits outside the right edge of the front view",
    !!dimLayout && dimLayout.heightGap >= 0 && dimLayout.heightGap <= 40,
    dimLayout ? { heightGap: dimLayout.heightGap, heightDimX: dimLayout.heightDimX } : {},
  );

  // Download into the OS temp folder: writing into tests/ made Vite's file
  // watcher lock the PDF mid-write and crash the dev server (EBUSY).
  const tmpPdf = path.join(os.tmpdir(), "marmaracad-drawing.pdf");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click('.modal .btn:has-text("Download PDF")'),
  ]);
  await download.saveAs(tmpPdf);
  const pdfSize = fs.statSync(tmpPdf).size;
  const pdfHead = fs.readFileSync(tmpPdf).subarray(0, 5).toString("latin1");
  fs.rmSync(tmpPdf, { force: true });
  record(
    "Download PDF writes a valid PDF file",
    download.suggestedFilename().endsWith(".pdf") && pdfHead === "%PDF-" && pdfSize > 5000,
    { filename: download.suggestedFilename(), size: pdfSize, head: pdfHead },
  );

  // --- Section view cuts the body and stays active until turned off.
  await page.click('[data-cmd-action="section-view"]');
  await page.waitForSelector("#pm-section-enabled");
  await page.check("#pm-section-enabled");
  await page.selectOption("#pm-section-axis", "x");
  await page.locator("#pm-section-offset").evaluate((el) => {
    el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * 0.4);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(300);
  const sectionOn = (await sample()).section;
  const cutBody = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const view = api.app.viewport.bodies?.get(doc.parts[0].id);
    const data = view?.data;
    return data
      ? { maxX: data.bbox.max[0], minX: data.bbox.min[0], triangles: data.indices.length / 3, volume: data.volume }
      : null;
  });
  record(
    "Section View applies a capped X cut and disables picking",
    sectionOn.enabled === true && sectionOn.axis === "x" &&
      (await page.evaluate(() => document.querySelector('[data-pick-filter="all"]')?.classList.contains("active") === false)),
    { section: sectionOn },
  );
  record(
    "The cut body is clipped at the section plane with capped triangles",
    !!cutBody &&
      (Math.abs(cutBody.minX - sectionOn.offset) < 0.2 || Math.abs(cutBody.maxX - sectionOn.offset) < 0.2) &&
      cutBody.triangles > 0 &&
      cutBody.triangles !== 924,
    { offset: sectionOn.offset, cutBody, fullTriangles: 924 },
  );
  await page.click('[data-cmd-action="section-view"]');
  await page.waitForSelector("#pm-section-enabled");
  await page.uncheck("#pm-section-enabled");
  await page.click("[data-pm-ok]");
  await page.waitForTimeout(200);
  record("Section View can be turned off again", (await sample()).section.enabled === false);
  const restored = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const view = api.app.viewport.bodies?.get(doc.parts[0].id);
    return view?.data ? { maxX: view.data.bbox.max[0], minX: view.data.bbox.min[0], triangles: view.data.indices.length / 3 } : null;
  });
  record(
    "Turning the section off restores the full body",
    !!restored && restored.minX < sectionOn.offset - 1 && restored.maxX > sectionOn.offset + 1 && restored.triangles === 924,
    { restored, offset: sectionOn.offset },
  );

  // --- Rollback bar drag + clear.
  const dragGesture = async (targetSelector) => {
    await page.evaluate((selector) => {
      const bar = document.querySelector("[data-rollback]");
      const target = document.querySelector(selector);
      if (!bar || !target) throw new Error("rollback bar or drop target missing");
      const dt = new DataTransfer();
      bar.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    }, targetSelector);
    await page.waitForTimeout(400);
  };
  await page.evaluate(() => {
    const rows = document.querySelectorAll('.tree-row[data-kind="feature"]');
    if (rows[1]) rows[1].id = "rollback-target";
  });
  await dragGesture("#rollback-target");
  await page.waitForFunction(() => window.__marmaracad.doc().parts[0].rollbackIndex === 2, null, { timeout: 180000 });
  await waitForRebuild(page);
  await page.waitForFunction(
    (v) => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = api.meshes().get(doc.parts[0].id);
      return mesh && Math.abs(mesh.volume - v) > 1;
    },
    baseline.volume,
    { timeout: 180000 },
  );
  const rolled = await sample();
  const suppressed = await page.evaluate(() => document.querySelectorAll('.tree-row[data-kind="feature"].suppressed').length);
  record(
    "Dragging the rollback bar rebuilds only the features above it",
    rolled.rollback === 2 && rolled.features === 3 && rolled.volume !== baseline.volume && suppressed >= 1,
    { rollback: rolled.rollback, volume: rolled.volume, baseline: baseline.volume, suppressed },
  );
  await dragGesture("[data-rollback]");
  await page.waitForFunction(() => window.__marmaracad.doc().parts[0].rollbackIndex === undefined, null, { timeout: 180000 });
  await waitForRebuild(page);
  await page.waitForFunction(
    (v) => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = api.meshes().get(doc.parts[0].id);
      return mesh && Math.abs(mesh.volume - v) < 1;
    },
    baseline.volume,
    { timeout: 180000 },
  );
  record("Dropping the rollback bar on itself restores the full tree", (await sample()).volume === baseline.volume);

  // --- Confirmation Corner (while the sample part is still the active part).
  const sketchId = await page.evaluate(() => window.__marmaracad.doc().parts[0].sketches[0]?.id);
  // Consumed sketches live under their feature now, so expand the owner first.
  await page.evaluate((id) => {
    if (document.querySelector(`[data-key="sketch:${id}"]`)) return;
    const part = window.__marmaracad.doc().parts[0];
    const owner = part.features.find((f) => f.sketchId === id);
    const row = [...document.querySelectorAll('.tree-row[data-kind="feature"]')].find((r) => r.dataset.id === owner?.id);
    row?.querySelector(".twisty")?.click();
  }, sketchId);
  await page.waitForSelector(`[data-key="sketch:${sketchId}"]`, { timeout: 15000 });
  await page.click(`[data-key="sketch:${sketchId}"]`);
  const featuresBefore = await page.evaluate(() => window.__marmaracad.doc().parts[0].features.length);
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="extrude-boss"]');
  await page.waitForSelector("#pm-depth");
  const cornerOpen = await page.evaluate(() => document.getElementById("confirmation-corner")?.classList.contains("visible"));
  await page.click(".cc-btn.cancel");
  await page.waitForTimeout(200);
  const cornerClosed = await page.evaluate(() => document.getElementById("confirmation-corner")?.classList.contains("visible"));
  const featuresAfter = await page.evaluate(() => window.__marmaracad.doc().parts[0].features.length);
  record(
    "Confirmation Corner mirrors the open feature panel and cancels it",
    cornerOpen === true && cornerClosed === false && featuresAfter === featuresBefore,
    { cornerOpen, cornerClosed, featuresBefore, featuresAfter },
  );

  // --- Toolbox M8 bolt.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="toolbox-bolt"]');
  await page.waitForSelector("#tb-size");
  await page.selectOption("#tb-size", "M8");
  await page.fill("#tb-length", "20");
  const beforeBolt = await page.evaluate(() => window.__marmaracad.doc().parts.length);
  await page.click(".modal .btn.primary");
  await page.waitForFunction((n) => window.__marmaracad.doc().parts.length === n + 1, beforeBolt, { timeout: 180000 });
  await page.waitForFunction(
    (n) => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const part = doc.parts[n];
      const mesh = part && api.meshes().get(part.id);
      return mesh && mesh.volume > 100;
    },
    beforeBolt,
    { timeout: 180000 },
  );
  const bolt = await page.evaluate((n) => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[n];
    const mesh = api.meshes().get(part.id);
    return {
      name: part.name,
      meshOnly: part.meshOnly,
      format: part.asset?.format,
      material: part.materialId,
      volume: mesh?.volume,
      bbox: mesh?.bbox,
      bolts: doc.parts.filter((p) => /Hex Bolt/i.test(p.name)).length,
    };
  }, beforeBolt);
  const boltSpan = [
    (bolt.bbox?.max[0] ?? 0) - (bolt.bbox?.min[0] ?? 0),
    (bolt.bbox?.max[1] ?? 0) - (bolt.bbox?.min[1] ?? 0),
    (bolt.bbox?.max[2] ?? 0) - (bolt.bbox?.min[2] ?? 0),
  ];
  record(
    "Toolbox creates a parametric M8 × 20 hex bolt body",
    /M8/.test(bolt.name) && /Hex Bolt/i.test(bolt.name) && bolt.meshOnly === true && bolt.format === "obj" &&
      Math.abs(boltSpan[0] - 13) < 0.6 && boltSpan[2] > 20,
    { bolt, boltSpan },
  );

  // The size list covers the whole M4–M12 range, and M12 scales the hex across flats.
  await page.click('[data-cmd-tab="features"]');
  await page.click('[data-cmd-action="toolbox-bolt"]');
  await page.waitForSelector("#tb-size");
  const sizeOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#tb-size option")).map((o) => o.value),
  );
  const beforeM12 = await page.evaluate(() => window.__marmaracad.doc().parts.length);
  await page.selectOption("#tb-size", "M12");
  await page.fill("#tb-length", "30");
  await page.click(".modal .btn.primary");
  await page.waitForFunction((n) => window.__marmaracad.doc().parts.length === n + 1, beforeM12, { timeout: 180000 });
  await page.waitForFunction(
    (n) => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const mesh = doc.parts[n] && api.meshes().get(doc.parts[n].id);
      return Boolean(mesh && mesh.volume > 100);
    },
    beforeM12,
    { timeout: 180000 },
  );
  const m12 = await page.evaluate((n) => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[n];
    const mesh = api.meshes().get(part.id);
    return {
      name: part.name,
      span: [(mesh.bbox.max[0] - mesh.bbox.min[0]), (mesh.bbox.max[1] - mesh.bbox.min[1]), (mesh.bbox.max[2] - mesh.bbox.min[2])],
      volume: mesh.volume,
    };
  }, beforeM12);
  record(
    "Toolbox offers M4–M12 and an M12 × 30 bolt scales to 18 mm across flats",
    ["M4", "M5", "M6", "M8", "M10", "M12"].every((s) => sizeOptions.includes(s)) &&
      /M12/.test(m12.name) &&
      Math.abs(Math.min(m12.span[0], m12.span[1]) - 18) < 0.9 &&
      m12.span[2] > 30,
    { sizeOptions, m12 },
  );

  // --- TR/EN language switch.
  await page.click('[data-title-action="language"]');
  await page.waitForTimeout(200);
  const tr = await page.evaluate(() => ({
    button: document.querySelector('[data-title-action="language"]')?.textContent,
    language: window.__marmaracad.doc().language,
    tab: document.querySelector('[data-cmd-tab="features"]')?.textContent,
    assemblyTab: document.querySelector('[data-mode="assembly"]')?.textContent?.trim(),
    analysisTab: document.querySelector('[data-mode="analysis"]')?.textContent?.trim(),
    massTitle: document.querySelector("#mass-card .title span")?.textContent?.trim(),
  }));
  await page.click('[data-menu="file"]');
  await page.waitForSelector("#dropdown-layer .menu");
  const trMenu = await page.evaluate(() => ({
    items: [...document.querySelectorAll("#dropdown-layer .menu-item > span:not(.shortcut)")].map((el) => el.textContent?.trim() ?? ""),
    text: document.querySelector("#dropdown-layer .menu")?.textContent ?? "",
  }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);

  await page.click('[data-title-action="language"]');
  await page.waitForTimeout(150);
  const en = await page.evaluate(() => ({
    button: document.querySelector('[data-title-action="language"]')?.textContent,
    language: window.__marmaracad.doc().language,
    tab: document.querySelector('[data-cmd-tab="features"]')?.textContent,
    assemblyTab: document.querySelector('[data-mode="assembly"]')?.textContent?.trim(),
    analysisTab: document.querySelector('[data-mode="analysis"]')?.textContent?.trim(),
    massTitle: document.querySelector("#mass-card .title span")?.textContent?.trim(),
  }));
  await page.click('[data-menu="file"]');
  await page.waitForSelector("#dropdown-layer .menu");
  const enMenu = await page.evaluate(() => ({
    items: [...document.querySelectorAll("#dropdown-layer .menu-item > span:not(.shortcut)")].map((el) => el.textContent?.trim() ?? ""),
    text: document.querySelector("#dropdown-layer .menu")?.textContent ?? "",
  }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  record(
    "TR/EN switch relabels the command manager and persists in the document",
    tr.button === "TR" && tr.language === "tr" && tr.tab !== en.tab && en.button === "EN" && en.language === "en",
    { tr, en },
  );
  record(
    "TR/EN switch relabels the Assembly tab, mass card and dropdown menus",
    tr.assemblyTab === "Montaj" &&
      tr.massTitle === "Kütle Özellikleri" &&
      tr.analysisTab === "Analiz" &&
      trMenu.items.includes("Yeni Belge") &&
      trMenu.items.includes("Şablondan Yeni…") &&
      /İÇE AKTAR/.test(trMenu.text) &&
      en.assemblyTab === "Assembly" &&
      en.massTitle === "Mass Properties" &&
      en.analysisTab === "Analysis" &&
      enMenu.items.includes("New Document") &&
      enMenu.items.includes("New from Template…") &&
      /IMPORT/.test(enMenu.text),
    { tr, trMenu: trMenu.items.slice(0, 6), en, enMenu: enMenu.items.slice(0, 6) },
  );

  // --- Space view selector + confirmation corner.
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  const selectorOpen = await page.evaluate(() => document.getElementById("space-selector")?.classList.contains("visible"));
  await page.evaluate(() => {
    const button = document.querySelector('[data-ss-view="front"]');
    if (button instanceof HTMLElement) button.click();
  });
  await page.waitForTimeout(450);
  const view = await page.evaluate(() => {
    const api = window.__marmaracad;
    return {
      open: document.getElementById("space-selector")?.classList.contains("visible"),
      camera: api.app.viewport.camera.position.toArray(),
    };
  });
  record(
    "Space opens the 3D View Selector and the front button snaps the camera",
    selectorOpen === true && view.open === false && Math.abs(view.camera[0]) < 1 && view.camera[2] > 0,
    { selectorOpen, ...view },
  );

  // --- Keyboard shortcut bar (S) and help (?).
  await page.mouse.move(640, 420);
  await page.keyboard.press("s");
  await page.waitForTimeout(200);
  const bar = await page.evaluate(() => ({
    visible: document.getElementById("shortcut-bar")?.classList.contains("visible"),
    count: document.querySelectorAll("#shortcut-bar [data-shortcut]").length,
  }));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const barHidden = await page.evaluate(() => document.getElementById("shortcut-bar")?.classList.contains("visible"));

  await page.keyboard.press("Shift+Slash");
  await page.waitForSelector(".modal");
  const help = await page.locator(".modal .modal-body").innerText();
  await page.click(".modal .btn.primary");
  record(
    "S opens the cursor shortcut bar and ? opens the shortcut guide",
    bar.visible === true && bar.count >= 6 && barHidden === false && /3D View Selector/.test(help) && /Ctrl \+ Click/.test(help),
    { bar, barHidden, help: help.split("\n").slice(0, 6) },
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
