/**
 * Small request guards for route handlers (server actions get Next.js's own
 * origin check; route handlers do not).
 */

import 'server-only';
import { safeEqual } from '@/allset/crypto';

/** True when a state-changing request came from this site's own pages. */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
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
