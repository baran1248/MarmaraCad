/* Gemini CAD assistant with a mocked Generative Language API.
 *
 * Verifies the local-only key storage, automatic model listing, the hydrogen
 * default + mid thinking level, the JSON command reply, whitelist validation,
 * one-click apply and undo integration. */
import { launch, openApp, newDocument, waitForRebuild } from "./e2e-lib.mjs";

const browser = await launch();
const { page, errors } = await openApp(browser);
const results = [];
const record = (name, pass, detail = {}) => {
  results.push({ name, pass, ...detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`, JSON.stringify(detail));
};

try {
  await newDocument(page);

  // Intercept only the Gemini endpoints; nothing leaves the browser.
  await page.evaluate(() => {
    const w = window;
    w.__aiCalls = [];
    w.__aiReply = {
      message: "Created the plate and assigned 6061-T6.",
      commands: [
        { action: "box", params: { length: 40, width: 20, height: 10 } },
        { action: "material", params: { id: "al6061" } },
        { action: "delete-everything", params: {} },
      ],
    };
    w.__aiModels = [
      { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-1.5-pro", displayName: "Gemini 1.5 Pro", supportedGenerationMethods: ["generateContent"] },
    ];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("generativelanguage.googleapis.com")) return realFetch(input, init);
      const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      w.__aiCalls.push(call);
      if (url.includes("/models?")) {
        return Promise.resolve(
          new Response(JSON.stringify({ models: w.__aiModels }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(w.__aiReply) }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
  });

  await page.click('[data-title-action="ai"]');
  await page.waitForSelector("#ai-panel.visible");
  await page.fill("#ai-key-input", "test-key-123456");
  await page.click("#ai-key-save");
  await page.waitForFunction(() => (document.querySelectorAll("#ai-model option").length ?? 0) >= 3, null, { timeout: 15000 });

  const panel = await page.evaluate(() => {
    const model = document.querySelector("#ai-model");
    return {
      visible: document.getElementById("ai-panel")?.classList.contains("visible"),
      options: [...(model?.querySelectorAll("option") ?? [])].map((o) => ({ value: o.value, label: o.textContent ?? "" })),
      selected: model?.value,
      thinking: document.querySelector("#ai-thinking")?.value,
      state: document.getElementById("ai-key-state")?.textContent,
      stored: localStorage.getItem("marmaracad.gemini.apiKey"),
      cookie: document.cookie,
      calls: window.__aiCalls?.map((c) => ({ url: c.url, method: c.method })),
    };
  });
  record(
    "Saving a key lists models and keeps the key local",
    panel.visible === true &&
      panel.stored === "test-key-123456" &&
      panel.cookie.includes("marmaracad_gemini_key=test-key-123456") &&
      panel.options.some((o) => o.value === "hydrogen") &&
      panel.options.some((o) => o.value === "gemini-2.5-flash") &&
      panel.selected === "hydrogen",
    { selected: panel.selected, options: panel.options, stored: panel.stored },
  );
  record(
    "Default model is hydrogen with mid thinking",
    panel.selected === "hydrogen" && panel.thinking === "mid" && /hydrogen/.test(panel.state ?? "") && /mid/.test(panel.state ?? ""),
    { selected: panel.selected, thinking: panel.thinking, state: panel.state },
  );
  record(
    "The panel reaches Google directly with the key in the query",
    panel.calls?.some((c) => c.method === "GET" && /models\?key=test-key-123456/.test(c.url)) === true,
    { calls: panel.calls },
  );

  // Saving the same key twice re-lists the models but must not duplicate the
  // "N Gemini model(s) listed" chat notice.
  const listCalls = await page.evaluate(() => window.__aiCalls.filter((c) => c.method === "GET").length);
  await page.click("#ai-key-save");
  await page.waitForFunction((n) => window.__aiCalls.filter((c) => c.method === "GET").length > n, listCalls, { timeout: 20000 });
  await page.waitForTimeout(300);
  const listedMessages = await page.evaluate(
    () => [...document.querySelectorAll(".ai-msg.bot")].filter((el) => /model\(s\) listed/.test(el.textContent ?? "")).length,
  );
  record("Re-listing the same models does not duplicate the chat notice", listedMessages === 1, { listedMessages });

  await page.fill("#ai-prompt", "40 x 20 x 10 mm plate in 6061-T6");
  await page.click("#ai-send");
  await page.waitForSelector(".ai-apply", { timeout: 15000 });
  const beforeApply = await page.evaluate(() => ({
    text: document.getElementById("ai-scroll")?.innerText ?? "",
    calls: window.__aiCalls?.length,
    last: window.__aiCalls?.at(-1),
  }));
  record(
    "Reply is parsed into an apply button with the command list",
    /Apply 3 command\(s\)/.test(beforeApply.text) && /box/.test(beforeApply.text) && /material/.test(beforeApply.text),
    { text: beforeApply.text.slice(-220) },
  );
  record(
    "Request aliases hydrogen to the newest flash model (gemini-3-flash) with thinkingLevel medium and the full command schema",
    /gemini-3-flash:generateContent/.test(beforeApply.last?.url ?? "") &&
      beforeApply.last?.body?.generationConfig?.thinkingConfig?.thinkingLevel === "medium" &&
      beforeApply.last?.body?.generationConfig?.thinkingConfig?.thinkingBudget === undefined &&
      /Allowed actions and params/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /box: \{length,width,height/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /cut: \{sketch/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /revolve: \{sketch/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /mirror: \{plane/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /pattern: \{axis/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /mate: \{type/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /al6061 \(Aluminum 6061-T6\)/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? ""),
    {
      url: beforeApply.last?.url?.replace(/key=[^&]+/, "key=***"),
      thinking: beforeApply.last?.body?.generationConfig?.thinkingConfig,
      systemChars: beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text?.length,
    },
  );

  await page.click(".ai-apply");
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const part = doc.parts.at(-1);
      const mesh = part && api.meshes().get(part.id);
      return doc.parts.length === 2 && mesh && Math.abs(mesh.volume - 8000) < 1;
    },
    null,
    { timeout: 180000 },
  );
  await waitForRebuild(page);
  const applied = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts.at(-1);
    const mesh = api.meshes().get(part.id);
    return { parts: doc.parts.length, volume: mesh?.volume, material: part.materialId, active: part.name };
  });
  record(
    "Apply builds the 40 × 20 × 10 box and assigns 6061-T6",
    applied.parts === 2 && Math.abs((applied.volume ?? 0) - 8000) < 1 && applied.material === "al6061",
    applied,
  );
  record(
    "Unknown actions are rejected by the whitelist (2/3 applied)",
    /AI: 2\/3 command\(s\) applied/.test(await page.locator("body").innerText()),
    { toast: (await page.locator("body").innerText()).match(/AI: [^\n]+/)?.[0] },
  );

  // Undo is the normal transaction history, so Ctrl+Z removes both commands.
  await page.mouse.click(420, 420);
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => window.__marmaracad.doc().parts.length === 1, null, { timeout: 30000 });
  record("AI edits participate in undo", (await page.evaluate(() => window.__marmaracad.doc().parts.length)) === 1);

  // --- Thinking configuration differs per model generation.
  const sendAndWait = async (prompt, previous) => {
    await page.fill("#ai-prompt", prompt);
    await page.click("#ai-send");
    await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, previous, { timeout: 20000 });
    await page.waitForTimeout(120);
  };
  const lastPost = () =>
    page.evaluate(() => {
      const calls = window.__aiCalls.filter((c) => c.method === "POST");
      const last = calls.at(-1);
      return { url: last?.url ?? "", thinking: last?.body?.generationConfig?.thinkingConfig };
    });

  await page.selectOption("#ai-model", "gemini-2.5-flash");
  await sendAndWait("repeat the plate", await page.locator(".ai-apply").count());
  const g25 = await lastPost();
  record(
    "Gemini 2.5 requests keep thinkingBudget (8192), not thinkingLevel",
    /gemini-2\.5-flash:generateContent/.test(g25.url) && g25.thinking?.thinkingBudget === 8192 && g25.thinking?.thinkingLevel === undefined,
    g25,
  );

  await page.selectOption("#ai-model", "gemini-3-flash");
  await sendAndWait("repeat the plate", await page.locator(".ai-apply").count());
  const g3 = await lastPost();
  record(
    "Gemini 3 requests use thinkingLevel (medium), not thinkingBudget",
    /gemini-3-flash:generateContent/.test(g3.url) && g3.thinking?.thinkingLevel === "medium" && g3.thinking?.thinkingBudget === undefined,
    g3,
  );

  await page.selectOption("#ai-model", "gemini-1.5-pro");
  await sendAndWait("repeat the plate", await page.locator(".ai-apply").count());
  const legacy = await lastPost();
  record(
    "Legacy models omit thinkingConfig entirely",
    /gemini-1\.5-pro:generateContent/.test(legacy.url) && legacy.thinking === undefined,
    legacy,
  );

  // --- A model actually named `hydrogen` is used directly instead of aliasing.
  await page.evaluate(() => {
    window.__aiModels = [
      { name: "models/hydrogen", displayName: "Hydrogen", supportedGenerationMethods: ["generateContent"] },
      ...window.__aiModels,
    ];
  });
  const getCalls = await page.evaluate(() => window.__aiCalls.filter((c) => c.method === "GET").length);
  await page.click("#ai-key-save");
  await page.waitForFunction((n) => window.__aiCalls.filter((c) => c.method === "GET").length > n, getCalls, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.selectOption("#ai-model", "hydrogen");
  await sendAndWait("repeat the plate", await page.locator(".ai-apply").count());
  const hydrogen = await lastPost();
  const hydrogenPanel = await page.evaluate(() => ({
    selected: document.querySelector("#ai-model")?.value,
    options: [...document.querySelectorAll("#ai-model option")].map((o) => o.value),
  }));
  record(
    "A listed hydrogen model is used directly",
    hydrogenPanel.selected === "hydrogen" &&
      hydrogenPanel.options.includes("hydrogen") &&
      /\/models\/hydrogen:generateContent/.test(hydrogen.url),
    { hydrogen, hydrogenPanel },
  );

  // --- No exact `hydrogen`: the newest hydrogen alias must win, and Gemini 4
  // models belong to the Recommended group in the model picker.
  await page.evaluate(() => {
    window.__aiModels = [
      { name: "models/gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen", supportedGenerationMethods: ["generateContent"] },
      ...window.__aiModels.filter((m) => m.name !== "models/hydrogen"),
    ];
  });
  const getCalls4 = await page.evaluate(() => window.__aiCalls.filter((c) => c.method === "GET").length);
  await page.click("#ai-key-save");
  await page.waitForFunction((n) => window.__aiCalls.filter((c) => c.method === "GET").length > n, getCalls4, { timeout: 20000 });
  await page.waitForTimeout(300);
  const g4Panel = await page.evaluate(() => {
    const select = document.querySelector("#ai-model");
    const option = [...select.querySelectorAll("option")].find((o) => o.value === "gemini-4-hydrogen");
    return {
      selected: select.value,
      hasOption: !!option,
      group: option?.parentElement?.tagName === "OPTGROUP" ? option.parentElement.label : option?.parentElement?.tagName,
      options: [...select.querySelectorAll("option")].map((o) => o.value),
      head: document.getElementById("ai-head-state")?.textContent,
    };
  });
  record(
    "Gemini 4 models are listed in the Recommended model group",
    g4Panel.selected === "hydrogen" && g4Panel.hasOption && g4Panel.group === "Recommended",
    g4Panel,
  );
  await sendAndWait("repeat the plate", await page.locator(".ai-apply").count());
  const g4 = await lastPost();
  record(
    "hydrogen resolves to the newest hydrogen alias (gemini-4-hydrogen) with thinkingLevel medium",
    /\/models\/gemini-4-hydrogen:generateContent/.test(g4.url) &&
      g4.thinking?.thinkingLevel === "medium" &&
      g4.thinking?.thinkingBudget === undefined,
    { g4, selected: g4Panel.selected, head: g4Panel.head },
  );

  // --- Multimodal context: viewport JPEG + B-Rep topology in every request.
  await newDocument(page);
  await page.click('[data-tree-action="sample"]');
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const part = api.doc().parts[0];
      const mesh = part && api.meshes().get(part.id);
      return !!mesh && Math.abs(mesh.volume - 98507) < 2;
    },
    null,
    { timeout: 240000 },
  );
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__aiReply = { message: "Moved to iso view.", commands: [{ action: "view", params: { name: "iso" } }] };
  });
  const visionApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "Show me the plate in iso view");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, visionApplies, { timeout: 30000 });
  await page.waitForTimeout(200);
  const vision = await page.evaluate(() => {
    const calls = window.__aiCalls.filter((c) => c.method === "POST");
    const last = calls.at(-1);
    const parts = last?.body?.contents?.at(-1)?.parts ?? [];
    const system = last?.body?.systemInstruction?.parts?.[0]?.text ?? "";
    const marker = "CURRENT TOPOLOGY (JSON):";
    const at = system.indexOf(marker);
    let topology = null;
    if (at >= 0) {
      try {
        topology = JSON.parse(system.slice(at + marker.length).trim());
      } catch {
        topology = null;
      }
    }
    const capture = window.__marmaracad.lastCapture?.();
    return {
      image: parts.find((p) => p.inlineData)?.inlineData ?? null,
      hasTopology: at >= 0,
      topology: topology && {
        holeAxes: topology.holeAxes,
        bbox: topology.part?.bbox,
        corners: topology.edges?.filter((e) => e.isOuterCorner).map((e) => e.index),
        faces: topology.faces?.length,
        edges: topology.edges?.length,
        selection: topology.selection,
      },
      capture: capture && { bytes: capture.bytes, content: capture.content, fallback: capture.fallback, width: capture.width, height: capture.height },
      systemChars: system.length,
    };
  });
  record(
    "Every request attaches the viewport JPEG and the B-Rep topology (hole axis + four outer corners)",
    vision.image?.mimeType === "image/jpeg" &&
      (vision.image?.data?.length ?? 0) > 2000 &&
      vision.hasTopology &&
      Array.isArray(vision.topology?.holeAxes) &&
      vision.topology.holeAxes.includes("y") &&
      vision.topology?.corners?.length === 4 &&
      vision.topology?.faces === 13 &&
      vision.topology?.edges === 30 &&
      (vision.capture?.bytes ?? 0) > 1000 &&
      (vision.capture?.content ?? 0) > 0.01,
    {
      imageBytes: Math.round(((vision.image?.data?.length ?? 0) * 3) / 4),
      topology: vision.topology,
      capture: vision.capture,
      systemChars: vision.systemChars,
    },
  );

  await page.uncheck("#ai-send-view");
  const textOnlyApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "Repeat that without the picture");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, textOnlyApplies, { timeout: 30000 });
  await page.waitForTimeout(200);
  const textOnly = await page.evaluate(() => {
    const calls = window.__aiCalls.filter((c) => c.method === "POST");
    const last = calls.at(-1);
    const parts = last?.body?.contents?.at(-1)?.parts ?? [];
    const system = last?.body?.systemInstruction?.parts?.[0]?.text ?? "";
    return { images: parts.filter((p) => p.inlineData).length, hasTopology: system.includes("CURRENT TOPOLOGY (JSON):") };
  });
  record("Turning Send viewport view off removes only the image, not the topology", textOnly.images === 0 && textOnly.hasTopology, textOnly);
  await page.check("#ai-send-view");

  // --- Targeted fillet: only the four outer corner edges, matching the analytic loss.
  const prepared = await page.evaluate(async () => {
    const api = window.__marmaracad;
    const part = api.doc().parts[0];
    const base = part.features.find((f) => f.type === "extrude" && f.params?.depth === 10);
    base.params.depth = 18;
    part.features = [base];
    await api.app.rebuild();
    const mesh = api.meshes().get(part.id);
    const summary = api.topology();
    return {
      volume: mesh?.volume,
      corners: summary.edges.filter((e) => e.isOuterCorner).map((e) => e.index),
      holeAxes: summary.holeAxes,
    };
  });
  record(
    "Test plate is 120 × 80 × 18 with four outer corners parallel to the holes",
    Math.abs((prepared.volume ?? 0) - 168219.56) < 2 && prepared.corners.length === 4 && prepared.holeAxes.includes("y"),
    prepared,
  );
  await page.evaluate(() => {
    window.__aiReply = {
      message: "Filleted only the four outer corners.",
      commands: [{ action: "fillet", params: { radius: 10, edges: { axis: "parallel-to-holes", outerOnly: true, straightOnly: true } } }],
    };
  });
  const filletApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "Sadece deliklerle aynı yöndeki dış dört köşeye 10 mm radyus ver");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, filletApplies, { timeout: 30000 });
  await page.locator(".ai-apply").last().click();
  await page.waitForFunction(
    () => {
      const api = window.__marmaracad;
      const part = api.doc().parts[0];
      const mesh = api.meshes().get(part.id);
      return !!mesh && part.features.some((f) => f.type === "fillet") && mesh.volume < 168000;
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(300);
  const filleted = await page.evaluate(() => {
    const api = window.__marmaracad;
    const part = api.doc().parts[0];
    const mesh = api.meshes().get(part.id);
    const feature = part.features.find((f) => f.type === "fillet");
    return {
      volume: mesh?.volume,
      radius: feature?.params?.radius,
      edgeIndices: feature?.params?.edgeIndices,
      warnings: mesh?.warnings,
      faces: mesh?.faces.length,
      edges: mesh?.edges.length,
    };
  });
  const loss = (prepared.volume ?? 0) - (filleted.volume ?? 0);
  record(
    "The selector fillets exactly the four outer corners and removes ≈1,545 mm³",
    JSON.stringify(filleted.edgeIndices) === JSON.stringify(prepared.corners) &&
      Math.abs((filleted.radius ?? 0) - 10) < 1e-9 &&
      Math.abs(loss - 1545.13) < 2 &&
      (filleted.warnings?.length ?? 0) === 0,
    { ...filleted, loss, corners: prepared.corners },
  );

  // --- AI force/direction must land in the study as a support + load.
  await page.evaluate(() => {
    window.__aiReply = {
      message: "Created the plate and a static study.",
      commands: [
        { action: "box", params: { length: 40, width: 20, height: 10 } },
        { action: "fea", params: { force: 250, direction: "down", meshSize: 5 } },
      ],
    };
  });
  const feaApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "40x20x10 plate, fix one end, push 250 N down");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, feaApplies, { timeout: 20000 });
  await page.locator(".ai-apply").last().click();
  await page.waitForFunction(
    () => {
      const doc = window.__marmaracad.doc();
      const study = doc.analyses.at(-1);
      return doc.mode === "analysis" && !!study && study.supports.length === 1 && study.loads.length === 1;
    },
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(400);
  const fea = await page.evaluate(() => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const study = doc.analyses.at(-1);
    const part = doc.parts.find((p) => p.id === study.partId);
    const mesh = part ? api.meshes().get(part.id) : undefined;
    return {
      mode: doc.mode,
      volume: mesh?.volume,
      supports: study.supports.map((s) => ({ faceIndex: s.faceIndex, normal: s.face.normal })),
      loads: study.loads.map((l) => ({ type: l.type, magnitude: l.magnitude, direction: l.direction, faceIndex: l.faceIndex })),
      status: study.status,
    };
  });
  record(
    "AI fea binds a fixed support on the lowest X face and a 250 N −Y force on the free end",
    fea.mode === "analysis" &&
      Math.abs((fea.volume ?? 0) - 8000) < 2 &&
      fea.supports.length === 1 &&
      fea.supports[0].normal[0] < -0.9 &&
      fea.loads.length === 1 &&
      fea.loads[0].type === "force" &&
      Math.abs(fea.loads[0].magnitude - 250) < 1e-6 &&
      Math.abs(fea.loads[0].direction[1] + 1) < 1e-6 &&
      fea.loads[0].faceIndex !== fea.supports[0].faceIndex,
    fea,
  );

  // --- AI mirror/pattern are whitelisted and build real features.
  await page.evaluate(() => {
    window.__aiReply = {
      message: "Patterned and mirrored the plate.",
      commands: [
        { action: "box", params: { length: 20, width: 20, height: 10 } },
        { action: "pattern", params: { axis: "x", count: 3, spacing: 40 } },
        { action: "mirror", params: { plane: "right" } },
      ],
    };
  });
  const bodyBefore = await page.evaluate(() => window.__marmaracad.doc().parts.length);
  const bodyApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "20 mm cube, 3 copies 40 mm apart, mirror it");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, bodyApplies, { timeout: 20000 });
  await page.locator(".ai-apply").last().click();
  await page.waitForFunction(
    (n) => {
      const api = window.__marmaracad;
      const doc = api.doc();
      const part = doc.parts[n];
      const mesh = part ? api.meshes().get(part.id) : undefined;
      return doc.parts.length === n + 1 && !!mesh && mesh.volume > 19000;
    },
    bodyBefore,
    { timeout: 180000 },
  );
  await page.waitForTimeout(300);
  const bodyFeatures = await page.evaluate((n) => {
    const api = window.__marmaracad;
    const doc = api.doc();
    const part = doc.parts[n];
    const mesh = api.meshes().get(part.id);
    return {
      name: part?.name,
      features: part?.features.map((f) => f.type),
      volume: mesh?.volume,
      bbox: mesh?.bbox,
    };
  }, bodyBefore);
  record(
    "AI pattern + mirror build a 3-copy mirrored body (≈20,000 mm³, −90…90 mm)",
    bodyFeatures.features?.includes("pattern") &&
      bodyFeatures.features?.includes("mirror") &&
      Math.abs((bodyFeatures.volume ?? 0) - 20000) < 60 &&
      (bodyFeatures.bbox?.min[0] ?? 0) < -85 &&
      (bodyFeatures.bbox?.max[0] ?? 0) > 85,
    bodyFeatures,
  );

  // --- AI mate: load the Box + Lid assembly, lift the lid, then let the mate solve it.
  await newDocument(page);
  await page.click('[data-menu="file"]');
  await page.click('[data-menu-action="templates"]');
  await page.waitForSelector('[data-template="box-lid"]');
  await page.click('[data-template="box-lid"]');
  await page.click(".modal .btn.primary");
  await waitForRebuild(page);
  await page.waitForFunction(() => window.__marmaracad.doc().parts.length === 2, null, { timeout: 60000 });
  await page.evaluate(() => {
    const app = window.__marmaracad.app;
    const lid = window.__marmaracad.doc().components.find((c) => /Lid/i.test(c.name));
    lid.position = [0, 45, 0];
    app.refreshScene();
    app.refreshTree();
  });
  await page.evaluate(() => {
    window.__aiReply = { message: "Mated the lid to the box.", commands: [{ action: "mate", params: { type: "coincident" } }] };
  });
  const mateApplies = await page.locator(".ai-apply").count();
  await page.fill("#ai-prompt", "Mate the lid onto the box");
  await page.click("#ai-send");
  await page.waitForFunction((n) => document.querySelectorAll(".ai-apply").length > n, mateApplies, { timeout: 20000 });
  await page.locator(".ai-apply").last().click();
  await page.waitForFunction(() => window.__marmaracad.doc().mates.length >= 1, null, { timeout: 60000 });
  await page.waitForTimeout(400);
  const mate = await page.evaluate(() => {
    const doc = window.__marmaracad.doc();
    const lid = doc.components.find((c) => /Lid/i.test(c.name));
    const box = doc.components.find((c) => /Box/i.test(c.name));
    const m = doc.mates.at(-1);
    return {
      count: doc.mates.length,
      name: m?.name,
      type: m?.type,
      differentComponents: !!m && m.a.componentId === box?.id && m.b.componentId === lid?.id,
      lidY: lid?.position[1],
      mode: doc.mode,
    };
  });
  record(
    "AI mate pairs the box top with the lid bottom and seats the lid at y = 30",
    mate.count === 1 && mate.type === "coincident" && mate.differentComponents && Math.abs((mate.lidY ?? 0) - 30) < 0.5,
    mate,
  );

  // Clearing the key removes it from localStorage and the cookie.
  await page.click("#ai-key-clear");
  await page.waitForTimeout(200);
  const cleared = await page.evaluate(() => ({
    stored: localStorage.getItem("marmaracad.gemini.apiKey"),
    cookie: document.cookie,
    state: document.getElementById("ai-key-state")?.textContent,
    models: document.querySelectorAll("#ai-model option").length,
  }));
  record(
    "Clear API Key removes the local key and resets the model list",
    cleared.stored === null && !/marmaracad_gemini_key=/.test(cleared.cookie) && cleared.state === "No key",
    cleared,
  );

  console.log("RESULT", results.every((r) => r.pass) ? "PASS" : "FAIL", JSON.stringify({ results, errors }, null, 2));
  if (!results.every((r) => r.pass) || errors.length) process.exitCode = 1;
} catch (error) {
  console.error("SUITE ERROR", error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
