'use client';

/**
 * The inquiry form, for both coverage and team inquiries.
 *
 * Progressive enhancement, deliberately:
 *   - Without JavaScript, the form POSTs to the server action and the page
 *     re-renders with the result — errors, preserved values, or the reference.
 *   - With JavaScript, submission happens in place. A network failure keeps
 *     every value, keeps the same idempotency key (so a retry can't create a
 *     duplicate), and says plainly that it couldn't confirm the request
 *     arrived.
 *
 * Validation lives on the server. The browser's own popups are turned off
 * (noValidate) so every message is the same plain-language one, placed next
 * to its field and listed in a summary that receives focus.
 */

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import {
  CONTACT_METHODS,
  CONTACT_METHOD_LABELS,
  COVERAGE_INTERESTS,
  COVERAGE_INTEREST_LABELS,
  EMPTY_VALUES,
  FIELD_ORDER,
  LICENSING_STATUSES,
  LICENSING_STATUS_LABELS,
  LIMITS,
  type FieldErrors,
  type FieldName,
  type InquiryValues,
} from '@/allset/inquiries/fields';
import type { InquiryState } from '@/allset/inquiries/state';
import type { Acknowledgment } from '@/allset/inquiries/consent';
import styles from './InquiryForm.module.css';
import { US_STATES } from '@/allset/content/states';

type Action = (previous: InquiryState, form: FormData) => Promise<InquiryState>;

interface InquiryFormProps {
  readonly action: Action;
  readonly initialState: InquiryState;
  readonly consentText: string;
  readonly disclosureAckText?: Acknowledgment | undefined;
  readonly successNextSteps: readonly string[];
}

const FIELD_IDS: Record<FieldName, string> = {
  fullName: 'inquiry-name',
  email: 'inquiry-email',
  zip: 'inquiry-zip',
  state: 'inquiry-state',
  contactMethod: 'inquiry-contact-method-email',
  phone: 'inquiry-phone',
  coverageInterest: 'inquiry-interest-life',
  licensingStatus: 'inquiry-licensing-licensed_life_health',
  consent: 'inquiry-consent',
  disclosureAck: 'inquiry-disclosure-ack',
};

function valuesFromForm(form: FormData): InquiryValues {
  const get = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  return {
    fullName: get('fullName'),
    email: get('email'),
    zip: get('zip'),
    state: get('state'),
    contactMethod: get('contactMethod'),
    phone: get('phone'),
    coverageInterest: get('coverageInterest'),
    licensingStatus: get('licensingStatus'),
    consent: form.get('consent') === 'yes',
    disclosureAck: form.get('disclosureAck') === 'yes',
  };
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined || undefined;
}

/** How long to wait for the server before saying the receipt is unconfirmed. */
const RECEIPT_TIMEOUT_MS = 20_000;

function unconfirmed(previous: InquiryState, data: FormData): InquiryState {
  const noun = previous.kind === 'coverage' ? 'request' : 'inquiry';
  return {
    kind: previous.kind,
    idempotencyKey: previous.idempotencyKey,
    formToken: previous.formToken,
    attempt: previous.attempt + 1,
    preview: previous.preview,
    status: 'error',
    unconfirmed: true,
    // It's unknown whether it arrived. The same idempotency key rides on the
    // retry, and the database refuses a second row for it, so sending again
    // can't create a duplicate.
    message: `We didn’t get confirmation that your ${noun} reached us, so there’s no reference number yet. Your details are still here. Check your connection and send it again; if the first one did arrive, sending again won’t create a duplicate.`,
    values: valuesFromForm(data),
  };
}

