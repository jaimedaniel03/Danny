'use client';

/**
 * A form bound to a server action that reports back in place.
 * Works without JavaScript (React renders the returned state after a normal
 * POST); with JavaScript it stays on the page and announces the result.
 */

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ActionState } from '@/allset/admin/action-state';

type Action = (previous: ActionState, form: FormData) => Promise<ActionState>;

interface ActionFormProps {
  readonly action: Action;
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly 'aria-label'?: string | undefined;
}

export function ActionForm({ action, children, className, ...rest }: ActionFormProps) {
  const [state, formAction] = useActionState(action, { status: 'idle' } as ActionState);
  return (
    <form action={formAction} className={className} aria-label={rest['aria-label']}>
      {children}
      <p
        className={`form-status ${state.status === 'ok' ? 'form-status--ok' : state.status === 'error' ? 'form-status--error' : ''}`}
        role={state.status === 'error' ? 'alert' : 'status'}
      >
        {state.message ?? ''}
      </p>
    </form>
  );
}

interface SubmitProps {
  readonly children: ReactNode;
  readonly pendingLabel?: string;
  readonly variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  readonly name?: string;
  readonly value?: string;
}

export function Submit({ children, pendingLabel = 'Saving…', variant = 'primary', name, value }: SubmitProps) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn btn--${variant}`} disabled={pending} aria-disabled={pending} name={name} value={value}>
      {pending ? pendingLabel : children}
    </button>
  );
}
