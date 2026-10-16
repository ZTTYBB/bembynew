/**
 * Bounded waits.
 *
 * Every network call on a job's path (Telegram connect, gramjs invoke, HTTP
 * fetch) can hang forever when the peer black-holes the connection: the socket
 * stays open, nothing rejects, and the awaiting code never resumes. That is
 * expensive here because a running job holds a scheduler concurrency slot and a
 * live Telegram client for its whole lifetime -- one hung await is enough to
 * wedge the account, and enough of them wedge the scheduler itself.
 *
 * So the awaits that can block a job are wrapped with a hard deadline.
 */

import { positiveEnvNumber } from "./env";

/** Ceiling on a single Telegram connect / reconnect attempt. */
export const CONNECT_TIMEOUT_MS = positiveEnvNumber(
  "TG_CONNECT_TIMEOUT_MS",
  30_000,
);

/** Ceiling on a teardown call, so cleanup can never itself hang. */
export const TEARDOWN_TIMEOUT_MS = positiveEnvNumber(
  "TG_TEARDOWN_TIMEOUT_MS",
  5_000,
);

/** Rejects with `new Error(message)` if `promise` has not settled within `ms`. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
  abortMessage = "Job cancelled",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error(abortMessage)));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), ms);
    promise.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Best-effort bounded teardown: resolves once `promise` settles or `ms`
 * elapses, and never rejects. Use it for `destroy()`-style cleanup, where the
 * point is to release resources without letting a wedged client stall the
 * caller that is trying to clean up after it.
 */
export async function settleQuietly(
  promise: Promise<unknown>,
  ms = TEARDOWN_TIMEOUT_MS,
): Promise<void> {
  try {
    await withTimeout(promise, ms, "teardown timed out");
  } catch {
    /* the caller is already tearing this resource down */
  }
}