export function InquiryForm({ action, initialState, consentText, disclosureAckText, successNextSteps }: InquiryFormProps) {
  // Server-driven state: this is what a no-JavaScript POST renders.
  const [serverState, formAction] = useActionState(action, initialState);
  // Script-driven state: what an in-place submission produced.
  const [clientState, setClientState] = useState<InquiryState | null>(null);
  const [pending, startTransition] = useTransition();
  const state = clientState ?? serverState;

  const summaryRef = useRef<HTMLDivElement>(null);
  /** Which submission the page is showing, so a late answer can't overwrite a newer one. */
  const latestAttempt = useRef(0);
  const successRef = useRef<HTMLHeadingElement>(null);
  const kind = state.kind;
  const noun = kind === 'coverage' ? 'request' : 'inquiry';

  const values: InquiryValues =
    state.status === 'invalid' || state.status === 'error' || state.status === 'ineligible' ? state.values : EMPTY_VALUES;
  const errors: FieldErrors = state.status === 'invalid' ? state.errors : {};
  const errorList = FIELD_ORDER.filter((name) => errors[name]);

  // Move focus to what changed: the success message, or the problem summary.
  useEffect(() => {
    if (state.attempt === 0) return;
    if (state.status === 'success') successRef.current?.focus();
    else if (state.status === 'invalid' || state.status === 'error' || state.status === 'ineligible') summaryRef.current?.focus();
  }, [state.attempt, state.status]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const previous = state;
    const attempt = previous.attempt + 1;
    latestAttempt.current = attempt;
    startTransition(async () => {
      const request = action(previous, data).then(
        (next) => ({ next }),
        () => ({ lost: true as const }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), RECEIPT_TIMEOUT_MS);
      });
      const first = await Promise.race([request, timeout]);
      clearTimeout(timer);
      if ('next' in first) {
        setClientState(first.next);
        return;
      }
      setClientState(unconfirmed(previous, data));
      if ('timedOut' in first) {
        // The answer may still come. If it does, and nothing newer has happened, show it.
        void request.then((late) => {
          if ('next' in late && late.next.status === 'success' && latestAttempt.current === attempt) setClientState(late.next);
        });
      }
    });
  }

  function startOver() {
    setClientState({
      kind,
      idempotencyKey: crypto.randomUUID(),
      formToken: state.formToken,
      attempt: state.attempt + 1,
      preview: state.preview,
      status: 'idle',
    });
  }

  if (state.status === 'closed') {
    return (
      <div className="notice notice--warning" role="status">
        <p className="notice__title">
          {kind === 'coverage' ? 'We’re not taking requests through this site yet.' : 'We’re not taking team inquiries through this site yet.'}
        </p>
        {kind === 'coverage' ? (
          <p>
            If you need coverage now, these free official sites can help:{' '}
            <a href="https://www.healthcare.gov/" rel="noopener noreferrer">HealthCare.gov</a>,{' '}
            <a href="https://www.medicaid.gov/" rel="noopener noreferrer">Medicaid.gov</a> and{' '}
            <a href="https://www.medicare.gov/" rel="noopener noreferrer">Medicare.gov</a>.
          </p>
        ) : null}
      </div>
    );
  }

  if (state.status === 'success') {
    return (
      <div className={styles.success} role="status">
        <h2 ref={successRef} tabIndex={-1} className={styles.successTitle}>
          Thank you. We have your {noun}.
        </h2>
        <p>
          Your reference is <strong className={styles.reference}>{state.reference}</strong>. Keep it
          handy in case you want to mention it when we talk.
        </p>
        <ul role="list" className={styles.nextSteps}>
          {successNextSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ul>
        <p className="fine-print">
          We&rsquo;ll reach you by {CONTACT_METHOD_LABELS[state.contactMethod].toLowerCase()}. Changed your mind?
          Reply STOP to a text, reply to an email, or tell the person who calls you, and we&rsquo;ll stop.
        </p>
        <button type="button" className="btn btn--secondary" onClick={startOver}>
          Send another {noun}
        </button>
      </div>
    );
  }

  const phoneRequired = values.contactMethod === 'phone' || values.contactMethod === 'text';

  return (
    <form
      key={state.attempt}
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      className={styles.form}
      aria-describedby="inquiry-required-note"
    >
      {state.preview ? (
        <p className="notice notice--warning" role="note">
          <strong>Test preview.</strong> Only signed-in staff see this form before launch. Use made-up
          details: everything sent here is stored as test data.
        </p>
      ) : null}

      {state.status === 'invalid' || state.status === 'error' || state.status === 'ineligible' ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          className={`notice ${state.status === 'ineligible' ? 'notice--warning' : 'notice--error'} ${styles.summary}`}
          role="alert"
          aria-labelledby="inquiry-summary-title"
        >
          <h2 id="inquiry-summary-title" className={styles.summaryTitle}>
            {state.status === 'invalid'
              ? errorList.length === 1
                ? 'There is 1 thing to fix'
                : `There are ${errorList.length} things to fix`
              : state.status === 'ineligible'
                ? 'We can’t take this request in your state'
                : state.unconfirmed
                  ? 'Receipt unconfirmed'
                  : `We couldn’t finish sending your ${noun}`}
          </h2>
          {state.status === 'invalid' ? (
            <ul className={styles.summaryList}>
              {errorList.map((name) => (
                <li key={name}>
                  <a href={`#${FIELD_IDS[name]}`}>{errors[name]}</a>
                </li>
              ))}
            </ul>
          ) : (
            <p>{state.message}</p>
          )}
        </div>
      ) : null}

      <p id="inquiry-required-note" className="fine-print">
        Every question is required unless it says otherwise.
      </p>

      <input type="hidden" name="idempotencyKey" value={state.idempotencyKey} />
      <input type="hidden" name="formToken" value={state.formToken} />

      {/* Honeypot: hidden from people and assistive tech; bots fill it in. */}
      <div className={styles.trap} aria-hidden="true">
        <label htmlFor="inquiry-company-website">Company website</label>
        <input id="inquiry-company-website" type="text" name="company_website" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="inquiry-name">
          Full name
        </label>
        {errors.fullName ? (
          <p className="field__error" id="inquiry-name-error">
            <span className="visually-hidden">Error:</span> {errors.fullName}
          </p>
        ) : null}
        <input
          id="inquiry-name"
          className="input"
          name="fullName"
          type="text"
          autoComplete="name"
          maxLength={LIMITS.fullName + 20}
          defaultValue={values.fullName}
          required
          aria-invalid={errors.fullName ? true : undefined}
          aria-describedby={describedBy(errors.fullName && 'inquiry-name-error')}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="inquiry-email">
          Email address
        </label>
        <p className="field__hint" id="inquiry-email-hint">
          We use it to match your {noun} if you send this form again. We contact you only the way you choose below.
        </p>
        {errors.email ? (
          <p className="field__error" id="inquiry-email-error">
            <span className="visually-hidden">Error:</span> {errors.email}
          </p>
        ) : null}
        <input
          id="inquiry-email"
          className="input"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          autoCapitalize="none"
          maxLength={LIMITS.email}
          defaultValue={values.email}
          required
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={describedBy('inquiry-email-hint', errors.email && 'inquiry-email-error')}
        />
      </div>

      <div className={`field ${styles.short}`}>
        <label className="field__label" htmlFor="inquiry-zip">
          ZIP code
        </label>
        <p className="field__hint" id="inquiry-zip-hint">
          {kind === 'coverage' ? 'Coverage options depend on where you live.' : 'Licensing rules depend on the state you live in.'}
        </p>
        {errors.zip ? (
          <p className="field__error" id="inquiry-zip-error">
            <span className="visually-hidden">Error:</span> {errors.zip}
          </p>
        ) : null}
        <input
          id="inquiry-zip"
          className="input"
          name="zip"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={10}
          defaultValue={values.zip}
          required
          aria-invalid={errors.zip ? true : undefined}
          aria-describedby={describedBy('inquiry-zip-hint', errors.zip && 'inquiry-zip-error')}
        />
      </div>

      <div className={`field ${styles.short}`}>
        <label className="field__label" htmlFor="inquiry-state">
          State
        </label>
        {errors.state ? (
          <p className="field__error" id="inquiry-state-error">
            <span className="visually-hidden">Error:</span> {errors.state}
          </p>
        ) : null}
        <select
          id="inquiry-state"
          className="select"
          name="state"
          autoComplete="address-level1"
          defaultValue={values.state}
          required
          aria-invalid={errors.state ? true : undefined}
          aria-describedby={errors.state ? 'inquiry-state-error' : undefined}
        >
          <option value="">Choose a state</option>
          {Object.entries(US_STATES).map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </div>

      {kind === 'coverage' ? (
        <fieldset aria-describedby={errors.coverageInterest ? 'inquiry-interest-error' : undefined}>
          <legend className="fieldset__legend">What would you like help with?</legend>
          {errors.coverageInterest ? (
            <p className="field__error" id="inquiry-interest-error">
              <span className="visually-hidden">Error:</span> {errors.coverageInterest}
            </p>
          ) : null}
          {COVERAGE_INTERESTS.map((value) => (
            <label key={value} className="choice" data-invalid={errors.coverageInterest ? 'true' : undefined}>
              <input
                id={`inquiry-interest-${value}`}
                type="radio"
                name="coverageInterest"
                value={value}
                defaultChecked={values.coverageInterest === value}
                required
              />
              <span>{COVERAGE_INTEREST_LABELS[value]}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <fieldset aria-describedby={errors.licensingStatus ? 'inquiry-licensing-error' : undefined}>
          <legend className="fieldset__legend">Where are you with insurance licensing?</legend>
          {errors.licensingStatus ? (
            <p className="field__error" id="inquiry-licensing-error">
              <span className="visually-hidden">Error:</span> {errors.licensingStatus}
            </p>
          ) : null}
          {LICENSING_STATUSES.map((value) => (
            <label key={value} className="choice" data-invalid={errors.licensingStatus ? 'true' : undefined}>
              <input
                id={`inquiry-licensing-${value}`}
                type="radio"
                name="licensingStatus"
                value={value}
                defaultChecked={values.licensingStatus === value}
                required
              />
              <span>{LICENSING_STATUS_LABELS[value]}</span>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset
        className={styles.contact}
        aria-describedby={describedBy('inquiry-contact-hint', errors.contactMethod && 'inquiry-contact-error')}
      >
        <legend className="fieldset__legend">How should we reach you?</legend>
        <p className="field__hint" id="inquiry-contact-hint">
          A person on our team will contact you this way.
        </p>
        {errors.contactMethod ? (
          <p className="field__error" id="inquiry-contact-error">
            <span className="visually-hidden">Error:</span> {errors.contactMethod}
          </p>
        ) : null}
        {CONTACT_METHODS.map((value) => (
          <label key={value} className="choice" data-invalid={errors.contactMethod ? 'true' : undefined}>
            <input
              id={`inquiry-contact-method-${value}`}
              type="radio"
              name="contactMethod"
              value={value}
              defaultChecked={values.contactMethod === value}
              required
            />
            <span>{CONTACT_METHOD_LABELS[value]}</span>
          </label>
        ))}

        {/* Shown when "Phone call" or "Text message" is selected (CSS :has),
            and always shown in browsers without :has, so it is never lost. */}
        <div className={`field ${styles.phone}`} data-required={phoneRequired ? 'true' : undefined}>
          <label className="field__label" htmlFor="inquiry-phone">
            Phone number <span className="field__optional">(needed for a call or text)</span>
          </label>
          <p className="field__hint" id="inquiry-phone-hint">
            US numbers only, for example (312) 555-0142.
          </p>
          {errors.phone ? (
            <p className="field__error" id="inquiry-phone-error">
              <span className="visually-hidden">Error:</span> {errors.phone}
            </p>
          ) : null}
          <input
            id="inquiry-phone"
            className="input"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            maxLength={20}
            defaultValue={values.phone}
            aria-invalid={errors.phone ? true : undefined}
            aria-describedby={describedBy('inquiry-phone-hint', errors.phone && 'inquiry-phone-error')}
          />
        </div>
      </fieldset>

      {disclosureAckText ? (
        <div className={styles.consent}>
          {errors.disclosureAck ? (
            <p className="field__error" id="inquiry-disclosure-error">
              <span className="visually-hidden">Error:</span> {errors.disclosureAck}
            </p>
          ) : null}
          <label className="choice choice--plain">
            <input
              id="inquiry-disclosure-ack"
              type="checkbox"
              name="disclosureAck"
              value="yes"
              defaultChecked={values.disclosureAck}
              required
              aria-invalid={errors.disclosureAck ? true : undefined}
              aria-describedby={errors.disclosureAck ? 'inquiry-disclosure-error' : undefined}
            />
            <span>
              {disclosureAckText.lead}
              <span className={styles.ackPoints}>
                {disclosureAckText.points.map((point) => (
                  <span key={point} className={styles.ackPoint}>
                    {point}
                  </span>
                ))}
              </span>
            </span>
          </label>
        </div>
      ) : null}

      <div className={styles.consent}>
        {errors.consent ? (
          <p className="field__error" id="inquiry-consent-error">
            <span className="visually-hidden">Error:</span> {errors.consent}
          </p>
        ) : null}
        <label className="choice choice--plain">
          <input
            id="inquiry-consent"
            type="checkbox"
            name="consent"
            value="yes"
            defaultChecked={values.consent}
            required
            aria-invalid={errors.consent ? true : undefined}
            aria-describedby={describedBy('inquiry-privacy-note', errors.consent && 'inquiry-consent-error')}
          />
          <span>{consentText}</span>
        </label>
        <p id="inquiry-privacy-note" className="fine-print">
          We never ask for Social Security numbers, medical history or payment details here. See how we
          use and protect what you send in our <Link href="/privacy">privacy policy</Link>.
        </p>
      </div>

      <div className={styles.submitRow}>
        <button type="submit" className="btn btn--primary" disabled={pending} aria-disabled={pending}>
          {pending ? 'Sending…' : kind === 'coverage' ? 'Send my request' : 'Send my team inquiry'}
        </button>
        <p className={styles.live} aria-live="polite">
          {pending ? `Sending your ${noun}…` : ''}
        </p>
      </div>
    </form>
  );
}
