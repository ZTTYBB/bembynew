// Verify that embywatch uses the IPv4-only undici agent (no proxy) vs ProxyAgent (proxy set).
// The IPv4 agent guards against Happy Eyeballs wasting the connect timeout on broken
// IPv6 routes in container environments.

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
import {
  EmbywatchError,
  isFallbackWorthy,
  resolveProxyLabel,
  resolveServerCandidates,
  runEmbywatch,
  testEmbyConnection,
} from '../jobs/embywatch';

const baseConfig = { username: 'user', password: 'pass', playDuration: 1 };

// Key-aware settings mock: returns a row only for the given keys, so e.g. the
// proxies JSON is never misread as a device-name template. `run` covers the
// device-name persistence path.
function mockSettings(settings: Record<string, string> = {}) {
  vi.mocked(db.prepare).mockReturnValue({
    get: vi.fn((key: string) => (key in settings ? { value: settings[key] } : undefined)),
    run: vi.fn(),
  } as any);
}

// Each test only needs to verify which dispatcher is used on the first request (auth).
// We let it fail after that -- no need to simulate full playback.

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings();
  mockUndiciFetch.mockRejectedValue(
    Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }),
  );
});

describe('embywatch proxy log labels', () => {
  it('records the proxy name instead of its authenticated URL', () => {
    mockSettings({
      proxies: JSON.stringify([
        { id: 'p1', name: 'Office', url: 'http://user:secret@proxy.local:3128' },
      ]),
    });
    expect(resolveProxyLabel('p1')).toBe('Office');
  });

  it('uses an identifier for unnamed proxies without exposing credentials', () => {
    mockSettings({
      proxies: JSON.stringify([
        { id: 'p1', url: 'http://user:secret@proxy.local:3128' },
      ]),
    });
    expect(resolveProxyLabel('p1')).toBe('proxy (p1)');
  });

  it('reports direct when no usable proxy is resolved', () => {
    expect(resolveProxyLabel()).toBe('direct');
    expect(resolveProxyLabel('missing')).toBe('direct');
    mockSettings({
      proxies: JSON.stringify([{ id: 'p1', name: 'Empty', url: '' }]),
    });
    expect(resolveProxyLabel('p1')).toBe('direct');
    mockSettings({ proxies: 'invalid JSON' });
    expect(resolveProxyLabel('p1')).toBe('direct');
  });
});

describe('embywatch fetch routing', () => {
  it('uses the IPv4 agent (not ProxyAgent) when no proxy is configured', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server');

    expect(mockUndiciFetch).toHaveBeenCalled();
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    // Should be the ipv4Agent instance (MockAgent), not a ProxyAgent
    expect(MockProxyAgent).not.toHaveBeenCalled();
    expect(dispatcher).toBeInstanceOf(MockAgent);
  });

  it('uses ProxyAgent when a proxy URL is resolved', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'p1', name: 'My Proxy', url: 'http://proxy.local:3128' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'p1' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy.local:3128');
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    expect(dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('falls back to IPv4 agent when proxyId does not match any stored proxy', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'other', url: 'http://x' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'missing' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).not.toHaveBeenCalled();
  });

  it('wraps network errors with a safe diagnostic code but no request URL', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server (ECONNREFUSED)');
  });

  it('sanitises whitespace in DeviceId but keeps the display device name', async () => {
    mockSettings({ default_device_name: 'Macbook Pro' });

    await expect(runEmbywatch('https://emby.example.com', baseConfig)).rejects.toThrow();

    const headers = (mockUndiciFetch.mock.calls[0][1] as any)?.headers;
    expect(headers['X-Emby-Authorization']).toContain('DeviceId="Macbook-Pro"');
    expect(headers['X-Emby-Authorization']).toContain('Device="Macbook Pro"');
  });

  it('surfaces HTTP error status and Emby JSON message on non-2xx response', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Invalid credentials');
  });
});

