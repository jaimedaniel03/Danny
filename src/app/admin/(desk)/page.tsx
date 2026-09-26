import type { Metadata } from 'next';
import Link from 'next/link';
import { requireActor } from '@/allset/auth/session-cookie';
import { can } from '@/allset/auth/roles';
import { db } from '@/allset/db/client';
import { dashboardCounts, listLeads } from '@/allset/leads/repo';
import { notificationHealth } from '@/allset/notifications/outbox';
import { emailConfig } from '@/allset/env';
import { isLaunchReady } from '@/allset/content/facts';
import { formatDate, statusLabel, statusTagClass } from '@/components/admin/format';

export const metadata: Metadata = { title: 'Today' };

interface Props {
  readonly searchParams: Promise<{ notice?: string }>;
}

export default async function TodayPage({ searchParams }: Props) {
  const actor = await requireActor('/admin');
  const { notice } = await searchParams;
  const sql = db();
  const counts = await dashboardCounts(sql, actor);
  const mine = await listLeads(sql, actor, { assigned: 'me', status: 'open' });
  const owner = can(actor, 'alerts.manage');
  const health = owner ? await notificationHealth(sql) : null;

  const lines = [
    { count: counts.overdue, label: 'follow-ups are overdue', href: '/admin/leads?due=overdue', urgent: counts.overdue > 0 },
    { count: counts.dueToday, label: 'follow-ups are due today', href: '/admin/leads?due=today', urgent: false },
    { count: counts.newUnassigned, label: 'new requests nobody has claimed', href: '/admin/leads?assigned=unassigned&status=new', urgent: counts.newUnassigned > 0 },
    { count: counts.mine, label: 'open leads are assigned to you', href: '/admin/leads?assigned=me', urgent: false },
  ];

  return (
    <>
      <h1 className="admin-title">Today</h1>
      {notice === 'owner-only' ? (
        <p className="notice notice--warning" role="status">
          That page is for owners only.
        </p>
      ) : null}

      {owner && health && (health.failed > 0 || health.confirmedRecipients === 0 || !emailConfig()) ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__title">New-inquiry alerts need attention</p>
          <p>
            {!emailConfig()
              ? 'Email alerts are not configured on this deployment, so nobody is emailed when a request arrives. New requests still appear here.'
              : health.confirmedRecipients === 0
                ? 'No confirmed recipient: nobody is emailed when a request arrives. New requests still appear here.'
                : `${health.failed} alert${health.failed === 1 ? '' : 's'} failed to send. Last reason: ${health.lastFailureReason ?? 'unknown'}.`}{' '}
            <Link href="/admin/alerts">Open alert settings</Link>.
          </p>
        </div>
      ) : null}

      {can(actor, 'launch.view') && !isLaunchReady() ? (
        <p className="notice notice--warning">
          The public site is not ready to launch: required business facts are missing, so search
          engines are told not to index it. <Link href="/admin/launch">See the launch checklist</Link>.
        </p>
      ) : null}

      <section className="panel" aria-labelledby="today-title">
        <h2 id="today-title" className="panel__title">
          What needs you
        </h2>
        <ul role="list" className="today">
          {lines.map((line) => (
            <li key={line.label}>
              <Link href={line.href} className="target">
                {line.label}
              </Link>
              <span className={`today__count ${line.urgent ? 'tag--overdue' : ''}`}>{line.count}</span>
            </li>
          ))}
        </ul>
        <p className="muted">{counts.openTotal} open requests in total{can(actor, 'lead.viewAll') ? '' : ' that you can see'}.</p>
      </section>

      <section aria-labelledby="mine-title">
        <h2 id="mine-title" className="panel__title">
          Your open leads
        </h2>
        {mine.rows.length === 0 ? (
          <p className="muted">
            Nothing assigned to you. <Link href="/admin/leads?assigned=unassigned">Claim a request</Link> from the shared list.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="visually-hidden">Open leads assigned to you</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Status</th>
                  <th scope="col">Follow up</th>
                  <th scope="col">Kind</th>
                </tr>
              </thead>
              <tbody>
                {mine.rows.map((lead) => (
                  <tr key={lead.id}>
                    <td data-label="Name">
                      <Link href={`/admin/leads/${lead.id}`}>{lead.fullName}</Link>
                    </td>
                    <td data-label="Status">
                      <span className={statusTagClass(lead.status)}>{statusLabel(lead.status)}</span>
                    </td>
                    <td data-label="Follow up">{lead.followUpOn ? formatDate(lead.followUpOn) : '—'}</td>
                    <td data-label="Kind">{lead.kind === 'coverage' ? 'Coverage' : 'Team'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
