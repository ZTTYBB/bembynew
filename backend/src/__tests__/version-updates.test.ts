// vi.mock calls are hoisted before imports, preventing the DB from opening
vi.mock("../db/database", () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi } from "vitest";
import { compareVersions } from "../version";
import { matchesChannel, pickNewerRelease } from "../routes/updates";

describe("compareVersions", () => {
  it("orders by major, minor then patch", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores a leading v", () => {
    expect(compareVersions("v1.0.0", "v0.9.0")).toBeGreaterThan(0);
  });

  it("sorts a pre-release below its release", () => {
    // 1.2.0-beta.1 is older than 1.2.0, which is what stops a beta build from
    // being offered the stable it precedes
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.2.0-beta.1")).toBeGreaterThan(0);
  });

  it("compares two pre-releases of the same core", () => {
    expect(compareVersions("1.2.0-beta.1", "1.2.0-beta.2")).toBeLessThan(0);
    expect(compareVersions("1.2.0-beta.2", "1.2.0-beta.1")).toBeGreaterThan(0);
  });

  it("tolerates missing segments", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1", "1.0.1")).toBeLessThan(0);
  });
});

describe("matchesChannel", () => {
  it("classifies a plain version as stable", () => {
    expect(matchesChannel("v1.2.3", "stable")).toBe(true);
    expect(matchesChannel("1.2.3", "stable")).toBe(true);
  });

  it("keeps dev- and beta-tagged builds off the stable channel", () => {
    expect(matchesChannel("v1.2.3-beta.1", "stable")).toBe(false);
    expect(matchesChannel("dev-v1.2.3-1", "stable")).toBe(false);
  });

  it("routes beta tags to the beta channel only", () => {
    expect(matchesChannel("v1.2.3-beta.1", "beta")).toBe(true);
    expect(matchesChannel("v1.2.3", "beta")).toBe(false);
    expect(matchesChannel("dev-v1.2.3-1", "beta")).toBe(false);
  });

  it("routes dev- tags to the dev channel only", () => {
    expect(matchesChannel("dev-v1.2.3-1", "dev")).toBe(true);
    expect(matchesChannel("v1.2.3", "dev")).toBe(false);
    expect(matchesChannel("v1.2.3-beta.1", "dev")).toBe(false);
  });
});

describe("pickNewerRelease", () => {
  const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
    tag_name: tag,
    prerelease: /beta|dev/.test(tag),
    draft: false,
    html_url: `https://example.test/${tag}`,
    published_at: "2026-01-01T00:00:00Z",
    ...extra,
  });

  it("returns null when nothing is newer", () => {
    expect(pickNewerRelease([rel("v1.0.0")], "stable", "1.0.0")).toBeNull();
    expect(pickNewerRelease([rel("v0.9.0")], "stable", "1.0.0")).toBeNull();
  });

  it("returns the highest newer release on the channel", () => {
    const picked = pickNewerRelease(
      [rel("v1.0.1"), rel("v1.2.0"), rel("v1.1.0")],
      "stable",
      "1.0.0",
    );
    expect(picked?.tag_name).toBe("v1.2.0");
  });

  it("ignores releases on other channels", () => {
    expect(
      pickNewerRelease([rel("v1.2.0-beta.1")], "stable", "1.0.0"),
    ).toBeNull();
    expect(pickNewerRelease([rel("v1.2.0")], "beta", "1.0.0")).toBeNull();
  });

  it("ignores drafts", () => {
    expect(
      pickNewerRelease([rel("v1.5.0", { draft: true })], "stable", "1.0.0"),
    ).toBeNull();
  });

  it("does not offer the release a beta precedes", () => {
    // On the beta channel, a stable 1.2.0 must not be offered to a 1.2.0-beta.2
    const picked = pickNewerRelease(
      [rel("v1.2.0"), rel("v1.2.0-beta.3")],
      "beta",
      "1.2.0-beta.2",
    );
    expect(picked?.tag_name).toBe("v1.2.0-beta.3");
  });

  it("returns null for an empty list", () => {
    expect(pickNewerRelease([], "stable", "1.0.0")).toBeNull();
  });
});
