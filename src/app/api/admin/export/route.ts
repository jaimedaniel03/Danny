/**
 * CSV export of leads, owners only. POST (not GET) so a link or image tag on
 * another site can't trigger an export in an owner's browser, and the Origin
 * must be this site.
 */

import { NextResponse } from 'next/server';
import { verifiedActor } from '@/allset/auth/session-cookie';
import { can, PermissionError } from '@/allset/auth/roles';
import { db } from '@/allset/db/client';
import { exportLeads } from '@/allset/leads/export';
import { isSameOrigin, NO_STORE } from '@/allset/http';
import { log } from '@/allset/log';
import { businessToday } from '@/allset/leads/repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === 'string' && value ? value.slice(0, 100) : undefined;
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return new NextResponse('Cross-site export refused.', { status: 403, headers: NO_STORE });
  }
  // Both sign-in steps done; a half-finished session can't export.
  const actor = await verifiedActor();
  if (!actor) return new NextResponse('Sign in to export.', { status: 401, headers: NO_STORE });
  if (!can(actor, 'lead.export')) return new NextResponse('Only an owner can export leads.', { status: 403, headers: NO_STORE });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new NextResponse('Bad request.', { status: 400, headers: NO_STORE });
  }
  const kind = field(form, 'kind');
  const due = field(form, 'due');

  try {
    const result = await exportLeads(db(), actor, {
      q: field(form, 'q'),
      status: field(form, 'status'),
      kind: kind === 'coverage' || kind === 'team' ? kind : undefined,
      assigned: field(form, 'assigned'),
      due: due === 'overdue' || due === 'today' || due === 'week' ? due : undefined,
    });
    if (!result.ok) {
      return new NextResponse(
        `Export limit reached. Try again in about ${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(result.retryAfterSeconds) } },
      );
    }
    return new NextResponse(result.csv, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="all-set-check-leads-${businessToday()}.csv"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof PermissionError) return new NextResponse(error.message, { status: 403, headers: NO_STORE });
    log.error('admin.export_failed', error);
    return new NextResponse('Export failed. Nothing was downloaded.', { status: 500, headers: NO_STORE });
  }
}
