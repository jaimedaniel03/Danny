/**
 * Dial authorization audit writes.
 *
 * `dial_authorizations` is an evidence table: migration 0001 puts an
 * immutability trigger on it that rejects UPDATE and DELETE outright. There is
 * no correction path by design — an audit row you can edit is not evidence.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LineOfBusiness } from '@/types';

let cached: SupabaseClient | null = null;

function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export interface AuthorizationWrite {
  readonly callRecordId: string;
  readonly agencyId: string;
  readonly contactId: string;
  readonly consentId: string | null;
  readonly line: LineOfBusiness;
  readonly granted: boolean;
  readonly failureCodes: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly requiredDisclosure: string | null;
}

export async function recordDialAuthorization(input: AuthorizationWrite): Promise<void> {
  const { error } = await serviceClient().from('dial_authorizations').insert({
    id: input.callRecordId,
    agency_id: input.agencyId,
    contact_id: input.contactId,
    consent_id: input.consentId,
    line_of_business: input.line,
    granted: input.granted,
    failure_codes: input.failureCodes,
    evidence: input.evidence,
    gate_version: (input.evidence as { gateVersion?: string }).gateVersion ?? 'unknown',
    issued_at: input.issuedAt.toISOString(),
    expires_at: input.expiresAt.toISOString(),
    required_disclosure: input.requiredDisclosure,
  });

  if (error) throw new Error(`Authorization audit write failed: ${error.message}`);
}

/**
 * Record a REFUSED gate evaluation.
 *
 * Worth storing as much as the grants. "We evaluated this contact and refused,
 * here is why" is a far stronger position than silence, and the refusal counts
 * are also how you notice a misconfigured profile blocking your whole book.
 */
export async function recordRefusal(input: {
  readonly agencyId: string;
  readonly contactId: string;
  readonly line: LineOfBusiness;
  readonly failureCodes: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly at: Date;
}): Promise<void> {
  const { error } = await serviceClient().from('dial_authorizations').insert({
    agency_id: input.agencyId,
    contact_id: input.contactId,
    line_of_business: input.line,
    granted: false,
    failure_codes: input.failureCodes,
    evidence: input.evidence,
    gate_version: (input.evidence as { gateVersion?: string }).gateVersion ?? 'unknown',
    issued_at: input.at.toISOString(),
    expires_at: input.at.toISOString(),
  });

  if (error) throw new Error(`Refusal audit write failed: ${error.message}`);
}
