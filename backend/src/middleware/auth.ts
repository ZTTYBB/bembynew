import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database';
import {
  isValidMediaTicket,
  type MediaTicketResource,
  type MediaTicketScope,
} from '../auth/mediaTickets';

// Publicly known placeholder secrets that must never sign real tokens
const KNOWN_DEFAULT_SECRETS = new Set(['change-me-in-production', 'changeme', 'secret']);

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('FATAL: JWT_SECRET env var is not set. Set it before starting Bemby.');
    process.exit(1);
  }
  if (KNOWN_DEFAULT_SECRETS.has(secret.trim())) {
    console.error(
      'FATAL: JWT_SECRET is set to a publicly known default. Generate a unique secret, e.g. `openssl rand -hex 32`.',
    );
    process.exit(1);
  }
  return secret;
}

export type SessionTokenPayload = {
  sub: string;
  typ?: string;
  cap?: string;
  /** Epoch the token was signed under; anything older has been revoked. */
  ep?: number;
  requirePasswordChange?: boolean;
};

export const TOKEN_EPOCH_KEY = 'token_epoch';

/**
 * A signed token cannot be withdrawn, so revocation needs a value the server can move: every
 * session token carries the epoch it was issued under, and changing credentials (or signing
 * out everywhere) advances it, which retires every token behind it at once. Without this a
 * stolen token outlived a password change by its full seven days.
 *
 * Zero means no epoch has ever been set, and tokens from before this existed carry no `ep`
 * at all. Both are accepted while the epoch is still zero, so an upgrade does not sign the
 * operator out; the first credential change moves it and they stop being accepted.
 */
export function getTokenEpoch(): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TOKEN_EPOCH_KEY) as
      | { value: string }
      | undefined;
    return Number(row?.value) || 0;
  } catch {
    return 0;
  }
}

/** Advances the epoch, retiring every session token issued before now. Returns the new value. */
export function bumpTokenEpoch(): number {
  // Date.now() alone can repeat within a millisecond, which would leave a token signed in the
  // same tick still valid; stepping past the stored value guarantees it moves.
  const next = Math.max(Date.now(), getTokenEpoch() + 1);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    TOKEN_EPOCH_KEY,
    String(next),
  );
  return next;
}

/** The claims every freshly issued session token carries. */
export function sessionClaims(username: string, requirePasswordChange = false): Record<string, unknown> {
  const base: Record<string, unknown> = { sub: username, typ: 'auth', ep: getTokenEpoch() };
  if (requirePasswordChange) base.requirePasswordChange = true;
  return base;
}

/**
 * Verifies a JWT is a genuine session token, not another token signed with the
 * same secret (e.g. the legacy captcha token, which carried `cap` and no `sub`).
 * Returns the payload, or null if invalid. Shared by the HTTP guard and the
 * WebSocket handshake so the two can't drift apart.
 */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as SessionTokenPayload;
    if (!decoded.sub || decoded.cap !== undefined || (decoded.typ !== undefined && decoded.typ !== 'auth')) {
      return null;
    }
    if ((decoded.ep ?? 0) !== getTokenEpoch()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Header only. The session token used to be accepted from ?token= as well, which put a
  // seven-day credential into image addresses and from there into access logs and browser
  // history; the routes that genuinely cannot set a header use a media ticket instead
  // (see auth/mediaTickets and requireMediaAuth below).
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: 'Unauthorised' });
    return;
  }

  const decoded = verifySessionToken(token);
  if (!decoded) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Restrict access until the default password is changed
  if (decoded.requirePasswordChange) {
    const path = req.originalUrl.split('?')[0];
    if (!(req.method === 'PUT' && path === '/api/auth/credentials')) {
      res.status(403).json({ error: 'Password change required', requirePasswordChange: true });
      return;
    }
  }
  next();
}

/**
 * For the handful of routes a browser loads by address rather than by fetch, where no header
 * can be set: a normal session token in the header still works, and a `?ticket=` naming a
 * live media ticket is accepted in its place. A route can request a
 * scope-specific ticket through mediaAuth(). Never the session token in the query.
 */
export function requireMediaAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  scope?: MediaTicketScope,
  resource?: MediaTicketResource,
): void {
  if (isValidMediaTicket(req.query.ticket as string | undefined, scope, resource)) {
    next();
    return;
  }
  requireAuth(req, res, next);
}

/** Express middleware factory for a media route with a scope-specific ticket. */
export function mediaAuth(
  scope: MediaTicketScope,
  resource?: (req: Request) => MediaTicketResource | undefined,
) {
  return (req: Request, res: Response, next: NextFunction): void =>
    requireMediaAuth(req, res, next, scope, resource?.(req));
}
