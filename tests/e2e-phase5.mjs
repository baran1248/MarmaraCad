/* Phase 5 regression: OCCT RAII lifetime, zero-copy FEA transport, the
 * Ansys-style material library, the split-dropdown ribbon, the Ctrl+K command
 * palette, studio PBR and live preview ghosts.
 *
 * Everything is measured from the running application: the OCCT object counters
 * come from the RAII scopes inside the kernel worker, the transfer counts from
 * the FeaClient, and the material/PBR checks read the real document and the
 * Three.js scene. */
import {
  launch,
  openApp,
  newDocument,
  startSketch,
  setTool,
  sketchClick,
  finishSketch,
  extrude,
  waitVolume,
  runCmd,
  body,
  near,
  zoomOut,
} from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, details = {}) => {
  results.push({ name, pass });
  console.log(pass ? "ok  " : "FAIL", name, JSON.stringify(details));
};
const app = (fn, arg) => page.evaluate(fn, arg);

try {
  // ------------------------------------------------------------------ ribbon
  const ribbon = await app(() => {
    const split = (action) => {
      const caret = document.querySelector(`[data-cmd-menu="${action}"]`);
      const panel = document.querySelector(`[data-cmd-menu-panel="${action}"]`);
      return {
        caret: Boolean(caret),
        items: panel ? [...panel.querySelectorAll("[data-cmd-action]")].map((b) => b.dataset.cmdAction) : [],
      };
    };
    return {
      tabs: [...document.querySelectorAll("[data-cmd-tab]")].map((b) => b.dataset.cmdTab),
      extrude: split("extrude-boss"),
      fillet: split("fillet"),
      pattern: split("linear-pattern"),
      bolt: split("toolbox-bolt"),
      groups: document.querySelectorAll(".cmd-group").length,
    };
  });
  await page.click('[data-cmd-tab="sketch"]');
  await page.waitForTimeout(150);
  const sketchSplits = await app(() => {
    const split = (action) => {
      const panel = document.querySelector(`[data-cmd-menu-panel="${action}"]`);
      return panel ? [...panel.querySelectorAll("[data-cmd-action]")].map((b) => b.dataset.cmdAction) : [];
    };
    return { toolLine: split("tool-line"), sketchFillet: split("sketch-fillet") };
  });
  await page.click('[data-cmd-tab="features"]');
  await page.waitForTimeout(150);
  record(
    "ribbon: secondary tools live under split dropdowns",
    ribbon.extrude.items.includes("extrude-cut") &&
      ribbon.extrude.items.includes("revolve") &&
      ribbon.extrude.items.includes("sweep") &&
      ribbon.extrude.items.includes("loft") &&
      ribbon.fillet.items.includes("chamfer") &&
      ribbon.pattern.items.includes("circular-pattern") &&
      sketchSplits.toolLine.includes("tool-slot") &&
      sketchSplits.toolLine.includes("tool-polygon") &&
      sketchSplits.toolLine.includes("tool-spline") &&
      sketchSplits.sketchFillet.includes("sketch-chamfer") &&
      ribbon.bolt.items.includes("toolbox-nut"),
    { ...ribbon, ...sketchSplits },
  );
  record("ribbon: the primary actions stay directly clickable", ribbon.groups > 0 && ribbon.extrude.caret, {
    groups: ribbon.groups,
  });

  // Every command must own a real icon, and Draft must not reuse Chamfer's.
  const iconAudit = await app(() => {
    const wanted = ["chamfer", "draft", "fillet", "extrude-boss", "extrude-cut", "revolve", "sweep", "loft", "hole-wizard"];
    const out = {};
    for (const action of wanted) {
      const svg = document.querySelector(`[data-cmd-action="${action}"] svg`);
      out[action] = svg ? svg.innerHTML.replace(/\s+/g, " ").slice(0, 120) : null;
    }
    return out;
  });
  record(
    "ribbon: Chamfer and Draft use different icons",
    Boolean(iconAudit.chamfer) && Boolean(iconAudit.draft) && iconAudit.chamfer !== iconAudit.draft,
    { chamfer: iconAudit.chamfer?.slice(0, 60), draft: iconAudit.draft?.slice(0, 60) },
  );

  // ------------------------------------------------------- command palette
  await newDocument(page);
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => !document.getElementById("cmd-palette-layer").hidden, null, { timeout: 6000 });
  const paletteSearch = async (query) => {
    await page.fill("#cp-input", query);
    await page.waitForTimeout(140);
    return app(() => [...document.querySelectorAll(".cp-row")].map((r) => r.dataset.cpAction));
  };
  const trDelik = await paletteSearch("delik");
  const trAcinim = await paletteSearch("açınım");
  const trMalzeme = await paletteSearch("malzeme");
  const trModal = await paletteSearch("modal");
  const enFillet = await paletteSearch("fillet");
  const enMesh = await paletteSearch("mesh");
  record("Ctrl+K: Turkish “delik” finds Hole Wizard", trDelik.includes("hole-wizard"), { trDelik: trDelik.slice(0, 4) });
  record("Ctrl+K: Turkish “açınım” finds Flatten", trAcinim.includes("flatten"), { trAcinim: trAcinim.slice(0, 4) });
  record("Ctrl+K: Turkish “malzeme” finds Material", trMalzeme.includes("study-material"), { trMalzeme: trMalzeme.slice(0, 4) });
  record("Ctrl+K: Turkish “modal” finds New Study", trModal.includes("new-study"), { trModal: trModal.slice(0, 4) });
  record("Ctrl+K: English “fillet” ranks Fillet first", enFillet[0] === "fillet", { enFillet: enFillet.slice(0, 3) });
  record("Ctrl+K: English “mesh” finds Mesh", enMesh.includes("study-mesh"), { enMesh: enMesh.slice(0, 4) });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ------------------------------------------------------------- base body
  await startSketch(page, "front");
  await zoomOut(page, 1.6);
  await setTool(page, "rectangle");
  await sketchClick(page, 0, 0);
  await sketchClick(page, 40, 20);
  await finishSketch(page);
  await extrude(page, { depth: 10, operation: "new" });
  await waitVolume(page, "v > 7000");
  const built = await body(page);

  // Run a command straight from the palette (needs the body above).
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => !document.getElementById("cmd-palette-layer").hidden, null, { timeout: 6000 });
  await page.fill("#cp-input", "kütle");
  await page.waitForTimeout(160);
  const firstRow = await app(() => document.querySelector(".cp-row")?.dataset.cpAction ?? null);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const paletteRun = await app(() => ({
    paletteHidden: document.getElementById("cmd-palette-layer").hidden,
    modalTitle: document.querySelector(".modal-head span")?.textContent?.trim() ?? null,
  }));
  record(
    "Ctrl+K: Enter runs the highlighted command",
    firstRow === "mass-props" && paletteRun.paletteHidden && /Mass Properties/i.test(paletteRun.modalTitle ?? ""),
    { firstRow, ...paletteRun },
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  // ------------------------------------------- material library + studio PBR
  await app(() => window.__marmaracad.app.openMaterialDialog());
  await page.waitForSelector(".mat-browser", { timeout: 10000 });
  const library = await app(() => ({
    rows: document.querySelectorAll("[data-material]").length,
    categories: [...document.querySelectorAll("[data-mat-cat]")].map((b) => b.dataset.matCat),
    fields: [
      "mat-E",
      "mat-G",
      "mat-nu",
      "mat-yield",
      "mat-uts",
      "mat-density",
      "mat-conductivity",
      "mat-specificHeat",
      "mat-cte",
      "mat-color",
      "mat-metalness",
      "mat-roughness",
    ].filter((id) => document.getElementById(id)),
  }));
  record(
    "material library: 45+ materials with full mechanical + thermal + PBR fields",
    library.rows >= 45 && library.fields.length === 12 && library.categories.length >= 7,
    library,
  );

  await page.fill("#mat-search", "bakır");
  await page.waitForTimeout(150);
  const trRows = await app(() => document.querySelectorAll("[data-material]").length);
  await page.fill("#mat-search", "abs");
  await page.waitForTimeout(150);
  const absRows = await app(() => [...document.querySelectorAll("[data-material]")].map((r) => r.dataset.material));
  await page.fill("#mat-search", "");
  await page.click('[data-mat-cat="Polymers & Elastomers"]');
  await page.waitForTimeout(150);
  const polymerRows = await app(() => document.querySelectorAll("[data-material]").length);
  record(
    "material library: search and category tabs filter the list",
    trRows >= 4 && absRows.length === 1 && absRows[0] === "abs" && polymerRows === 11,
    { trRows, absRows, polymerRows },
  );

  // Copper: real conductivity + metallic PBR, applied to the part.
  await page.click('[data-mat-cat="All"]');
  await page.waitForTimeout(100);
  await page.click('[data-material="copper"]');
  await page.waitForTimeout(120);
  const copperFields = await app(() => ({
    k: document.getElementById("mat-conductivity").value,
    metalness: document.getElementById("mat-metalness").value,
    roughness: document.getElementById("mat-roughness").value,
  }));
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(500);
  const applied = await app(() => {
    const part = window.__marmaracad.doc().parts[0];
    const scene = window.__marmaracad.app.viewport.scene;
    const view = [...window.__marmaracad.app.viewport.bodies.values()][0];
    return {
      materialId: part.materialId,
      override: part.materialOverride ?? null,
      environment: Boolean(scene.environment),
      ground: window.__marmaracad.app.viewport.groundGroup.children.length,
      bodyMetalness: view?.material.metalness ?? null,
      bodyRoughness: view?.material.roughness ?? null,
      bodyColor: view ? `#${view.material.color.getHexString()}` : null,
    };
  });
  record(
    "material library: copper carries k = 0.385 W/(mm·K)",
    near(Number(copperFields.k), 0.385, 0.5).ok && Number(copperFields.metalness) > 0.9,
    copperFields,
  );
  record(
    "studio: PMREM environment + soft ground are live",
    applied.environment === true && applied.ground >= 2,
    { environment: applied.environment, ground: applied.ground },
  );
  record(
    "studio PBR: the applied material drives the body shader",
    applied.materialId === "copper" &&
      applied.bodyMetalness !== null &&
      Math.abs(applied.bodyMetalness - Number(copperFields.metalness)) < 0.02 &&
      Math.abs(applied.bodyRoughness - Number(copperFields.roughness)) < 0.02,
    applied,
  );

  // Custom edit: tweak metalness and confirm the viewport follows immediately.
  await app(() => window.__marmaracad.app.openMaterialDialog());
  await page.waitForSelector(".mat-browser", { timeout: 10000 });
  await page.fill("#mat-metalness", "0.25");
  await page.dispatchEvent("#mat-metalness", "input");
  await page.waitForTimeout(120);
  const badge = await app(() => document.getElementById("mat-badge").textContent);
  await page.click(".modal-foot .btn.primary");
  await page.waitForTimeout(500);
  const custom = await app(() => {
    const part = window.__marmaracad.doc().parts[0];
    const view = [...window.__marmaracad.app.viewport.bodies.values()][0];
    return {
      override: part.materialOverride,
      bodyMetalness: view?.material.metalness ?? null,
    };
  });
  record(
    "Edit Material: custom PBR edit is stored and repainted",
    /edited/i.test(badge) &&
      Boolean(custom.override) &&
      near(custom.override.metalness, 0.25, 1).ok &&
      near(custom.bodyMetalness, 0.25, 1).ok,
    { badge, overrideMetalness: custom.override?.metalness, bodyMetalness: custom.bodyMetalness },
  );

  // ------------------------------------------------------ live ghost preview
  const ghostTone = async () =>
    app(() => {
      const g = window.__marmaracad.app.viewport.ghostGroup;
      return g ? { tone: g.userData.tone, children: g.children.length } : null;
    });

  await runCmd(page, "extrude-cut");
  await page.waitForSelector("#pm-depth", { timeout: 20000 });
  const cutGhost = await ghostTone();
  await page.fill("#pm-depth", "18");
  await page.waitForTimeout(250);
  const cutGhostDeep = await ghostTone();
  await page.click("[data-pm-cancel]");
  await page.waitForTimeout(350);
  const cleared = await ghostTone();

  await runCmd(page, "fillet");
  await page.waitForSelector("#pm-fillet-radius", { timeout: 20000 });
  await app(() => {
    const application = window.__marmaracad.app;
    const part = window.__marmaracad.doc().parts[0];
    const mesh = window.__marmaracad.meshes().get(part.id);
    const edge = mesh.edges.find((e) => e.points.length >= 2) ?? mesh.edges[0];
    application.command.onEdge({ componentId: null, partId: part.id, edgeIndex: edge.index, edge });
  });
  await page.waitForTimeout(350);
  const filletGhost = await ghostTone();
  await page.fill("#pm-fillet-radius", "4");
  await page.waitForTimeout(250);
  await page.click("[data-pm-cancel]");
  await page.waitForTimeout(250);

  await runCmd(page, "chamfer");
  await page.waitForSelector("#pm-chamfer-distance", { timeout: 20000 });
  await app(() => {
    const application = window.__marmaracad.app;
    const part = window.__marmaracad.doc().parts[0];
    const mesh = window.__marmaracad.meshes().get(part.id);
    const edge = mesh.edges.find((e) => e.points.length >= 2) ?? mesh.edges[0];
    application.command.onEdge({ componentId: null, partId: part.id, edgeIndex: edge.index, edge });
  });
  await page.waitForTimeout(350);
  const chamferGhost = await ghostTone();
  await page.click("[data-pm-cancel]");
  await page.waitForTimeout(300);
  const clearedAfterChamfer = await ghostTone();

  record(
    "live preview: Cut, Fillet and Chamfer ghosts appear in the viewport",
    cutGhost?.tone === "cut" && filletGhost?.tone === "fillet" && chamferGhost?.tone === "chamfer",
    { cutGhost, filletGhost, chamferGhost },
  );
  record(
    "live preview: closing the panel removes the ghost",
    cleared === null && clearedAfterChamfer === null && cutGhostDeep?.children === cutGhost?.children,
    { cleared, clearedAfterChamfer, before: cutGhost, after: cutGhostDeep },
  );

  // ------------------------------------------------------- 20 rebuilds, leak 0
  const leak = await app(async () => {
    const application = window.__marmaracad.app;
    const part = window.__marmaracad.doc().parts[0];
    const feature = part.features.find((f) => f.type === "extrude" || f.type === "cut");
    for (let i = 0; i < 20; i++) {
      // Toggle a real parameter so every iteration re-tessellates and rebinds.
      if (feature) feature.params.depth = 10 + (i % 2) * 5;
      await application.rebuild();
    }
    // Back to the original depth so the volume comparison is meaningful.
    if (feature) feature.params.depth = 10;
    await application.rebuild();
    return window.__marmaracad.kernelMemory();
  });
  record(
    "memory: 20 consecutive rebuilds leave zero tracked OCCT objects",
    leak.occt && leak.occt.leaked === 0 && leak.occt.untracked === 0 && leak.occt.created > 0,
    leak.occt,
  );
  record(
    "memory: the volume is stable after the 20 rebuilds",
    Math.abs((await body(page)).volume - built.volume) < 1e-3,
    { before: built.volume, after: (await body(page)).volume },
  );

  const chip = await app(() => {
    const el = document.getElementById("status-memory");
    el?.click();
    const panel = document.getElementById("memory-panel");
    return {
      text: document.getElementById("status-memory-text")?.textContent ?? "",
      open: panel ? !panel.hidden : false,
      rows: [...document.querySelectorAll("#memory-grid span")].map((s) => s.textContent),
    };
  });
  record(
    "memory: status chip reports heap + OCCT counters",
    chip.open && chip.text.length > 0 && chip.rows.some((r) => /OCCT objects live/.test(r ?? "")),
    chip,
  );
  await page.keyboard.press("Escape");

  // -------------------------------------------------- FEA zero-copy transport
  const fea = await app(async () => {
    const application = window.__marmaracad.app;
    const part = window.__marmaracad.doc().parts[0];
    const mesh = window.__marmaracad.meshes().get(part.id);
    const fixed = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] < -0.9);
    const tip = mesh.faces.findIndex((f) => f.surface === "plane" && f.normal[0] > 0.9);
    const outcome = await application.fea.solve({
      material: { E: 200000, nu: 0.3, yield: 250, density: 7850, conductivity: 0.05 },
      positions: mesh.positions,
      indices: mesh.indices,
      triFaceIds: mesh.triFaceIds,
      supportFaces: [fixed],
      supports: [{ faceIndex: fixed, kind: "fixed" }],
      loads: [{ type: "force", faceIndex: tip, magnitude: 1000, direction: [0, 0, -1] }],
      meshSize: 8,
      meshKind: "hex",
      analysisType: "static",
      ambient: 22,
    });
    return {
      transfer: application.fea.transfer,
      nodes: outcome.nodes,
      elements: outcome.elements,
      maxStress: outcome.result.maxStress,
      arrays: {
        displacement: outcome.result.displacement.length,
        vonMises: outcome.result.vonMises.length,
      },
    };
  });
  record(
    "FEA: the solve reply moves its typed arrays as transferables",
    fea.transfer.lastReplyBuffers > 0 && fea.transfer.totalBuffers >= fea.transfer.lastReplyBuffers && fea.arrays.displacement > 0,
    fea,
  );

  record("phase 5: no console or page errors", errors.length === 0, { errors: errors.slice(0, 6) });
} finally {
  const failed = results.filter((r) => !r.pass);
  console.log(`RESULT ${failed.length === 0 ? "PASS" : "FAIL"} ${results.length - failed.length}/${results.length}`);
  await browser.close();
  if (failed.length) process.exit(1);
}
