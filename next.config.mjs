/** @type {import('next').NextConfig} */

const dev = process.env.NODE_ENV !== 'production';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // Photos ship pre-encoded (scripts/build-images.ts), so the on-demand optimizer
  // is never needed. Turning it off removes the one runtime path into sharp/libvips.
  images: { unoptimized: true },
  // CSS is served as files, not inlined: Next's inlined <style> blocks carry
  // no nonce, and the CSP allows no 'unsafe-inline'. (Inlining shaved a few
  // hundred ms off simulated mobile LCP; the strict policy is worth more.)
  // Always put metadata in <head>, for every client. Our metadata is static,
  // so streaming it later buys nothing and hides it from some tools.
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      // The Content-Security-Policy is set per request, with a nonce, in src/middleware.ts.
      { source: '/:path*', headers: securityHeaders },
      // Consent pages carry signed tokens tied to a person's phone number.
      // Belt and braces alongside the robots metadata on the page.
      {
        source: '/consent/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
      },
      {
        source: '/images/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/api/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex' }],
      },
    ];
  },
};
