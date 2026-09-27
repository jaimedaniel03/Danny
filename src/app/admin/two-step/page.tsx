import type { Metadata } from 'next';
import { Mark } from '@/components/brand/Mark';
import { QrCode } from '@/components/admin/QrCode';
import {
  ConfirmEnrollmentForm,
  RegenerateCodesForm,
  StartEnrollmentForm,
} from '@/components/admin/AuthForms';
import { requireActor } from '@/allset/auth/session-cookie';
import { mfaStatus, pendingEnrollment } from '@/allset/auth/mfa';
import { db } from '@/allset/db/client';
import { signOutAction } from '@/allset/admin/actions';

export const metadata: Metadata = { title: 'Two-step sign-in' };

interface Props {
  readonly searchParams: Promise<{ recovery_used?: string }>;
}

/**
 * Setup and status for two-step sign-in. The one page a session that hasn't
 * passed the second step can reach. Loading it never changes anything:
 * setup starts with a button.
 */
export default async function TwoStepPage({ searchParams }: Props) {
  const actor = await requireActor('/admin/two-step', { allowUnverified: true });
  const { recovery_used: recoveryUsed } = await searchParams;
  const sql = db();
  const status = await mfaStatus(sql, actor.id);
  const pending = status.enabledAt ? null : await pendingEnrollment(sql, actor);

  return (
    <main id="main" className="container">
      <div className="auth-card auth-card--wide">
        <Mark size={44} />
        <h1 className="admin-title">Two-step sign-in</h1>

        {status.enabledAt ? (
          <>
            {recoveryUsed !== undefined ? (
              <p className="notice notice--warning" role="status">
                You signed in with a recovery code. {Number(recoveryUsed)} of your codes are left. If you’ve lost
                your phone, ask an owner to reset two-step sign-in so you can set up a new one.
              </p>
            ) : null}
            <p>
              Two-step sign-in is on for <strong>{actor.email}</strong>. Each sign-in needs your password and a
              code from your authenticator app. You have <strong>{status.recoveryCodesLeft}</strong> unused
              recovery code{status.recoveryCodesLeft === 1 ? '' : 's'}.
            </p>
            <h2 className="panel__title">Recovery codes</h2>
            <p>Making new ones cancels every old code.</p>
            <RegenerateCodesForm />
            <p>
              <a className="target" href="/admin">
                Go to the lead desk
              </a>
            </p>
          </>
        ) : (
          <>
            <p>
              Every lead desk account uses two-step sign-in: your password plus a code from an authenticator
              app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password). Set it
              up now to continue.
            </p>
            {pending ? (
              <ol className="steps-list">
                <li>
                  <p>Open your authenticator app, add an account, and scan this code.</p>
                  <QrCode value={pending.uri} label="QR code for your authenticator app" />
                  <p className="fine-print">
                    Can’t scan it? Enter this key instead:{' '}
                    <code className="secret-key">{pending.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
                  </p>
                </li>
                <li>
                  <p>Enter the 6-digit code the app shows.</p>
                  <ConfirmEnrollmentForm />
                </li>
              </ol>
            ) : (
              <StartEnrollmentForm label="Set up two-step sign-in" />
            )}
          </>
        )}

        <form action={signOutAction}>
          <button type="submit" className="btn btn--quiet">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
