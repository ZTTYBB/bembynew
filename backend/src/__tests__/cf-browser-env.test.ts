import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ dir: "/tmp/cf-cache" }));
vi.mock("../db/database", () => ({ db: { prepare: vi.fn() } }));
vi.mock("../jobs/cfTuning", () => ({ cfTuning: () => ({}) }));
vi.mock("../jobs/cfFonts", () => ({ applyCfFontEnv: () => {} }));
vi.mock("../jobs/cfLicense", () => ({
  anyCfLicenseKey: () => undefined, cfLicenseUsage: () => ({ total: 0 }), leaseCfLicenseKey: vi.fn(),
}));
vi.mock("../jobs/paths", () => ({ dataDir: () => cache.dir }));
vi.mock("../tg/proxyProviders", () => ({ cfExitGeo: () => undefined }));
vi.mock("socks", () => ({ SocksClient: {} }));
vi.mock("playwright-core", () => ({}));
vi.mock("../jobs/cfBrowserMaintenance", () => ({ acquireCfBrowserUse: vi.fn() }));

describe("CloakBrowser SDK update policy", () => {
  beforeEach(() => {
    vi.stubEnv("CLOAKBROWSER_AUTO_UPDATE", "true");
    vi.stubEnv("CLOAKBROWSER_CACHE_DIR", cache.dir);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("forces the SDK's implicit update check off even when the old env flag is true", async () => {
    const module = await import("../jobs/cfBrowser");
    expect(module.cloakCacheDir()).toBe(cache.dir);
    module.applyCloakEnv();
    expect(process.env.CLOAKBROWSER_AUTO_UPDATE).toBe("false");
  });

  it("preserves the configured cache while repeatedly disabling implicit updates", async () => {
    const module = await import("../jobs/cfBrowser");
    module.applyCloakEnv();
    expect(process.env.CLOAKBROWSER_CACHE_DIR).toBe(cache.dir);
    process.env.CLOAKBROWSER_AUTO_UPDATE = "true";
    module.applyCloakEnv();
    expect(process.env.CLOAKBROWSER_AUTO_UPDATE).toBe("false");
  });
});
