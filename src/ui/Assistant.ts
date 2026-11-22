/* Gemini-powered CAD assistant.
 *
 * The API key never leaves this device: it is stored in localStorage (and
 * optionally a first-party cookie) and calls go straight from the browser to
 * Google's Generative Language API. The system prompt teaches the model the
 * MarmaraCad command schema, and its reply is parsed into a command list that
 * the application applies inside the normal undo/redo transaction. */
import type { ProjectDocument } from "../model/types";
import { createDocument } from "../model/defaults";
import { escapeHtml } from "../utils/misc";
import { icon } from "./icons";

export interface AiCommand {
  action: string;
  params?: Record<string, unknown>;
}

export interface AiReply {
  message: string;
  commands: AiCommand[];
}

export interface AssistantOptions {
  onCommands: (commands: AiCommand[], message: string) => void;
  onStatus?: (text: string) => void;
}

const KEY_STORAGE = "marmaracad.gemini.apiKey";
const MODEL_STORAGE = "marmaracad.gemini.model";
const THINK_STORAGE = "marmaracad.gemini.thinking";
const COOKIE = "marmaracad_gemini_key";

/** Public-facing names used by the panel; `hydrogen` is the default. */
const DEFAULT_MODEL = "hydrogen";
const DEFAULT_MODEL_ID = "gemini-2.5-flash";
const THINK_LEVELS: Record<string, string> = { low: "low", mid: "medium", high: "high" };
const THINK_BUDGETS: Record<string, number> = { low: 1024, mid: 8192, high: 24576 };

/** Google split thinking controls between model generations:
 *  Gemini 3 uses `thinkingLevel`, 2.5 uses a token `thinkingBudget`, and older
 *  models reject the whole `thinkingConfig` object. */
export function thinkingConfigFor(modelId: string, thinking: string): Record<string, unknown> | undefined {
  if (/gemini-3/i.test(modelId)) return { thinkingLevel: THINK_LEVELS[thinking] ?? "medium" };
  if (/gemini-2\.5/i.test(modelId)) return { thinkingBudget: THINK_BUDGETS[thinking] ?? 8192 };
  return undefined;
}

export function systemPrompt(doc: ProjectDocument): string {
  return `You are the MarmaraCad CAD assistant. MarmaraCad is a browser CAD/assembly/FEA app (mm, N, MPa).
You translate Turkish or English natural-language modelling requests into a JSON command list.

Reply with ONE JSON object and nothing else:
{"message":"short explanation in the user's language","commands":[{"action":"...","params":{...}}]}

Allowed actions and params:
- box: {length,width,height,centered?} - create a rectangular part (new document part).
- cylinder: {diameter,height,centered?}
- extrude: {sketch?:"Sketch1",depth,direction?} - extrude an existing sketch.
- cut: {sketch?:"Sketch2",depth,direction?} - extruded cut that removes material from the body.
- revolve: {sketch?:"Sketch1",angle?,axis?:"u"|"v",operation?:"join"|"cut"|"new"} - revolve a sketch.
- fillet: {radius,edges?:"all"} - round the body edges.
- chamfer: {distance,edges?:"all"}
- shell: {thickness}
- mirror: {plane?:"right"|"front"|"top"} - mirror and fuse the body about a base plane.
- pattern: {axis?:"x"|"y"|"z",count,spacing} - linear pattern of the body.
- mate: {type?:"coincident"|"concentric"|"distance",componentA?,componentB?,distance?} - mate two inserted components.
- material: {id:"aisi1020"|"steel"|"al6061"|"ss304"|"ti6al4v"|"abs"|"brass"}
- variable: {name,expression} - global equation, e.g. {"name":"L","expression":"100"}.
- measure: {} - open the measure tool.
- view: {name:"front"|"top"|"right"|"iso"}
- section: {axis:"x"|"y"|"z",offset}
- drawing: {} - generate the technical drawing.
- fea: {material?,meshSize?,force?,pressure?,direction?:"down"|"up"|"x"|"zdown"|"normal"|[x,y,z]} - create/setup a static study; the fixed support goes on the lowest X or Z face and the force/pressure on the opposite end.
- reference-plane: {mode?:"offset"|"angle"|"mid",base?:"front"|"top"|"right",value?} - create reference geometry.
- circular-pattern: {axis?:"x"|"y"|"z",count?,angle?} - circular pattern of the body.
- sweep: {sketch?,pathSketch?} - sweep a profile along a path sketch.
- loft: {sketches?:string[]} - loft between two or more section sketches.
- hole: {diameter?,depth?,type?:"simple"|"counterbore"|"countersink",faceIndex?} - Hole Wizard on the active body.
- exploded-view: {amount?} - set the assembly explode slider (0..1).
- modal: {material?,meshSize?,modes?} - modal study with the first natural frequencies.
- thermal: {material?,meshSize?,temperature?,ambient?} - steady-state thermal study.
- buckling: {material?,meshSize?,force?} - linear buckling study with a compressive end load.
- action: {name:"zoom-fit"|"mass-props"|"interference"|"toolbox-bolt"|"new-sketch"} - run an app command.
Keep models small and printable. If the request is ambiguous, ask a question in "message" and return an empty commands array.
Current document: "${doc.name}", ${doc.parts.length} part(s), mode ${doc.mode}. Active part features: ${
    doc.parts.find((p) => p.id === doc.activePartId)?.features.map((f) => `${f.type}(${f.name})`).join(", ") || "none"
  }.`;
}

