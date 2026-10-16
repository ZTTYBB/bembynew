import { describe, expect, it } from "vitest";
import {
  EMBY_TEMPLATE_META_KEY,
  embyTemplateOverrides,
  mergeEmbyTemplateConfig,
  parseEmbyConfig,
  resolveEmbyDefaultPlayDuration,
  validateEmbyDurations,
  validateEffectiveEmbyDurations,
  withEmbyTemplateMeta,
} from "../jobs/embyTemplate";

describe("Emby template config", () => {
  it("parses legacy double-encoded configs safely", () => {
    expect(parseEmbyConfig(JSON.stringify(JSON.stringify({ username: "u" })))).toEqual({
      username: "u",
    });
    expect(parseEmbyConfig("{bad json")).toEqual({});
    expect(parseEmbyConfig(JSON.stringify(JSON.stringify(null)))).toEqual({});
    expect(parseEmbyConfig("[]")).toEqual({});
  });

  it("merges a marked duration override while keeping template defaults", () => {
    const job = withEmbyTemplateMeta(
      { username: "u", password: "", playDuration: 300 },
      { playDuration: 900 },
    );
    const merged = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300, playDurationMax: 600, backupUrl: "https://backup" }),
      job,
    );
    expect(merged).toMatchObject({
      username: "u",
      password: "",
      playDuration: 900,
      backupUrl: "https://backup",
    });
    expect(merged.playDurationMax).toBeUndefined();
    expect(embyTemplateOverrides(job)).toEqual({ playDuration: 900 });
  });

  it("preserves a linked job's explicit range", () => {
    const merged = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300, playDurationMax: 600 }),
      withEmbyTemplateMeta({ username: "u", password: "" }, {
        playDuration: 500,
        playDurationMax: 1800,
      }),
    );
    expect(merged.playDuration).toBe(500);
    expect(merged.playDurationMax).toBe(1800);
  });

  it("follows the complete template range when duration overrides are blank", () => {
    const merged = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300, playDurationMax: 600 }),
      withEmbyTemplateMeta({ username: "u", password: "", playDuration: 900 }, {}),
    );
    expect(merged.playDuration).toBe(300);
    expect(merged.playDurationMax).toBe(600);
  });

  it("does not let a linked job override template-owned fields", () => {
    const job = withEmbyTemplateMeta(
      { username: "u", password: "p", userAgent: "job-ua", backupUrl: "job-backup" },
      {},
    );
    const merged = mergeEmbyTemplateConfig(
      JSON.stringify({ userAgent: "template-ua", backupUrl: "template-backup" }),
      job,
    );
    expect(merged.userAgent).toBe("template-ua");
    expect(merged.backupUrl).toBe("template-backup");
    expect(merged[EMBY_TEMPLATE_META_KEY as keyof typeof merged]).toBeUndefined();
  });

  it("keeps legacy per-job fields until the next template sync", () => {
    const legacy = { username: "u", password: "p", playDuration: 480, userAgent: "legacy-ua" };
    const merged = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300, userAgent: "template-ua" }),
      legacy,
    );
    expect(merged.playDuration).toBe(480);
    expect(merged.userAgent).toBe("legacy-ua");
  });
});

describe("Emby duration validation", () => {
  it.each([29, 0, -30, 30.5, "abc", " ", true, {}, [], Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid duration %j",
    (playDuration) => {
      expect(validateEmbyDurations({ playDuration })).toContain("at least 30 seconds");
    },
  );

  it.each([undefined, null, "", 30, "30", 1200])("accepts a duration %j", (playDuration) => {
    expect(validateEmbyDurations({ playDuration })).toBeNull();
  });

  it("validates both ends and namespaced linked-job overrides", () => {
    expect(validateEmbyDurations({ playDuration: 500, playDurationMax: 1800 })).toBeNull();
    expect(validateEmbyDurations({ playDuration: 500, playDurationMax: 400 })).toContain("less than");
    expect(validateEmbyDurations({ playDurationMax: 20 })).toContain("at least 30 seconds");
    expect(validateEmbyDurations({
      [EMBY_TEMPLATE_META_KEY]: { overrides: { playDuration: "bad" } },
    })).toContain("at least 30 seconds");
  });
});

describe("effective Emby duration validation", () => {
  it("checks an upper-only config against the inherited system minimum", () => {
    expect(validateEffectiveEmbyDurations({ playDurationMax: 500 }, "600")).toContain("effective");
    expect(validateEffectiveEmbyDurations({ playDurationMax: 600 }, "600")).toBeNull();
    expect(validateEffectiveEmbyDurations({ playDurationMax: 900 }, "600")).toBeNull();
    expect(validateEffectiveEmbyDurations({ playDurationMax: 299 })).toContain("effective");
  });

  it("uses the linked template minimum for an upper-only job override", () => {
    const linked = withEmbyTemplateMeta({ username: "u", password: "" }, { playDurationMax: 500 });
    const effective = mergeEmbyTemplateConfig(JSON.stringify({ playDuration: 600 }), linked);
    expect(validateEffectiveEmbyDurations(effective, 300)).toContain("less than");
  });

  it("detects when a changed template makes an inherited range invalid", () => {
    const linked = withEmbyTemplateMeta({ username: "u", password: "" }, { playDurationMax: 500 });
    expect(validateEffectiveEmbyDurations(
      mergeEmbyTemplateConfig(JSON.stringify({ playDuration: 300 }), linked),
      300,
    )).toBeNull();
    expect(validateEffectiveEmbyDurations(
      mergeEmbyTemplateConfig(JSON.stringify({ playDuration: 600 }), linked),
      300,
    )).toContain("less than");
  });

  it("detects when a changed system default makes an inherited range invalid", () => {
    const effective = mergeEmbyTemplateConfig(
      null,
      withEmbyTemplateMeta({ username: "u", password: "" }, { playDurationMax: 500 }),
    );
    expect(validateEffectiveEmbyDurations(effective, 300)).toBeNull();
    expect(validateEffectiveEmbyDurations(effective, 600)).toContain("effective");
  });

  it("does not reapply the template maximum over a marked fixed duration", () => {
    const effective = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300, playDurationMax: 600 }),
      withEmbyTemplateMeta({ username: "u", password: "" }, { playDuration: 900 }),
    );
    expect(validateEffectiveEmbyDurations(effective, 1200)).toBeNull();
  });

  it("does not drop a malformed explicit override during the runtime merge", () => {
    const linked = {
      username: "u",
      password: "",
      [EMBY_TEMPLATE_META_KEY]: { overrides: { playDurationMax: true } },
    };
    const effective = mergeEmbyTemplateConfig(
      JSON.stringify({ playDuration: 300 }),
      linked as never,
    );
    expect(effective.playDurationMax).toBe(true);
    expect(validateEffectiveEmbyDurations(effective, 300)).toContain("at least 30 seconds");
  });

  it("uses a safe built-in default for malformed old settings", () => {
    for (const raw of [undefined, null, "", "bad", 0, -1, 1, 30.5, Infinity, true, []]) {
      expect(resolveEmbyDefaultPlayDuration(raw)).toBe(300);
      expect(validateEffectiveEmbyDurations({ playDurationMax: 300 }, raw)).toBeNull();
    }
    expect(resolveEmbyDefaultPlayDuration("600")).toBe(600);
  });
});

