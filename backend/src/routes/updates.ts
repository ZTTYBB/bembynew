import { Router } from 'express';
import { db } from '../db/database';
import { withTimeout } from '../util/timeout';
import {
  IS_PUBLISHED_BUILD,
  RUNNING_CHANNEL,
  RUNNING_VERSION,
  UPDATE_REPO,
  UPGRADE_IMAGE,
  compareVersions,
  type ReleaseChannel,
} from '../version';

const router = Router();

const CHECK_TIMEOUT_MS = 8_000;
const UPGRADE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;

type GithubRelease = {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  published_at: string | null;
};

export type UpdateCheck = {
  latest: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  error?: string;
};

/** Cached so the Settings page does not hit GitHub on every render. */
let cache: { at: number; result: UpdateCheck } | null = null;

function updateCheckEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'update_check_enabled'")
    .get() as { value: string } | undefined;
  // On by default; the panel can switch it off, after which no request is made.
  return row?.value !== 'false';
}

/**
 * The Watchtower this container may ask for an upgrade, or null when one-click
 * upgrade is not set up. Both values come from the environment and cannot be
 * changed from the panel.
 */
function watchtowerConfig(): { url: string; token: string } | null {
  const token = (process.env.WATCHTOWER_TOKEN ?? '').trim();
  if (!token) return null;
  const url = (process.env.WATCHTOWER_URL ?? '').trim() || 'http://watchtower:8080';
  return { url: url.replace(/\/+$/, ''), token };
}

/** Whether a release tag belongs to the channel this build came from. */
export function matchesChannel(tag: string, channel: ReleaseChannel): boolean {
  const isDev = tag.startsWith('dev-');
  const isBeta = /beta/i.test(tag);
  if (channel === 'dev') return isDev;
  if (channel === 'beta') return isBeta && !isDev;
  // Stable: a plain vX.Y.Z, so neither dev- nor beta-tagged
  return !isDev && !isBeta && /^v?\d+\.\d+\.\d+$/.test(tag);
}

/** The highest release on `channel` newer than `current`, or null. */
export function pickNewerRelease(
  releases: GithubRelease[],
  channel: ReleaseChannel,
  current: string,
): GithubRelease | null {
  let best: GithubRelease | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    if (!matchesChannel(release.tag_name, channel)) continue;
    const version = release.tag_name.replace(/^v/, '');
    if (compareVersions(version, current) <= 0) continue;
    if (!best || compareVersions(version, best.tag_name.replace(/^v/, '')) > 0) {
      best = release;
    }
  }
  return best;
}

async function fetchReleases(): Promise<GithubRelease[]> {
  const res = await withTimeout(
    fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=50`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bemby-update-check',
      },
    }),
    CHECK_TIMEOUT_MS,
    'GitHub did not answer in time',
  );
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return (await res.json()) as GithubRelease[];
}

async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const newer = pickNewerRelease(await fetchReleases(), RUNNING_CHANNEL, RUNNING_VERSION);
    return newer
      ? {
          latest: newer.tag_name.replace(/^v/, ''),
          releaseUrl: newer.html_url,
          publishedAt: newer.published_at,
        }
      : { latest: null, releaseUrl: null, publishedAt: null };
  } catch (err) {
    // A failed check is not an error state for the panel -- it just means we
    // cannot say. Never let it look like "you are up to date".
    return {
      latest: null,
      releaseUrl: null,
      publishedAt: null,
      error: err instanceof Error ? err.message : 'Update check failed',
    };
  }
}

function manualCommand(): string {
  return `docker compose pull && docker compose up -d`;
}

router.get('/', async (_req, res) => {
  const watchtower = watchtowerConfig();
  const base = {
    version: RUNNING_VERSION,
    channel: RUNNING_CHANNEL,
    /** False for a source checkout or a local build: no update is ever offered. */
    published: IS_PUBLISHED_BUILD,
    repo: UPDATE_REPO,
    upgrade: {
      /** Whether the "Upgrade now" button can work. */
      available: watchtower !== null,
      image: UPGRADE_IMAGE,
      command: manualCommand(),
    },
  };

  if (!IS_PUBLISHED_BUILD || !updateCheckEnabled()) {
    res.json({
      ...base,
      checked: false,
      reason: IS_PUBLISHED_BUILD ? 'disabled' : 'unpublished',
      latest: null,
      releaseUrl: null,
      publishedAt: null,
      updateAvailable: false,
    });
    return;
  }

  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    cache = { at: Date.now(), result: await checkForUpdate() };
  }
  const result = cache.result;
  res.json({
    ...base,
    checked: true,
    ...result,
    updateAvailable: result.latest !== null,
  });
});

// POST /upgrade -- ask the Watchtower in this compose file to pull the newer
// image and recreate this container. Watchtower answers immediately and does the
// work in the background, so the panel goes on showing "upgrading" until the new
// build replaces this one.
router.post('/upgrade', async (_req, res) => {
  const watchtower = watchtowerConfig();
  if (!watchtower) {
    res.status(400).json({
      error: 'One-click upgrade is not configured',
      command: manualCommand(),
    });
    return;
  }

  try {
    const answer = await withTimeout(
      fetch(`${watchtower.url}/v1/update`, {
        headers: { Authorization: `Bearer ${watchtower.token}` },
      }),
      UPGRADE_TIMEOUT_MS,
      'Watchtower did not answer in time',
    );
    if (!answer.ok) {
      res.status(502).json({
        error:
          answer.status === 401 || answer.status === 403
            ? 'Watchtower rejected the token — check WATCHTOWER_TOKEN matches on both services'
            : `Watchtower returned ${answer.status}`,
      });
      return;
    }
    res.json({ ok: true, image: UPGRADE_IMAGE });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : 'Upgrade request failed',
    });
  }
});

export default router;
