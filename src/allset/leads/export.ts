/**
 * Owner-only CSV export.
 *
 * Restricted three ways: only owners, at most a few exports an hour, and each
 * export is audited (who, when, how many rows, which filters — never the
 * contents). Cells are neutralized against spreadsheet formula injection: a
 * name like `=HYPERLINK(...)` typed into a public form must not become a live
 * formula on an owner's laptop.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { recordAudit } from '@/allset/audit';
import { hit, LIMITS } from '@/allset/ratelimit';
import { can, PermissionError, type Actor } from '@/allset/auth/roles';
import { COVERAGE_INTEREST_LABELS, LICENSING_STATUS_LABELS, type CoverageInterest, type LicensingStatus } from '@/allset/inquiries/fields';
import { listLeads, STATUS_LABELS, type LeadFilters, type LeadRow } from './repo';

export const EXPORT_MAX_ROWS = 5000;

export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralize anything a spreadsheet would evaluate.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const HEADER = [
  'Reference',
  'Kind',
  'Status',
  'Received',
  'Name',
  'Email',
  'Phone',
  'ZIP',
  'Contact by',
  'Interest or licensing',
  'Assigned to',
  'Follow up on',
  'Submissions',
];

function row(lead: LeadRow): string {
  const qualifier = lead.coverageInterest
    ? COVERAGE_INTEREST_LABELS[lead.coverageInterest as CoverageInterest]
    : lead.licensingStatus
      ? LICENSING_STATUS_LABELS[lead.licensingStatus as LicensingStatus]
      : '';
  return [
    lead.latestReference,
    lead.kind,
    STATUS_LABELS[lead.status],
    lead.createdAt.toISOString(),
    lead.fullName,
    lead.email,
    lead.phoneE164,
    lead.zip,
    lead.contactMethod,
    qualifier,
    lead.assignedName,
    lead.followUpOn,
    lead.submissionCount,
  ]
    .map(csvCell)
    .join(',');
}

export type ExportResult =
  | { readonly ok: true; readonly csv: string; readonly count: number }
  | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number };

export async function exportLeads(sql: Sql, actor: Actor, filters: LeadFilters): Promise<ExportResult> {
  if (!can(actor, 'lead.export')) throw new PermissionError('Only an owner can export leads.');
  const limit = await hit(sql, LIMITS.exportPerStaff, actor.id);
  if (!limit.allowed) return { ok: false, reason: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };

  const lines = [HEADER.map(csvCell).join(',')];
  let count = 0;
  for (let page = 1; count < EXPORT_MAX_ROWS; page += 1) {
    const result = await listLeads(sql, actor, { ...filters, page });
    for (const lead of result.rows) {
      if (count >= EXPORT_MAX_ROWS) break;
      lines.push(row(lead));
      count += 1;
    }
    if (page >= result.pages) break;
  }

  await recordAudit(sql, {
    actor: { id: actor.id, label: `${actor.displayName} (${actor.role})` },
    action: 'lead.exported',
    entityType: 'export',
    details: {
      rows: count,
      status_filter: filters.status ?? 'open',
      kind_filter: filters.kind ?? 'all',
      searched: Boolean(filters.q?.trim()),
    },
  });
  // Byte-order mark so spreadsheet apps read UTF-8 names correctly.
  return { ok: true, csv: `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`, count };
}
