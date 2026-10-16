// Tests for the TG App Clients feature:
//   1. DB column — app_client_id defaults to null, persists, clears
//   2. Default profile seeding — 5 profiles, Linux is default, all presets present
//   3. resolveAppClientParams logic — specific client, default fallback, unknown ID, missing setting
//   4. Device params forwarded to requestCode
//   5. Device params forwarded to checkAccountStatus
//   6. Accounts CRUD — app_client_id stored, updated, cleared

import Database from 'better-sqlite3';

let testDb!: InstanceType<typeof Database>;

const { MockTelegramClient, mockConnect, mockSendCode, mockGetMe, mockDestroy } = vi.hoisted(() => {
  const mockConnect    = vi.fn().mockResolvedValue(undefined);
  const mockSendCode   = vi.fn().mockResolvedValue({ phoneCodeHash: 'hash' });
  const mockGetMe      = vi.fn().mockResolvedValue({
    firstName: 'Test', deleted: false, restricted: false, restrictionReason: [],
  });
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  const MockTelegramClient = vi.fn().mockReturnValue({
    connect: mockConnect, sendCode: mockSendCode, getMe: mockGetMe,
    destroy: mockDestroy, session: { save: vi.fn().mockReturnValue('') },
  });
  return { MockTelegramClient, mockConnect, mockSendCode, mockGetMe, mockDestroy };
});

vi.mock('telegram', () => ({ TelegramClient: MockTelegramClient, Api: {}, Logger: vi.fn().mockReturnValue({}) }));
vi.mock('telegram/extensions/Logger', () => ({ LogLevel: { NONE: 0 } }));
vi.mock('telegram/sessions', () => ({ StringSession: vi.fn().mockReturnValue({}) }));
vi.mock('../db/database', () => ({ get db() { return testDb; } }));

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { TelegramClient } from 'telegram';
import { requestCode, checkAccountStatus } from '../auth/tgAuth';
import type { TgDeviceParams } from '../auth/tgAuth';
import type { TgAppClient } from '../types';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL DEFAULT 'Acct',
    phone_number   TEXT    NOT NULL DEFAULT '',
    api_id         INTEGER NOT NULL DEFAULT 0,
    api_hash       TEXT    NOT NULL DEFAULT '',
    session_string TEXT,
    auth_status    TEXT    NOT NULL DEFAULT 'unauthenticated',
    proxy_id       TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
    app_client_id  TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

