// Unit tests for testEmbyConnection: the pre-save connectivity/credential
// check used by the jobs and templates screens.

const { mockUndiciFetch, MockProxyAgent, MockAgent } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
  MockProxyAgent: vi.fn(),
  MockAgent: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mockUndiciFetch,
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

vi.mock('../db/database', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db/database';
import { testEmbyConnection } from '../jobs/embywatch';

const creds = { username: 'user', password: 'pass' };

function mockAuthSuccess() {
  mockUndiciFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }),
      ),
  });
}

/** Settings lookup returning undefined for every key (all defaults). */
function mockNoSettings() {
  vi.mocked(db.prepare).mockReturnValue({
    get: vi.fn().mockReturnValue(undefined),
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNoSettings();
});

describe('testEmbyConnection', () => {
  it('returns ok with the user name when authentication succeeds', async () => {
    mockAuthSuccess();

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result).toEqual({ ok: true, userName: 'Tester', serverUrl: 'https://emby.example.com' });
  });

  it('sends the credentials to /Users/AuthenticateByName', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    const [url, opts] = mockUndiciFetch.mock.calls[0] as [string, any];
    expect(url).toBe('https://emby.example.com/Users/AuthenticateByName');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ Username: 'user', Pw: 'pass' });
    expect(opts.headers['X-Emby-Authorization']).toContain('MediaBrowser');
  });

  it('returns ok false with the server message on invalid credentials', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve(JSON.stringify({ Message: 'Invalid user or password' })),
    });

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Invalid user or password');
  });

  it('returns ok false when the server is unreachable', async () => {
    mockUndiciFetch.mockRejectedValue(
      Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }),
    );

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Cannot reach Emby server');
  });

  it('passes an abort signal so a dead host cannot hang the request', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    const opts = mockUndiciFetch.mock.calls[0][1] as any;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the given user agent, falling back to the default when absent', async () => {
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, userAgent: 'MyPlayer/1.0' });
    expect((mockUndiciFetch.mock.calls[0][1] as any).headers['User-Agent']).toBe('MyPlayer/1.0');

    mockUndiciFetch.mockClear();
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', creds);
    expect((mockUndiciFetch.mock.calls[0][1] as any).headers['User-Agent']).toContain('SenPlayer');
  });

  it('derives the auth header Client and Version from the user agent', async () => {
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, userAgent: 'CapyPlayer/1.2.3 CFNetwork/1.0' });
    const auth = (mockUndiciFetch.mock.calls[0][1] as any).headers['X-Emby-Authorization'];
    expect(auth).toContain('Client="CapyPlayer"');
    expect(auth).toContain('Version="1.2.3"');
    expect(auth).not.toContain('SenPlayer');
  });

  it('routes through the configured proxy when proxyId is given', async () => {
    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn().mockImplementation((key: string) =>
        key === 'proxies'
          ? { value: JSON.stringify([{ id: 'p1', name: 'P', url: 'http://proxy.local:3128' }]) }
          : undefined,
      ),
    } as any);
    mockAuthSuccess();

    const result = await testEmbyConnection('https://emby.example.com', {
      ...creds,
      proxyId: 'p1',
    });

    expect(result.ok).toBe(true);
    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy.local:3128');
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('uses the direct IPv4 agent when no proxy is configured', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);

    expect(MockProxyAgent).not.toHaveBeenCalled();
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBeInstanceOf(MockAgent);
  });

  it('uses an insecure IPv4 dispatcher when ignoreCertErrors is true and falls back to strict when false', async () => {
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', creds);
    const strictDispatcher = (mockUndiciFetch.mock.calls[0][1] as any).dispatcher;

    mockUndiciFetch.mockClear();
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, ignoreCertErrors: true });
    const insecureDispatcher = (mockUndiciFetch.mock.calls[0][1] as any).dispatcher;

    expect(MockAgent).toHaveBeenCalledWith({
      connect: expect.objectContaining({ rejectUnauthorized: false }),
    });
    expect(insecureDispatcher).toBeInstanceOf(MockAgent);
    expect(insecureDispatcher).not.toBe(strictDispatcher);

    mockUndiciFetch.mockClear();
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', { ...creds, ignoreCertErrors: false });
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBe(strictDispatcher);
  });

  it('configures ProxyAgent with requestTls.rejectUnauthorized=false when ignoreCertErrors is true', async () => {
    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn((key: string) =>
        key === 'proxies'
          ? { value: JSON.stringify([{ id: 'p-tls', name: 'P-TLS', url: 'http://proxy-insecure.local:3128' }]) }
          : undefined,
      ),
    } as any);
    mockAuthSuccess();

    const result = await testEmbyConnection('https://emby.example.com', {
      ...creds,
      proxyId: 'p-tls',
      ignoreCertErrors: true,
    });

    expect(result.ok).toBe(true);
    expect(MockProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy-insecure.local:3128',
      requestTls: { rejectUnauthorized: false },
    });
    expect((mockUndiciFetch.mock.calls[0][1] as any).dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('respects default_ignore_cert_errors setting and explicit ignoreCertErrors=false override', async () => {
    vi.mocked(db.prepare).mockReturnValue({
      get: vi.fn((key: string) => {
        if (key === 'default_ignore_cert_errors') return { value: 'true' };
        if (key === 'proxies') {
          return {
            value: JSON.stringify([
              { id: 'p-def', name: 'P-Def', url: 'http://proxy-default-insecure.local:3128' },
              { id: 'p-strict', name: 'P-Strict', url: 'http://proxy-override-strict.local:3128' },
            ]),
          };
        }
        return undefined;
      }),
    } as any);
    mockAuthSuccess();

    await testEmbyConnection('https://emby.example.com', { ...creds, proxyId: 'p-def' });
    expect(MockProxyAgent).toHaveBeenCalledWith({
      uri: 'http://proxy-default-insecure.local:3128',
      requestTls: { rejectUnauthorized: false },
    });

    MockProxyAgent.mockClear();
    mockAuthSuccess();
    await testEmbyConnection('https://emby.example.com', {
      ...creds,
      proxyId: 'p-strict',
      ignoreCertErrors: false,
    });
    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy-override-strict.local:3128');
  });

  it('preserves TLS certificate error codes such as CERT_HAS_EXPIRED in failure message', async () => {
    mockUndiciFetch.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }),
    );

    const result = await testEmbyConnection('https://emby.example.com', creds);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('CERT_HAS_EXPIRED');
  });
});