describe('embywatch structured failure logs', () => {
  it('records the named proxy on failure without leaking URLs or credentials', async () => {
    const proxyUrl = 'http://proxy-user:proxy-secret@proxy.local:3128';
    mockSettings({ proxies: JSON.stringify([{ id: 'failure-proxy', name: 'Office', url: proxyUrl }]) });
    mockUndiciFetch.mockRejectedValue(Object.assign(new Error(`Proxy failed: ${proxyUrl}`), {
      cause: { code: 'ECONNREFUSED', message: `proxy-user proxy-secret ${proxyUrl}` },
    }));

    const error = await runEmbywatch(
      'https://emby-user:emby-secret@emby.example.com',
      { ...baseConfig, proxyId: 'failure-proxy' },
    ).catch(e => e);

    expect(error).toBeInstanceOf(EmbywatchError);
    expect(error.log).toMatchObject({ proxy: 'Office', error: 'Cannot reach Emby server (ECONNREFUSED)' });
    expect(JSON.stringify({ message: error.message, log: error.log })).not.toMatch(
      /https?:\/\/|proxy-user|proxy-secret|emby-user|emby-secret|proxy\.local/,
    );
  });

  it('records direct and the validation reason before making a network request', async () => {
    const error = await runEmbywatch(
      'https://emby.example.com',
      { ...baseConfig, playDuration: 600, playDurationMax: 500 },
    ).catch(e => e);

    expect(error).toBeInstanceOf(EmbywatchError);
    expect(error.log).toMatchObject({ proxy: 'direct', watchedSeconds: 0 });
    expect(error.log.error).toContain('effective playDuration');
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('redacts echoed proxy credentials, Emby passwords and URLs in an API failure', async () => {
    const proxyUrl = 'http://proxy-user:proxy-secret@proxy.local:3128';
    mockSettings({ proxies: JSON.stringify([{ id: 'api-failure', name: 'Office', url: proxyUrl }]) });
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        Message: `Rejected proxy-user proxy-secret emby-password ${proxyUrl} https://media.local?api_key=private-token`,
      })),
    });

    const error = await runEmbywatch(
      'https://emby.example.com',
      { ...baseConfig, password: 'emby-password', proxyId: 'api-failure' },
    ).catch(e => e);

    expect(error.log.proxy).toBe('Office');
    expect(error.log.error).toContain('HTTP 502');
    expect(JSON.stringify({ message: error.message, log: error.log })).not.toMatch(
      /https?:\/\/|proxy-user|proxy-secret|emby-password|proxy\.local|private-token/,
    );
  });

  it('does not record a raw HTML proxy error body', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 407,
      text: vi.fn().mockResolvedValue('<html>proxy-user:proxy-secret@proxy.local</html>'),
    });
    const error = await runEmbywatch('https://emby.example.com', baseConfig).catch(e => e);
    expect(error.log.error).toContain('HTTP 407');
    expect(error.log.error).not.toContain('proxy-secret');
  });

  it('does not expose a proxy URL used as its display name', () => {
    const proxyUrl = 'http://proxy-user:proxy-secret@proxy.local:3128';
    mockSettings({ proxies: JSON.stringify([{ id: 'url-name', name: proxyUrl, url: proxyUrl }]) });
    expect(resolveProxyLabel('url-name')).not.toMatch(/https?:\/\/|proxy-user|proxy-secret|proxy\.local/);
  });
});

// A one-chunk ReadableStream reader, as the probe path consumes responses via
// getReader rather than buffering them. `bytes` of 0 models an unreadable file.
function streamOf(bytes: number) {
  let sent = false;
  return {
    read: vi.fn(() => {
      if (sent || bytes === 0) return Promise.resolve({ done: true, value: undefined });
      sent = true;
      return Promise.resolve({ done: false, value: new Uint8Array(bytes) });
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

// Routes mock responses by request URL so we can simulate auth + item pick +
// stream probe independently.
function routeFetch(
  streamStatus: number,
  opts: { directStreamUrl?: string; directStatus?: number } = {},
) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const probeRes = (status: number) => ({
    status,
    body: { cancel: vi.fn(), getReader: () => streamOf(status === 200 || status === 206 ? 1024 : 0) },
  });
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/PlaybackInfo')) {
      return Promise.resolve(jsonRes({
        MediaSources: [{ Id: 's1', DirectStreamUrl: opts.directStreamUrl }],
      }));
    }
    // DirectStreamUrl probe (the /videos/{id}/original.{container} form)
    if (url.includes('/original.')) {
      return Promise.resolve(probeRes(opts.directStatus ?? 404));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      return Promise.resolve(probeRes(streamStatus));
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }],
      }));
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch playability verification', () => {
  it('skips reporting when the media is offline (stream probe fails)', async () => {
    routeFetch(404);

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');

    // No playback should have been reported.
    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Sessions/Playing'),
    );
    expect(reported).toBe(false);
  });

  it('reports playback when the stream probe succeeds', async () => {
    routeFetch(206);

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing'),
    );
    expect(reported).toBe(true);
  });

  it('accepts an item when the static probe fails but the PlaybackInfo DirectStreamUrl works', async () => {
    // Mirrors proxies that only route the DirectStreamUrl form and reject /stream
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 206 });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    // The DirectStreamUrl succeeded, so the static /stream fallback is never probed
    const staticProbed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream?'),
    );
    expect(staticProbed).toBe(false);
  });

  it('skips reporting when both the DirectStreamUrl and static probes fail', async () => {
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 500 });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');
  });

  it('stops reading after the first chunk when the server ignores Range and returns the whole file', async () => {
    // A proxy fronting Emby may answer 200 with the entire movie instead of a 206
    // range. Buffering that would pull the whole file into memory and OOM the process,
    // so the probe must take one chunk and cancel.
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(65_536) }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockUndiciFetch.mockImplementation((url: string) => {
      if (url.includes('/Users/AuthenticateByName')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } })) });
      }
      if (url.includes('/PlaybackInfo')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ MediaSources: [{ Id: 's1' }] })) });
      }
      if (url.includes('/Videos/') && url.includes('/stream')) {
        // 200 rather than 206: Range ignored, body is the entire file
        return Promise.resolve({ status: 200, body: { cancel: vi.fn(), getReader: () => reader } });
      }
      if (url.includes('/Items')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }] })) });
      }
      return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
    });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');
    // The endless body was read once and abandoned, never drained.
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('does not probe the stream when verifyPlayable is false', async () => {
    routeFetch(404);

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.title).toBe('Ep');

    const probed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(probed).toBe(false);
  });
});

