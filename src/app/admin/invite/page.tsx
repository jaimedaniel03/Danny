import type { Metadata } from 'next';
import { Mark } from '@/components/brand/Mark';
import { InviteFromLink } from '@/components/admin/AuthForms';

export const metadata: Metadata = { title: 'Set your password' };

/**
 * The invite token is in the URL fragment, which never reaches the server;
 * the page reads it in the browser (so this page needs JavaScript).
 */
export default function InvitePage() {
  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Set your password</h1>
        <InviteFromLink />
        <noscript>
          <p>This page needs JavaScript to read your one-time link securely.</p>
        </noscript>
      </div>
    </main>
  );
}
