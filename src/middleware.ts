/**
 * Lead desk hardening, applied before any admin page renders:
 *
 *  - A per-request nonce Content-Security-Policy with 'strict-dynamic', so
 *    only scripts this response itself authorized can run where personal
 *    data is displayed. (Public pages are static and use a baseline policy
 *    from next.config.mjs instead.)
 *  - No caching, no indexing.
 *  - A fast redirect to sign-in when there is no session cookie at all. This
 *    is a convenience; every page and action still verifies the session.
 */

import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_ADMIN = ['/admin/login', '/admin/setup', '/admin/invite', '/admin/confirm-alert'];

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * The origin the visitor actually asked for. nextUrl can carry the server's
 * bind address (e.g. localhost) when self-hosted behind a proxy, and a
 * redirect there would lose the session cookie set on the real host.
 */
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '';
  const proto = request.headers.get('x-forwarded-proto') === 'https' || request.nextUrl.protocol === 'https:' ? 'https' : 'http';
  return HOST.test(host) ? `${proto}://${host}` : request.nextUrl.origin;
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const hasSession =
    request.cookies.has('__Host-asc_session') || request.cookies.has('asc_session');
  const isPublic = PUBLIC_ADMIN.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  let response: NextResponse;
  if (!hasSession && !isPublic && pathname.startsWith('/admin')) {
    response = NextResponse.redirect(
      new URL(`/admin/login?next=${encodeURIComponent(`${pathname}${search}`)}`, requestOrigin(request)),
    );
  } else {
    const headers = new Headers(request.headers);
    // Next.js reads the nonce from this request header and stamps it on its own scripts.
    headers.set('Content-Security-Policy', csp);
    headers.set('x-nonce', nonce);
    response = NextResponse.next({ request: { headers } });
  }

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

export const config = {
  matcher: ['/admin/:path*', '/admin'],
};
