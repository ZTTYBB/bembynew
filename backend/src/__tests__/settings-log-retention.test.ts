// Tests for the log_retention_days setting: whitelist membership and the
// immediate purge triggered when the value is saved.

const {
  mockRun,
  mockAll,
  mockPrepare,
  mockPurge,
  mockRefresh,
  mockRefreshRunSlots,
} = vi.hoisted(() => {
  const mockRun = vi.fn();
  const mockAll = vi.fn().mockReturnValue([]);
  const mockPrepare = vi.fn((sql: string) => ({
    run: mockRun,
    all: mockAll,
    // aiKeyConfigured counts ai_suppliers rows and reads `.n` off the result
    get: vi.fn().mockReturnValue(sql.includes('COUNT(*) AS n') ? { n: 0 } : undefined),
  }));
  return {
    mockRun,
    mockAll,
    mockPrepare,
    mockPurge: vi.fn(),
    mockRefresh: vi.fn(),
    mockRefreshRunSlots: vi.fn(),
  };
});

vi.mock('../db/database', () => ({
  getDefaultTimezone: () => "UTC",
  FALLBACK_TIMEZONE: "Australia/Sydney",
  db: {
    prepare: mockPrepare,
    transaction: (fn: any) => fn,
  },
}));
vi.mock('../scheduler', () => ({
  refreshScheduler: mockRefresh,
  refreshRunSlots: mockRefreshRunSlots,
  purgeOldLogs: mockPurge,
}));
vi.mock('../jobs/runner', () => ({ parseTgProxy: vi.fn() }));
vi.mock('socks', () => ({ SocksClient: { createConnection: vi.fn() } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import settingsRouter, { ALLOWED_KEYS } from '../routes/settings';

/** Pulls a route handler out of the Express router so it can be called directly. */
function routeHandler(method: string, path: string) {
  const layer = (settingsRouter as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[0].handle as (req: any, res: any) => void;
}

function makeRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

const putSettings = routeHandler('put', '/');

beforeEach(() => {
  vi.clearAllMocks();
  mockAll.mockReturnValue([]);
});

describe('max_concurrent_jobs setting', () => {
  it('wakes the existing run queue when the limit is saved', () => {
    putSettings({ body: { max_concurrent_jobs: '3' } }, makeRes());

    expect(mockRun).toHaveBeenCalledWith('max_concurrent_jobs', '3');
    expect(mockRefreshRunSlots).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe('log_retention_days setting', () => {
  it('is an allowed settings key', () => {
    expect(ALLOWED_KEYS).toContain('log_retention_days');
  });

  it('persists the value and purges immediately when saved', () => {
    putSettings({ body: { log_retention_days: '30' } }, makeRes());

    expect(mockRun).toHaveBeenCalledWith('log_retention_days', '30');
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does not purge when the retention setting is untouched', () => {
    putSettings({ body: { default_timezone: 'UTC' } }, makeRes());

    expect(mockRun).toHaveBeenCalledWith('default_timezone', 'UTC');
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('is returned to the client by GET /settings', () => {
    mockAll.mockReturnValue([{ key: 'log_retention_days', value: '7' }]);
    const res = makeRes();

    routeHandler('get', '/')({}, res);

    expect(res.body.log_retention_days).toBe('7');
  });
});

describe('log_screenshot_max_count setting', () => {
  it('accepts and persists a non-negative screenshot count', () => {
    expect(ALLOWED_KEYS).toContain('log_screenshot_max_count');
    putSettings({ body: { log_screenshot_max_count: '12' } }, makeRes());
    expect(mockRun).toHaveBeenCalledWith('log_screenshot_max_count', '12');
  });

  it('rejects malformed or excessive screenshot counts', () => {
    const decimal = makeRes();
    putSettings({ body: { log_screenshot_max_count: '1.5' } }, decimal);
    expect(decimal.statusCode).toBe(400);
    const excessive = makeRes();
    putSettings({ body: { log_screenshot_max_count: '10001' } }, excessive);
    expect(excessive.statusCode).toBe(400);
  });
});
