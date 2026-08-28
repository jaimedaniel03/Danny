import type { ReactNode } from 'react';

export const metadata = {
  title: 'Danny',
  description: 'AI producer for insurance agencies',
  // Consent pages must never be indexed: the URLs carry signed tokens tied to
  // a specific person's phone number.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
