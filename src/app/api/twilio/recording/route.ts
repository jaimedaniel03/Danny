/**
 * Recording-ready callback.
 *
 * Stores the recording URI against the call and starts the tonality pipeline.
 *
 * Retention is set here rather than by a global policy, because it is not
 * global: CMS requires Medicare call recordings be kept TEN YEARS, and a
 * generic "delete after 2 years" job that eats them is a compliance incident
 * discovered during an audit. `purge_after` is written per call.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { verifyTwilioRequest, acknowledged } from '../_verify';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const verified = await verifyTwilioRequest(request);
  if (!verified.ok) return verified.response;

  const { params } = verified.webhook;
  const callRecordId = new URL(request.url).searchParams.get('call');
  const recordingUrl = params['RecordingUrl'];
  const status = params['RecordingStatus'];

  if (status !== 'completed' || !recordingUrl) return acknowledged();

  try {
    const { recordCallRecording } = await import('@/db/calls');
    await recordCallRecording({
      callRecordId,
      providerSid: params['CallSid'] ?? null,
      recordingUri: recordingUrl,
      recordingSid: params['RecordingSid'] ?? null,
      durationSeconds: params['RecordingDuration']
        ? Number.parseInt(params['RecordingDuration'], 10)
        : null,
    });
  } catch (err) {
    console.error('[twilio/recording] failed to record', err);
  }

  return acknowledged();
}
