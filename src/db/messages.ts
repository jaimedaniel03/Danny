/**
 * Message log writes.
 *
 * Every outbound message carries the authorization evidence that permitted it —
 * enforced by a CHECK constraint in migration 0002, so an unaudited send cannot
 * be persisted even if the application layer is wrong.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Channel, MessageIntent } from '@/channels/types';

let cached: SupabaseClient | null = null;

function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export async function recordOutboundMessage(input: {
  readonly agencyId: string;
  readonly contactId: string | null;
  readonly channel: Channel;
  readonly intent: MessageIntent;
  readonly destination: string;
  readonly providerId: string | null;
  readonly subject: string | null;
  readonly body: string;
  readonly footer: string | null;
  readonly authorizationEvidence: Readonly<Record<string, unknown>>;
  readonly segments?: number;
  readonly encoding?: string;
}): Promise<void> {
  const { error } = await serviceClient().from('messages').insert({
    agency_id: input.agencyId,
    contact_id: input.contactId,
    channel: input.channel,
    direction: 'outbound',
    intent: input.intent,
    destination: input.destination,
    provider_id: input.providerId,
    subject: input.subject,
    body: input.body,
    footer: input.footer,
    authorization_evidence: input.authorizationEvidence,
    segments: input.segments ?? null,
    encoding: input.encoding ?? null,
    sent_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Message log write failed: ${error.message}`);
}

/**
 * Record an inbound message. Note what this does NOT do: it does not create or
 * upgrade consent. Replying to a text is not a signature, so an inbound message
 * routes to a human producer rather than unlocking the AI channels.
 */
export async function recordInboundMessage(input: {
  readonly phoneE164: string;
  readonly channel: Channel;
  readonly body: string;
  readonly providerSid: string | null;
}): Promise<void> {
  const { error } = await serviceClient().from('messages').insert({
    channel: input.channel,
    direction: 'inbound',
    destination: input.phoneE164,
    provider_id: input.providerSid,
    body: input.body,
  });
  if (error) throw new Error(`Inbound message log failed: ${error.message}`);
}

/**
 * Delivery status for an outbound message.
 *
 * `carrierFiltered` is the field worth watching. It marks the silent A2P 10DLC
 * failure — the message reports as sent, the carrier drops it, and nothing
 * arrives. Without a column recording it, the only symptom is that replies stop.
 */
export async function recordMessageStatus(input: {
  readonly providerId: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  readonly carrierFiltered: boolean;
}): Promise<void> {
  if (!input.providerId) return;

  const update: Record<string, unknown> = {};
  if (input.status === 'delivered') update['delivered_at'] = new Date().toISOString();
  if (input.status === 'failed' || input.status === 'undelivered') {
    update['failed_at'] = new Date().toISOString();
    update['failure_reason'] = input.carrierFiltered
      ? `Carrier filtered (Twilio error ${input.errorCode}). Check A2P 10DLC registration.`
      : `${input.status}${input.errorCode ? ` (error ${input.errorCode})` : ''}`;
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await serviceClient()
    .from('messages')
    .update(update)
    .eq('provider_id', input.providerId);

  if (error) throw new Error(`Message status write failed: ${error.message}`);
}
