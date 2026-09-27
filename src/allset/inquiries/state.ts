/**
 * The state an inquiry form renders from. Shared by the server action (which
 * returns it) and the client form (which displays it), so it is plain data.
 */

import type { ContactMethod, FieldErrors, InquiryValues } from './fields';
import type { InquiryKind } from './consent';

interface Base {
  readonly kind: InquiryKind;
  /** Same key until a submission succeeds, so a retry cannot duplicate. */
  readonly idempotencyKey: string;
  readonly formToken: string;
  /** Bumped on every response; remounts inputs with the returned values. */
  readonly attempt: number;
  /** A staff-only test run before launch: made-up details only, stored as synthetic. */
  readonly preview: boolean;
}

export type InquiryState =
  | (Base & { readonly status: 'idle' })
  /** The site isn't taking inquiries yet (see src/allset/inquiries/gate.ts). */
  | (Base & { readonly status: 'closed' })
  | (Base & { readonly status: 'invalid'; readonly errors: FieldErrors; readonly values: InquiryValues })
  /** We can't take this request where the person lives; nothing was saved. */
  | (Base & { readonly status: 'ineligible'; readonly message: string; readonly values: InquiryValues })
  | (Base & {
      readonly status: 'error';
      readonly message: string;
      readonly values: InquiryValues;
      /** No answer came back (timeout or lost connection): it may or may not have arrived. */
      readonly unconfirmed?: true;
    })
  | (Base & {
      readonly status: 'success';
      readonly reference: string;
      readonly contactMethod: ContactMethod;
    });