/**
 * Serves auth, item pick, a 1-byte size probe and ranged data reads (via a
 * getReader stream) so Real Watch can pull and count real bytes. The options
 * cover the shapes proxied servers return: no size header, no direct play,
 * transcode-only, HLS, and stream URLs that reject every read.
 */
function routeRealWatch(
  opts: {
    /** Total size the probe advertises; null serves no Content-Range at all. */
    size?: number | null;
    /** MediaSources[0] on the picked item; null strips it entirely. */
    source?: any;
    /** Status for the static /Videos/{id}/stream route. */
    staticStatus?: number;
    directStreamUrl?: string;
    transcodingUrl?: string;
    /** URL fragment → m3u8 body, for the HLS transcode path. */
    playlists?: Record<string, string>;
    /** Status for data (non-probe) reads on non-static media URLs. */
    dataStatus?: number;
    /** 416 any read that starts past byte 0, as a short file would. */
    rejectOffsets?: boolean;
  } = {},
) {
  const size = opts.size === undefined ? 60_000_000 : opts.size;
  const source = opts.source === undefined ? { Id: 's1', Size: 60_000_000, Bitrate: 800_000 } : opts.source;
  const staticStatus = opts.staticStatus ?? 206;
  const dataStatus = opts.dataStatus ?? 206;

  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const textRes = (body: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: vi.fn().mockResolvedValue(body),
  });
  const probeRes = (status: number) => ({
    status,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-range' && size != null ? `bytes 0-0/${size}` : null,
    },
    body: { cancel: vi.fn() },
  });
  const dataRes = (status: number) => {
    let read = 0;
    const reader = {
      read: vi.fn(() =>
        read++ === 0
          ? Promise.resolve({ done: false, value: new Uint8Array(4096) })
          : Promise.resolve({ done: true, value: undefined }),
      ),
      cancel: vi.fn(),
    };
    return { status, headers: { get: () => null }, body: { getReader: () => reader, cancel: vi.fn() } };
  };
  const isProbe = (init: any) => (init?.headers?.Range ?? '') === 'bytes=0-0';
  const offsetRejected = (init: any) =>
    opts.rejectOffsets === true && !/^bytes=0-/.test(init?.headers?.Range ?? '');

  mockUndiciFetch.mockImplementation((url: string, init: any) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/PlaybackInfo')) {
      return Promise.resolve(jsonRes({
        MediaSources: [{ Id: 's1', DirectStreamUrl: opts.directStreamUrl, TranscodingUrl: opts.transcodingUrl }],
      }));
    }
    for (const [fragment, body] of Object.entries(opts.playlists ?? {})) {
      if (url.includes(fragment)) return Promise.resolve(textRes(body));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      if (isProbe(init)) return Promise.resolve(probeRes(staticStatus));
      if (offsetRejected(init)) return Promise.resolve(dataRes(416));
      return Promise.resolve(dataRes(opts.dataStatus ?? staticStatus));
    }
    if (url.includes('/videos/') || url.endsWith('.ts')) {
      return Promise.resolve(isProbe(init) ? probeRes(200) : dataRes(dataStatus));
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: [{
          Id: 'i1',
          Name: 'Ep',
          Type: 'Episode',
          RunTimeTicks: 6000_000_000,
          MediaSources: source ? [source] : [],
        }],
      }));
    }
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

const realWatchConfig = { ...baseConfig, realWatch: true, verifyPlayable: false };

// Data reads carrying a Range that isn't the 1-byte size probe.
function dataReads() {
  return mockUndiciFetch.mock.calls.filter(
    c =>
      typeof c[0] === 'string' &&
      (c[1] as any)?.headers?.Range &&
      !(c[1] as any).headers.Range.includes('0-0'),
  );
}

