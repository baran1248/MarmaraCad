import { escapeHtml } from "../utils/misc";

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  html?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "text") el.textContent = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  if (html !== undefined) el.innerHTML = html;
  return el;
}

export function qs<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

export function inputValue(root: ParentNode, selector: string): string {
  return (qs<HTMLInputElement>(root, selector)?.value ?? "").trim();
}

export function numberValue(root: ParentNode, selector: string, fallback = 0): number {
  const v = Number((qs<HTMLInputElement>(root, selector)?.value ?? "").trim());
  return Number.isFinite(v) ? v : fallback;
}

export function checkedValue(root: ParentNode, selector: string): boolean {
  return !!qs<HTMLInputElement>(root, selector)?.checked;
}

export function escape(text: string): string {
  return escapeHtml(text);
}

export function fmtMm(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + " m";
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1) + " mm";
  return v.toFixed(v % 1 === 0 ? 0 : 1) + " mm";
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: any[]) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}
