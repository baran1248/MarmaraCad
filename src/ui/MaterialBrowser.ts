import { MATERIALS, MATERIAL_CATEGORIES, matchesMaterialQuery, type MaterialCategory } from "../analysis/materials";
import type { FeaMaterial } from "../model/types";
import { escapeHtml, fmt } from "../utils/misc";
import { hydrateIcons, icon } from "./icons";

/** The editable field set stored in `part.materialOverride`. */
export interface MaterialOverride {
  name: string;
  E: number;
  nu: number;
  G: number;
  yield: number;
  uts: number;
  density: number;
  conductivity: number;
  specificHeat: number;
  cte: number;
  color: string;
  metalness: number;
  roughness: number;
}

export interface MaterialDraft {
  materialId: string;
  /** Only present when the user edited a value (or picked Custom). */
  override?: MaterialOverride;
}

export interface MaterialBrowser {
  body: HTMLElement;
  /** Read the current selection when the dialog is applied. */
  value: () => MaterialDraft;
}

function draftFrom(material: FeaMaterial, name = material.name): MaterialOverride {
  return {
    name,
    E: material.E,
    nu: material.nu,
    G: material.G,
    yield: material.yield,
    uts: material.uts,
    density: material.density,
    conductivity: material.conductivity,
    specificHeat: material.specificHeat,
    cte: material.cte,
    color: material.color,
    metalness: material.metalness,
    roughness: material.roughness,
  };
}

function row(label: string, id: string, value: number | string, unit: string, step = "any"): string {
  const isColor = id === "mat-color";
  const isRange = id === "mat-metalness" || id === "mat-roughness";
  if (isColor) {
    return `<div class="mbt-row"><span class="mbt-label">${label}</span><input id="${id}" type="color" value="${value}" /><span class="mbt-unit">${unit}</span></div>`;
  }
  if (isRange) {
    return `<div class="mbt-row"><span class="mbt-label">${label}</span><input id="${id}" type="range" min="0" max="1" step="0.01" value="${value}" /><span class="mbt-unit mono" id="${id}-out">${Number(value).toFixed(2)}</span></div>`;
  }
  return `<div class="mbt-row"><span class="mbt-label">${label}</span><input id="${id}" class="mono" type="number" step="${step}" value="${value}" /><span class="mbt-unit">${unit}</span></div>`;
}

/** Ansys Engineering Data-style material browser: search, category tabs,
 *  the full mechanical + thermal property table and per-part custom edits. */