describe('embywatch Real Watch', () => {
  it('streams actual media bytes with a position-following Range request', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();

    // A ranged data read (not the 1-byte size probe) hit the static stream URL,
    // carrying the play session so the transfer ties to the reported session.
    const dataFetch = dataReads().find(
      c => (c[0] as string).includes('/stream') && (c[0] as string).includes('PlaySessionId='),
    );
    expect(dataFetch).toBeTruthy();
    // Size known, so the range is bounded at both ends
    expect((dataFetch![1] as any).headers.Range).toMatch(/^bytes=\d+-\d+$/);
  });

  it('does not stream bytes when Real Watch is off', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.streamedBytes).toBeUndefined();

    const streamed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(streamed).toBe(false);
  });

  it('streams open-ended when the server exposes no size or bitrate', async () => {
    // Proxied servers often answer without Content-Range and strip Size/Bitrate
    routeRealWatch({ size: null, source: { Id: 's1' } });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();

    const dataFetch = dataReads()[0];
    expect((dataFetch[1] as any).headers.Range).toMatch(/^bytes=\d+-$/);
  });

  it('falls back to the transcode stream when no direct play is offered', async () => {
    routeRealWatch({
      size: null,
      staticStatus: 404,
      source: { Id: 's1' },
      transcodingUrl: '/videos/i1/stream.mkv?api_key=tok',
    });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchTranscoded).toBe(true);
    expect(dataReads().some(c => (c[0] as string).includes('stream.mkv'))).toBe(true);
  });

  it('drains HLS segments when the transcode stream is a playlist', async () => {
    routeRealWatch({
      size: null,
      staticStatus: 404,
      source: { Id: 's1' },
      transcodingUrl: '/videos/i1/master.m3u8?api_key=tok',
      playlists: {
        'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmain.m3u8?api_key=tok\n',
        'main.m3u8': '#EXTM3U\n#EXTINF:6.0,\nhls1/main/0.ts\n#EXTINF:6.0,\nhls1/main/1.ts\n',
      },
    });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchTranscoded).toBe(true);
    expect(mockUndiciFetch.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes('hls1/main/0.ts'))).toBe(true);
  });

  it('retries from the start when an estimated offset lands past the end of the file', async () => {
    routeRealWatch({ size: null, source: { Id: 's1' }, rejectOffsets: true });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();
    expect(dataReads().some(c => (c[1] as any).headers.Range === 'bytes=0-')).toBe(true);
  });

  it('records why nothing streamed when the server serves no stream at all', async () => {
    routeRealWatch({ staticStatus: 404, source: { Id: 's1' } });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBe(0);
    expect(result.realWatchNote).toBe('no-stream-url');
  });

  it('records a stream failure when the resolved URL rejects every read', async () => {
    // The size probe succeeds, then the server 403s the actual data reads
    routeRealWatch({ dataStatus: 403 });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBe(0);
    expect(result.realWatchNote).toBe('stream-failed');
  });
});

// Configurable Sequence Play backend: a resume list, a series episode list, and
// generic session endpoints. Runtimes are short so segments finish in one tick.
function routeSequence(opts: {
  resume?: any[];
  nextUp?: any[];
  episodes?: any[];
} = {}) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.resume ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: opts.nextUp ?? [] }));
    if (url.includes('/Episodes')) return Promise.resolve(jsonRes({ Items: opts.episodes ?? [] }));
    if (url.includes('/Items?SortBy=Random')) {
      return Promise.resolve(jsonRes({ Items: [{ Id: 'rand', Name: 'Random', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] }));
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

const ep = (id: string, index: number, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `Ep ${index}`,
  Type: 'Episode',
  SeriesId: 'series1',
  SeriesName: 'Show',
  IndexNumber: index,
  RunTimeTicks: 10_000_000, // 1s runtime so a segment finishes in one tick
  MediaSources: [{ Id: `${id}-s` }],
  ...extra,
});

describe('embywatch Sequence Play', () => {
  const seqConfig = { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 5 };

  it('resumes from the last position and chains to the next episode', async () => {
    // e1 resumes near its end; episode list lets it advance to e2, then e3.
    routeSequence({
      resume: [ep('e1', 1, { UserData: { PlaybackPositionTicks: 0 } })],
      episodes: [ep('e1', 1), ep('e2', 2), ep('e3', 3)],
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);

    expect(result.sequencePlay).toBe(true);
    // playDuration 5s over 1s episodes: e1, e2, e3 all finish (series ends at e3)
    expect(result.episodesCompleted).toBe(3);

    // Every played episode is recalled, in order, with its own watch window.
    expect(result.episodes?.map(e => e.title)).toEqual(['Ep 1', 'Ep 2', 'Ep 3']);
    expect(result.episodes?.every(e => e.watchedSeconds === 1)).toBe(true);
    expect(result.episodes?.every(e => e.markedWatched)).toBe(true);
    const total = result.episodes!.reduce((s, e) => s + e.watchedSeconds, 0);
    expect(result.watchedSeconds).toBe(total);

    const marked = mockUndiciFetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('/PlayedItems/'),
    );
    // Each finished episode is marked watched
    expect(marked.length).toBe(result.episodesCompleted);

    const resumed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items/Resume'),
    );
    expect(resumed).toBe(true);
  });

  it('falls back to Next Up when nothing is resuming', async () => {
    routeSequence({
      resume: [],
      nextUp: [ep('n1', 4)],
      episodes: [ep('n1', 4)], // last in series, no chaining
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Ep 4');
    expect(result.episodesCompleted).toBe(1);

    const usedNextUp = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Shows/NextUp'),
    );
    expect(usedNextUp).toBe(true);
  });

  it('falls back to a random item when nothing is resuming or up next', async () => {
    routeSequence({ resume: [], nextUp: [] });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Random');

    const usedRandom = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items?SortBy=Random'),
    );
    expect(usedRandom).toBe(true);
  });
});

