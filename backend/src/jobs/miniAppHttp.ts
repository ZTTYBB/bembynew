import { assertMutableVariableName } from "./automation";
import { ssrfSafeFetch } from "../tg/safeFetch";

/**
 * Mini App HTTP is intentionally a small request primitive rather than a script runner.
 * Keeping the allow-list here makes it difficult for a future UI field to accidentally
 * become an arbitrary proxy or JavaScript execution surface.
 */
export type MiniAppHttpAction = {
  type: "mini_app_http";
  url: string;
  method?: "GET" | "POST";
  body?: string;
  contentType?: "application/json" | "application/x-www-form-urlencoded" | "text/plain";
  responseVariable?: string;
  statusVariable?: string;
  successContains?: string;
  failContains?: string;
  maxWaitMs?: number;
  sendInitData?: boolean;
  bot?: string;
};

export const MINI_APP_HTTP_MAX_BODY_BYTES = 64 * 1024;
export const MINI_APP_HTTP_MAX_RESPONSE_BYTES = 256 * 1024;
export const MINI_APP_HTTP_MAX_REDIRECTS = 3;
export const MINI_APP_HTTP_DEFAULT_WAIT_MS = 30_000;
export const MINI_APP_HTTP_MAX_WAIT_MS = 300_000;

export type MiniAppHttpResult = {
  url: string;
  status: number;
  bytes: number;
  body: string;
  preview: string;
  initDataAvailable: boolean;
};

export type MiniAppHttpFetcher = (
  url: string,
  init: RequestInit,
  options?: number | { maxHops?: number; followRedirects?: boolean },
) => Promise<Response>;

/** The signed WebView fragment is never sent by fetch; read it only for explicit opt-in. */
export function extractMiniAppInitData(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (!parsed.hash) return undefined;
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  const value = fragment.get("tgWebAppData");
  return value || undefined;
}

/** Return a URL suitable for a persisted step label, never including WebView init data. */
export function miniAppLogUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    // Telegram puts tgWebAppData in the fragment so it is not sent to the
    // server, but job details are persisted and may be exported later.
    if (parsed.hash) {
      const fragment = new URLSearchParams(parsed.hash.slice(1));
      if (fragment.has("tgWebAppData")) parsed.hash = "";
    }
    return parsed.toString();
  } catch {
    // Keep malformed input useful for an error label while covering the common
    // hand-written fragment form. Remove the whole fragment: its value can
    // contain encoded ampersands and a partial replacement could leak `hash`.
    const hash = rawUrl.indexOf("#");
    if (hash >= 0 && /(?:^|[&#])tgWebAppData=/i.test(rawUrl.slice(hash + 1))) {
      return rawUrl.slice(0, hash);
    }
    return rawUrl;
  }
}

function httpUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`${label} must use http:// or https://`);
  }
  return parsed;
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === right.protocol && left.host === right.host;
}

function bodyBytes(body: string): number {
  return Buffer.byteLength(body, "utf8");
}

function assertVariableName(name: string | undefined, label: string): void {
  if (name != null && name !== "") {
    try {
      assertMutableVariableName(name);
    } catch {
      throw new Error(`${label} is invalid`);
    }
  }
}

/**
 * Validate and resolve the request against Telegram's signed page. The action may give an
 * absolute same-origin endpoint or a relative path. It may not turn a signed Mini App into
 * a cross-origin HTTP proxy.
 */
export function prepareMiniAppHttpRequest(
  action: MiniAppHttpAction,
  signedUrl: string,
  signed: boolean,
): {
  baseUrl: URL;
  requestUrl: URL;
  initData?: string;
  body?: string;
  method: "GET" | "POST";
  contentType?: string;
} {
  if (typeof action.url !== "string" || action.url.length === 0 || action.url.length > 2048) {
    throw new Error("Mini App HTTP URL is required and must be at most 2048 characters");
  }
  for (const [name, marker] of [
    ["successContains", action.successContains],
    ["failContains", action.failContains],
  ] as const) {
    if (marker != null && marker.length > 4096) throw new Error(`Mini App HTTP ${name} is too long`);
  }
  const baseUrl = httpUrl(signedUrl, "Signed Mini App URL");
  const requestUrl = httpUrl(new URL(action.url, baseUrl).toString(), "Mini App request URL");
  if (!sameOrigin(baseUrl, requestUrl)) {
    throw new Error("Mini App HTTP request must stay on the signed app origin");
  }

  const initData = extractMiniAppInitData(signedUrl) ?? extractMiniAppInitData(requestUrl.toString());
  if (!signed && !initData) {
    throw new Error("Telegram did not sign this Mini App URL and it has no tgWebAppData");
  }

  const method = action.method ?? "GET";
  if (method !== "GET" && method !== "POST") throw new Error("Mini App HTTP method is not allowed");
  const body = action.body ?? "";
  if (method === "GET" && body) throw new Error("GET Mini App HTTP requests cannot have a body");
  if (body && bodyBytes(body) > MINI_APP_HTTP_MAX_BODY_BYTES) {
    throw new Error("Mini App HTTP request body is too large");
  }

  const contentType = body ? (action.contentType ?? "text/plain") : undefined;
  if (
    contentType &&
    contentType !== "application/json" &&
    contentType !== "application/x-www-form-urlencoded" &&
    contentType !== "text/plain"
  ) {
    throw new Error("Mini App HTTP content type is not allowed");
  }
  assertVariableName(action.responseVariable, "Response variable");
  assertVariableName(action.statusVariable, "Status variable");

  const maxWaitMs = action.maxWaitMs ?? MINI_APP_HTTP_DEFAULT_WAIT_MS;
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 100 || maxWaitMs > MINI_APP_HTTP_MAX_WAIT_MS) {
    throw new Error(`Mini App HTTP timeout must be between 100 and ${MINI_APP_HTTP_MAX_WAIT_MS} ms`);
  }

  // Fragments have no place in an HTTP request. Keeping the same URL object here also makes
  // logging and redirect origin checks deterministic.
  requestUrl.hash = "";
  return { baseUrl, requestUrl, initData, body: body || undefined, method, contentType };
}

