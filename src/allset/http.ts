/**
 * Small request guards for route handlers (server actions get Next.js's own
 * origin check; route handlers do not).
 */

import 'server-only';
import { safeEqual } from '@/allset/crypto';
import { publicBaseUrl } from '@/allset/env';

/**
 * True when a state-changing request came from this site's own pages: the
 * Origin header must name this site. "This site" is PUBLIC_BASE_URL when set,
 * otherwise the host the request was addressed to. X-Forwarded-Host is never
 * consulted: off a trusted platform it is whatever the client sent.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const configured = publicBaseUrl();
  let expected: string;
  try {
    expected = configured ? new URL(configured).host : (request.headers.get('host') ?? '');
    return Boolean(expected) && new URL(origin).host === expected;
  } catch {
    return false;
  }
}

/** Constant-time check of an `Authorization: Bearer …` header. */
export function hasBearer(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer (.+)$/);
  return Boolean(match && safeEqual(match[1]!, secret));
}

export const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;
