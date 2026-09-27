import type { Metadata } from 'next';
import { Mark } from '@/components/brand/Mark';
import { VerifyCodeForm } from '@/components/admin/AuthForms';
import { readMfaToken, safeReturnPath } from '@/allset/auth/session-cookie';

export const metadata: Metadata = { title: 'Two-step sign-in' };

interface Props {
  readonly searchParams: Promise<{ next?: string }>;
}

export default async function VerifyPage({ searchParams }: Props) {
  const { next } = await searchParams;
  const pending = Boolean(await readMfaToken());
  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Enter your code</h1>
        {pending ? (
          <VerifyCodeForm next={safeReturnPath(next)} />
        ) : (
          <>
            <p>This sign-in has expired or was already finished.</p>
            <p>
              <a className="btn btn--primary" href="/admin/login">
                Sign in again
              </a>
            </p>
          </>
        )}
        <p className="fine-print">
          Lost your phone and your recovery codes? Ask an owner to reset your two-step sign-in.
        </p>
      </div>
    </main>
  );
}
