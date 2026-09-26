import 'server-only';
import type { InquiryKind } from '@/allset/inquiries/consent';
import { issueFormToken } from '@/allset/inquiries/form-token';
import { inquiriesOpen } from '@/allset/inquiries/gate';
import type { InquiryState } from '@/allset/inquiries/state';

/**
 * Fresh state for a newly rendered form: a new idempotency key and a new
 * signed timestamp. Pages that render a form must be dynamic, or every
 * visitor would share one key.
 */
export function initialInquiryState(kind: InquiryKind): InquiryState {
  const open = inquiriesOpen();
  return {
    kind,
    idempotencyKey: crypto.randomUUID(),
    // A closed form renders no fields, so there is nothing to sign.
    formToken: open ? issueFormToken(kind) : '',
    attempt: 0,
    status: open ? 'idle' : 'closed',
  };
}
