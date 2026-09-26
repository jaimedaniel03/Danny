import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/allset/auth/session-cookie';
import { can } from '@/allset/auth/roles';
import { db } from '@/allset/db/client';
import { listAssignable } from '@/allset/auth/accounts';
import { LEAD_STATUSES, STATUS_LABELS, businessToday, listLeads, type LeadFilters } from '@/allset/leads/repo';
import { formatDate, formatDateTime, statusLabel, statusTagClass } from '@/components/admin/format';
import { COVERAGE_INTEREST_LABELS, type CoverageInterest } from '@/allset/inquiries/fields';

export const metadata: Metadata = { title: 'Leads' };

type Params = Record<string, string | undefined>;

interface Props {
  readonly searchParams: Promise<Params>;
}

function filtersFrom(params: Params): LeadFilters {
  const kind = params['kind'] === 'coverage' || params['kind'] === 'team' ? params['kind'] : undefined;
  const due = params['due'] === 'overdue' || params['due'] === 'today' || params['due'] === 'week' ? params['due'] : undefined;
  return {
    q: params['q']?.slice(0, 100),
    status: params['status']?.slice(0, 40),
    kind,
    assigned: params['assigned']?.slice(0, 64),
    due,
    page: Number(params['page'] ?? '1') || 1,
  };
}

function query(params: Params, overrides: Params): string {
  const merged = { ...params, ...overrides };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
}

export default async function LeadsPage({ searchParams }: Props) {
  const actor = await requireActor('/admin/leads');
  const params = await searchParams;
  const filters = filtersFrom(params);
  const sql = db();
  const result = await listLeads(sql, actor, filters);
  const owner = can(actor, 'lead.viewAll');
  const team = owner ? await listAssignable(sql) : [];
  const today = businessToday();

  return (
    <>
      <h1 className="admin-title">Leads</h1>
      {params['deleted'] ? (
        <p className="notice notice--success" role="status">
          Lead {params['deleted']} and its records were permanently deleted.
        </p>
      ) : null}
      {!owner ? (
        <p className="admin-sub">You see requests assigned to you and requests nobody has claimed yet.</p>
      ) : null}

      <form method="get" className="panel filters" role="search" aria-label="Filter leads">
        <div className="field">
          <label className="field__label" htmlFor="f-q">
            Search
          </label>
          <input id="f-q" name="q" className="input" defaultValue={filters.q ?? ''} placeholder="Name, email, ZIP, phone or reference" />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="f-status">
            Status
          </label>
          <select id="f-status" name="status" className="select" defaultValue={filters.status ?? 'open'}>
            <option value="open">All open</option>
            <option value="closed">All closed</option>
            <option value="all">Everything</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="f-kind">
            Kind
          </label>
          <select id="f-kind" name="kind" className="select" defaultValue={filters.kind ?? ''}>
            <option value="">Coverage and team</option>
            <option value="coverage">Coverage</option>
            <option value="team">Team</option>
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="f-assigned">
            Assigned
          </label>
          <select id="f-assigned" name="assigned" className="select" defaultValue={filters.assigned ?? 'any'}>
            <option value="any">Anyone</option>
            <option value="me">Me</option>
            <option value="unassigned">Unassigned</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor="f-due">
            Follow-up
          </label>
          <select id="f-due" name="due" className="select" defaultValue={filters.due ?? ''}>
            <option value="">Any time</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="week">Due within a week</option>
          </select>
        </div>
        <div className="inline-form">
          <button type="submit" className="btn btn--primary">
            Apply
          </button>
          <Link href="/admin/leads" className="btn btn--quiet">
            Reset
          </Link>
        </div>
      </form>

      <div className="pager">
        <p aria-live="polite">
          {result.total === 0 ? 'No leads match.' : `${result.total} lead${result.total === 1 ? '' : 's'} · page ${result.page} of ${result.pages}`}
        </p>
        {can(actor, 'lead.export') ? (
          <form method="post" action="/api/admin/export">
            {Object.entries({ q: filters.q, status: filters.status, kind: filters.kind, assigned: filters.assigned, due: filters.due }).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null,
            )}
            <button type="submit" className="btn btn--secondary">
              Export these as CSV
            </button>
          </form>
        ) : null}
      </div>

      {result.rows.length > 0 ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Leads matching the filters</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Assigned</th>
                <th scope="col">Follow up</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((lead) => (
                <tr key={lead.id}>
                  <td data-label="Name">
                    <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
                    <br />
                    <span className="muted">{lead.latestReference}</span>
                    {lead.submissionCount > 1 ? <span className="muted"> · sent {lead.submissionCount}×</span> : null}
                  </td>
                  <td data-label="Kind">
                    {lead.kind === 'coverage'
                      ? `Coverage · ${lead.coverageInterest ? COVERAGE_INTEREST_LABELS[lead.coverageInterest as CoverageInterest] : ''}`
                      : 'Team'}
                  </td>
                  <td data-label="Status">
                    <span className={statusTagClass(lead.status)}>{statusLabel(lead.status)}</span>
                  </td>
                  <td data-label="Assigned">{lead.assignedName ?? <span className="muted">Unassigned</span>}</td>
                  <td data-label="Follow up">
                    {lead.followUpOn ? (
                      <span className={lead.followUpOn < today ? 'tag tag--overdue' : undefined}>
                        {formatDate(lead.followUpOn)}
                        {lead.followUpOn < today ? ' · overdue' : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="Received">{formatDateTime(lead.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {result.pages > 1 ? (
        <nav className="pager" aria-label="Pages">
          {result.page > 1 ? (
            <Link className="btn btn--secondary" href={`/admin/leads${query(params, { page: String(result.page - 1) })}`}>
              Previous page
            </Link>
          ) : (
            <span />
          )}
          {result.page < result.pages ? (
            <Link className="btn btn--secondary" href={`/admin/leads${query(params, { page: String(result.page + 1) })}`}>
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
