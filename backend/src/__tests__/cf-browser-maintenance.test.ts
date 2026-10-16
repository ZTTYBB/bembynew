import { beforeEach, describe, expect, it, vi } from "vitest";

let lock: typeof import("../jobs/cfBrowserMaintenance");
beforeEach(async () => {
  vi.resetModules();
  lock = await import("../jobs/cfBrowserMaintenance");
});

describe("browser maintenance exclusion", () => {
  it("counts startup reservations, not only already-open contexts", async () => {
    const first = await lock.acquireCfBrowserUse();
    const second = await lock.acquireCfBrowserUse();
    expect(lock.cfBrowserMaintenanceStatus()).toEqual({ users: 2, maintaining: false });
    expect(lock.tryAcquireCfBrowserMaintenance()).toBeUndefined();
    first();
    first();
    expect(lock.cfBrowserMaintenanceStatus().users).toBe(1);
    expect(lock.tryAcquireCfBrowserMaintenance()).toBeUndefined();
    second();
    const release = lock.tryAcquireCfBrowserMaintenance();
    expect(release).toBeTypeOf("function");
    release!();
  });

  it("holds new browser launches until maintenance is finished", async () => {
    const release = lock.tryAcquireCfBrowserMaintenance()!;
    let started = false;
    const pending = lock.acquireCfBrowserUse().then((done) => { started = true; return done; });
    await Promise.resolve();
    expect(started).toBe(false);
    expect(lock.tryAcquireCfBrowserMaintenance()).toBeUndefined();
    release();
    release();
    const done = await pending;
    expect(started).toBe(true);
    expect(lock.cfBrowserMaintenanceStatus()).toEqual({ users: 1, maintaining: false });
    done();
    done();
    expect(lock.cfBrowserMaintenanceStatus().users).toBe(0);
  });

  it("rechecks if a second maintenance operation wins before a waiting launch resumes", async () => {
    const finishFirst = lock.tryAcquireCfBrowserMaintenance()!;
    let started = false;
    const pending = lock.acquireCfBrowserUse().then((done) => { started = true; return done; });
    finishFirst();
    const finishSecond = lock.tryAcquireCfBrowserMaintenance()!;
    await Promise.resolve();
    expect(started).toBe(false);
    finishSecond();
    (await pending)();
    expect(lock.cfBrowserMaintenanceStatus()).toEqual({ users: 0, maintaining: false });
  });
});
