const { mockDeleteRun, mockSettingGet, mockPrepare } = vi.hoisted(() => {
  const mockDeleteRun = vi.fn().mockReturnValue({ changes: 0 });
  const mockSettingGet = vi.fn();
  const mockPrepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.startsWith("DELETE FROM job_logs")) return { run: mockDeleteRun };
    if (sql.includes("log_retention_days")) return { get: mockSettingGet };
    return {
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
      run: vi.fn(),
    };
  });
  return { mockDeleteRun, mockSettingGet, mockPrepare };
});

vi.mock("../db/database", () => ({
  db: { prepare: mockPrepare },
  getDefaultTgApiCredentials: vi.fn().mockReturnValue(null),
}));
vi.mock("../jobs/runner", () => ({ runJob: vi.fn() }));
vi.mock("../jobs/cancellation", () => ({
  cancelJob: vi.fn(),
  registerJob: vi.fn(),
  unregisterJob: vi.fn(),
  registerLiveDetail: vi.fn(),
  clearLiveDetail: vi.fn(),
}));
vi.mock("../jobs/notify", () => ({
  getNotifyConfig: vi.fn().mockReturnValue({ events: [], username: null }),
  notifyJobEvent: vi.fn(),
  sendTgNotify: vi.fn(),
  buildSuccessMessage: vi.fn(),
  buildFailureMessage: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { purgeOldLogs } from "../scheduler";

const DAY_MS = 86_400_000;

describe("purgeOldLogs — log retention", () => {
  beforeEach(() => {
    mockDeleteRun.mockClear();
    mockSettingGet.mockReset();
  });

  it("keeps all logs when retention is 0", () => {
    mockSettingGet.mockReturnValue({ value: "0" });
    purgeOldLogs();
    expect(mockDeleteRun).not.toHaveBeenCalled();
  });

  it("keeps all logs when the setting is missing", () => {
    mockSettingGet.mockReturnValue(undefined);
    purgeOldLogs();
    expect(mockDeleteRun).not.toHaveBeenCalled();
  });

  it("keeps all logs when the setting is not a number", () => {
    mockSettingGet.mockReturnValue({ value: "abc" });
    purgeOldLogs();
    expect(mockDeleteRun).not.toHaveBeenCalled();
  });

  it("keeps all logs when retention is negative", () => {
    mockSettingGet.mockReturnValue({ value: "-5" });
    purgeOldLogs();
    expect(mockDeleteRun).not.toHaveBeenCalled();
  });

  it("deletes logs older than the retention window", () => {
    mockSettingGet.mockReturnValue({ value: "30" });
    purgeOldLogs();

    expect(mockDeleteRun).toHaveBeenCalledTimes(1);
    const cutoff = mockDeleteRun.mock.calls[0][0] as string;
    const cutoffAgeMs = Date.now() - new Date(cutoff).getTime();
    // Cutoff should sit ~30 days in the past
    expect(cutoffAgeMs).toBeGreaterThan(30 * DAY_MS - 60_000);
    expect(cutoffAgeMs).toBeLessThan(30 * DAY_MS + 60_000);
  });

  it("never deletes logs for jobs that are still running", () => {
    mockSettingGet.mockReturnValue({ value: "1" });
    purgeOldLogs();

    const deleteSql = (
      mockPrepare.mock.calls.map((c) => c[0] as string)
    ).find((sql) => sql.startsWith("DELETE FROM job_logs"));
    expect(deleteSql).toContain("status != 'running'");
  });
});