// Model an Emby server behind optional ID-aliasing. ParentId is honoured only for
// browsing a library's Series/Movies (SortBy=Random). The global Resume/NextUp and
// whole-server random are unscoped. Library membership is derived primarily from the
// item's Ancestors chain (real Emby returns the CollectionFolder view id there); when
// Ancestors is unavailable (aliasing proxy → 404) it falls back to the series'
// ParentId. Distinguishes the query shapes the code issues.
const jsonRes = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: vi.fn().mockResolvedValue(JSON.stringify(body)),
});
function routeProxy(opts: {
  views: any[];
  librarySample?: any[]; // Items?ParentId&IncludeItemTypes=Series,Movie&SortBy=Random
  episodes?: Record<string, any[]>; // /Shows/{seriesId}/Episodes
  wholeResume?: any[]; // /Items/Resume (unscoped global Continue Watching)
  ancestors?: Record<string, string[]>; // itemId -> ancestor ids (real Emby membership signal)
  seriesParent?: Record<string, string>; // seriesId -> library id (aliasing-proxy fallback)
  wholeRandom?: any[]; // /Items?SortBy=Random&IncludeItemTypes=Episode,Movie (unscoped)
  offlineIds?: string[]; // ids whose stream probe fails
}) {
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Views')) return Promise.resolve(jsonRes({ Items: opts.views }));
    if (url.includes('/PlaybackInfo')) return Promise.resolve(jsonRes({ MediaSources: [{ Id: 's' }] }));
    const vid = url.match(/\/Videos\/([^/]+)\/stream/);
    if (vid) {
      const bad = (opts.offlineIds ?? []).includes(vid[1]);
      return Promise.resolve({ status: bad ? 404 : 206, body: { cancel: vi.fn(), getReader: () => streamOf(bad ? 0 : 1024) } });
    }
    // Ancestors chain: /Items/{id}/Ancestors — real Emby's membership signal.
    // Return the configured chain, or 404 (like an aliasing proxy) so the code
    // falls back to the series ParentId signal.
    const anc = url.match(/\/Items\/([^/?]+)\/Ancestors/);
    if (anc) {
      const chain = opts.ancestors?.[anc[1]];
      if (!chain) return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: vi.fn().mockResolvedValue('') });
      return Promise.resolve(jsonRes(chain.map(id => ({ Id: id }))));
    }
    // Series ParentId lookup: /Users/u1/Items/{seriesId}?Fields=ParentId
    const sl = url.match(/\/Items\/([^/?]+)\?Fields=ParentId/);
    if (sl && sl[1] !== 'Resume') {
      return Promise.resolve(jsonRes({ Id: sl[1], Type: 'Series', ParentId: opts.seriesParent?.[sl[1]] }));
    }
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.wholeResume ?? [] }));
    if (url.includes('IncludeItemTypes=Series,Movie')) return Promise.resolve(jsonRes({ Items: opts.librarySample ?? [] }));
    const eps = url.match(/\/Shows\/([^/]+)\/Episodes/);
    if (eps) return Promise.resolve(jsonRes({ Items: opts.episodes?.[eps[1]] ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: [] }));
    if (url.includes('SortBy=Random')) return Promise.resolve(jsonRes({ Items: opts.wholeRandom ?? [] }));
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch library scoping', () => {
  const views = [{ Id: 'lib-movies', Name: 'Movies' }, { Id: 'lib-tv', Name: 'TV Shows' }];
  const series = (id: string, name: string) => ({ Id: id, Name: name, Type: 'Series', MediaSources: [{ Id: `${id}-s` }] });
  const urls = () => mockUndiciFetch.mock.calls.map(c => c[0] as string).filter(u => typeof u === 'string');

  it('scopes the random pick to the library by name, via a bounded Series/Movie browse', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'tv shows' });
    expect(result.title).toBe('Ep 1');
    const browse = urls().find(u => u.includes('IncludeItemTypes=Series,Movie'));
    expect(browse).toContain('ParentId=lib-tv');
    // Bounded: no full enumeration (small Limit, no paging).
    expect(browse).toContain('Limit=12');
    expect(urls().some(u => /Limit=(?:[5-9]\d\d|\d{4,})/.test(u) || u.includes('StartIndex='))).toBe(false);
  });

  it('scopes to a library by its 1-based index', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: '1' });
    expect(urls().find(u => u.includes('IncludeItemTypes=Series,Movie'))).toContain('ParentId=lib-movies');
  });

  it('ignores an unknown library and uses the whole server', async () => {
    routeProxy({ views, wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'Nope' });
    expect(result.title).toBe('Whole');
    // No library browse happened.
    expect(urls().some(u => u.includes('IncludeItemTypes=Series,Movie'))).toBe(false);
  });

  it('resumes the in-library Continue Watching item (Ancestors signal) and chains the next episode', async () => {
    // Real-Emby shape: the library view sits above physical folders, so membership
    // comes from the Ancestors chain, not the series ParentId. Global Continue
    // Watching holds an out-of-library drama and an in-library anime; Sequence Play
    // must resume the anime, then keep playing the next episode in the same show.
    const drama = { Id: 'drama', Name: 'E29', SeriesName: 'Drama', Type: 'Episode', SeriesId: 'sDrama', RunTimeTicks: 600_000_000, UserData: { PlaybackPositionTicks: 100_000_000 }, MediaSources: [{ Id: 'd-s' }] };
    // Short runtimes keep the real-timed watch fast: Ep 5 resumes near its end
    // (1s left), then Ep 6 (1s) plays and completes.
    const anime = { Id: 'anime5', Name: 'Ep 5', SeriesName: 'Anime', Type: 'Episode', SeriesId: 'sAnime', IndexNumber: 5, RunTimeTicks: 20_000_000, UserData: { PlaybackPositionTicks: 10_000_000 }, MediaSources: [{ Id: 'a-s' }] };
    const anime6 = { Id: 'anime6', Name: 'Ep 6', SeriesName: 'Anime', Type: 'Episode', SeriesId: 'sAnime', IndexNumber: 6, RunTimeTicks: 10_000_000, MediaSources: [{ Id: 'a6-s' }] };
    routeProxy({
      views,
      wholeResume: [drama, anime], // drama first, but it is out-of-library
      // Real Emby: physical parent chain differs from the view id; Ancestors carries it.
      ancestors: { drama: ['folderD', 'lib-movies', 'root'], anime5: ['folderA', 'lib-tv', 'root'] },
      episodes: { sAnime: [anime, anime6] },
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 5, library: 'TV Shows' });

    expect(result.sequencePlay).toBe(true);
    expect(result.episodes?.[0].title).toBe('Ep 5'); // resumed the in-library anime
    expect(result.episodes?.[0].startSeconds).toBe(1); // from its stored position (1s)
    expect(result.episodes?.[1].title).toBe('Ep 6'); // sequence play chained the next episode
    expect((result.episodes ?? []).some(e => e.title === 'E29')).toBe(false); // never the drama
    // No random library browse was needed since resume succeeded.
    expect(urls().some(u => u.includes('IncludeItemTypes=Series,Movie'))).toBe(false);
  });

  it('starts a random in-library title when nothing in the library is resuming', async () => {
    // Only out-of-library resume exists → skip it, start a random in-library show.
    const drama = { Id: 'drama', Name: 'E29', Type: 'Episode', SeriesId: 'sDrama', RunTimeTicks: 600_000_000, UserData: { PlaybackPositionTicks: 100_000_000 }, MediaSources: [{ Id: 'd-s' }] };
    routeProxy({
      views,
      wholeResume: [drama],
      seriesParent: { sDrama: 'lib-movies' },
      librarySample: [series('sA', 'InLibShow')],
      episodes: { sA: [ep('e1', 1)] },
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 1, library: 'TV Shows' });
    expect(result.episodes?.[0].title).toBe('Ep 1'); // in-library random start
    expect((result.episodes ?? []).some(e => e.title === 'E29')).toBe(false);
  });

  it('falls back to the whole server when the library has nothing to play', async () => {
    routeProxy({
      views,
      wholeResume: [],
      librarySample: [], // empty library
      wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('Whole');
  });

  it('falls back to the whole server when the library item is offline', async () => {
    routeProxy({
      views,
      librarySample: [series('sA', 'InLibShow')],
      // The stream probe keys on item id in /Videos/{id}/stream, so mark by item id.
      episodes: { sA: [{ ...ep('e1', 1), Id: 'offline', MediaSources: [{ Id: 'offline-s' }] }] },
      offlineIds: ['offline'],
      wholeRandom: [{ Id: 'good', Name: 'GoodOnServer', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 'good' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: true, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('GoodOnServer');
  });
});

describe('embywatch cancellation', () => {
  it('aborts before contacting the server when already cancelled', async () => {
    routeFetch(206);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(runEmbywatch('https://emby.example.com', baseConfig, ctrl.signal))
      .rejects.toThrow('Job cancelled');
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('stops mid-playback and still reports Stopped so Emby clears the session', async () => {
    routeFetch(206);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    await expect(
      runEmbywatch('https://emby.example.com', { ...baseConfig, playDuration: 60 }, ctrl.signal),
    ).rejects.toThrow('Job cancelled');

    const stopped = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing/Stopped'),
    );
    expect(stopped).toBe(true);
  });
});

// ---- backup server fallback (v1.2.0 "Emby 观看支持备用地址") ------------------

describe('embywatch backup server fallback', () => {
  const PRIMARY = 'https://emby.example.com';
  const BACKUP = 'https://backup.example.com';

  const authOk = () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(
      JSON.stringify({ AccessToken: 'tok', User: { Id: 'uid', Name: 'someone' } }),
    ),
  });
  const unreachable = () =>
    Promise.reject(Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }));

  const calledUrls = () => mockUndiciFetch.mock.calls.map((c) => String(c[0]));

  it('switches to the backup when the primary cannot be reached', async () => {
    // Only the backup answers auth; everything after that is free to fail, we
    // only need to prove which server the run settled on.
    mockUndiciFetch.mockImplementation((url: unknown) =>
      String(url).startsWith(`${BACKUP}/Users/AuthenticateByName`)
        ? Promise.resolve(authOk())
        : unreachable(),
    );

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrl: BACKUP }),
    ).rejects.toThrow();

    const urls = calledUrls();
    expect(urls[0]).toContain(`${PRIMARY}/Users/AuthenticateByName`);
    expect(urls.some((u) => u.startsWith(`${BACKUP}/Users/AuthenticateByName`))).toBe(true);
    // Every request after the switch goes to the backup too -- the token it
    // issued is only valid there.
    const afterSwitch = urls.slice(urls.indexOf(`${BACKUP}/Users/AuthenticateByName`) + 1);
    expect(afterSwitch.every((u) => u.startsWith(BACKUP))).toBe(true);
  });

  it('does not switch when the primary answers but rejects the credentials', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrl: BACKUP }),
    ).rejects.toThrow('Invalid credentials');

    // A server that replies is up; the backup would say the same thing
    expect(calledUrls().every((u) => u.startsWith(PRIMARY))).toBe(true);
  });

  it('does not try a backup when none is configured', async () => {
    await expect(runEmbywatch(PRIMARY, baseConfig)).rejects.toThrow(
      'Cannot reach Emby server (ECONNREFUSED)',
    );
    expect(calledUrls()).toHaveLength(1);
  });

  it('reports the backup failure when the backup is unreachable too', async () => {
    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrl: BACKUP }),
    ).rejects.toThrow('Cannot reach Emby server (ECONNREFUSED)');
    expect(calledUrls()).toContain(`${BACKUP}/Users/AuthenticateByName`);
  });

  it('ignores an empty backup URL string', async () => {
    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrl: '' }),
    ).rejects.toThrow('Cannot reach Emby server (ECONNREFUSED)');
    expect(calledUrls()).toHaveLength(1);
  });
});

