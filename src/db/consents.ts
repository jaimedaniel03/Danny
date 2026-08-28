/**
 * Consent ledger writes.
 *
 * The `consents` table is append-only, enforced by a database trigger
 * (`consents_immutable` in supabase/migrations/0001_init.sql). This module is
 * the only place that writes it, and it deliberately exposes no update or
 * delete — revocation is its own function with its own name, because "update a
 * consent record" should not be an expressible operation.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface ConsentWrite {
  readonly agencyId: string;
  readonly contactId: string;
  readonly phoneE164: string;
  readonly basis: 'prior_express_written' | 'inbound_call' | 'inbound_web_request';
  readonly disclosureText: string;
  readonly disclosureVersion: string;
  readonly sourceUri: string;
  readonly capturedAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly scopedLines: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
}

let cached: SupabaseClient | null = null;

/**
 * Service-role client. Consent writes bypass RLS deliberately: the submitter is
 * an unauthenticated consumer following a link, not a tenant user, so the
 * tenant scope comes from the signed token instead. Never expose this client to
 * anything that takes a client-supplied agency id.
 */
function serviceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }

  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export async function recordConsent(input: ConsentWrite): Promise<{ id: string }> {
  const supabase = serviceClient();

  // Idempotency: a double-tap on a phone should not create two rows. The token
  // nonce is unique per issued link, so it identifies the submission.
  const nonce = (input.evidence as { tokenNonce?: string }).tokenNonce;
  if (nonce) {
    const { data: existing } = await supabase
      .from('consents')
      .select('id')
      .eq('phone_e164', input.phoneE164)
      .eq('evidence->>tokenNonce', nonce)
      .maybeSingle();
    if (existing) return { id: (existing as { id: string }).id };
  }

  const { data, error } = await supabase
    .from('consents')
    .insert({
      agency_id: input.agencyId,
      contact_id: input.contactId,
      phone_e164: input.phoneE164,
      basis: input.basis,
      disclosure_text: input.disclosureText,
      disclosure_version: input.disclosureVersion,
      source_uri: input.sourceUri,
      captured_at: input.capturedAt,
      ip_address: input.ipAddress,
      user_agent: input.userAgent,
      scoped_lines: input.scopedLines,
      evidence: input.evidence,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Consent write failed: ${error.message}`);
  return { id: (data as { id: string }).id };
}

/**
 * Revoke consent. The only permitted mutation on the ledger, and it is one-way
 * — the trigger rejects any attempt to un-revoke.
 *
 * Revocation is by NUMBER, not by contact: someone saying "stop calling me"
 * revokes for that phone regardless of how many contact rows reference it.
 */
export async function revokeConsent(input: {
  readonly phoneE164: string;
  readonly reason: string;
  readonly at?: Date;
}): Promise<{ revoked: number }> {
  const supabase = serviceClient();
  const at = (input.at ?? new Date()).toISOString();

  const { data, error } = await supabase
    .from('consents')
    .update({ revoked_at: at, revoked_reason: input.reason })
    .eq('phone_e164', input.phoneE164)
    .is('revoked_at', null)
    .select('id');

  if (error) throw new Error(`Consent revocation failed: ${error.message}`);
  return { revoked: data?.length ?? 0 };
}

/**
 * Suppress a number permanently. Called the instant a DNC request is heard on
 * a call — before the agent finishes its acknowledgement sentence.
 *
 * Does two things, and both matter: revokes consent, and sets the internal DNC
 * flag. The second is what no exemption can override.
 */
export async function suppressNumber(input: {
  readonly phoneE164: string;
  readonly reason: string;
}): Promise<void> {
  const supabase = serviceClient();
  const now = new Date().toISOString();

  await revokeConsent({ phoneE164: input.phoneE164, reason: input.reason });

  const { error } = await supabase
    .from('contacts')
    .update({ internal_dnc_at: now, internal_dnc_reason: input.reason })
    .eq('phone_e164', input.phoneE164)
    .is('internal_dnc_at', null);

  if (error) throw new Error(`Suppression failed: ${error.message}`);
}
