import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Mark } from '@/components/brand/Mark';
import { LoginForm } from '@/components/admin/AuthForms';
import { currentActor, safeReturnPath } from '@/allset/auth/session-cookie';

export const metadata: Metadata = { title: 'Sign in' };

interface Props {
  readonly searchParams: Promise<{ next?: string; signed_out?: string; password_set?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeReturnPath(params.next);
  const signedIn = await currentActor();
  if (signedIn) redirect(signedIn.mfaVerified ? next : '/admin/two-step');

  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Sign in to the lead desk</h1>
        {params.signed_out === 'partial' ? (
          <p role="alert" className="notice notice--error">
            You’re signed out on this device, but we couldn’t end the session on our server. Sign in
            and choose “Sign out other devices”, or tell an owner.
          </p>
        ) : params.password_set ? (
          <p role="status" className="notice notice--success">
            Your new password is set. Sign in with it, then enter the code from your authenticator app.
          </p>
        ) : params.signed_out ? (
          <p role="status" className="notice notice--success">
            You’re signed out.
          </p>
        ) : null}
        <LoginForm next={next} />
        <p className="fine-print">
          For All Set Check team members only. Forgot your password? Ask an owner for a reset link.
        </p>
      </div>
    </main>
  );
}