// ---- multiple backup addresses (v1.2.0 "Emby 多备用地址") ---------------------

describe('isFallbackWorthy', () => {
  it('accepts a network-level failure', () => {
    expect(
      isFallbackWorthy(new Error('Cannot reach Emby server at https://x/y — ECONNREFUSED')),
    ).toBe(true);
  });

  it('accepts a 5xx answer', () => {
    expect(
      isFallbackWorthy(
        new Error('Emby POST /Users/AuthenticateByName failed: HTTP 503: down'),
      ),
    ).toBe(true);
    expect(isFallbackWorthy(new Error('Emby GET /x failed: HTTP 500: boom'))).toBe(true);
  });

  it('rejects a 4xx answer', () => {
    expect(isFallbackWorthy(new Error('Emby POST /x failed: HTTP 401: bad password'))).toBe(false);
    expect(isFallbackWorthy(new Error('Emby GET /x failed: HTTP 404: nope'))).toBe(false);
  });

  it('rejects anything that is neither', () => {
    expect(isFallbackWorthy(new Error('something else entirely'))).toBe(false);
    expect(isFallbackWorthy('not an error object')).toBe(false);
    expect(isFallbackWorthy(undefined)).toBe(false);
  });
});

describe('resolveServerCandidates', () => {
  it('puts the primary first and keeps the given order', () => {
    expect(resolveServerCandidates('https://a', { backupUrls: ['https://b', 'https://c'] })).toEqual([
      'https://a',
      'https://b',
      'https://c',
    ]);
  });

  it('reads the older single-address field', () => {
    expect(resolveServerCandidates('https://a', { backupUrl: 'https://b' })).toEqual([
      'https://a',
      'https://b',
    ]);
  });

  it('ignores the legacy field when the list is set', () => {
    expect(
      resolveServerCandidates('https://a', { backupUrls: ['https://b'], backupUrl: 'https://c' }),
    ).toEqual(['https://a', 'https://b']);
  });

  it('trims and drops blanks', () => {
    expect(
      resolveServerCandidates(' https://a/ ', { backupUrls: ['', '   ', ' https://b/ '] }),
    ).toEqual(['https://a', 'https://b']);
  });

  it('removes duplicates, including ones that differ only by a trailing slash', () => {
    expect(
      resolveServerCandidates('https://a/', { backupUrls: ['https://a', 'https://b', 'https://b/'] }),
    ).toEqual(['https://a', 'https://b']);
  });

  it('returns just the primary when nothing is configured', () => {
    expect(resolveServerCandidates('https://a', {})).toEqual(['https://a']);
  });
});