export function createMaterialBrowser(currentId: string | undefined, effective: FeaMaterial, hasOverride = false): MaterialBrowser {
  let selectedId = currentId && MATERIALS.some((m) => m.id === currentId) ? currentId : effective.id;
  let category: MaterialCategory | "All" = "All";
  let query = "";
  let dirty = hasOverride || currentId === "custom";
  const body = document.createElement("div");
  body.className = "mat-browser";

  const cats: (MaterialCategory | "All")[] = ["All", ...MATERIAL_CATEGORIES];
  body.innerHTML = `
    <aside class="mbt-side">
      <div class="mbt-search">${icon("search")}<input id="mat-search" type="text" placeholder="Search materials — steel, alüminyum, polymer…" autocomplete="off" spellcheck="false" /></div>
      <div class="mbt-cats" id="mat-cats">${cats
        .map((c) => `<button class="mbt-cat ${c === category ? "active" : ""}" data-mat-cat="${escapeHtml(c)}">${c === "All" ? "All" : escapeHtml(c)}</button>`)
        .join("")}</div>
      <div class="mbt-list" id="mat-list" role="listbox"></div>
      <div class="mbt-count hint" id="mat-count"></div>
    </aside>
    <section class="mbt-detail">
      <div class="mbt-head">
        <span class="mbt-sphere" id="mat-sphere"></span>
        <div class="mbt-title">
          <div id="mat-preview-name">${escapeHtml(effective.name)}</div>
          <div class="hint" id="mat-preview-meta"></div>
        </div>
        <span class="mbt-badge" id="mat-badge">Library</span>
      </div>
      <div class="mbt-group">
        <div class="mbt-group-head">${icon("ruler")} Mechanical</div>
        ${row("Young's modulus E", "mat-E", effective.E, "MPa", "100")}
        ${row("Shear modulus G", "mat-G", effective.G, "MPa", "100")}
        ${row("Poisson ratio ν", "mat-nu", effective.nu, "—", "0.01")}
        ${row("Yield strength σy", "mat-yield", effective.yield, "MPa", "1")}
        ${row("Ultimate strength σu", "mat-uts", effective.uts, "MPa", "1")}
      </div>
      <div class="mbt-group">
        <div class="mbt-group-head">${icon("flame")} Physical &amp; thermal</div>
        ${row("Density ρ", "mat-density", effective.density, "kg/m³", "1")}
        ${row("Conductivity k", "mat-conductivity", effective.conductivity, "W/(mm·K)", "0.0001")}
        ${row("Specific heat cp", "mat-specificHeat", effective.specificHeat, "J/(kg·K)", "1")}
        ${row("CTE α", "mat-cte", effective.cte, "1/K", "0.0000001")}
      </div>
      <div class="mbt-group">
        <div class="mbt-group-head">${icon("palette")} Studio appearance</div>
        ${row("Base color", "mat-color", effective.color, "")}
        ${row("Metalness", "mat-metalness", effective.metalness, "")}
        ${row("Roughness", "mat-roughness", effective.roughness, "")}
      </div>
      <div class="mbt-note hint" id="mat-note">
        Values come from MatWeb / ASM / Ansys Granta room-temperature data. Electrical conductivity is not modelled.
      </div>
    </section>`;

  const list = body.querySelector<HTMLElement>("#mat-list")!;
  const count = body.querySelector<HTMLElement>("#mat-count")!;
  const search = body.querySelector<HTMLInputElement>("#mat-search")!;

  const labelFor = (material: FeaMaterial): string => {
    if (material.id !== selectedId) return material.name;
    return dirty ? `${material.name} (edited)` : material.name;
  };

  const renderList = (): void => {
    const needle = query.trim().toLocaleLowerCase("tr");
    const matches = MATERIALS.filter((material) => {
      if (category !== "All" && material.category !== category) return false;
      if (!needle) return true;
      return matchesMaterialQuery(material, needle);
    });
    count.textContent = `${matches.length} of ${MATERIALS.length} materials`;
    list.innerHTML = matches.length
      ? matches
          .map(
            (material) => `<button class="material-row ${material.id === selectedId ? "active" : ""}" data-material="${material.id}" role="option" aria-selected="${material.id === selectedId}">
              <span class="material-swatch" style="background:${material.color}"></span>
              <span class="mbt-row-main"><span class="name">${escapeHtml(labelFor(material))}</span>
              <span class="props">${escapeHtml(material.category)} · E ${material.E >= 1000 ? `${fmt(material.E / 1000, 1)} GPa` : `${fmt(material.E, 0)} MPa`} · k ${fmt(material.conductivity, 4)}</span></span>
              ${material.id === selectedId ? icon("check") : ""}
            </button>`,
          )
          .join("")
      : `<div class="hint" style="padding:12px 8px">No material matches “${escapeHtml(query)}”.</div>`;
    hydrateIcons();
  };

  const setField = (id: string, value: string | number): void => {
    const input = body.querySelector<HTMLInputElement>(`#${id}`);
    if (input) input.value = String(value);
  };

  const syncPreview = (): void => {
    const material = MATERIALS.find((m) => m.id === selectedId) ?? MATERIALS[0];
    const read = (id: string): string => body.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
    const nameEl = body.querySelector<HTMLElement>("#mat-preview-name")!;
    const meta = body.querySelector<HTMLElement>("#mat-preview-meta")!;
    const sphere = body.querySelector<HTMLElement>("#mat-sphere")!;
    const badge = body.querySelector<HTMLElement>("#mat-badge")!;
    const color = read("mat-color") || material.color;
    const metal = Number(read("mat-metalness") || material.metalness);
    const rough = Number(read("mat-roughness") || material.roughness);
    // A CSS stand-in for the studio shader: bright specular lobe for polished
    // metal, broad soft highlight for rough dielectrics.
    const shine = Math.max(0, 1 - rough) * (0.55 + metal * 0.45);
    sphere.style.background = `radial-gradient(circle at ${32 + metal * 6}% ${28 + metal * 4}%, rgba(255,255,255,${(0.25 + shine * 0.6).toFixed(2)}) 0%, ${color} ${(28 + rough * 26).toFixed(0)}%, #1b242c 100%)`;
    sphere.style.boxShadow = `inset -6px -8px 14px rgba(0,0,0,${(0.18 + metal * 0.25).toFixed(2)}), 0 2px 6px rgba(15,30,45,.28)`;
    const edited = dirty ? "Custom · edited" : "Library";
    badge.textContent = edited;
    badge.classList.toggle("edited", dirty);
    nameEl.textContent = dirty ? `${material.name} (custom)` : material.name;
    meta.textContent = `${dirty ? "Custom values" : material.category} · E ${fmt(Number(read("mat-E")), 0)} MPa · k ${fmt(Number(read("mat-conductivity")), 4)} W/(mm·K) · ρ ${fmt(Number(read("mat-density")), 0)} kg/m³`;
    body.querySelector<HTMLElement>("#mat-note")!.innerHTML = dirty
      ? "Edited values are stored as a per-part override; the library entry stays untouched. Conductivity feeds the steady-state thermal study."
      : "Values come from MatWeb / ASM / Ansys Granta room-temperature data. Conductivity (W/mm·K) feeds the steady-state thermal study.";
  };

  const loadMaterial = (material: FeaMaterial): void => {
    selectedId = material.id;
    dirty = false;
    setField("mat-name-hidden", material.name);
    setField("mat-E", material.E);
    setField("mat-G", material.G);
    setField("mat-nu", material.nu);
    setField("mat-yield", material.yield);
    setField("mat-uts", material.uts);
    setField("mat-density", material.density);
    setField("mat-conductivity", material.conductivity);
    setField("mat-specificHeat", material.specificHeat);
    setField("mat-cte", material.cte);
    setField("mat-color", material.color);
    setField("mat-metalness", material.metalness);
    setField("mat-roughness", material.roughness);
    body.querySelector<HTMLElement>("#mat-metalness-out")!.textContent = material.metalness.toFixed(2);
    body.querySelector<HTMLElement>("#mat-roughness-out")!.textContent = material.roughness.toFixed(2);
    renderList();
    syncPreview();
  };

  // Hidden carrier keeps the display name of the selected library entry so the
  // header can read “Aluminum 6061-T6 (custom)” while the fields are edited.
  body.insertAdjacentHTML("beforeend", `<input id="mat-name-hidden" type="hidden" />`);

  body.querySelector("#mat-cats")?.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-mat-cat]");
    if (!btn?.dataset.matCat) return;
    category = btn.dataset.matCat as MaterialCategory | "All";
    for (const other of body.querySelectorAll<HTMLElement>("[data-mat-cat]")) other.classList.toggle("active", other === btn);
    renderList();
  });
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });
  list.addEventListener("click", (event) => {
    const rowEl = (event.target as HTMLElement).closest<HTMLElement>("[data-material]");
    if (!rowEl?.dataset.material) return;
    const material = MATERIALS.find((m) => m.id === rowEl.dataset.material);
    if (material) loadMaterial(material);
  });
  body.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest(".mbt-detail") || !(target instanceof HTMLInputElement)) return;
    dirty = true;
    if (target.id === "mat-metalness" || target.id === "mat-roughness") {
      const out = body.querySelector<HTMLElement>(`#${target.id}-out`);
      if (out) out.textContent = Number(target.value).toFixed(2);
    }
    renderList();
    syncPreview();
  });
  body.querySelector<HTMLElement>("#mat-badge")?.addEventListener("click", () => {
    const material = MATERIALS.find((m) => m.id === selectedId);
    if (material) loadMaterial(material);
  });

  renderList();
  syncPreview();

  return {
    body,
    value: () => {
      const material = MATERIALS.find((m) => m.id === selectedId) ?? MATERIALS[0];
      if (!dirty) return { materialId: material.id };
      const read = (id: string): number => {
        const n = Number(body.querySelector<HTMLInputElement>(`#${id}`)?.value);
        return Number.isFinite(n) ? n : 0;
      };
      const readText = (id: string, fallback: string): string => body.querySelector<HTMLInputElement>(`#${id}`)?.value ?? fallback;
      const E = Math.max(1, read("mat-E"));
      const nu = Math.min(0.495, Math.max(0, read("mat-nu")));
      const override: MaterialOverride = {
        name: `${material.name} (custom)`,
        E,
        nu,
        G: Math.max(1, read("mat-G")),
        yield: Math.max(0, read("mat-yield")),
        uts: Math.max(0, read("mat-uts")),
        density: Math.max(1, read("mat-density")),
        conductivity: Math.max(1e-6, read("mat-conductivity")),
        specificHeat: Math.max(1, read("mat-specificHeat")),
        cte: read("mat-cte"),
        color: readText("mat-color", material.color),
        metalness: Math.min(1, Math.max(0, read("mat-metalness"))),
        roughness: Math.min(1, Math.max(0, read("mat-roughness"))),
      };
      return { materialId: material.id, override };
    },
  };
}
