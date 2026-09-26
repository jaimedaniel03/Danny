'use client';

/**
 * Sign-in, first-owner setup, invitation acceptance and alert confirmation.
 * Plain server-action forms: they work without JavaScript, errors are tied to
 * their fields, and a summary receives focus when something needs fixing.
 */

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/allset/admin/action-state';
import {
  acceptInviteAction,
  confirmRecipientAction,
  inviteInfoAction,
  setupAction,
  signInAction,
} from '@/allset/admin/actions';

/**
 * One-time tokens arrive in the URL fragment (#token=…), which browsers never
 * send to the server, so they stay out of request logs. Read it once, then
 * strip it from the address bar and history.
 */
function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const match = window.location.hash.match(/token=([^&]+)/);
    setToken(match ? decodeURIComponent(match[1]!) : null);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);
  return token;
}

const IDLE: ActionState = { status: 'idle' };

function SubmitButton({ label, pending: pendingLabel }: { label: string; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--primary btn--block" disabled={pending} aria-disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

function Problem({ state }: { state: ActionState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === 'error') ref.current?.focus();
  }, [state]);
  if (state.status === 'idle' || !state.message) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={state.status === 'error' ? 'alert' : 'status'}
      className={`notice ${state.status === 'error' ? 'notice--error' : 'notice--success'}`}
    >
      {state.message}
    </div>
  );
}

interface FieldProps {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly type?: string;
  readonly autoComplete: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly defaultValue?: string;
}

function Field({ id, name, label, type = 'text', autoComplete, hint, error, defaultValue }: FieldProps) {
  const described = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          <span className="visually-hidden">Error:</span> {error}
        </p>
      ) : null}
      <input
        id={id}
        name={name}
        type={type}
        className="input"
        autoComplete={autoComplete}
        required
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        spellCheck={type === 'email' ? false : undefined}
        autoCapitalize={type === 'email' ? 'none' : undefined}
      />
    </div>
  );
}

export function LoginForm({ next }: { readonly next: string }) {
  const [state, action] = useActionState(signInAction, IDLE);
  return (
    <form action={action} className="stack" noValidate>
      <Problem state={state} />
      <input type="hidden" name="next" value={next} />
      <Field id="login-email" name="email" label="Email" type="email" autoComplete="username" />
      <Field id="login-password" name="password" label="Password" type="password" autoComplete="current-password" />
      <SubmitButton label="Sign in" pending="Signing in…" />
    </form>
  );
}

export function SetupForm() {
  const [state, action] = useActionState(setupAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <Problem state={state} />
      <Field id="setup-token" name="token" label="Setup code" type="password" autoComplete="off" hint="The ADMIN_SETUP_TOKEN value from the deployment settings." error={errors['token']} />
      <Field id="setup-name" name="displayName" label="Your name" autoComplete="name" error={errors['displayName']} />
      <Field id="setup-email" name="email" label="Email" type="email" autoComplete="username" error={errors['email']} />
      <Field id="setup-password" name="password" label="Password" type="password" autoComplete="new-password" hint="At least 12 characters. A short sentence works well." error={errors['password']} />
      <SubmitButton label="Create owner account" pending="Creating…" />
    </form>
  );
}

/** The invite page's body: reads the fragment token, looks the invite up, then shows the form. */
export function InviteFromLink() {
  const token = useFragmentToken();
  const [invite, setInvite] = useState<{ displayName: string; email: string } | null | undefined>(undefined);
  useEffect(() => {
    if (token === undefined) return;
    if (!token) {
      setInvite(null);
      return;
    }
    void inviteInfoAction(token).then(setInvite, () => setInvite(null));
  }, [token]);

  if (token === undefined || (token && invite === undefined)) {
    return <p role="status">Checking your link…</p>;
  }
  if (!token || !invite) {
    return (
      <p>
        This link has expired or was already used. Ask an owner for a new one, or <a href="/admin/login">sign in</a>.
      </p>
    );
  }
  return (
    <>
      <p>
        Welcome, {invite.displayName}. Choose a password for <strong>{invite.email}</strong>.
      </p>
      <InviteForm token={token} email={invite.email} />
    </>
  );
}

export function InviteForm({ token, email }: { readonly token: string; readonly email: string }) {
  const [state, action] = useActionState(acceptInviteAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} className="stack" noValidate>
      <Problem state={state} />
      <input type="hidden" name="token" value={token} />
      {/* Lets password managers associate the new password with the account. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <Field id="invite-password" name="password" label="New password" type="password" autoComplete="new-password" hint="At least 12 characters. A short sentence works well." error={errors['password'] ?? errors['token']} />
      <Field id="invite-confirm" name="confirm" label="Type it again" type="password" autoComplete="new-password" error={errors['confirm']} />
      <SubmitButton label="Set password and sign in" pending="Saving…" />
    </form>
  );
}

export function ConfirmAlertForm() {
  const token = useFragmentToken();
  const [state, action] = useActionState(confirmRecipientAction, IDLE);
  if (state.status === 'ok') return <Problem state={state} />;
  if (token === undefined) return <p role="status">Checking your link…</p>;
  if (!token) return <p>This link is incomplete. Open it again from the email, or ask an owner to send a new one.</p>;
  return (
    <form action={action} className="stack">
      <Problem state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton label="Yes, send me new-inquiry alerts" pending="Confirming…" />
    </form>
  );
}
