/**
 * What the server may know about the request, reduced to what it needs.
 * The IP is never stored or logged in the clear — only as a keyed hash.
 */

import 'server-only';
import { headers } from 'next/headers';
import { hmacHex } from '@/allset/crypto';

export interface RequestContext {
  /** Raw IP, for rate-limit keys only. Never persisted. */
  readonly ip: string;
  readonly ipHash: string;
  readonly userAgent: string | null;
}

/**
 * On Vercel, x-real-ip and x-forwarded-for are set by the platform edge and a
 * client-supplied value is not passed through. Behind any other proxy this
 * must be revisited: a spoofable IP makes per-IP limits advisory.
 */
export function ipFrom(get: (name: string) => string | null): string {
  const real = get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || 'unknown';
}

export async function requestContext(): Promise<RequestContext> {
  const h = await headers();
  const ip = ipFrom((name) => h.get(name));
  const ua = h.get('user-agent');
  return {
    ip,
    ipHash: hmacHex('ip', ip),
    userAgent: ua ? ua.slice(0, 256) : null,
  };
}
