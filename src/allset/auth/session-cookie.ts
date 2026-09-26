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

/** For pages: redirect to sign-in when there is no valid session. */
export async function requireActor(returnTo = '/admin'): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect(`/admin/login?next=${encodeURIComponent(safeReturnPath(returnTo))}`);
  return actor;
}

/** For pages: owners only. Staff are sent to the dashboard with a notice. */
export async function requireOwnerPage(permission: OwnerPermission, returnTo: string): Promise<Actor> {
  const actor = await requireActor(returnTo);
  if (!can(actor, permission)) redirect('/admin?notice=owner-only');
  return actor;
}

/** For server actions: throw rather than redirect, so the action can report it. */
export async function actorForAction(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) throw new PermissionError('Your session has ended. Sign in again to continue.');
  return actor;
}

/** Only same-site admin paths are valid post-login destinations. */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/admin') || value.startsWith('//') || value.includes('\\')) return '/admin';
  if (value.startsWith('/admin/login') || value.startsWith('/admin/setup')) return '/admin';
  return value.slice(0, 300);
}
