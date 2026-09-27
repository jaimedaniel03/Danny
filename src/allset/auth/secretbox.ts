/**
 * Encryption for the few secrets the server must be able to read back (the
 * TOTP seeds). AES-256-GCM with a key derived from APP_SECRET per purpose, so
 * the database alone never yields a usable seed.
 */

import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { appSecret } from '@/allset/env';

const VERSION = 'v1';

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', appSecret(), 'all-set-check', `secretbox:${purpose}`, 32));
}

export function seal(purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString('base64url')}.${body.toString('base64url')}`;
}

/** Null when the box was sealed for another purpose, tampered with, or under another APP_SECRET. */
export function open(purpose: string, sealed: string): string | null {
  const [version, ivText, bodyText] = sealed.split('.');
  if (version !== VERSION || !ivText || !bodyText) return null;
  try {
    const body = Buffer.from(bodyText, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(ivText, 'base64url'));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