describe('embywatch multiple backup addresses', () => {
  const PRIMARY = 'https://emby.example.com';
  const B1 = 'https://backup1.example.com';
  const B2 = 'https://backup2.example.com';

  const authOk = () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(
      JSON.stringify({ AccessToken: 'tok', User: { Id: 'uid', Name: 'someone' } }),
    ),
  });
  const unreachable = () =>
    Promise.reject(Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }));
  const serverError = () =>
    Promise.resolve({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Server error' })),
    });

  const calledUrls = () => mockUndiciFetch.mock.calls.map((c) => String(c[0]));

  it('tries each backup in order until one answers', async () => {
    mockUndiciFetch.mockImplementation((url: unknown) =>
      String(url).startsWith(`${B2}/Users/AuthenticateByName`)
        ? Promise.resolve(authOk())
        : unreachable(),
    );

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrls: [B1, B2] }),
    ).rejects.toThrow();

    const urls = calledUrls();
    expect(urls[0]).toContain(`${PRIMARY}/Users/AuthenticateByName`);
    expect(urls).toContain(`${B1}/Users/AuthenticateByName`);
    expect(urls).toContain(`${B2}/Users/AuthenticateByName`);
    // The run settles on the one that answered: everything after it goes there
    const afterSwitch = urls.slice(urls.indexOf(`${B2}/Users/AuthenticateByName`) + 1);
    expect(afterSwitch.every((u) => u.startsWith(B2))).toBe(true);
  });

  it('switches when the primary answers with a 5xx', async () => {
    mockUndiciFetch.mockImplementation((url: unknown) =>
      String(url).startsWith(`${B1}/Users/AuthenticateByName`)
        ? Promise.resolve(authOk())
        : serverError(),
    );

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrls: [B1] }),
    ).rejects.toThrow();

    const urls = calledUrls();
    expect(urls[0]).toContain(`${PRIMARY}/Users/AuthenticateByName`);
    expect(urls.some((u) => u.startsWith(B1))).toBe(true);
  });

  it('does not walk the list past a 4xx, even with several backups', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrls: [B1, B2] }),
    ).rejects.toThrow('Invalid credentials');

    // Every backup would answer the same way, so none is asked
    expect(calledUrls().every((u) => u.startsWith(PRIMARY))).toBe(true);
  });

  it('reports the last address when every one of them fails', async () => {
    mockUndiciFetch.mockImplementation((url: unknown) =>
      String(url).startsWith(`${B2}/Users/AuthenticateByName`) ? serverError() : unreachable(),
    );

    await expect(
      runEmbywatch(PRIMARY, { ...baseConfig, backupUrls: [B1, B2] }),
    ).rejects.toThrow('503');

    expect(calledUrls()).toContain(`${B2}/Users/AuthenticateByName`);
  });

  it('testEmbyConnection walks the same list a run would', async () => {
    mockUndiciFetch.mockImplementation((url: unknown) =>
      String(url).startsWith(`${B2}/Users/AuthenticateByName`)
        ? Promise.resolve(authOk())
        : unreachable(),
    );

    const result = await testEmbyConnection(PRIMARY, {
      username: 'u',
      password: 'p',
      backupUrls: [B1, B2],
    });

    expect(result.ok).toBe(true);
    // Which address answered, so the panel can say which one it settled on
    expect(result.serverUrl).toBe(B2);
  });

  it('testEmbyConnection stops at a 4xx just like a run', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    const result = await testEmbyConnection(PRIMARY, {
      username: 'u',
      password: 'p',
      backupUrls: [B1, B2],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid credentials');
    expect(calledUrls().every((u) => u.startsWith(PRIMARY))).toBe(true);
  });
});

