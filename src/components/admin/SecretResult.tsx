'use client';

/**
 * A form whose success returns a one-time secret (an invite or reset link)
 * that is shown exactly once, with a copy button.
 */

import { useActionState, useState, type ReactNode } from 'react';
import type { ActionState } from '@/allset/admin/action-state';

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;

export function SecretForm({
  action,
  children,
  label,
}: {
  readonly action: Action;
  readonly children: ReactNode;
  readonly label: string;
}) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as ActionState);
  const [copied, setCopied] = useState(false);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} aria-label={label} className="stack">
      {children}
      {Object.entries(errors).map(([field, message]) => (
        <p key={field} className="field__error">
          <span className="visually-hidden">Error:</span> {message}
        </p>
      ))}
      <p className={`form-status ${state.status === 'ok' ? 'form-status--ok' : state.status === 'error' ? 'form-status--error' : ''}`} role={state.status === 'error' ? 'alert' : 'status'}>
        {state.message ?? ''}
      </p>
      {state.secret ? (
        <div className="stack">
          <p className="secret-box" aria-label="One-time link">
            {state.secret}
          </p>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(state.secret ?? '').then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      ) : null}
    </form>
  );
}
