import type { CommandEntry } from "./CommandManager";
import { hydrateIcons, icon } from "./icons";

/** SolidWorks/Shapr3D-style instant command search (Ctrl+K).
 *
 *  The palette indexes every ribbon command in both English and Turkish, plus a
 *  keyword list of engineering synonyms ("delik", "açınım", "malzeme", "mesh"…),
 *  so the command can be found in whichever language comes to mind. */
export class CommandPalette {
  private layer: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private empty: HTMLElement;
  private entries: () => CommandEntry[];
  private filtered: CommandEntry[] = [];
  private index = 0;
  private open = false;
  /** Commands executed from the palette (the Shell forwards them to onCommand). */
  onRun: (action: string) => void = () => undefined;

  constructor(layer: HTMLElement, entries: () => CommandEntry[]) {
    this.layer = layer;
    this.entries = entries;
    layer.innerHTML = `
      <div class="cp-dialog" role="dialog" aria-label="Command Search">
        <div class="cp-search">${icon("search")}<input id="cp-input" type="text" placeholder="Search commands — try “delik”, “fillet”, “açınım”, “malzeme”…" autocomplete="off" spellcheck="false" /><kbd>Esc</kbd></div>
        <div class="cp-list" id="cp-list" role="listbox"></div>
        <div class="cp-empty" id="cp-empty" hidden>No command matches that search.</div>
        <div class="cp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> run</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> close</span></div>
      </div>`;
    this.input = layer.querySelector<HTMLInputElement>("#cp-input")!;
    this.list = layer.querySelector<HTMLElement>("#cp-list")!;
    this.empty = layer.querySelector<HTMLElement>("#cp-empty")!;
    this.input.addEventListener("input", () => {
      this.index = 0;
      this.render(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => this.onKey(event));
    layer.addEventListener("pointerdown", (event) => {
      if (event.target === layer) this.close();
    });
    this.list.addEventListener("click", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-cp-action]");
      if (!row) return;
      this.run(row.dataset.cpAction ?? "");
    });
    this.list.addEventListener("pointermove", (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-cp-index]");
      if (!row) return;
      const next = Number(row.dataset.cpIndex);
      if (Number.isFinite(next) && next !== this.index) {
        this.index = next;
        this.paintSelection();
      }
    });
    hydrateIcons();
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    this.open = true;
    this.layer.hidden = false;
    this.input.value = "";
    this.index = 0;
    this.render("");
    this.input.focus();
    this.input.select();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.layer.hidden = true;
    this.input.blur();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  private onKey(event: KeyboardEvent): void {
    // The palette is a modal surface: handled keys must not reach the document
    // listeners (a fresh modal would otherwise close on the very Enter that
    // opened it, because the same event keeps bubbling).
    const handled = ["Escape", "ArrowDown", "ArrowUp", "Tab", "Enter"].includes(event.key);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      return;
    }
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      this.move(1);
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      this.move(-1);
      return;
    }
    if (event.key === "Enter") {
      const entry = this.filtered[this.index];
      if (entry) this.run(entry.action);
    }
  }

  private move(delta: number): void {
    if (!this.filtered.length) return;
    this.index = (this.index + delta + this.filtered.length) % this.filtered.length;
    this.paintSelection();
    const row = this.list.querySelector<HTMLElement>(`[data-cp-index="${this.index}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }

  private run(action: string): void {
    if (!action) return;
    this.close();
    this.onRun(action);
  }

  private paintSelection(): void {
    for (const row of this.list.querySelectorAll<HTMLElement>("[data-cp-index]")) {
      row.classList.toggle("active", Number(row.dataset.cpIndex) === this.index);
    }
  }

  private render(query: string): void {
    this.filtered = searchCommands(this.entries(), query, 12);
    if (!this.filtered.length) {
      this.list.innerHTML = "";
      this.empty.hidden = false;
      return;
    }
    this.empty.hidden = true;
    this.list.innerHTML = this.filtered
      .map(
        (entry, i) => `<button class="cp-row ${i === this.index ? "active" : ""}" data-cp-action="${entry.action}" data-cp-index="${i}" role="option">
          <span class="cp-ic">${icon(entry.icon)}</span>
          <span class="cp-label">${escapeHtml(entry.label)}</span>
          <span class="cp-where">${escapeHtml(entry.tabLabel)} · ${escapeHtml(entry.group)}</span>
        </button>`,
      )
      .join("");
    hydrateIcons();
    this.paintSelection();
  }
}

/** Fold Turkish characters so "acik" finds "açık" and "sigdır" finds "Sığdır". */
export function foldText(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/â/g, "a");
}

/** Subsequence match ("ytf" -> "YuvarTlat F..." not needed, but "sig" -> "sığdır"). */
function subsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Score one command against the query; 0 means no match. */
export function scoreCommand(entry: CommandEntry, rawQuery: string): number {
  const query = foldText(rawQuery.trim());
  if (!query) return 1;
  const label = foldText(entry.label);
  const words = query.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const word of words) {
    let wordScore = 0;
    if (label === word) wordScore = 120;
    else if (label.startsWith(word)) wordScore = 90;
    else if (label.includes(word)) wordScore = 60;
    if (!wordScore) {
      for (const keyword of entry.keywords) {
        const folded = foldText(keyword);
        if (folded === word) wordScore = Math.max(wordScore, 70);
        else if (folded.startsWith(word)) wordScore = Math.max(wordScore, 50);
        else if (folded.includes(word)) wordScore = Math.max(wordScore, 35);
      }
    }
    if (!wordScore) {
      const action = foldText(entry.action);
      if (action.includes(word)) wordScore = 25;
    }
    if (!wordScore && word.length >= 3 && subsequence(word, label)) wordScore = 12;
    if (!wordScore) return 0;
    score += wordScore;
  }
  // Shorter labels win ties: "Fillet" before "Sketch Fillet" for "fillet".
  return score - label.length * 0.01;
}

export function searchCommands(entries: CommandEntry[], query: string, limit = 12): CommandEntry[] {
  const scored = entries
    .map((entry) => ({ entry, score: scoreCommand(entry, query) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((row) => row.entry);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}