function readCookie(name: string): string | null {
  const match = document.cookie.split(";").map((p) => p.trim()).find((p) => p.startsWith(name + "="));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export class Assistant {
  private root: HTMLElement;
  private options: AssistantOptions;
  private key = "";
  private model = DEFAULT_MODEL;
  private modelId = DEFAULT_MODEL_ID;
  private thinking = "mid";
  private models: { id: string; label: string }[] = [];
  private messagesEl: HTMLElement | null = null;
  private keyInput: HTMLInputElement | null = null;
  private modelSelect: HTMLSelectElement | null = null;
  private thinkSelect: HTMLSelectElement | null = null;
  private promptEl: HTMLTextAreaElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private stateEl: HTMLElement | null = null;
  private busy = false;
  private history: { role: "user" | "model"; text: string }[] = [];

  constructor(root: HTMLElement, options: AssistantOptions) {
    this.root = root;
    this.options = options;
    this.key = this.loadKey();
    this.model = localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL;
    this.thinking = localStorage.getItem(THINK_STORAGE) || "mid";
    this.render();
    if (this.key) void this.refreshModels();
  }

  private loadKey(): string {
    try {
      const stored = localStorage.getItem(KEY_STORAGE);
      if (stored) return stored;
    } catch {
      /* storage can be disabled */
    }
    return readCookie(COOKIE) ?? "";
  }

  private saveKey(key: string): void {
    this.key = key;
    try {
      if (key) localStorage.setItem(KEY_STORAGE, key);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* ignore quota/security errors */
    }
    if (key) document.cookie = `${COOKIE}=${encodeURIComponent(key)}; max-age=31536000; path=/; SameSite=Strict`;
    else document.cookie = `${COOKIE}=; max-age=0; path=/`;
  }

  get visible(): boolean {
    return this.root.classList.contains("visible");
  }

  toggle(open = !this.visible): void {
    this.root.classList.toggle("visible", open);
    if (open) this.promptEl?.focus();
  }

  setStatus(text: string): void {
    this.options.onStatus?.(text);
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="ai-head">
        <span class="ai-logo">${icon("sparkles")}</span>
        <div class="ai-title">Gemini CAD assistant<small id="ai-head-state">Local key · no server relay</small></div>
        <button class="ai-close" title="Close">${icon("x")}</button>
      </div>
      <div class="ai-key">
        <input id="ai-key-input" type="password" placeholder="Gemini API key (stored locally)" autocomplete="off" spellcheck="false" />
        <div class="ai-key-row">
          <button class="btn primary" id="ai-key-save">Save key</button>
          <button class="btn" id="ai-key-clear">Clear API Key</button>
          <span class="ai-state" id="ai-key-state">No key</span>
        </div>
        <div class="ai-models">
          <select id="ai-model" title="Model">
            <option value="hydrogen">hydrogen (default)</option>
          </select>
          <select id="ai-thinking" title="Thinking level">
            <option value="low">low</option>
            <option value="mid" selected>mid (medium)</option>
            <option value="high">high</option>
          </select>
        </div>
      </div>
      <div class="ai-scroll" id="ai-scroll">
        <div class="ai-msg bot">Ask in Turkish or English. I can build parts, apply features, assign materials and set up studies. The API key is stored only in this browser; no MarmaraCad server sees it.</div>
      </div>
      <div class="ai-chipbar">
        <button class="ai-chip" data-ai-prompt="Create a 80 x 40 x 20 mm plate">80×40×20 plate</button>
        <button class="ai-chip" data-ai-prompt="Add a 3 mm fillet to all edges">Fillet 3 mm</button>
        <button class="ai-chip" data-ai-prompt="Assign AISI 1020 steel">AISI 1020</button>
        <button class="ai-chip" data-ai-prompt="Set up a static study with a 500 N downward force">FEA 500 N</button>
      </div>
      <div class="ai-foot">
        <textarea id="ai-prompt" placeholder="Describe the change…  (Ctrl+Enter to send)"></textarea>
        <button class="ai-send" id="ai-send" title="Send">${icon("arrow-up-from-line")}</button>
      </div>
      <div class="ai-hint">Model replies are validated; only the listed command actions are applied.</div>
    `;
    this.messagesEl = this.root.querySelector("#ai-scroll");
    this.keyInput = this.root.querySelector("#ai-key-input");
    this.modelSelect = this.root.querySelector("#ai-model");
    this.thinkSelect = this.root.querySelector("#ai-thinking");
    this.promptEl = this.root.querySelector("#ai-prompt");
    this.sendBtn = this.root.querySelector("#ai-send");
    this.stateEl = this.root.querySelector("#ai-key-state");
    if (this.keyInput) this.keyInput.value = this.key;
    if (this.thinkSelect) this.thinkSelect.value = this.thinking;
    if (this.modelSelect) this.modelSelect.value = this.model;
    this.updateKeyState();
    this.root.querySelector(".ai-close")?.addEventListener("click", () => this.toggle(false));
    this.root.querySelector("#ai-key-save")?.addEventListener("click", () => {
      const value = (this.keyInput?.value ?? "").trim();
      if (!value) {
        this.pushMessage("Paste a Gemini API key first.", "error");
        return;
      }
      this.saveKey(value);
      this.updateKeyState();
      this.pushMessage("API key saved locally. Fetching models…", "bot");
      void this.refreshModels();
    });
    this.root.querySelector("#ai-key-clear")?.addEventListener("click", () => {
      this.saveKey("");
      if (this.keyInput) this.keyInput.value = "";
      this.models = [];
      this.renderModelOptions();
      this.updateKeyState();
      this.pushMessage("API key removed from localStorage and the cookie.", "bot");
    });
    this.modelSelect?.addEventListener("change", () => {
      this.model = this.modelSelect?.value ?? DEFAULT_MODEL;
      this.modelId = this.model === DEFAULT_MODEL ? this.defaultModelId() : this.model;
      try {
        localStorage.setItem(MODEL_STORAGE, this.model);
      } catch {
        /* ignore */
      }
      this.updateKeyState();
    });
    this.thinkSelect?.addEventListener("change", () => {
      this.thinking = this.thinkSelect?.value ?? "mid";
      try {
        localStorage.setItem(THINK_STORAGE, this.thinking);
      } catch {
        /* ignore */
      }
      this.updateKeyState();
    });
    this.sendBtn?.addEventListener("click", () => void this.send());
    this.promptEl?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void this.send();
      }
    });
    this.root.querySelectorAll<HTMLElement>("[data-ai-prompt]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!this.promptEl) return;
        this.promptEl.value = button.dataset.aiPrompt ?? "";
        void this.send();
      });
    });
    this.renderModelOptions();
  }

  private updateKeyState(): void {
    if (this.stateEl) {
      this.stateEl.textContent = this.key ? `Key saved · ${this.model} · ${this.thinking}` : "No key";
      this.stateEl.style.color = this.key ? "#2e7d5b" : "#96690c";
    }
    const head = this.root.querySelector("#ai-head-state");
    if (head) head.textContent = `${this.key ? "Local key" : "No key"} · ${this.model} · ${this.thinking}`;
  }

  /** `hydrogen` is the visible default. When Google lists a model with that
   *  exact id use it unchanged, otherwise alias it to the first flash model. */
  private defaultModelId(): string {
    if (this.models.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
    return (this.models.find((m) => /flash/i.test(m.id)) ?? this.models[0])?.id ?? DEFAULT_MODEL_ID;
  }

  private renderModelOptions(): void {
    if (!this.modelSelect) return;
    const hydrogen = this.models.find((m) => m.id === DEFAULT_MODEL);
    const fallback = hydrogen ?? this.models.find((m) => /flash/i.test(m.id)) ?? this.models[0];
    const list = this.models.length
      ? [
          { id: DEFAULT_MODEL, label: hydrogen ? "hydrogen (default)" : `hydrogen (default · ${fallback.label})` },
          ...this.models.filter((m) => m.id !== DEFAULT_MODEL).map((m) => ({ id: m.id, label: m.label })),
        ]
      : [{ id: DEFAULT_MODEL, label: "hydrogen (default)" }];
    this.modelSelect.innerHTML = list
      .map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`)
      .join("");
    let selected = list.find((m) => m.id === this.model);
    if (!selected) {
      this.model = DEFAULT_MODEL;
      selected = list[0];
    }
    if (selected) {
      this.modelSelect.value = selected.id;
      if (selected.id === DEFAULT_MODEL) {
        this.model = DEFAULT_MODEL;
        this.modelId = this.defaultModelId();
      } else {
        this.model = selected.id;
        this.modelId = selected.id;
      }
    }
  }

  async refreshModels(): Promise<void> {
    if (!this.key) return;
    this.setStatus("Listing Gemini models…");
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.key)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
      const models = (data.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => {
          const id = m.name.replace(/^models\//, "");
          return { id, label: m.displayName ?? id };
        });
      this.models = models;
      // `hydrogen` stays the visible default; it is used directly when the API
      // lists that id, otherwise aliased to the first flash model.
      this.renderModelOptions();
      this.updateKeyState();
      this.setStatus(`${this.models.length} model(s) available`);
      this.pushMessage(
        `${this.models.length} Gemini model(s) listed. Default is hydrogen (${this.modelId}), thinking mid.`,
        "bot",
      );
    } catch (error) {
      this.pushMessage(`Could not list models: ${error instanceof Error ? error.message : String(error)}`, "error");
      this.setStatus("Model listing failed");
    }
  }

  private pushMessage(text: string, kind: "bot" | "user" | "error", commands?: AiCommand[]): void {
    if (!this.messagesEl) return;
    const el = document.createElement("div");
    el.className = `ai-msg ${kind === "error" ? "error" : kind}`;
    el.innerHTML = `<div>${escapeHtml(text)}</div>`;
    if (commands && commands.length) {
      const list = document.createElement("div");
      list.className = "ai-cmds";
      list.innerHTML = commands
        .map((c) => `<div class="ai-cmd">${icon("play")}<span>${escapeHtml(c.action)} ${escapeHtml(JSON.stringify(c.params ?? {}))}</span></div>`)
        .join("");
      el.appendChild(list);
      const apply = document.createElement("button");
      apply.className = "ai-apply";
      apply.textContent = `Apply ${commands.length} command(s)`;
      apply.addEventListener("click", () => {
        apply.disabled = true;
        apply.textContent = "Applied";
        this.options.onCommands(commands, text);
      });
      el.appendChild(apply);
    }
    this.messagesEl.appendChild(el);
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  async send(): Promise<void> {
    if (this.busy) return;
    const prompt = (this.promptEl?.value ?? "").trim();
    if (!prompt) return;
    if (!this.key) {
      this.pushMessage("Add a Gemini API key first. It is stored locally and used only for direct API calls.", "error");
      this.keyInput?.focus();
      return;
    }
    if (this.promptEl) this.promptEl.value = "";
    this.pushMessage(prompt, "user");
    this.history.push({ role: "user", text: prompt });
    this.busy = true;
    if (this.sendBtn) this.sendBtn.disabled = true;
    this.setStatus("Gemini is thinking…");
    try {
      const debugDoc = (window as unknown as { __marmaracad?: { doc?: () => ProjectDocument } }).__marmaracad?.doc?.();
      const generationConfig: Record<string, unknown> = {
        temperature: 0.15,
        responseMimeType: "application/json",
      };
      const thinkingConfig = thinkingConfigFor(this.modelId, this.thinking);
      if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
      const body = {
        systemInstruction: { parts: [{ text: systemPrompt(debugDoc ?? createDocument()) }] },
        contents: [
          ...this.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
        ],
        generationConfig,
      };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent?key=${encodeURIComponent(this.key)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const reply = parseReply(text);
      this.history.push({ role: "model", text });
      if (reply.commands.length) {
        this.pushMessage(reply.message, "bot", reply.commands);
      } else {
        this.pushMessage(reply.message || "I could not produce a command for that request.", "bot");
      }
      this.setStatus("Gemini replied");
    } catch (error) {
      this.pushMessage(`Gemini request failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      this.setStatus("Gemini request failed");
    } finally {
      this.busy = false;
      if (this.sendBtn) this.sendBtn.disabled = false;
      this.promptEl?.focus();
    }
  }
}

/** Extract the first JSON object and coerce it into the command schema. */
export function parseReply(text: string): AiReply {
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try {
    const parsed = JSON.parse(raw) as { message?: string; commands?: unknown };
    const commands: AiCommand[] = Array.isArray(parsed.commands)
      ? parsed.commands
          .filter((c): c is AiCommand => !!c && typeof c === "object" && typeof (c as { action?: unknown }).action === "string")
          .map((c) => ({ action: c.action, params: typeof c.params === "object" && c.params ? c.params : {} }))
      : [];
    return { message: typeof parsed.message === "string" ? parsed.message : "", commands };
  } catch {
    return { message: text.trim(), commands: [] };
  }
}
