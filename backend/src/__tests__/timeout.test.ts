import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout, settleQuietly } from "../util/timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes a settled value through untouched", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "nope")).resolves.toBe("ok");
  });

  it("propagates the original rejection, not the deadline", async () => {
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1000, "deadline")).rejects.toBe(boom);
  });

  it("rejects with the given message once the deadline passes", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const p = withTimeout(never, 5000, "Telegram connect timed out");

    const assertion = expect(p).rejects.toThrow("Telegram connect timed out");
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
  });

  it("does not fire the deadline when the promise wins the race", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve(1), 5000, "too slow");
    await expect(p).resolves.toBe(1);

    // The timer was cleared, so nothing is left pending
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects promptly on abort and removes its listener and deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const never = new Promise<void>(() => {});
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = withTimeout(never, 5000, "deadline", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow("Job cancelled");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("settleQuietly", () => {
  it("resolves for a fulfilled promise", async () => {
    await expect(settleQuietly(Promise.resolve("done"))).resolves.toBeUndefined();
  });

  it("swallows a rejection -- cleanup must not throw", async () => {
    await expect(settleQuietly(Promise.reject(new Error("destroy failed")))).resolves
      .toBeUndefined();
  });

  it("gives up on a teardown that hangs", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => {});
    const p = settleQuietly(never, 2000);

    let settled = false;
    void p.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe(true);
  });
});
