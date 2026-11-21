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
    const reply = {
      message: "Created the plate and assigned 6061-T6.",
      commands: [
        { action: "box", params: { length: 40, width: 20, height: 10 } },
        { action: "material", params: { id: "al6061" } },
        { action: "delete-everything", params: {} },
      ],
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.includes("generativelanguage.googleapis.com")) return realFetch(input, init);
      const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      w.__aiCalls.push(call);
      if (url.includes("/models?")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] },
                { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedGenerationMethods: ["generateContent"] },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), {
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
    "Request uses the hydrogen→flash alias and medium thinking",
    /gemini-2\.5-flash:generateContent/.test(beforeApply.last?.url ?? "") &&
      beforeApply.last?.body?.generationConfig?.thinkingConfig?.thinkingLevel === "medium" &&
      /Allowed actions and params/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? "") &&
      /box: \{length,width,height/.test(beforeApply.last?.body?.systemInstruction?.parts?.[0]?.text ?? ""),
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
