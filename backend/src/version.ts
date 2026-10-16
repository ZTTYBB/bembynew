import { readFileSync } from 'node:fs';
import path from 'node:path';

export type ReleaseChannel = 'stable' | 'beta' | 'dev';

/**
 * The build this process is running.
 *
 * The release workflow stamps BEMBY_VERSION / BEMBY_CHANNEL into the image (see
 * the Dockerfile's ARGs), which is what lets the panel compare itself against
 * published releases and offer an upgrade.
 *
 * A source checkout or a locally built image has no stamp. That is deliberate:
 * the published tags do not describe such a build, so it must never be told an
 * update is available or be offered one.
 */
const stamped = (process.env.BEMBY_VERSION ?? '').trim();
const stampedChannel = (process.env.BEMBY_CHANNEL ?? '').trim();

/** True only for an image the release workflow produced. */
export const IS_PUBLISHED_BUILD = stamped !== '';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Bare version, without a leading `v`. */
export const RUNNING_VERSION = IS_PUBLISHED_BUILD
  ? stamped.replace(/^v/, '')
  : packageVersion();

/**
 * The channel this build came from. The release workflow stamps `latest`, `beta`
 * or `dev`; `latest` and an unstamped build both read as the stable channel.
 */
export const RUNNING_CHANNEL: ReleaseChannel =
  stampedChannel === 'beta' || stampedChannel === 'dev' ? stampedChannel : 'stable';

/**
 * The image the upgrade path should pull. Only used for the command shown when
 * one-click upgrade is not configured; Watchtower resolves the image from the
 * running container itself.
 */
export const UPGRADE_IMAGE =
  (process.env.BEMBY_UPGRADE_IMAGE ?? '').trim() || 'ghcr.io/zttybb/bembynew';

/** Owner/repo the update check reads releases from. */
export const UPDATE_REPO =
  (process.env.BEMBY_UPDATE_REPO ?? '').trim() || 'ZTTYBB/bembynew';

/** Compares dotted numeric versions; a pre-release suffix sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ''] = v.replace(/^v/, '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums, pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  // 1.2.0-beta.1 is older than 1.2.0
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return left.pre === right.pre ? 0 : left.pre > right.pre ? 1 : -1;
}
