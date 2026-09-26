import type { Metadata } from 'next';
import { Mark } from '@/components/brand/Mark';
import { ConfirmAlertForm } from '@/components/admin/AuthForms';

export const metadata: Metadata = { title: 'Confirm alerts' };

interface Props {
  readonly searchParams: Promise<{ token?: string }>;
}

/**
 * Confirmation takes a button press, not a page load: mail scanners that
 * follow links automatically must not be able to confirm an address.
 */
export default async function ConfirmAlertPage({ searchParams }: Props) {
  const { token = '' } = await searchParams;
  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Receive new-inquiry alerts?</h1>
        <p>
          You’ll get a short email each time someone sends an inquiry. It contains a reference
          number and a link to the lead desk — never the person’s details.
        </p>
        <ConfirmAlertForm token={token.slice(0, 200)} />
      </div>
    </main>
  );
}
