/**
 * Password hashing with scrypt (memory-hard, in node:crypto).
 *
 * Stored format: scrypt$N$r$p$<salt b64>$<hash b64>, so parameters can be
 * raised later without invalidating existing hashes.
 */

import 'server-only';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 96 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64!, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64!, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEM,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * A real hash of a random password. Verifying against it when an account
 * doesn't exist makes "no such user" take as long as "wrong password".
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'));
  return dummy;
}

const COMMON = new Set([
  'password1234', 'password12345', '123456789012', 'qwertyuiop12', 'letmein12345', 'allsetcheck1',
  'allsetcheck123', 'insurance123', 'welcome12345', 'iloveyou1234', 'changeme1234', 'administrator',
]);

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Plain-language problem with a proposed password, or null if it's acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters. A short sentence works well.`;
  if (password.length > PASSWORD_MAX) return `Use ${PASSWORD_MAX} characters or fewer.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Try a short sentence only you would think of.';
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && lower.includes(local)) return 'Don’t include your email address in your password.';
  if (/^(.)\1+$/.test(password)) return 'Don’t repeat a single character.';
  return null;
}
