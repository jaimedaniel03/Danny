/** Daily purge per the published retention policy (src/allset/retention.ts). */

import { NextResponse } from 'next/server';
import { db } from '@/allset/db/client';
import { cronSecret } from '@/allset/env';
import { hasBearer, NO_STORE } from '@/allset/http';
import { runRetention } from '@/allset/retention';
import { log } from '@/allset/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!hasBearer(request, cronSecret())) return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  try {
    const report = await runRetention(db());
    log.info('cron.retention', { ...report });
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (error) {
    log.error('cron.retention_failed', error);
    return NextResponse.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }
}
