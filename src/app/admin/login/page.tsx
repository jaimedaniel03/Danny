import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Mark } from '@/components/brand/Mark';
import { LoginForm } from '@/components/admin/AuthForms';
import { currentActor, safeReturnPath } from '@/allset/auth/session-cookie';

export const metadata: Metadata = { title: 'Sign in' };

interface Props {
  readonly searchParams: Promise<{ next?: string; signed_out?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeReturnPath(params.next);
  if (await currentActor()) redirect(next);

  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Sign in to the lead desk</h1>
        {params.signed_out ? (
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
