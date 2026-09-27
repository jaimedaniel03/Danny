/**
 * Next.js glue for staff sessions: the cookie, and the guards every admin
 * page, server action and route handler calls first.
 *
 * Layouts are not a security boundary in the App Router (they don't re-run on
 * every navigation, and server actions bypass them), so each page and action
 * calls requireActor()/requireOwner() itself.
 */

import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '@/allset/db/client';
import { isProduction } from '@/allset/env';
import { lookupSession, SESSION_ABSOLUTE_HOURS } from './sessions';
import { can, PermissionError, type Actor, type OwnerPermission } from './roles';

/** __Host- pins the cookie to this exact origin over HTTPS, path=/, no Domain. */
export const SESSION_COOKIE = isProduction() ? '__Host-asc_session' : 'asc_session';

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge: SESSION_ABSOLUTE_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  // A __Host- cookie is only replaced by one with the same attributes
  // (Secure, Path=/); a bare delete() is ignored by browsers.
  jar.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
  // A search term can hold a name or email; don't leave it behind on a shared computer.
  jar.set(SEARCH_COOKIE, '', {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
}

/** Lead search terms are personal data; they ride in a cookie, not the URL (and so not in request logs). */
export const SEARCH_COOKIE = isProduction() ? '__Host-asc_lead_q' : 'asc_lead_q';

export async function readSearchTerm(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SEARCH_COOKIE)?.value.slice(0, 100) || undefined;
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

/** The signed-in staff member for this request, or null. Cached per request. */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  return lookupSession(db(), token);
});

/**
 * For pages: redirect to sign-in when there is no valid session, and to
 * two-step setup when the session hasn't passed the second step. Only the
 * setup page itself passes `allowUnverified`.
 */
export async function requireActor(returnTo = '/admin', options: { allowUnverified?: boolean } = {}): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect(`/admin/login?next=${encodeURIComponent(safeReturnPath(returnTo))}`);
  if (!actor.mfaVerified && !options.allowUnverified) redirect('/admin/two-step');
  return actor;
}

/** For pages: owners only. Staff are sent to the dashboard with a notice. */
export async function requireOwnerPage(permission: OwnerPermission, returnTo: string): Promise<Actor> {
  const actor = await requireActor(returnTo);
  if (!can(actor, permission)) redirect('/admin?notice=owner-only');
  return actor;
}

/** For server actions: throw rather than redirect, so the action can report it. */
export async function actorForAction(options: { allowUnverified?: boolean } = {}): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new PermissionError('Your session has ended. Sign in again to continue.');
  if (!actor.mfaVerified && !options.allowUnverified) {
    throw new PermissionError('Finish setting up two-step sign-in first.');
  }
  return actor;
}

/** For route handlers and non-desk code: a fully signed-in staff member, or null. */
export async function verifiedActor(): Promise<Actor | null> {
  const actor = await currentActor();
  return actor?.mfaVerified ? actor : null;
}

// ── Second-step and device cookies ───────────────────────────────────────

/** Between a right password and a right code. Five minutes, this browser only. */
export const MFA_COOKIE = isProduction() ? '__Host-asc_mfa' : 'asc_mfa';
/** Marks a browser that completed a full sign-in (its own sign-in attempt budget). */
export const DEVICE_COOKIE = isProduction() ? '__Host-asc_device' : 'asc_device';

async function setCookie(name: string, value: string, expiresAt: Date, sameSite: 'lax' | 'strict'): Promise<void> {
  const jar = await cookies();
  jar.set(name, value, {
    httpOnly: true,
    secure: isProduction(),
    sameSite,
    path: '/',
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}

export async function setMfaCookie(token: string, expiresAt: Date): Promise<void> {
  await setCookie(MFA_COOKIE, token, expiresAt, 'strict');
}

export async function clearMfaCookie(): Promise<void> {
  await setCookie(MFA_COOKIE, '', new Date(0), 'strict');
}

export async function readMfaToken(): Promise<string | null> {
  return (await cookies()).get(MFA_COOKIE)?.value ?? null;
}

export async function setDeviceCookie(token: string, expiresAt: Date): Promise<void> {
  await setCookie(DEVICE_COOKIE, token, expiresAt, 'strict');
}

export async function readDeviceToken(): Promise<string | null> {
  return (await cookies()).get(DEVICE_COOKIE)?.value ?? null;
}

/** Only same-site admin paths are valid post-login destinations. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/admin') || value.startsWith('//') || value.includes('\\')) return '/admin';
  if (value.startsWith('/admin/login') || value.startsWith('/admin/setup')) return '/admin';
  return value.slice(0, 300);
}
