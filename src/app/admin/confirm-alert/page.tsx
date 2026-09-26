import type { Metadata } from 'next';
import { Mark } from '@/components/brand/Mark';
import { ConfirmAlertForm } from '@/components/admin/AuthForms';

export const metadata: Metadata = { title: 'Confirm alerts' };

/**
 * Confirmation takes a button press, not a page load: mail scanners that
 * follow links automatically must not be able to confirm an address. The
 * token is in the URL fragment, so it never reaches server logs.
 */
export default function ConfirmAlertPage() {
  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Receive new-inquiry alerts?</h1>
        <p>
          You’ll get a short email each time someone sends an inquiry. It contains a reference
          number and a link to the lead desk — never the person’s details.
        </p>
        <ConfirmAlertForm />
        <noscript>
          <p>This page needs JavaScript to read your one-time link securely.</p>
        </noscript>
      </div>
    </main>
  );
}
