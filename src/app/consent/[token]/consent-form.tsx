'use client';

import { useState } from 'react';
import styles from './consent.module.css';

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
      <div className={styles.done}>
        <p className={styles.doneTitle}>You’re all set.</p>
        <p className={styles.doneBody}>
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
      <div className={styles.disclosure}>
        {props.body.split('\n\n').map((paragraph, i) => (
          <p key={i} className={styles.disclosureP}>
            {paragraph}
          </p>
        ))}
      </div>

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className={styles.checkbox}
          required
        />
        <span className={styles.checkboxLabel}>{props.checkboxLabel}</span>
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Type your full name to sign</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          className={styles.input}
          required
          minLength={2}
        />
      </label>

      {/* Honeypot: positioned off-screen rather than display:none, which some
          bots detect. Real people never see or fill it. */}
      <div className={styles.honeypot} aria-hidden="true">
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
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <button type="submit" disabled={!canSubmit} className={canSubmit ? styles.button : styles.buttonDisabled}>
        {status === 'saving' ? 'Saving…' : 'Submit'}
      </button>

      <p className={styles.footer}>{props.footer}</p>
    </form>
  );
}
