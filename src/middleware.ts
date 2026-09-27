/**
 * Applied before any page renders:
 *
 *  - Every HTML page gets a per-request nonce Content-Security-Policy with
 *    'strict-dynamic': only scripts this response itself authorized can run.
 *    There is no 'unsafe-inline' or 'unsafe-eval' for scripts in production,
 *    and styles are limited to our own files and nonced <style> blocks.
 *  - The lead desk is also never cached or indexed, and a request with no
 *    session cookie at all is sent to sign-in. That redirect is a
 *    convenience; every page and action still verifies the session.
 *
 * Pages are rendered per request (see the root layout), because a nonce
 * only works if each response carries its own.
 */

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_ADMIN = ['/admin/login', '/admin/setup', '/admin/invite', '/admin/confirm-alert'];

/**
 * Where redirects point. A configured public address wins; otherwise the URL
 * the platform resolved. Forwarded-host headers are never trusted here: off
 * Vercel they are whatever the client sent.
 */
function origin(request: NextRequest): string {
  const configured = process.env['PUBLIC_BASE_URL']?.trim().replace(/\/+$/, '');
  return configured || request.nextUrl.origin;
}

export function contentSecurityPolicy(nonce: string, options: { dev: boolean }): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    ...(options.dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const isAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  const csp = contentSecurityPolicy(nonce, { dev });

  const hasSession = request.cookies.has('__Host-asc_session') || request.cookies.has('asc_session');
  const isPublicAdmin = PUBLIC_ADMIN.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  let response: NextResponse;
  if (isAdmin && !hasSession && !isPublicAdmin) {
    response = NextResponse.redirect(
      new URL(`/admin/login?next=${encodeURIComponent(`${pathname}${search}`)}`, origin(request)),
    );
  } else {
    const headers = new Headers(request.headers);
    // Next.js reads the nonce from this request header and stamps it on its own scripts and styles.
    headers.set('Content-Security-Policy', csp);
    headers.set('x-nonce', nonce);
    response = NextResponse.next({ request: { headers } });
  }

  response.headers.set('Content-Security-Policy', csp);
  if (isAdmin) {
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  return response;
}

export const config = {
  // Every page. Not API routes (they return JSON, not documents), build
  // assets, photos, or metadata files.
  matcher: [
    '/((?!api/|_next/static|_next/image|images/|favicon\\.ico|icon\\.svg|apple-icon\\.png|icon-|opengraph-image|twitter-image|robots\\.txt|sitemap\\.xml).*)',
  ],
};
