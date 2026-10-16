// Covers the watermark recording that makes an OOM kill diagnosable after the fact.
// A SIGKILLed process cannot log its own death, so the value is entirely in what was
// persisted beforehand and what the next boot makes of it.

const { store, mockRunningLogIds } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  mockRunningLogIds: vi.fn((): number[] => []),
}));

// Stands in for the settings key/value table, plus the job-name lookup join.
vi.mock('../db/database', () => ({
  db: {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((key: string) =>
        store.has(key) ? { value: store.get(key) } : undefined,
      ),
      run: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      all: vi.fn((...ids: number[]) =>
        sql.includes('job_logs')
          ? ids.map((logId) => ({ logId, jobName: `job-${logId}` }))
          : [],
      ),
    })),
  },
}));

vi.mock('../jobs/cancellation', () => ({
  cancelJob: vi.fn(), runningLogIds: mockRunningLogIds }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sampleMemory,
  recordMemory,
  reportPreviousShutdown,
  markCleanShutdown,
  memoryReport,
  memoryLimitMb,
} from '../monitor/memory';

beforeEach(() => {
  store.clear();
  mockRunningLogIds.mockReturnValue([]);
  vi.restoreAllMocks();
});

describe('sampleMemory', () => {
  it('reports rss, external and heap as whole megabytes', () => {
    const s = sampleMemory();
    expect(s.rssMb).toBeGreaterThan(0);
    expect(Number.isInteger(s.rssMb)).toBe(true);
    expect(Number.isInteger(s.externalMb)).toBe(true);
    expect(Number.isInteger(s.heapUsedMb)).toBe(true);
    expect(Date.parse(s.at)).not.toBeNaN();
  });

  // external, not just heap: the OOM this exists for was an ArrayBuffer, which
  // --max-old-space-size does not bound and heapUsed does not show.
  it('tracks external memory separately from the heap', () => {
    const before = sampleMemory();
    const held = new ArrayBuffer(120 * 1024 * 1024);
    const after = sampleMemory();
    expect(after.externalMb - before.externalMb).toBeGreaterThan(100);
    expect(after.heapUsedMb - before.heapUsedMb).toBeLessThan(50);
    expect(held.byteLength).toBe(120 * 1024 * 1024);
  });

  it('names the runs in flight so a spike can be attributed to a job', () => {
    mockRunningLogIds.mockReturnValue([41, 42]);
    expect(sampleMemory().runs).toEqual([
      { logId: 41, jobName: 'job-41' },
      { logId: 42, jobName: 'job-42' },
    ]);
  });
});

describe('recordMemory', () => {
  it('persists the sample so it survives a kill the process cannot log', () => {
    recordMemory();
    const saved = JSON.parse(store.get('memory_watermark')!);
    expect(saved.current.rssMb).toBeGreaterThan(0);
    expect(saved.peak.rssMb).toBeGreaterThan(0);
  });

  it('keeps the high-water mark rather than only the latest reading', () => {
    recordMemory();
    const firstPeak = JSON.parse(store.get('memory_watermark')!).peak.rssMb;
    // Force a lower current reading; the peak must not regress
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 1024 * 1024,
      external: 0,
      heapUsed: 0,
      heapTotal: 0,
      arrayBuffers: 0,
    } as NodeJS.MemoryUsage);
    recordMemory();
    const saved = JSON.parse(store.get('memory_watermark')!);
    expect(saved.current.rssMb).toBe(1);
    expect(saved.peak.rssMb).toBe(firstPeak);
  });

  it('warns once past the threshold, naming the job, then re-arms after it recedes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limit = memoryLimitMb()!;
    mockRunningLogIds.mockReturnValue([7]);
    const at = (share: number) =>
      vi.spyOn(process, 'memoryUsage').mockReturnValue({
        rss: Math.round(limit * share) * 1048576,
        external: 0,
        heapUsed: 0,
        heapTotal: 0,
        arrayBuffers: 0,
      } as NodeJS.MemoryUsage);

    at(0.8);
    recordMemory();
    recordMemory();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"job-7" (log 7)');

    // Below the re-arm point, then high again -> a second warning
    at(0.4);
    recordMemory();
    at(0.85);
    recordMemory();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('reportPreviousShutdown', () => {
  it('reports the last sample and the job in flight when no clean marker exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.set(
      'memory_watermark',
      JSON.stringify({
        current: { at: '2026-07-31T10:00:00Z', rssMb: 1902, externalMb: 1743, heapUsedMb: 61, runs: [{ logId: 4471, jobName: 'emby_观看' }] },
        peak: { rssMb: 1980 },
      }),
    );

    reportPreviousShutdown();

    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('without shutting down cleanly');
    expect(msg).toContain('rss 1902MB');
    expect(msg).toContain('external 1743MB');
    expect(msg).toContain('emby_观看');
    expect(msg).toContain('log 4471');
    expect(memoryReport().lastBeforeCrash?.rssMb).toBe(1902);
  });

  it('stays quiet when the previous process shut down cleanly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.set('memory_watermark', JSON.stringify({ current: { rssMb: 500, runs: [] }, peak: { rssMb: 500 } }));
    markCleanShutdown();

    reportPreviousShutdown();

    expect(warn).not.toHaveBeenCalled();
  });

  it('consumes the clean marker so a later kill is not read as a clean stop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.set('memory_watermark', JSON.stringify({ current: { rssMb: 500, runs: [] }, peak: { rssMb: 500 } }));
    markCleanShutdown();

    reportPreviousShutdown(); // clean stop, silent
    reportPreviousShutdown(); // marker spent -> the next abrupt exit is reported

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