describe('embywatch PlaySessionId compliance (Emby 4.9+ support)', () => {
  it('sends a valid 32-character hex GUID for PlaySessionId and adopts server-allocated ID from PlaybackInfo', async () => {
    const SERVER_SESSION_ID = '382a5c9284fa4f40940bf87e248b111a';
    routeFetch(206);

    const originalImpl = mockUndiciFetch.getMockImplementation();
    mockUndiciFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/PlaybackInfo')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: vi.fn().mockResolvedValue(JSON.stringify({
            PlaySessionId: SERVER_SESSION_ID,
            MediaSources: [{ Id: 's1' }],
          })),
        });
      }
      return originalImpl!(url, init);
    });

    await runEmbywatch('https://emby.example.com', baseConfig);

    const playingCall = mockUndiciFetch.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing'),
    );
    expect(playingCall).toBeDefined();
    const body = JSON.parse((playingCall![1] as any).body);
    expect(body.PlaySessionId).toBe(SERVER_SESSION_ID);
    expect(/^[0-9a-f]{32}$/.test(body.PlaySessionId)).toBe(true);
  });

  it('generates a standard 32-char lowercase hex GUID when PlaybackInfo does not provide one', async () => {
    routeFetch(206);

    await runEmbywatch('https://emby.example.com', baseConfig);

    const playingCall = mockUndiciFetch.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing'),
    );
    expect(playingCall).toBeDefined();
    const body = JSON.parse((playingCall![1] as any).body);
    expect(body.PlaySessionId).toBeDefined();
    expect(body.PlaySessionId.startsWith('bemby-')).toBe(false);
    expect(/^[0-9a-f]{32}$/.test(body.PlaySessionId)).toBe(true);
  });
});

describe('embywatch Progress heartbeat fault tolerance', () => {
  it('does not abort playback when /Sessions/Playing/Progress returns 409 conflict', async () => {
    routeFetch(206);

    const originalImpl = mockUndiciFetch.getMockImplementation();
    mockUndiciFetch.mockImplementation((url: string, init?: any) => {
      if (url.includes('/Sessions/Playing/Progress')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          statusText: 'Conflict',
          text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'playback_lease_inactive' })),
        });
      }
      return originalImpl!(url, init);
    });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');
    expect(result.watchedSeconds).toBe(1);

    const stoppedCall = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing/Stopped'),
    );
    expect(stoppedCall).toBe(true);
  });
});


