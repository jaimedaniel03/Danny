/**
 * How long the site keeps what people send it — and the job that enforces it.
 *
 * These constants are the single source of truth: the privacy policy renders
 * them, and the purge job runs on them, so the promise and the practice
 * cannot drift apart. Changing a number here changes both.
 *
 * Why these numbers (for the owner and counsel to confirm):
 *  - Inquiries and their consent evidence: 60 months after the last activity
 *    on the lead. Claims under the federal telephone consumer protection law
 *    can be brought for four years from a call, so the proof that someone
 *    asked to be contacted has to outlast that, with margin.
 *  - Do-not-contact hashes: 5 years from the request (the FCC's
 *    do-not-call honoring period), regardless of what happens to the lead.
 *  - Deactivated staff accounts: anonymized 3 years after deactivation.
 *  - Audit trail: 3 years (the database refuses earlier deletion).
 *  - Alert delivery records: 12 months.
 *  - Sign-in sessions: deleted once expired. Rate-limit counters: 2 days.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { recordAudit } from '@/allset/audit';

export const RETENTION = {
  leadMonthsAfterLastActivity: 60,
  suppressionYears: 5,
  auditYears: 3,
  notificationMonths: 12,
  rateLimitDays: 2,
  deactivatedStaffYears: 3,
} as const;

export interface RetentionReport {
  readonly leadsDeleted: number;
  readonly notificationsDeleted: number;
  readonly auditEventsDeleted: number;
  readonly sessionsDeleted: number;
  readonly rateLimitRowsDeleted: number;
  readonly invitesExpired: number;
  readonly suppressionsExpired: number;
  readonly staffAnonymized: number;
}

export async function runRetention(sql: Sql): Promise<RetentionReport> {
  const leads = await sql`
    delete from allset.leads
    where last_activity_at < now() - make_interval(months => ${RETENTION.leadMonthsAfterLastActivity})
    returning id`;
  const notifications = await sql`
    delete from allset.notifications
    where created_at < now() - make_interval(months => ${RETENTION.notificationMonths})
    returning id`;
  const audit = await sql`
    delete from allset.audit_events
    where occurred_at < now() - make_interval(years => ${RETENTION.auditYears}) - interval '1 day'
    returning id`;
  const sessions = await sql`delete from allset.staff_sessions where expires_at < now() returning id`;
  const limits = await sql`
    delete from allset.rate_limits
    where window_start < now() - make_interval(days => ${RETENTION.rateLimitDays})
    returning 1`;
  const invites = await sql`
    update allset.staff_users
    set invite_token_hash = null, invite_expires_at = null, updated_at = now()
    where invite_expires_at < now()
    returning id`;

  const suppressions = await sql`
    delete from allset.contact_suppressions
    where created_at < now() - make_interval(years => ${RETENTION.suppressionYears})
    returning 1`;
  // Anonymize rather than delete: audit rows and notes must keep pointing at
  // an account, and they are immutable.
  const staff = await sql`
    update allset.staff_users
    set email = 'removed-' || id::text || '@invalid.example', display_name = 'Former team member',
        password_hash = null, invite_token_hash = null, invite_expires_at = null, updated_at = now()
    where not is_active
      and deactivated_at < now() - make_interval(years => ${RETENTION.deactivatedStaffYears})
      and email not like 'removed-%@invalid.example'
    returning id`;

  const report: RetentionReport = {
    leadsDeleted: leads.length,
    notificationsDeleted: notifications.length,
    auditEventsDeleted: audit.length,
    sessionsDeleted: sessions.length,
    rateLimitRowsDeleted: limits.length,
    invitesExpired: invites.length,
    suppressionsExpired: suppressions.length,
    staffAnonymized: staff.length,
  };
  await recordAudit(sql, {
    actor: null,
    action: 'retention.run',
    details: {
      leads_deleted: report.leadsDeleted,
      notifications_deleted: report.notificationsDeleted,
      audit_events_deleted: report.auditEventsDeleted,
      sessions_deleted: report.sessionsDeleted,
      suppressions_expired: report.suppressionsExpired,
      staff_anonymized: report.staffAnonymized,
    },
  });
  return report;
}
