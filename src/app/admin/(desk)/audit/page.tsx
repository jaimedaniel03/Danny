import type { Metadata } from 'next';
import Link from 'next/link';
import { requireOwnerPage } from '@/allset/auth/session-cookie';
import { db } from '@/allset/db/client';
import { RETENTION } from '@/allset/retention';
import { actionLabel, detailLine, formatDateTime } from '@/components/admin/format';

export const metadata: Metadata = { title: 'Audit log' };

const PAGE = 50;

interface Props {
  readonly searchParams: Promise<{ page?: string; area?: string }>;
}

const AREAS: Record<string, string> = {
  lead: 'Leads',
  staff: 'Team accounts',
  recipient: 'Alerts',
  export: 'Exports',
};

export default async function AuditPage({ searchParams }: Props) {
  await requireOwnerPage('audit.view', '/admin/audit');
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const area = params.area && params.area in AREAS ? params.area : null;
  const sql = db();
  const rows = await sql<
    { id: string; occurred_at: Date; actor_label: string | null; action: string; entity_type: string | null; entity_id: string | null; entity_ref: string | null; details: Record<string, unknown> }[]
  >`
    select id::text, occurred_at, actor_label, action, entity_type, entity_id, entity_ref, details
    from allset.audit_events
    where ${area ? sql`entity_type = ${area}` : sql`true`}
    order by occurred_at desc
    limit ${PAGE + 1} offset ${(page - 1) * PAGE}`;
  const hasMore = rows.length > PAGE;

  return (
    <>
      <h1 className="admin-title">Audit log</h1>
      <p className="admin-sub">
        Every staff action, account change and export, append-only and kept {RETENTION.auditYears} years.
        Entries record what changed, never a person’s contact details.
      </p>
      <nav aria-label="Filter the audit log" className="inline-form">
        <Link className="btn btn--quiet" href="/admin/audit" aria-current={area === null ? 'page' : undefined}>
          Everything
        </Link>
        {Object.entries(AREAS).map(([key, label]) => (
          <Link key={key} className="btn btn--quiet" href={`/admin/audit?area=${key}`} aria-current={area === key ? 'page' : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table className="data-table">
          <caption className="visually-hidden">Audit events, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What</th>
              <th scope="col">Subject</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PAGE).map((row) => (
              <tr key={row.id}>
                <td data-label="When">{formatDateTime(row.occurred_at)}</td>
                <td data-label="Who">{row.actor_label ?? 'Website / system'}</td>
                <td data-label="What">
                  {actionLabel(row.action)} <span className="muted">{detailLine(row.action, row.details)}</span>
                </td>
                <td data-label="Subject">
                  {row.entity_type === 'lead' && row.entity_id && row.action !== 'lead.deleted' ? (
                    <Link href={`/admin/leads/${row.entity_id}`}>{row.entity_ref ?? 'Open lead'}</Link>
                  ) : (
                    (row.entity_ref ?? (row.entity_type ? AREAS[row.entity_type] ?? row.entity_type : '—'))
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Pages">
        {page > 1 ? (
          <Link className="btn btn--secondary" href={`/admin/audit?page=${page - 1}${area ? `&area=${area}` : ''}`}>
            Newer
          </Link>
        ) : (
          <span />
        )}
        {hasMore ? (
          <Link className="btn btn--secondary" href={`/admin/audit?page=${page + 1}${area ? `&area=${area}` : ''}`}>
            Older
          </Link>
        ) : null}
      </nav>
    </>
  );
}
