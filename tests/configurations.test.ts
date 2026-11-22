import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIGURATION,
  activeConfiguration,
  addConfiguration,
  applyConfiguration,
  captureConfiguration,
  configurationSummary,
  ensureConfigurations,
  removeConfiguration,
} from "../src/model/configurations";
import { createDocument } from "../src/model/defaults";
import { applyVariables, makeVariable } from "../src/model/variables";
import type { Feature, Part } from "../src/model/types";

const addFeature = (part: Part, id: string, name = id): Feature => {
  const feature: Feature = { id, type: "extrude", name, sketchId: "sk_1", params: { depth: 10 } };
  part.features.push(feature);
  return feature;
};

describe("configurations", () => {
  it("creates a Default configuration and marks it active", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const configs = ensureConfigurations(part);
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe(DEFAULT_CONFIGURATION);
    expect(part.activeConfigurationId).toBe(configs[0].id);
    expect(activeConfiguration(part)?.id).toBe(configs[0].id);
    // Idempotent.
    ensureConfigurations(part);
    expect(part.configurations).toHaveLength(1);
  });

  it("captures variables and suppression flags", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const configs = ensureConfigurations(part);
    doc.variables = [makeVariable("L", "160"), makeVariable("W", "80")];
    const hidden = addFeature(part, "feat_2");
    hidden.suppressed = true;
    addFeature(part, "feat_3");
    captureConfiguration(part, doc, configs[0].id);
    expect(configs[0].variables).toEqual({ L: "160", W: "80" });
    expect(configs[0].suppressed).toEqual(["feat_2"]);
  });

  it("applies a variant to the live document and rebuild state", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const [defaultConfig] = ensureConfigurations(part);
    doc.variables = [makeVariable("L", "160"), makeVariable("W", "80")];
    addFeature(part, "feat_2");
    captureConfiguration(part, doc, defaultConfig.id);

    const short = addConfiguration(part, "Short");
    short.variables = { L: "80", W: "40" };
    short.suppressed = ["feat_2"];

    const long = addConfiguration(part, "Long");
    long.variables = { L: "240", W: "120" };
    long.suppressed = [];

    expect(applyConfiguration(part, doc, short.id)).toBe(true);
    applyVariables(doc);
    expect(part.activeConfigurationId).toBe(short.id);
    expect(doc.variables.find((v) => v.name === "L")?.value).toBe(80);
    expect(doc.variables.find((v) => v.name === "W")?.value).toBe(40);
    expect(part.features.find((f) => f.id === "feat_2")?.suppressed).toBe(true);

    expect(applyConfiguration(part, doc, long.id)).toBe(true);
    applyVariables(doc);
    expect(doc.variables.find((v) => v.name === "L")?.value).toBe(240);
    expect(part.features.find((f) => f.id === "feat_2")?.suppressed).toBe(false);

    // Switching back restores the captured values exactly.
    expect(applyConfiguration(part, doc, defaultConfig.id)).toBe(true);
    applyVariables(doc);
    expect(doc.variables.find((v) => v.name === "L")?.value).toBe(160);
    expect(part.features.find((f) => f.id === "feat_2")?.suppressed).toBe(false);
  });

  it("does not leak suppression between variants", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const [defaultConfig] = ensureConfigurations(part);
    const feature = addFeature(part, "feat_2");
    feature.suppressed = true;
    captureConfiguration(part, doc, defaultConfig.id);
    const variant = addConfiguration(part, "Open");
    variant.suppressed = [];
    applyConfiguration(part, doc, variant.id);
    expect(feature.suppressed).toBe(false);
    applyConfiguration(part, doc, defaultConfig.id);
    expect(feature.suppressed).toBe(true);
  });

  it("copies a source variant including its variables", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const [base] = ensureConfigurations(part);
    base.variables = { L: "160" };
    base.suppressed = ["feat_2"];
    const copy = addConfiguration(part, "M8", base);
    expect(copy.id).not.toBe(base.id);
    expect(copy.variables).toEqual({ L: "160" });
    expect(copy.suppressed).toEqual(["feat_2"]);
    copy.variables.L = "200";
    expect(base.variables.L).toBe("160");
  });

  it("never removes the last configuration", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const [only] = ensureConfigurations(part);
    expect(removeConfiguration(part, only.id)).toBe(false);
    const second = addConfiguration(part, "Second");
    expect(removeConfiguration(part, second.id)).toBe(true);
    expect(part.configurations).toHaveLength(1);
  });

  it("summarises variables and suppressed features", () => {
    const doc = createDocument();
    const part = doc.parts[0];
    const [config] = ensureConfigurations(part);
    config.variables = { L: "160", W: "80", D: "10", H: "5" };
    config.suppressed = ["a", "b"];
    const summary = configurationSummary(part, config);
    expect(summary).toContain("L=160");
    expect(summary).toContain("2 suppressed");
  });
});