async function readBoundedText(response: Response): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MINI_APP_HTTP_MAX_RESPONSE_BYTES) {
    response.body?.cancel().catch(() => {});
    throw new Error("Mini App HTTP response is too large");
  }

  if (!response.body) return { text: "", bytes: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value);
      bytes += chunk.byteLength;
      if (bytes > MINI_APP_HTTP_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Mini App HTTP response is too large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), bytes };
}

function responsePreview(text: string): string {
  // A preview is useful in the run log, but never persist an entire API response (which may
  // contain a token or account data). Keep it short and normalize control characters.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 512);
}

function requestHeaders(contentType: string | undefined, initData: string | undefined, sendInitData: boolean): Headers {
  const headers = new Headers({ accept: "application/json, text/plain;q=0.9, */*;q=0.1" });
  if (contentType) headers.set("content-type", contentType);
  if (sendInitData && initData) headers.set("x-telegram-init-data", initData);
  return headers;
}

export type RunMiniAppHttpOptions = {
  signedUrl: string;
  signed: boolean;
  signal?: AbortSignal;
  fetcher?: MiniAppHttpFetcher;
};

/**
 * Execute one bounded request. Redirects are handled here, instead of delegated to fetch, so
 * every hop can be checked against the exact signed origin.
 */
export async function runMiniAppHttp(
  action: MiniAppHttpAction,
  options: RunMiniAppHttpOptions,
): Promise<MiniAppHttpResult> {
  const prepared = prepareMiniAppHttpRequest(action, options.signedUrl, options.signed);
  const fetcher = options.fetcher ?? ssrfSafeFetch;
  const maxWaitMs = action.maxWaitMs ?? MINI_APP_HTTP_DEFAULT_WAIT_MS;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) throw new Error("Job cancelled");
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), maxWaitMs);

  let current = prepared.requestUrl;
  let currentMethod = prepared.method;
  let currentBody = prepared.body;
  let currentContentType = prepared.contentType;
  let response: Response | undefined;
  try {
    for (let hop = 0; hop <= MINI_APP_HTTP_MAX_REDIRECTS; hop++) {
      response = await fetcher(current.toString(), {
        method: currentMethod,
        headers: requestHeaders(currentContentType, prepared.initData, action.sendInitData === true),
        ...(currentBody !== undefined ? { body: currentBody } : {}),
        signal: controller.signal,
      }, { maxHops: 0, followRedirects: false });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) break;
        const next = httpUrl(new URL(location, current).toString(), "Redirect URL");
        if (!sameOrigin(prepared.baseUrl, next)) {
          response.body?.cancel().catch(() => {});
          throw new Error("Mini App HTTP redirect leaves the signed app origin");
        }
        response.body?.cancel().catch(() => {});
        current = next;
        // Follow the browser/fetch redirect rules for a request that has no
        // explicit redirect policy: 301/302 turn POST into GET, 303 always
        // becomes GET, while 307/308 preserve method and body.
        if (response.status === 301 || response.status === 302 || response.status === 303) {
          if (response.status === 303 || currentMethod === "POST") {
            currentMethod = "GET";
            currentBody = undefined;
            currentContentType = undefined;
          }
        }
        continue;
      }
      break;
    }
    if (!response) throw new Error("Mini App HTTP request returned no response");
    if (response.status >= 300 && response.status < 400) throw new Error("Too many Mini App HTTP redirects");
    const result = await readBoundedText(response);
    const status = response.status;
    if (action.failContains && result.text.includes(action.failContains)) {
      throw new Error(`Mini App response indicates failure: "${action.failContains}"`);
    }
    if (status < 200 || status >= 400) {
      throw new Error(`Mini App HTTP request returned status ${status}`);
    }
    if (action.successContains && !result.text.includes(action.successContains)) {
      throw new Error(`Mini App response did not contain "${action.successContains}"`);
    }
    return {
      url: current.toString(),
      status,
      bytes: result.bytes,
      body: result.text,
      preview: responsePreview(result.text),
      initDataAvailable: Boolean(prepared.initData),
    };
  } catch (error) {
    if (options.signal?.aborted) throw new Error("Job cancelled");
    if (controller.signal.aborted) throw new Error(`Mini App HTTP request timed out after ${maxWaitMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
