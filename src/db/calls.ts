/**
 * Call record writes.
 *
 * Every function here is called from a Twilio webhook, so every one of them is
 * idempotent: Twilio retries on any non-2xx and occasionally delivers the same
 * event twice on its own. A handler that double-counts a call, or throws on the
 * second delivery, produces a retry storm and a corrupted ledger.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { MEDICARE_LINES, type CallDisposition, type LineOfBusiness } from '@/types';

let cached: SupabaseClient | null = null;

function serviceClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  cached = createClient(url, key, { auth: { persistSession: false } });
  return cached;
}

/**
 * Recording retention, in days, by line of business.
 *
 * CMS requires Medicare marketing call recordings be retained TEN YEARS. This
 * is written per call rather than applied by a global policy precisely so a
 * generic cleanup job cannot delete them — which is the kind of thing nobody
 * notices until an audit asks for a call from 2027.
 */
export function retentionDaysFor(line: LineOfBusiness): number {
  if (MEDICARE_LINES.has(line)) return 3653; // 10 years, leap-adjusted
  // TCPA's statute of limitations is 4 years; match it so a recording outlives
  // any claim it could rebut.
  return 1461;
}

export async function recordCallStatus(input: {
  readonly callRecordId: string | null;
  readonly providerSid: string | null;
  readonly status: string;
  readonly durationSeconds: number | null;
  readonly priceUsd: number | null;
}): Promise<void> {
  if (!input.providerSid) return;

  const update: Record<string, unknown> = {
    ended_at: new Date().toISOString(),
    final_state: input.status,
  };
  if (input.durationSeconds !== null) update['duration_seconds'] = input.durationSeconds;
  if (input.priceUsd !== null) {
    update['telephony_cost_cents'] = Math.round(Math.abs(input.priceUsd) * 100);
  }

  // Map Twilio's terminal statuses onto our disposition vocabulary, but only
  // where the call never reached a conversation. A connected call's disposition
  // is decided by the state machine and must not be overwritten here.
  const noConversation: Record<string, CallDisposition> = {
    busy: 'busy',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'failed',
  };
  const disposition = noConversation[input.status];
  if (disposition) update['disposition'] = disposition;

  const { error } = await serviceClient()
    .from('calls')
    .update(update)
    .eq('provider_sid', input.providerSid)
    // Idempotency: a retried webhook must not reopen a call already finalized.
    .is('ended_at', null);

  if (error) throw new Error(`Call status write failed: ${error.message}`);
}

export async function recordCallRecording(input: {
  readonly callRecordId: string | null;
  readonly providerSid: string | null;
  readonly recordingUri: string;
  readonly recordingSid: string | null;
  readonly durationSeconds: number | null;
}): Promise<void> {
  if (!input.providerSid) return;
  const supabase = serviceClient();

  const { data, error: readError } = await supabase
    .from('calls')
    .select('id, line_of_business, recording_uri')
    .eq('provider_sid', input.providerSid)
    .maybeSingle();

  if (readError) throw new Error(`Call lookup failed: ${readError.message}`);
  if (!data) return;

  const row = data;
  if (row.recording_uri) return; // already recorded; retried webhook

  const { error } = await supabase
    .from('calls')
    .update({ recording_uri: input.recordingUri })
    .eq('id', row.id);

  if (error) throw new Error(`Recording write failed: ${error.message}`);

  // Stamp the retention clock now, while the line of business is in hand.
  const purgeAfter = new Date();
  purgeAfter.setDate(purgeAfter.getDate() + retentionDaysFor(row.line_of_business));

  await supabase
    .from('transcripts')
    .update({ purge_after: purgeAfter.toISOString() })
    .eq('call_id', row.id);
}

/** Written by the media server when a call ends with a real disposition. */
export async function recordCallOutcome(input: {
  readonly providerSid: string;
  readonly disposition: CallDisposition;
  readonly finalState: string;
  readonly durationSeconds: number;
  readonly aiDisclosedAt: Date | null;
}): Promise<void> {
  const { error } = await serviceClient()
    .from('calls')
    .update({
      disposition: input.disposition,
      final_state: input.finalState,
      duration_seconds: input.durationSeconds,
      ended_at: new Date().toISOString(),
      ai_disclosed_at: input.aiDisclosedAt?.toISOString() ?? null,
    })
    .eq('provider_sid', input.providerSid);

  if (error) throw new Error(`Call outcome write failed: ${error.message}`);
}
