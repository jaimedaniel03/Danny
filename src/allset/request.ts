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
 * The client's IP, for rate-limit keys. Forwarded-IP headers are trusted only
 * where a proxy we control sets them: on Vercel (whose edge overwrites
 * x-real-ip and x-forwarded-for, so a client can't choose its own), or when
 * TRUST_PROXY_IP_HEADERS=true declares another such proxy. Anywhere else they
 * are whatever the client sent, so every request shares one "unknown" key:
 * limits then apply to everyone together, which fails closed.
 */
export function ipFrom(get: (name: string) => string | null, env: NodeJS.ProcessEnv = process.env): string {
  const trusted = env['VERCEL'] === '1' || env['TRUST_PROXY_IP_HEADERS'] === 'true';
  if (!trusted) return 'unknown';
  const real = get('x-real-ip')?.trim();
  if (real) return rateLimitKey(real);
  const forwarded = get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded ? rateLimitKey(forwarded) : 'unknown';
}

/**
 * IPv6 hands one household or device a whole /64, so limiting per full
 * address would give a single client billions of keys. Limit per /64.
 * IPv4 (including IPv4-mapped IPv6) is used as is.
 */
export function rateLimitKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = ip.includes('::') ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
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
