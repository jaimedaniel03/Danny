import type { Metadata } from 'next';
import Link from 'next/link';
import { Mark } from '@/components/brand/Mark';
import { InviteForm } from '@/components/admin/AuthForms';
import { db } from '@/allset/db/client';
import { findInvite } from '@/allset/auth/accounts';

export const metadata: Metadata = { title: 'Set your password' };

interface Props {
  readonly searchParams: Promise<{ token?: string }>;
}

export default async function InvitePage({ searchParams }: Props) {
  const { token = '' } = await searchParams;
  const invite = await findInvite(db(), token.slice(0, 100));

  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Set your password</h1>
        {invite ? (
          <>
            <p>
              Welcome, {invite.displayName}. Choose a password for <strong>{invite.email}</strong>.
            </p>
            <InviteForm token={token} email={invite.email} />
          </>
        ) : (
          <p>
            This link has expired or was already used. Ask an owner for a new one, or{' '}
            <Link href="/admin/login">sign in</Link>.
          </p>
        )}
      </div>
    </main>
  );
}
