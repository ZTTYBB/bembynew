import { describe, expect, it, vi } from "vitest";
import {
  MINI_APP_HTTP_MAX_BODY_BYTES,
  MINI_APP_HTTP_MAX_RESPONSE_BYTES,
  extractMiniAppInitData,
  miniAppLogUrl,
  prepareMiniAppHttpRequest,
  runMiniAppHttp,
} from "../jobs/miniAppHttp";
import { assertPublicUrl } from "../tg/safeFetch";

const signedUrl = "https://mini.example/app#tgWebAppData=query_id%3Dx%26hash%3Dsecret";

describe("mini app HTTP request validation", () => {
  it("removes Telegram init data from persisted step labels", () => {
    expect(miniAppLogUrl(signedUrl)).toBe("https://mini.example/app");
    expect(miniAppLogUrl("https://mini.example/app#section")).toBe("https://mini.example/app#section");
  });

  it("extracts init data and keeps relative requests on the signed origin", () => {
    expect(extractMiniAppInitData(signedUrl)).toBe("query_id=x&hash=secret");
    const result = prepareMiniAppHttpRequest(
      { type: "mini_app_http", url: "/api/check", method: "GET" },
      signedUrl,
      true,
    );
    expect(result.requestUrl.toString()).toBe("https://mini.example/api/check");
    expect(result.initData).toContain("query_id=x");
  });

  it("rejects cross-origin and unsigned requests", () => {
    expect(() =>
      prepareMiniAppHttpRequest(
        { type: "mini_app_http", url: "https://other.example/api" },
        signedUrl,
        true,
      ),
    ).toThrow(/origin/i);
    expect(() =>
      prepareMiniAppHttpRequest(
        { type: "mini_app_http", url: "/api" },
        "https://mini.example/app",
        false,
      ),
    ).toThrow(/sign/i);
  });

  it("rejects invalid variables, GET bodies, and oversized request bodies", () => {
    expect(() =>
      prepareMiniAppHttpRequest(
        { type: "mini_app_http", url: "/api", responseVariable: "__proto__" },
        signedUrl,
        true,
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      prepareMiniAppHttpRequest(
        { type: "mini_app_http", url: "/api", method: "GET", body: "x" },
        signedUrl,
        true,
      ),
    ).toThrow(/body/i);
    expect(() =>
      prepareMiniAppHttpRequest(
        { type: "mini_app_http", url: "/api", method: "POST", body: "x".repeat(MINI_APP_HTTP_MAX_BODY_BYTES + 1) },
        signedUrl,
        true,
      ),
    ).toThrow(/too large/i);
  });
});

describe("mini app HTTP execution", () => {
  it("sends only the controlled init-data header and returns bounded metadata", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("x-telegram-init-data")).toBe("query_id=x&hash=secret");
      expect(new Headers(init.headers).get("cookie")).toBeNull();
      return new Response("accepted", { status: 200 });
    });
    const result = await runMiniAppHttp(
      {
        type: "mini_app_http",
        url: "/api/check",
        responseVariable: "reply",
        statusVariable: "status",
        sendInitData: true,
        successContains: "accept",
      },
      { signedUrl, signed: true, fetcher },
    );
    expect(result).toMatchObject({ status: 200, bytes: 8, body: "accepted", preview: "accepted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin redirects and oversized responses", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://other.example/x" } }));
    await expect(runMiniAppHttp({ type: "mini_app_http", url: "/api" }, { signedUrl, signed: true, fetcher: redirect })).rejects.toThrow(/redirect.*origin/i);

    const oversized = vi.fn(async () => new Response("x".repeat(MINI_APP_HTTP_MAX_RESPONSE_BYTES + 1), { status: 200 }));
    await expect(runMiniAppHttp({ type: "mini_app_http", url: "/api" }, { signedUrl, signed: true, fetcher: oversized })).rejects.toThrow(/response is too large/i);
  });

  it("handles same-origin redirects and timeout/cancellation", async () => {
    let count = 0;
    const redirect = vi.fn(async (url: string) => {
      count++;
      return count === 1
        ? new Response(null, { status: 302, headers: { location: "/api/final" } })
        : new Response("done", { status: 200 });
    });
    const result = await runMiniAppHttp({ type: "mini_app_http", url: "/api" }, { signedUrl, signed: true, fetcher: redirect });
    expect(result.url).toBe("https://mini.example/api/final");

    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(runMiniAppHttp({ type: "mini_app_http", url: "/api", maxWaitMs: 100 }, { signedUrl, signed: true, fetcher: hanging })).rejects.toThrow(/timed out/i);
  });

  it("applies fetch redirect semantics when a POST is redirected", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, method: String(init.method), body: init.body });
      return requests.length === 1
        ? new Response(null, { status: 303, headers: { location: "/api/result" } })
        : new Response("ok", { status: 200 });
    });
    const result = await runMiniAppHttp(
      { type: "mini_app_http", url: "/api", method: "POST", body: "payload", contentType: "text/plain" },
      { signedUrl, signed: true, fetcher },
    );
    expect(result.url).toBe("https://mini.example/api/result");
    expect(requests).toEqual([
      { url: "https://mini.example/api", method: "POST", body: "payload" },
      { url: "https://mini.example/api/result", method: "GET", body: undefined },
    ]);
  });
});

describe("mini app HTTP SSRF boundary", () => {
  it("refuses private signed origins before a request can be made", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8080/app")).rejects.toThrow(/private/i);
  });
});
