import { describe, expect, it } from "vitest";
import {
  mergeCustomTemplateConfig,
  readTemplateOptions,
  restoreMissingTemplateOptions,
  resolveTemplateOptionValues,
  templateOptionVariables,
  validateTemplateOptions,
} from "../jobs/templateOptions";

describe("custom template options", () => {
  const definition = {
    actions: [{ type: "send_command", content: "{minRate}-{maxRate}" }],
    jobOptions: [
      { name: "minRate", label: "Minimum", options: [1, 1.5, 2], default: 1 },
      { name: "grabRedPacket", label: "Grab", options: [true, false], default: true },
    ],
  };

  it("normalises and resolves primitive choices", () => {
    const parsed = readTemplateOptions(definition);
    expect(parsed.error).toBeNull();
    expect(parsed.options[0]).toMatchObject({ name: "minRate", default: 1 });
    expect(resolveTemplateOptionValues(parsed.options, {
      minRate: 1.5,
      grabRedPacket: false,
    })).toEqual({
      values: { minRate: 1.5, grabRedPacket: false },
      error: null,
    });
    expect(templateOptionVariables({
      ...definition,
      jobOptionValues: { minRate: 1.5, grabRedPacket: false },
    })).toEqual({ minRate: 1.5, grabRedPacket: false });
  });

  it("falls back to defaults for omitted values and rejects unknown choices", () => {
    const options = readTemplateOptions(definition).options;
    expect(resolveTemplateOptionValues(options, {})).toEqual({
      values: { minRate: 1, grabRedPacket: true },
      error: null,
    });
    expect(resolveTemplateOptionValues(options, { minRate: 99 }).error).toContain("minRate");
    expect(resolveTemplateOptionValues(options, { extra: "x" }, true).error).toContain("Unknown");
  });

  it("rejects unsafe, duplicate and malformed definitions", () => {
    expect(validateTemplateOptions({
      jobOptions: [{ name: "__proto__", label: "bad", options: ["x"], default: "x" }],
    })).toContain("invalid");
    expect(validateTemplateOptions({
      jobOptions: [
        { name: "same", label: "one", options: ["x"], default: "x" },
        { name: "same", label: "two", options: ["y"], default: "y" },
      ],
    })).toContain("Duplicate");
    expect(validateTemplateOptions({
      jobOptions: [{ name: "mode", label: "Mode", options: ["a"], default: "b" }],
    })).toContain("invalid");
  });

  it("merges template definitions while preserving job selections", () => {
    const merged = mergeCustomTemplateConfig(
      definition,
      { jobOptionValues: { minRate: 2, grabRedPacket: false } },
    );
    expect(merged).toMatchObject({
      actions: definition.actions,
      jobOptions: definition.jobOptions,
      jobOptionValues: { minRate: 2, grabRedPacket: false },
    });
    const restored = mergeCustomTemplateConfig(definition, { actions: [] });
    expect(restored?.jobOptionValues).toEqual({ minRate: 1, grabRedPacket: true });
  });

  it("repairs only jobs missing definitions and is safe to run again", () => {
    const rows: Array<{ id: number; jobConfig: unknown; templateConfig: unknown }> = [
      {
        id: 1,
        jobConfig: { actions: [], jobOptionValues: { minRate: 2, grabRedPacket: false } },
        templateConfig: definition,
      },
      {
        id: 2,
        jobConfig: {
          jobOptions: [{ name: "custom", label: "Keep", options: ["x"], default: "x" }],
          jobOptionValues: { custom: "x" },
        },
        templateConfig: definition,
      },
      {
        id: 3,
        jobConfig: "{not-json",
        templateConfig: definition,
      },
    ];
    const updates: Array<{ id: number; config: Record<string, unknown> }> = [];
    const update = (id: number, config: Record<string, unknown>) => {
      updates.push({ id, config });
      const row = rows.find((candidate) => candidate.id === id);
      if (row) row.jobConfig = config;
    };

    expect(restoreMissingTemplateOptions(rows, update)).toBe(1);
    expect(updates[0]).toMatchObject({
      id: 1,
      config: {
        jobOptions: definition.jobOptions,
        jobOptionValues: { minRate: 2, grabRedPacket: false },
      },
    });
    expect(updates.some((entry) => entry.id === 2)).toBe(false);
    expect(updates.some((entry) => entry.id === 3)).toBe(false);
    expect(restoreMissingTemplateOptions(rows, update)).toBe(0);
    expect(updates).toHaveLength(1);
  });
});

