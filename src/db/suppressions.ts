/**
 * Channel suppression writes.
 *
 * Suppression is the one record in this system with no exemptions, no expiry,
 * and no override. Everything here is append-only in spirit: `unsuppressChannel`
 * exists only because a texted START is a legitimate re-subscribe, and it
 * records the reversal rather than deleting the original row.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Channel, ChannelSuppression } from '@/channels/types';

let cached: SupabaseClient | null = null;

function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

export type SuppressionSource = ChannelSuppression['source'];

/**
 * Suppress one or more channels for a phone number.
 *
 * Upsert rather than insert: a second STOP from someone already suppressed
 * must not error. It is also idempotent by design, because carriers retry
 * webhooks and a retry must not turn into a failure.
 */
export async function suppressChannels(input: {
  readonly phoneE164: string;
  readonly channels: readonly Channel[];
  readonly reason: string;
  readonly source: SuppressionSource;
  readonly at?: Date;
}): Promise<void> {
  const supabase = serviceClient();
  const at = (input.at ?? new Date()).toISOString();

  const rows = input.channels.map((channel) => ({
    phone_e164: input.phoneE164,
    channel,
    suppressed_at: at,
    reason: input.reason,
    source: input.source,
  }));

  const { error } = await supabase
    .from('channel_suppressions')
    .upsert(rows, { onConflict: 'phone_e164,channel', ignoreDuplicates: true });

  if (error) throw new Error(`Suppression write failed: ${error.message}`);

  // A voice-scope suppression is also an internal DNC entry. The two exist
  // separately because the gate checks them at different points, and a contact
  // suppressed for voice must fail the DNC check even if the channel table is
  // never consulted.
  if (input.channels.includes('ai_voice') || input.channels.includes('human_voice')) {
    await supabase
      .from('contacts')
      .update({ internal_dnc_at: at, internal_dnc_reason: input.reason })
      .eq('phone_e164', input.phoneE164)
      .is('internal_dnc_at', null);
  }
}

export async function suppressEmail(input: {
  readonly emailAddress: string;
  readonly contactId: string | null;
  readonly reason: string;
  readonly source: SuppressionSource;
  readonly at?: Date;
}): Promise<void> {
  const supabase = serviceClient();
  const at = (input.at ?? new Date()).toISOString();

  const { error } = await supabase.from('channel_suppressions').upsert(
    {
      // Suppression keys on the ADDRESS, not the contact. The same address may
      // appear on several contact rows, and unsubscribing one of them while
      // continuing to email the others is exactly what generates a complaint.
      email_address: input.emailAddress.toLowerCase(),
      contact_id: input.contactId,
      channel: 'email' satisfies Channel,
      suppressed_at: at,
      reason: input.reason,
      source: input.source,
    },
    { onConflict: 'email_address,channel', ignoreDuplicates: true },
  );

  if (error) throw new Error(`Email suppression failed: ${error.message}`);
}

/** Reverse a suppression. Only ever called for a texted START. */
export async function unsuppressChannel(input: {
  readonly phoneE164: string;
  readonly channel: Channel;
}): Promise<void> {
  const supabase = serviceClient();
  const { error } = await supabase
    .from('channel_suppressions')
    .delete()
    .eq('phone_e164', input.phoneE164)
    .eq('channel', input.channel);

  if (error) throw new Error(`Unsuppress failed: ${error.message}`);
}

/** Load every suppression for a contact, for the gate. */
export async function loadSuppressions(input: {
  readonly phoneE164: string | null;
  readonly emailAddress: string | null;
}): Promise<readonly ChannelSuppression[]> {
  const supabase = serviceClient();

  const filters: string[] = [];
  if (input.phoneE164) filters.push(`phone_e164.eq.${input.phoneE164}`);
  if (input.emailAddress) filters.push(`email_address.eq.${input.emailAddress.toLowerCase()}`);
  if (filters.length === 0) return [];

  const { data, error } = await supabase
    .from('channel_suppressions')
    .select('channel, suppressed_at, reason, source')
    .or(filters.join(','));

  if (error) throw new Error(`Suppression read failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const r = row as { channel: Channel; suppressed_at: string; reason: string; source: SuppressionSource };
    return {
      channel: r.channel,
      suppressedAt: new Date(r.suppressed_at),
      reason: r.reason,
      source: r.source,
    };
  });
}
