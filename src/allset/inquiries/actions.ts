'use server';

/**
 * Server actions behind the two inquiry forms. They work with or without
 * JavaScript: a plain form POST runs the same function and the page renders
 * the returned state.
 */

import { after } from 'next/server';
import { db } from '@/allset/db/client';
import { log } from '@/allset/log';
import { requestContext } from '@/allset/request';
import { deliverPending } from '@/allset/notifications/outbox';
import { newReference } from '@/allset/crypto';
import type { InquiryKind } from './consent';
import { readValues, validateInquiry } from './fields';
import { checkFormToken, issueFormToken } from './form-token';
import type { InquiryState } from './state';
import { isIdempotencyKey, submitInquiry } from './submit';
import { inquiriesOpen } from './gate';

const SOURCE_PATH: Record<InquiryKind, string> = { coverage: '/contact', team: '/team' };

function field(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.slice(0, max) : '';
}

async function handle(kind: InquiryKind, previous: InquiryState, form: FormData): Promise<InquiryState> {
  const values = readValues(form);
  const submittedKey = field(form, 'idempotencyKey', 64);
  const idempotencyKey = isIdempotencyKey(submittedKey) ? submittedKey : crypto.randomUUID();
  const attempt = (previous?.attempt ?? 0) + 1;
  const base = { kind, idempotencyKey, attempt };
  const noun = kind === 'coverage' ? 'request' : 'inquiry';

  // Closed before launch unless deliberately opened for a private preview.
  // Checked here, not only by hiding the form.
  if (!inquiriesOpen()) {
    return { ...base, formToken: '', status: 'closed' };
  }

  // Honeypot: a field people never see. Answer exactly as for a real success,
  // so an automated sender learns nothing; save nothing.
  if (field(form, 'company_website', 200).trim() !== '') {
    log.info('inquiry.honeypot', { kind });
    return { ...base, formToken: issueFormToken(kind), status: 'success', reference: newReference(), contactMethod: 'email' };
  }

  const submittedToken = field(form, 'formToken', 200);
  const token = checkFormToken(kind, submittedToken);
  // Keep the original render time across corrections: a person who fixes one
  // field and resubmits quickly is not a bot. Only a bad or stale token is
  // replaced.
  const formToken = token === 'ok' || token === 'too_fast' ? submittedToken : issueFormToken(kind);
  if (token === 'wording_changed') {
    log.info('inquiry.form_token_rejected', { kind, verdict: token });
    return {
      ...base,
      formToken,
      status: 'error',
      message:
        'The agreement wording on this form was updated after you opened it. Please read it again and check the box to send your ' +
        `${noun}. Your details are still here.`,
      values: { ...values, consent: false, disclosureAck: false },
    };
  }
  if (token !== 'ok') {
    log.info('inquiry.form_token_rejected', { kind, verdict: token });
    return {
      ...base,
      formToken,
      status: 'error',
      message:
        token === 'too_fast'
          ? 'That was quicker than we expected. Please check your details and send the form again.'
          : 'This form had been open a long time, so we refreshed it. Your details are still here — please send it again.',
      values,
    };
  }

  const verdict = validateInquiry(kind, values);
  if (!verdict.ok) {
    return { ...base, formToken, status: 'invalid', errors: verdict.errors, values };
  }

  try {
    const ctx = await requestContext();
    const outcome = await submitInquiry(db(), verdict.inquiry, idempotencyKey, {
      ip: ctx.ip,
      ipHash: ctx.ipHash,
      userAgent: ctx.userAgent,
      sourcePath: SOURCE_PATH[kind],
    });

    if (outcome.kind === 'rate_limited') {
      const minutes = Math.max(1, Math.ceil(outcome.retryAfterSeconds / 60));
      return {
        ...base,
        formToken,
        status: 'error',
        message: `We've received several ${noun === 'request' ? 'requests' : 'inquiries'} recently from this connection or email address. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Your details are still here.`,
        values,
      };
    }

    log.info('inquiry.accepted', { kind, replay: outcome.replay, merged: outcome.merged });
    if (!outcome.replay) {
      // Runs after the response is sent. The alerts are already saved as
      // outbox rows, so a failure here delays them; it cannot lose them.
      after(async () => {
        try {
          await deliverPending(db(), 10);
        } catch (error) {
          log.error('notification.deliver_after_inquiry_failed', error);
        }
      });
    }
    return {
      ...base,
      formToken,
      status: 'success',
      reference: outcome.reference,
      contactMethod: verdict.inquiry.contactMethod,
    };
  } catch (error) {
    log.error('inquiry.save_failed', error, { kind });
    return {
      ...base,
      formToken,
      status: 'error',
      message:
        `We couldn't save your ${noun} just now. Your details are still here — please try again in a moment. Trying again won't send it twice.`,
      values,
    };
  }
}

export async function submitCoverageInquiry(previous: InquiryState, form: FormData): Promise<InquiryState> {
  return handle('coverage', previous, form);
}

export async function submitTeamInquiry(previous: InquiryState, form: FormData): Promise<InquiryState> {
  return handle('team', previous, form);
}
