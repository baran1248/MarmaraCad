/* Floating numeric input that follows the sketch cursor.
 *
 * SolidWorks-style: while a drawing tool is armed the length/angle boxes track
 * the pointer; typing a digit starts editing the first box, Tab moves to the
 * next, Enter draws with exactly those values. */
export interface DynField {
  key: string;
  label: string;
  unit: string;
  value: number;
  digits?: number;
}

export class DynamicInput {
  readonly root: HTMLDivElement;
  private fields: DynField[] = [];
  private overrides = new Map<string, number>();
  private active = 0;
  private draft = "";
  private dirty = false;
  private committed: ((values: Record<string, number>) => void) | null = null;
  private cancelled: (() => void) | null = null;
  private visible = false;

  constructor(container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "dyn-input";
    this.root.style.display = "none";
    container.appendChild(this.root);
  }

  setHandlers(commit: (values: Record<string, number>) => void, cancel: () => void): void {
    this.committed = commit;
    this.cancelled = cancel;
  }

  show(clientX: number, clientY: number, fields: DynField[]): void {
    // Keep user-typed values for keys that survive between frames.
    const kept = new Map<string, number>();
    for (const f of fields) {
      const override = this.overrides.get(f.key);
      if (override !== undefined) kept.set(f.key, override);
    }
    this.overrides = kept;
    this.fields = fields;
    this.visible = true;
    this.root.style.display = "";
    this.root.style.left = `${Math.round(clientX)}px`;
    this.root.style.top = `${Math.round(clientY)}px`;
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.dirty = false;
    this.draft = "";
    this.active = 0;
    this.overrides.clear();
    this.root.style.display = "none";
    this.root.innerHTML = "";
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Current effective values (typed overrides win over live pointer values). */
  values(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of this.fields) out[f.key] = this.overrides.get(f.key) ?? f.value;
    return out;
  }

  private render(): void {
    if (!this.visible) return;
    this.root.innerHTML = this.fields
      .map((f, i) => {
        const typed = i === this.active && this.dirty;
        const value = typed ? this.draft : (this.overrides.get(f.key)?.toFixed(f.digits ?? 2) ?? f.value.toFixed(f.digits ?? 2));
        return `<div class="dyn-field ${i === this.active ? "active" : ""}">
          <span class="dyn-label">${f.label}</span>
          <span class="dyn-value">${value || "0"}</span>
          <span class="dyn-unit">${f.unit}</span>
        </div>`;
      })
      .join("");
  }

  /** Returns true when the key was consumed by the dynamic input. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.visible || this.fields.length === 0) return false;
    const key = event.key;
    if (/^[0-9]$/.test(key) || key === "." || (key === "-" && this.dirty === false)) {
      this.dirty = true;
      this.draft += key;
      this.render();
      return true;
    }
    if (key === "Backspace" && this.dirty) {
      this.draft = this.draft.slice(0, -1);
      this.render();
      return true;
    }
    if (key === "Tab" || key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      this.commitDraft();
      const dir = key === "ArrowLeft" ? -1 : 1;
      this.active = (this.active + dir + this.fields.length) % this.fields.length;
      this.dirty = false;
      this.draft = "";
      this.render();
      return true;
    }
    if (key === "Enter") {
      event.preventDefault();
      this.commitDraft();
      const values = this.values();
      this.committed?.(values);
      return true;
    }
    if (key === "Escape") {
      event.preventDefault();
      this.dirty = false;
      this.draft = "";
      this.overrides.clear();
      this.cancelled?.();
      this.render();
      return true;
    }
    return false;
  }

  private commitDraft(): void {
    if (!this.dirty) return;
    const value = Number(this.draft);
    if (Number.isFinite(value) && this.draft.trim() !== "") this.overrides.set(this.fields[this.active].key, value);
    this.dirty = false;
    this.draft = "";
  }
}
