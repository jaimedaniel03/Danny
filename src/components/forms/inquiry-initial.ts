import 'server-only';
import type { InquiryKind } from '@/allset/inquiries/consent';
import { issueFormToken } from '@/allset/inquiries/form-token';
import type { InquiryState } from '@/allset/inquiries/state';

/**
 * Fresh state for a newly rendered form: a new idempotency key and a new
 * signed timestamp. Pages that render a form must be dynamic, or every
 * visitor would share one key.
 */
export function initialInquiryState(kind: InquiryKind): InquiryState {
  return {
    kind,
    idempotencyKey: crypto.randomUUID(),
    formToken: issueFormToken(kind),
    attempt: 0,
    status: 'idle',
  };
}
