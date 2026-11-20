import { h } from "./dom";
import { hydrateIcons, icon } from "./icons";

export interface ModalAction {
  label: string;
  value: string;
  kind?: "primary" | "danger" | "plain";
}

export interface ModalOptions {
  title: string;
  icon?: string;
  body: string | HTMLElement;
  actions?: ModalAction[];
  width?: number;
  onMount?: (root: HTMLElement, close: (value: string | null) => void) => void;
}

let activeModal: { root: HTMLElement; close: (value: string | null) => void } | null = null;

function layer(): HTMLElement {
  let el = document.getElementById("modal-layer");
  if (!el) {
    el = h("div", { id: "modal-layer", class: "modal-layer" });
    document.body.appendChild(el);
  }
  return el;
}

export function openModal(options: ModalOptions): Promise<string | null> {
  if (activeModal) activeModal.close(null);
  return new Promise((resolve) => {
    const layerEl = layer();
    layerEl.innerHTML = "";
    layerEl.classList.add("open");
    const modal = h("div", { class: "modal" });
    if (options.width) modal.style.width = `min(${options.width}px, 94vw)`;
    const head = h(
      "div",
      { class: "modal-head" },
      `${options.icon ? icon(options.icon) : icon("info")}<span>${options.title}</span><button class="close" aria-label="Close">${icon("x")}</button>`,
    );
    const body = h("div", { class: "modal-body" });
    if (typeof options.body === "string") body.innerHTML = options.body;
    else body.appendChild(options.body);
    const actions = options.actions ?? [{ label: "Close", value: "close", kind: "plain" }];
    const foot = h("div", { class: "modal-foot" });
    for (const action of actions) {
      const btn = h("button", {
        class: `btn ${action.kind ?? "plain"}`,
        text: action.label,
      });
      btn.addEventListener("click", () => close(action.value));
      foot.appendChild(btn);
    }
    modal.append(head, body, foot);
    layerEl.appendChild(modal);
    hydrateIcons();

    const close = (value: string | null) => {
      layerEl.classList.remove("open");
      layerEl.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      activeModal = null;
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = options.actions?.find((a) => a.kind === "primary");
        if (primary) close(primary.value);
      }
    };
    head.querySelector(".close")?.addEventListener("click", () => close(null));
    layerEl.onclick = (e) => {
      if (e.target === layerEl) close(null);
    };
    document.addEventListener("keydown", onKey);
    options.onMount?.(body, close);
    activeModal = { root: modal, close };
    const firstInput = body.querySelector<HTMLInputElement>("input, select, textarea");
    firstInput?.focus();
    if (firstInput instanceof HTMLInputElement && firstInput.type === "number") firstInput.select();
    setTimeout(() => firstInput?.focus(), 30);
  });
}

export function promptNumber(options: {
  title: string;
  label: string;
  value: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}): Promise<number | null> {
  const body = h("div", { class: "prompt-body" });
  let inputRef: HTMLInputElement | null = null;
  body.innerHTML = `
    <label style="display:block;font-size:11px;color:#5a6c7e;margin-bottom:5px;">${options.label}</label>
    <div style="display:flex; align-items:center; gap:8px;">
      <input id="prompt-value" type="number" step="${options.step ?? "any"}" value="${options.value}" style="font-family:var(--mono); font-size:15px; height:34px;" />
      <span style="font-family:var(--mono);color:#6b7f92;font-size:12px;min-width:26px;">${options.unit ?? ""}</span>
    </div>
    ${options.hint ? `<div class="hint" style="margin-top:8px;">${options.hint}</div>` : ""}
  `;
  return openModal({
    title: options.title,
    icon: "ruler",
    body,
    width: 380,
    actions: [
      { label: "Cancel", value: "cancel", kind: "plain" },
      { label: "OK", value: "ok", kind: "primary" },
    ],
    onMount: () => {
      inputRef = body.querySelector<HTMLInputElement>("#prompt-value");
    },
  }).then((result) => {
    if (result !== "ok" || !inputRef) return null;
    let n = Number(inputRef.value);
    if (!Number.isFinite(n)) return null;
    if (options.min !== undefined) n = Math.max(options.min, n);
    if (options.max !== undefined) n = Math.min(options.max, n);
    return n;
  });
}

export function confirmDialog(title: string, message: string, confirmLabel = "Delete"): Promise<boolean> {
  return openModal({
    title,
    icon: "alert-triangle",
    body: `<p>${message}</p>`,
    width: 390,
    actions: [
      { label: "Cancel", value: "cancel", kind: "plain" },
      { label: confirmLabel, value: "ok", kind: "danger" },
    ],
  }).then((r) => r === "ok");
}

export function alertDialog(title: string, html: string, iconName = "info"): Promise<void> {
  return openModal({
    title,
    icon: iconName,
    body: html,
    width: 430,
    actions: [{ label: "Close", value: "close", kind: "primary" }],
  }).then(() => undefined);
}

export type ToastKind = "info" | "success" | "warn" | "error";

export function toast(message: string, kind: ToastKind = "info", timeout = 4200): void {
  let stack = document.getElementById("toast-stack");
  if (!stack) {
    stack = h("div", { id: "toast-stack", class: "toast-stack" });
    document.body.appendChild(stack);
  }
  const iconName = kind === "error" ? "alert-triangle" : kind === "warn" ? "alert-triangle" : kind === "success" ? "check-circle-2" : "info";
  const el = h(
    "div",
    { class: `toast ${kind}` },
    `${icon(iconName)}<div class="toast-text">${message}</div><button class="close" aria-label="Dismiss">×</button>`,
  );
  const remove = () => el.remove();
  el.querySelector(".close")?.addEventListener("click", remove);
  stack.appendChild(el);
  hydrateIcons();
  window.setTimeout(remove, timeout);
}
