import type { Metadata } from 'next';
import { requireActor } from '@/allset/auth/session-cookie';
import { SESSION_ABSOLUTE_HOURS, SESSION_IDLE_MINUTES } from '@/allset/auth/sessions';
import { ActionForm, Submit } from '@/components/admin/ActionForm';
import { changePasswordAction, signOutEverywhereAction } from '@/allset/admin/actions';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const actor = await requireActor('/admin/account');
  return (
    <>
      <h1 className="admin-title">Your account</h1>
      <p className="admin-sub">
        Signed in as {actor.email} ({actor.role}). Sessions end after {SESSION_ABSOLUTE_HOURS} hours, or after{' '}
        {SESSION_IDLE_MINUTES / 60} hours without activity.
      </p>

      <section className="panel" aria-labelledby="password-title" style={{ maxWidth: '36rem' }}>
        <h2 id="password-title" className="panel__title">
          Change your password
        </h2>
        <ActionForm action={changePasswordAction} aria-label="Change password">
          <input type="email" name="username" autoComplete="username" value={actor.email} readOnly hidden />
          <div className="field">
            <label className="field__label" htmlFor="current">
              Current password
            </label>
            <input id="current" name="current" type="password" className="input" autoComplete="current-password" required />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="next">
              New password
            </label>
            <p className="field__hint" id="next-hint">
              At least 12 characters. A short sentence works well.
            </p>
            <input id="next" name="next" type="password" className="input" autoComplete="new-password" required aria-describedby="next-hint" />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="confirm">
              Type it again
            </label>
            <input id="confirm" name="confirm" type="password" className="input" autoComplete="new-password" required />
          </div>
          <Submit>Change password</Submit>
        </ActionForm>
      </section>

      <section className="panel" aria-labelledby="sessions-title" style={{ maxWidth: '36rem' }}>
        <h2 id="sessions-title" className="panel__title">
          Other devices
        </h2>
        <p>Lost a phone or signed in somewhere shared? Sign out everywhere except here.</p>
        <ActionForm action={signOutEverywhereAction} aria-label="Sign out other devices">
          <Submit variant="secondary">Sign out other devices</Submit>
        </ActionForm>
      </section>
    </>
  );
}
