import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Mark } from '@/components/brand/Mark';
import { SetupForm } from '@/components/admin/AuthForms';
import { adminSetupToken } from '@/allset/env';
import { db } from '@/allset/db/client';
import { hasActiveOwner } from '@/allset/auth/accounts';

export const metadata: Metadata = { title: 'Set up the lead desk' };

export default async function SetupPage() {
  await connection();
  const enabled = Boolean(adminSetupToken()) && !(await hasActiveOwner(db()));

  return (
    <main id="main" className="container">
      <div className="auth-card">
        <Mark size={44} />
        <h1 className="admin-title">Create the first owner account</h1>
        {enabled ? (
          <>
            <p>
              This page works once. After an owner exists, everyone else is invited from the Team
              page and this setup closes.
            </p>
            <SetupForm />
          </>
        ) : (
          <p>
            Setup is closed — an owner account already exists or setup isn’t enabled.{' '}
            <Link href="/admin/login">Sign in</Link> instead.
          </p>
        )}
      </div>
    </main>
  );
}
