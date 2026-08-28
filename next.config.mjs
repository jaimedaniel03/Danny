/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Consent pages carry signed tokens tied to a person's phone number.
  // Belt and braces alongside the robots metadata in layout.tsx.
  async headers() {
    return [
      {
        source: '/consent/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
      },
    ];
  },
};