// Mirrors the seeded defaults from database.ts — used as test reference data
const SEEDED_CLIENTS: TgAppClient[] = [
  { id: 'preset-ios',     name: 'iOS',     deviceModel: 'iPhone 13 Pro Max', systemVersion: 'iOS 15.4.1',       appVersion: '8.4.2',  langCode: 'en', langPack: 'ios',      systemLangCode: 'en-US', isDefault: false },
  { id: 'preset-android', name: 'Android', deviceModel: 'Samsung SM-G991B',  systemVersion: 'Android 12',        appVersion: '9.1.1',  langCode: 'en', langPack: 'android',  systemLangCode: 'en-US', isDefault: false },
  { id: 'preset-windows', name: 'Windows', deviceModel: 'Desktop',           systemVersion: 'Windows 10',        appVersion: '4.16.5', langCode: 'en', langPack: 'tdesktop', systemLangCode: 'en-US', isDefault: false },
  { id: 'preset-mac',     name: 'Mac',     deviceModel: 'MacBook Pro',       systemVersion: 'macOS 13.2',        appVersion: '8.4.2',  langCode: 'en', langPack: 'macos',    systemLangCode: 'en-US', isDefault: false },
  { id: 'preset-linux',   name: 'Linux',   deviceModel: 'PC 64bit',          systemVersion: 'Ubuntu 22.04 LTS', appVersion: '4.16.5', langCode: 'en', langPack: 'tdesktop', systemLangCode: 'en-US', isDefault: true  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertAccount(fields: Partial<{ appClientId: string | null }> = {}) {
  const { lastInsertRowid } = testDb.prepare(
    'INSERT INTO tg_accounts (app_client_id) VALUES (?)'
  ).run(fields.appClientId ?? null);
  return testDb.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(lastInsertRowid) as any;
}

function seedClients(clients: TgAppClient[] = SEEDED_CLIENTS) {
  testDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    'tg_app_clients', JSON.stringify(clients)
  );
}

// Mirrors the resolveAppClientParams logic from accounts.ts and runner.ts
function resolveAppClientParams(appClientId: string | null | undefined): TgDeviceParams | undefined {
  try {
    const row = testDb.prepare('SELECT value FROM settings WHERE key = ?').get('tg_app_clients') as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as TgAppClient[];
    const client = appClientId ? list.find(c => c.id === appClientId) : list.find(c => c.isDefault);
    if (!client) return undefined;
    return {
      deviceModel: client.deviceModel,
      systemVersion: client.systemVersion,
      appVersion: client.appVersion,
      langCode: client.langCode,
      langPack: client.langPack,
      systemLangCode: client.systemLangCode,
    };
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.exec(SCHEMA);
});

beforeEach(() => {
  vi.clearAllMocks();
  testDb.exec('DELETE FROM tg_accounts; DELETE FROM settings;');
});

// ---------------------------------------------------------------------------
// 1. DB column behaviour
// ---------------------------------------------------------------------------

describe('tg_accounts.app_client_id column', () => {
  it('defaults to null for a newly inserted account', () => {
    const a = insertAccount();
    expect(a.app_client_id).toBeNull();
  });

  it('persists a specific client ID after INSERT', () => {
    const a = insertAccount({ appClientId: 'preset-linux' });
    expect(a.app_client_id).toBe('preset-linux');
  });

  it('can be updated to a new client ID', () => {
    const a = insertAccount({ appClientId: 'preset-ios' });
    testDb.prepare('UPDATE tg_accounts SET app_client_id = ? WHERE id = ?').run('preset-android', a.id);
    const row = testDb.prepare('SELECT app_client_id FROM tg_accounts WHERE id = ?').get(a.id) as any;
    expect(row.app_client_id).toBe('preset-android');
  });

  it('can be cleared back to null', () => {
    const a = insertAccount({ appClientId: 'preset-ios' });
    testDb.prepare('UPDATE tg_accounts SET app_client_id = NULL WHERE id = ?').run(a.id);
    const row = testDb.prepare('SELECT app_client_id FROM tg_accounts WHERE id = ?').get(a.id) as any;
    expect(row.app_client_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Default profile seeding
// ---------------------------------------------------------------------------

describe('default TG app client profiles', () => {
  it('seeds exactly 5 profiles', () => {
    seedClients();
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'tg_app_clients'").get() as any;
    const profiles = JSON.parse(row.value) as TgAppClient[];
    expect(profiles).toHaveLength(5);
  });

  it('Linux is the only default profile', () => {
    seedClients();
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'tg_app_clients'").get() as any;
    const profiles = JSON.parse(row.value) as TgAppClient[];
    const defaults = profiles.filter(p => p.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe('Linux');
    expect(defaults[0].id).toBe('preset-linux');
  });

  it('all five platform presets are present by name', () => {
    seedClients();
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'tg_app_clients'").get() as any;
    const profiles = JSON.parse(row.value) as TgAppClient[];
    const names = profiles.map((p: TgAppClient) => p.name);
    expect(names).toEqual(expect.arrayContaining(['iOS', 'Android', 'Windows', 'Mac', 'Linux']));
  });

  it('Linux profile has tdesktop lang pack', () => {
    seedClients();
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'tg_app_clients'").get() as any;
    const profiles = JSON.parse(row.value) as TgAppClient[];
    const linux = profiles.find((p: TgAppClient) => p.id === 'preset-linux');
    expect(linux?.langPack).toBe('tdesktop');
  });

  it('iOS profile has ios lang pack', () => {
    seedClients();
    const row = testDb.prepare("SELECT value FROM settings WHERE key = 'tg_app_clients'").get() as any;
    const profiles = JSON.parse(row.value) as TgAppClient[];
    const ios = profiles.find((p: TgAppClient) => p.id === 'preset-ios');
    expect(ios?.langPack).toBe('ios');
  });
});

// ---------------------------------------------------------------------------
// 3. resolveAppClientParams logic
// ---------------------------------------------------------------------------

describe('resolveAppClientParams', () => {
  it('returns device params for the named client when appClientId matches', () => {
    seedClients();
    const params = resolveAppClientParams('preset-ios');
    expect(params?.deviceModel).toBe('iPhone 13 Pro Max');
    expect(params?.systemVersion).toBe('iOS 15.4.1');
    expect(params?.appVersion).toBe('8.4.2');
    expect(params?.langPack).toBe('ios');
  });

  it('returns the default (Linux) profile when appClientId is null', () => {
    seedClients();
    const params = resolveAppClientParams(null);
    expect(params?.deviceModel).toBe('PC 64bit');
    expect(params?.systemVersion).toBe('Ubuntu 22.04 LTS');
    expect(params?.langPack).toBe('tdesktop');
  });

  it('returns the default profile when appClientId is undefined', () => {
    seedClients();
    const params = resolveAppClientParams(undefined);
    expect(params?.deviceModel).toBe('PC 64bit');
  });

  it('returns undefined when appClientId does not match any profile', () => {
    seedClients();
    expect(resolveAppClientParams('nonexistent-id')).toBeUndefined();
  });

  it('returns undefined when the tg_app_clients setting is absent', () => {
    // No settings seeded — DB is empty
    expect(resolveAppClientParams(null)).toBeUndefined();
    expect(resolveAppClientParams('preset-ios')).toBeUndefined();
  });

  it('returns correct params for each seeded preset', () => {
    seedClients();
    for (const preset of SEEDED_CLIENTS) {
      const params = resolveAppClientParams(preset.id);
      expect(params).toBeDefined();
      expect(params?.deviceModel).toBe(preset.deviceModel);
      expect(params?.systemVersion).toBe(preset.systemVersion);
      expect(params?.appVersion).toBe(preset.appVersion);
      expect(params?.langCode).toBe(preset.langCode);
      expect(params?.langPack).toBe(preset.langPack);
      expect(params?.systemLangCode).toBe(preset.systemLangCode);
    }
  });

  it('returns the custom default when a non-preset profile is marked isDefault', () => {
    seedClients([
      ...SEEDED_CLIENTS.map(c => ({ ...c, isDefault: false })),
      { id: 'custom-1', name: 'Custom', deviceModel: 'My Device', systemVersion: 'Custom OS 1.0', appVersion: '1.0', langCode: 'en', langPack: 'tdesktop', systemLangCode: 'en-US', isDefault: true },
    ]);
    const params = resolveAppClientParams(null);
    expect(params?.deviceModel).toBe('My Device');
  });
});

// ---------------------------------------------------------------------------
// 4. Device params forwarded to requestCode
// ---------------------------------------------------------------------------

describe('requestCode — device params', () => {
  // Device params are intentionally stripped during requestCode auth -- desktop profiles
  // can cause Telegram to route the code to a non-existent desktop session.
  it('does not forward device params to TelegramClient during auth', async () => {
    const params: TgDeviceParams = {
      deviceModel: 'iPhone 13 Pro Max',
      systemVersion: 'iOS 15.4.1',
      appVersion: '8.4.2',
      langCode: 'en',
      langPack: 'ios',
      systemLangCode: 'en-US',
    };
    await requestCode(901, 1, 'hash', '+61400000000', undefined, params);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('deviceModel');
    expect(opts).not.toHaveProperty('systemVersion');
    expect(opts).not.toHaveProperty('langPack');
  });

  it('does not include device fields in TelegramClient opts when none provided', async () => {
    await requestCode(902, 1, 'hash', '+61400000001');
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('deviceModel');
    expect(opts).not.toHaveProperty('systemVersion');
    expect(opts).not.toHaveProperty('langPack');
  });

  it('retains connectionRetries even when device params are provided', async () => {
    const params: TgDeviceParams = { deviceModel: 'PC 64bit' };
    await requestCode(903, 1, 'hash', '+61400000002', undefined, params);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts.connectionRetries).toBe(3);
    expect(opts).not.toHaveProperty('deviceModel');
  });
});

// ---------------------------------------------------------------------------
// 5. Device params forwarded to checkAccountStatus
// ---------------------------------------------------------------------------

describe('checkAccountStatus — device params', () => {
  it('passes device params to TelegramClient when provided', async () => {
    const params: TgDeviceParams = {
      deviceModel: 'Samsung SM-G991B',
      systemVersion: 'Android 12',
      appVersion: '9.1.1',
      langCode: 'en',
      langPack: 'android',
      systemLangCode: 'en-US',
    };
    await checkAccountStatus(1, 'hash', 'session', undefined, params);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts.deviceModel).toBe('Samsung SM-G991B');
    expect(opts.systemVersion).toBe('Android 12');
    expect(opts.langPack).toBe('android');
  });

  it('does not include device fields when none provided', async () => {
    await checkAccountStatus(1, 'hash', 'session');
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('deviceModel');
    expect(opts).not.toHaveProperty('langPack');
  });

  it('partial device params only set provided fields', async () => {
    const params: TgDeviceParams = { deviceModel: 'PC 64bit' };
    await checkAccountStatus(1, 'hash', 'session', undefined, params);
    const opts = vi.mocked(TelegramClient).mock.calls[0][3] as Record<string, unknown>;
    expect(opts.deviceModel).toBe('PC 64bit');
    // Unset fields must not appear
    expect(opts).not.toHaveProperty('systemVersion');
    expect(opts).not.toHaveProperty('langPack');
  });
});

// ---------------------------------------------------------------------------
// 6. Accounts CRUD — app_client_id
// ---------------------------------------------------------------------------

describe('accounts CRUD — app_client_id', () => {
  it('stores app_client_id during account creation', () => {
    const { lastInsertRowid } = testDb.prepare(
      'INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, app_client_id) VALUES (?, ?, ?, ?, ?)'
    ).run('Alice', '+1', 1, 'hash', 'preset-android');
    const row = testDb.prepare('SELECT app_client_id FROM tg_accounts WHERE id = ?').get(lastInsertRowid) as any;
    expect(row.app_client_id).toBe('preset-android');
  });

  it('updates app_client_id without affecting other fields', () => {
    const a = insertAccount({ appClientId: 'preset-ios' });
    testDb.prepare('UPDATE tg_accounts SET app_client_id = ? WHERE id = ?').run('preset-linux', a.id);
    const row = testDb.prepare('SELECT * FROM tg_accounts WHERE id = ?').get(a.id) as any;
    expect(row.app_client_id).toBe('preset-linux');
    expect(row.name).toBe('Acct'); // unrelated field unchanged
  });

  it('clearing app_client_id causes resolveAppClientParams to return the default profile', () => {
    seedClients();
    const a = insertAccount({ appClientId: 'preset-mac' });
    testDb.prepare('UPDATE tg_accounts SET app_client_id = NULL WHERE id = ?').run(a.id);
    const row = testDb.prepare('SELECT app_client_id FROM tg_accounts WHERE id = ?').get(a.id) as any;
    expect(row.app_client_id).toBeNull();
    // Resolving null falls back to the seeded default (Linux)
    const params = resolveAppClientParams(null);
    expect(params?.deviceModel).toBe('PC 64bit');
  });
});

// ---------------------------------------------------------------------------
// 7. checkAccountStatus — account state detection
// ---------------------------------------------------------------------------

describe('checkAccountStatus — account state detection', () => {
  beforeEach(() => { vi.mocked(TelegramClient).mockClear(); mockConnect.mockClear(); mockGetMe.mockClear(); mockDestroy.mockClear(); });

  it('returns isActive true and isRestricted false for a normal account', async () => {
    mockGetMe.mockResolvedValueOnce({ firstName: 'Alice', deleted: false, restricted: false, restrictionReason: [] });
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isActive).toBe(true);
    expect(result.isDeleted).toBe(false);
    expect(result.isRestricted).toBe(false);
    expect(result.firstName).toBe('Alice');
  });

  it('returns isDeleted true when the user object has deleted flag', async () => {
    mockGetMe.mockResolvedValueOnce({ firstName: '', deleted: true, restricted: false, restrictionReason: [] });
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isDeleted).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it('returns isRestricted true and populates restrictions for a restricted user', async () => {
    mockGetMe.mockResolvedValueOnce({
      firstName: 'Bob', deleted: false, restricted: true,
      restrictionReason: [{ platform: 'all', reason: 'spam', text: 'Spam restricted' }],
    });
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isRestricted).toBe(true);
    expect(result.isActive).toBe(false);
    expect(result.restrictions[0].reason).toBe('spam');
  });

  it('returns isDeleted true for UserEmpty response', async () => {
    mockGetMe.mockResolvedValueOnce({ className: 'UserEmpty' });
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isDeleted).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it('returns isDeleted true when connect throws USER_DEACTIVATED_BAN', async () => {
    mockConnect.mockRejectedValueOnce(Object.assign(new Error('USER_DEACTIVATED_BAN'), { errorMessage: 'USER_DEACTIVATED_BAN' }));
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isDeleted).toBe(true);
    expect(result.isActive).toBe(false);
    expect(result.restrictions[0].reason).toBe('banned');
  });

  it('returns isRestricted true when connect throws ACCOUNT_FROZEN', async () => {
    mockConnect.mockRejectedValueOnce(Object.assign(new Error('ACCOUNT_FROZEN'), { errorMessage: 'ACCOUNT_FROZEN' }));
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isRestricted).toBe(true);
    expect(result.isActive).toBe(false);
    expect(result.restrictions[0].reason).toBe('account_frozen');
  });

  it('returns isRestricted true when connect throws AUTH_KEY_UNREGISTERED', async () => {
    mockConnect.mockRejectedValueOnce(Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' }));
    const result = await checkAccountStatus(1, 'hash', 'session');
    expect(result.isRestricted).toBe(true);
    expect(result.restrictions[0].text).toMatch(/revoked/i);
  });

  it('re-throws unknown errors', async () => {
    mockConnect.mockRejectedValueOnce(Object.assign(new Error('FLOOD_WAIT_60'), { errorMessage: 'FLOOD_WAIT_60' }));
    await expect(checkAccountStatus(1, 'hash', 'session')).rejects.toThrow('FLOOD_WAIT_60');
  });
});
