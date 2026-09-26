/** @type {import('next').NextConfig} */

const dev = process.env.NODE_ENV !== 'production';
// Vercel's preview toolbar loads from vercel.live on preview deployments only.
const preview = process.env.VERCEL_ENV === 'preview';

/**
 * Baseline policy for public pages. They are statically rendered, so a
 * per-request nonce isn't available; inline scripts are Next.js's own
 * bootstrap. The lead desk gets a stricter nonce-based policy in middleware.
 */
const publicCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}${preview ? ' https://vercel.live' : ''}`,
  `style-src 'self' 'unsafe-inline'${preview ? ' https://vercel.live' : ''}`,
  `img-src 'self' data:${preview ? ' https://vercel.live https://vercel.com' : ''}`,
  `font-src 'self'${preview ? ' https://vercel.live' : ''}`,
  `connect-src 'self'${preview ? ' https://vercel.live wss://ws-us3.pusher.com' : ''}`,
  `frame-src ${preview ? 'https://vercel.live' : "'none'"}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(dev ? [] : ['upgrade-insecure-requests']),
].join('; ');

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
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Everything except the lead desk, which sets its own nonce policy.
      { source: '/((?!admin).*)', headers: [{ key: 'Content-Security-Policy', value: publicCsp }] },
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
