'use client';

import { useState } from 'react';

interface ConsentFormProps {
  readonly token: string;
  readonly checkboxLabel: string;
  readonly body: string;
  readonly footer: string;
}

export function ConsentForm(props: ConsentFormProps) {
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setStatus('saving');
    setError(null);

    try {
      const response = await fetch('/api/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: props.token,
          agreed: true,
          signatureName: name.trim(),
          scopedLines: [],
          website,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? 'Something went wrong. Please try again.');
        setStatus('error');
        return;
      }
      setStatus('done');
    } catch {
      setError('We couldn’t reach the server. Check your connection and try again.');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div style={s.done}>
        <p style={s.doneTitle}>You’re all set.</p>
        <p style={s.doneBody}>
          We’ll be in touch shortly. You can tell us to stop at any time and we’ll take you off
          the list right away.
        </p>
      </div>
    );
  }

  const canSubmit = agreed && name.trim().length >= 2 && status !== 'saving';

  return (
    <form
      onSubmit={(event) => {
        // React expects a void handler here. Returning the promise would make
        // a rejection unhandled; `void` makes the discard deliberate and the
        // catch inside submit() is what actually reports failure.
        event.preventDefault();
        void submit();
      }}
    >
      {/* The disclosure sits adjacent to the checkbox, never behind a link.
          "Clear and conspicuous" is a standard the layout either meets or not. */}
      <div style={s.disclosure}>
        {props.body.split('\n\n').map((paragraph, i) => (
          <p key={i} style={s.disclosureP}>
            {paragraph}
          </p>
        ))}
      </div>

      <label style={s.checkboxRow}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          style={s.checkbox}
          required
        />
        <span style={s.checkboxLabel}>{props.checkboxLabel}</span>
      </label>

      <label style={s.field}>
        <span style={s.fieldLabel}>Type your full name to sign</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          style={s.input}
          required
          minLength={2}
        />
      </label>

      {/* Honeypot: positioned off-screen rather than display:none, which some
          bots detect. Real people never see or fill it. */}
      <div style={s.honeypot} aria-hidden="true">
        <label>
          Website
          <input
            type="text"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            tabIndex={-1}
            autoComplete="off"
          />
        </label>
      </div>

      {error && (
        <p role="alert" style={s.error}>
          {error}
        </p>
      )}

      <button type="submit" disabled={!canSubmit} style={canSubmit ? s.button : s.buttonDisabled}>
        {status === 'saving' ? 'Saving…' : 'Submit'}
      </button>

      <p style={s.footer}>{props.footer}</p>
    </form>
  );
}

const s = {
  disclosure: {
    background: '#f5f7fa',
    border: '1px solid #dde3eb',
    borderRadius: '4px',
    padding: '1rem 1.1rem',
    marginBottom: '1.25rem',
    maxHeight: '15rem',
    overflowY: 'auto' as const,
  },
  disclosureP: { margin: '0 0 0.85rem', fontSize: '0.9rem', color: '#3d4653', lineHeight: 1.55 },
  checkboxRow: {
    display: 'flex',
    gap: '0.7rem',
    alignItems: 'flex-start',
    marginBottom: '1.5rem',
    cursor: 'pointer',
  },
  checkbox: { marginTop: '0.25rem', width: '1.15rem', height: '1.15rem', flex: 'none' },
  checkboxLabel: { fontSize: '0.95rem', lineHeight: 1.5 },
  field: { display: 'block', marginBottom: '1.5rem' },
  fieldLabel: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: 600,
    marginBottom: '0.4rem',
    color: '#3d4653',
  },
  input: {
    width: '100%',
    padding: '0.7rem 0.8rem',
    fontSize: '1rem',
    border: '1px solid #c3ccd8',
    borderRadius: '4px',
    fontFamily: 'inherit',
  },
  honeypot: {
    position: 'absolute' as const,
    left: '-9999px',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
  },
  error: {
    color: '#a62e1a',
    fontSize: '0.9rem',
    margin: '0 0 1rem',
    padding: '0.7rem 0.85rem',
    background: '#fbedea',
    border: '1px solid #e8c4bc',
    borderRadius: '4px',
  },
  button: {
    width: '100%',
    padding: '0.85rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#ffffff',
    background: '#1b6349',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  buttonDisabled: {
    width: '100%',
    padding: '0.85rem',
    fontSize: '1rem',
    fontWeight: 600,
    color: '#8a94a3',
    background: '#edf0f5',
    border: 'none',
    borderRadius: '4px',
    cursor: 'not-allowed',
    fontFamily: 'inherit',
  },
  footer: { fontSize: '0.8rem', color: '#626d7d', margin: '1rem 0 0', lineHeight: 1.5 },
  done: {
    background: '#e8f2ee',
    border: '1px solid #b7d6ca',
    borderRadius: '4px',
    padding: '1.5rem',
  },
  doneTitle: { margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 600, color: '#1b6349' },
  doneBody: { margin: 0, fontSize: '0.95rem', color: '#3d4653' },
} as const;
