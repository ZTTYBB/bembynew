import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestRequest, isRequestCancelled } from "../src/utils/latestRequest.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("replaces and aborts the old request even if it ignores cancellation", async () => {
  const first = deferred();
  const second = deferred();
  const owner = createLatestRequest();
  const values = [];
  let oldSignal;
  const old = owner.run(async ({ signal, commit }) => {
    oldSignal = signal;
    commit(() => values.push("old started"));
    await first.promise;
    commit(() => values.push("stale"));
    return "old";
  });
  const current = owner.run(async ({ commit }) => {
    await second.promise;
    commit(() => values.push("latest"));
    return "new";
  });
  assert.equal(oldSignal.aborted, true);
  second.resolve();
  assert.equal(await current, "new");
  first.resolve();
  assert.equal(await old, undefined);
  assert.deepEqual(values, ["old started", "latest"]);
});

test("a stale finally cannot clear the newer request's loading state", async () => {
  const first = deferred();
  const second = deferred();
  let loading = false;
  const owner = createLatestRequest({
    onStart: () => { loading = true; },
    onFinish: () => { loading = false; },
  });
  const old = owner.run(() => first.promise);
  const latest = owner.run(() => second.promise);
  first.resolve();
  await old;
  assert.equal(loading, true);
  assert.equal(owner.pending, true);
  second.resolve();
  await latest;
  assert.equal(loading, false);
  assert.equal(owner.pending, false);
});

test("suppresses stale failures and only reports the active failure", async () => {
  const first = deferred();
  const second = deferred();
  const errors = [];
  const owner = createLatestRequest({ onError: (error) => errors.push(error.message) });
  const old = owner.run(() => first.promise);
  const latest = owner.run(() => second.promise);
  first.reject(new Error("stale failure"));
  await old;
  second.reject(new Error("current failure"));
  await latest;
  assert.deepEqual(errors, ["current failure"]);
});

test("recognizes browser and axios cancellation without displaying an error", async () => {
  const errors = [];
  const owner = createLatestRequest({ onError: (error) => errors.push(error) });
  for (const error of [
    { name: "AbortError" }, { name: "CanceledError" }, { code: "ERR_CANCELED" },
  ]) {
    assert.equal(isRequestCancelled(error), true);
    await owner.run(async () => { throw error; });
  }
  assert.equal(isRequestCancelled(new Error("failed")), false);
  assert.deepEqual(errors, []);
});

test("background refresh skips a pending request instead of starving a slow response", async () => {
  const slow = deferred();
  const owner = createLatestRequest();
  let attempts = 0;
  let signal;
  const first = owner.run(async (context) => {
    attempts += 1;
    signal = context.signal;
    return slow.promise;
  });
  for (let i = 0; i < 8; i++) await owner.run(async () => { attempts += 1; }, { ifIdle: true });
  assert.equal(attempts, 1);
  assert.equal(signal.aborted, false);
  slow.resolve("settled");
  assert.equal(await first, "settled");
  await owner.run(async () => { attempts += 1; }, { ifIdle: true });
  assert.equal(attempts, 2);
});

test("cancel clears loading and blocks every stage of a composite request", async () => {
  const first = deferred();
  const owner = createLatestRequest();
  let secondStage = false;
  let updated = false;
  const request = owner.run(async ({ signal, isCurrent, commit }) => {
    await first.promise;
    if (!isCurrent()) return;
    secondStage = true;
    assert.equal(signal.aborted, false);
    commit(() => { updated = true; });
  });
  owner.cancel();
  assert.equal(owner.pending, false);
  first.resolve();
  await request;
  assert.equal(secondStage, false);
  assert.equal(updated, false);
});

test("dispose aborts pending work and blocks future work, callbacks and commits", async () => {
  const response = deferred();
  let finishes = 0;
  let commits = 0;
  let signal;
  const owner = createLatestRequest({ onFinish: () => { finishes += 1; } });
  const request = owner.run(async (context) => {
    signal = context.signal;
    await response.promise;
    context.commit(() => { commits += 1; });
  });
  owner.dispose();
  assert.equal(signal.aborted, true);
  response.resolve();
  await request;
  await owner.run(async () => { commits += 1; });
  assert.equal(finishes, 0);
  assert.equal(commits, 0);
});

test("throws only a current real error when there is no error hook", async () => {
  const owner = createLatestRequest();
  await assert.rejects(owner.run(async () => { throw new Error("active failure"); }), /active failure/);
  assert.equal(owner.pending, false);
});

test("aborts sibling work when one stage of a composite request fails", async () => {
  let siblingAborted = false;
  const owner = createLatestRequest({ onError: () => {} });
  await owner.run(async ({ signal }) => {
    const sibling = new Promise((resolve) => {
      signal.addEventListener("abort", () => { siblingAborted = true; resolve(); }, { once: true });
    });
    await Promise.all([sibling, Promise.reject(new Error("primary failed"))]);
  });
  assert.equal(siblingAborted, true);
});
