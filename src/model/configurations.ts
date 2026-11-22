/* Named part configurations (SolidWorks-style variants).
 *
 * A configuration stores the global variable expressions plus the suppression
 * state of the part's features. Activating one rewrites the document variables,
 * marks the suppressed features and lets the normal rebuild produce that
 * variant, so mass properties and drawings follow automatically. */
import type { Configuration, Part, ProjectDocument, Variable } from "./types";
import { makeVariable } from "./variables";
import { uid } from "./defaults";

export const DEFAULT_CONFIGURATION = "Default";

export function ensureConfigurations(part: Part): Configuration[] {
  part.configurations ??= [];
  if (part.configurations.length === 0) {
    part.configurations.push({ id: uid("cfg"), name: DEFAULT_CONFIGURATION, variables: {}, suppressed: [] });
  }
  if (!part.configurations.some((c) => c.id === part.activeConfigurationId)) {
    part.activeConfigurationId = part.configurations[0].id;
  }
  return part.configurations;
}

export function activeConfiguration(part: Part): Configuration | undefined {
  if (!part.configurations) return undefined;
  return part.configurations.find((c) => c.id === part.activeConfigurationId) ?? part.configurations[0];
}

/** Snapshot the current variables and suppression flags into a configuration. */
export function captureConfiguration(part: Part, doc: ProjectDocument, id: string): Configuration | undefined {
  const config = part.configurations?.find((c) => c.id === id);
  if (!config) return undefined;
  config.variables = {};
  for (const variable of doc.variables ?? []) config.variables[variable.name] = variable.expression;
  config.suppressed = part.features.filter((f) => f.suppressed).map((f) => f.id);
  return config;
}

/** Write a configuration into the live document. Returns true when the
 *  document changed and the caller should rebuild. */
export function applyConfiguration(part: Part, doc: ProjectDocument, id: string): boolean {
  const config = part.configurations?.find((c) => c.id === id);
  if (!config) return false;
  part.activeConfigurationId = config.id;

  const variables: Variable[] = [...(doc.variables ?? [])];
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const [name, expression] of Object.entries(config.variables)) {
    const existing = byName.get(name);
    if (existing) {
      existing.expression = expression;
    } else {
      const created = makeVariable(name, expression);
      variables.push(created);
      byName.set(name, created);
    }
  }
  doc.variables = variables;

  const suppressed = new Set(config.suppressed);
  for (const feature of part.features) {
    if (suppressed.has(feature.id)) feature.suppressed = true;
    else if (feature.suppressed) feature.suppressed = false;
  }
  return true;
}

export function addConfiguration(part: Part, name: string, copyFrom?: Configuration): Configuration {
  const source = copyFrom ?? activeConfiguration(part);
  const config: Configuration = {
    id: uid("cfg"),
    name: name.trim() || `Configuration ${(part.configurations?.length ?? 0) + 1}`,
    variables: source ? { ...source.variables } : {},
    suppressed: source ? [...source.suppressed] : [],
  };
  part.configurations ??= [];
  part.configurations.push(config);
  return config;
}

export function removeConfiguration(part: Part, id: string): boolean {
  if (!part.configurations || part.configurations.length <= 1) return false;
  const index = part.configurations.findIndex((c) => c.id === id);
  if (index < 0) return false;
  part.configurations.splice(index, 1);
  if (part.activeConfigurationId === id) part.activeConfigurationId = part.configurations[0].id;
  return true;
}

/** Variable summary shown in the Configurations panel. */
export function configurationSummary(part: Part, config: Configuration): string {
  const names = Object.keys(config.variables);
  const suppressed = config.suppressed.length;
  const vars = names.length ? names.slice(0, 3).map((n) => `${n}=${config.variables[n]}`).join(" · ") : "current values";
  return suppressed ? `${vars} · ${suppressed} suppressed` : vars;
}
