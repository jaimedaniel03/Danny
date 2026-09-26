/**
 * Fixed-window rate limits stored in Postgres.
 *
 * Serverless instances share no memory, so an in-process counter would reset
 * on every cold start and let a determined client straight through. One
 * atomic upsert per check keeps the count honest across instances. Keys are
 * HMACs: the table never holds a raw IP or email.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { hmacHex } from '@/allset/crypto';

export interface Limit {
  readonly bucket: string;
  readonly max: number;
  readonly windowSeconds: number;
}

export interface LimitResult {
  readonly allowed: boolean;
  readonly count: number;
  readonly retryAfterSeconds: number;
}

function windowStart(limit: Limit, now: number): Date {
  const size = limit.windowSeconds * 1000;
  return new Date(Math.floor(now / size) * size);
}

function retryAfter(limit: Limit, start: Date, now: number): number {
  return Math.max(1, Math.ceil((start.getTime() + limit.windowSeconds * 1000 - now) / 1000));
}

/** Count one hit and report whether it was within the limit. */
export async function hit(sql: Sql, limit: Limit, key: string, now = Date.now()): Promise<LimitResult> {
  const start = windowStart(limit, now);
  const keyHash = hmacHex(`ratelimit:${limit.bucket}`, key);
  const [row] = await sql<{ hits: number }[]>`
    insert into allset.rate_limits (bucket, key_hash, window_start, hits)
    values (${limit.bucket}, ${keyHash}, ${start}, 1)
    on conflict (bucket, key_hash, window_start)
    do update set hits = allset.rate_limits.hits + 1
    returning hits`;
  const count = row?.hits ?? 1;
  return { allowed: count <= limit.max, count, retryAfterSeconds: retryAfter(limit, start, now) };
}

/** Read the current count without adding to it. */
export async function peek(sql: Sql, limit: Limit, key: string, now = Date.now()): Promise<LimitResult> {
  const start = windowStart(limit, now);
  const keyHash = hmacHex(`ratelimit:${limit.bucket}`, key);
  const [row] = await sql<{ hits: number }[]>`
    select hits from allset.rate_limits
    where bucket = ${limit.bucket} and key_hash = ${keyHash} and window_start = ${start}`;
  const count = row?.hits ?? 0;
  return { allowed: count < limit.max, count, retryAfterSeconds: retryAfter(limit, start, now) };
}

export const LIMITS = {
  inquiryPerIpShort: { bucket: 'inquiry-ip-10m', max: 5, windowSeconds: 600 },
  inquiryPerIpDay: { bucket: 'inquiry-ip-day', max: 20, windowSeconds: 86_400 },
  inquiryPerEmailHour: { bucket: 'inquiry-email-1h', max: 4, windowSeconds: 3_600 },
  loginPerIp: { bucket: 'login-ip-15m', max: 20, windowSeconds: 900 },
  loginPerEmail: { bucket: 'login-email-15m', max: 10, windowSeconds: 900 },
  exportPerStaff: { bucket: 'export-staff-1h', max: 10, windowSeconds: 3_600 },
  setupPerIp: { bucket: 'setup-ip-1h', max: 10, windowSeconds: 3_600 },
} as const satisfies Record<string, Limit>;
