/**
 * The lead desk's data access. Every function takes the verified Actor and
 * enforces what that actor may see or change *in the query itself*: a staff
 * member's list is filtered in SQL, and a lead they may not see comes back as
 * "not found", indistinguishable from one that doesn't exist.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { recordAudit, type AuditActor } from '@/allset/audit';
import { businessTimeZone } from '@/allset/env';
import { canAssign, canEditLead, canViewLead, can, PermissionError, type Actor } from '@/allset/auth/roles';
import { suppress } from '@/allset/suppression';
import { CONTACT_METHODS, COVERAGE_INTERESTS, LICENSING_STATUSES, normalizeUsPhone, normalizeZip } from '@/allset/inquiries/fields';

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'meeting_scheduled',
  'following_up',
  'closed_helped',
  'closed_no_action',
  'do_not_contact',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const CLOSED_STATUSES: readonly LeadStatus[] = ['closed_helped', 'closed_no_action', 'do_not_contact'];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  meeting_scheduled: 'Meeting scheduled',
  following_up: 'Following up',
  closed_helped: 'Closed · helped',
  closed_no_action: 'Closed · no action',
  do_not_contact: 'Do not contact',
};

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

function auditActor(actor: Actor): AuditActor {
  return { id: actor.id, label: `${actor.displayName} (${actor.role})` };
}

/** Today's date in the business's time zone, as YYYY-MM-DD. */
export function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// ── Listing and search ───────────────────────────────────────────────────

export interface LeadFilters {
  readonly q?: string | undefined;
  /** 'open' (default), 'closed', 'all', or one specific status. */
  readonly status?: string | undefined;
  readonly kind?: 'coverage' | 'team' | undefined;
  /** 'me' | 'unassigned' | 'any' (default) | a staff id (owners only). */
  readonly assigned?: string | undefined;
  readonly due?: 'overdue' | 'today' | 'week' | undefined;
  readonly page?: number | undefined;
}

export const PAGE_SIZE = 25;

export interface LeadRow {
  readonly id: string;
  readonly kind: 'coverage' | 'team';
  readonly fullName: string;
  readonly email: string;
  readonly zip: string;
  readonly contactMethod: 'email' | 'phone' | 'text';
  readonly phoneE164: string | null;
  readonly coverageInterest: string | null;
  readonly licensingStatus: string | null;
  readonly status: LeadStatus;
  readonly assignedTo: string | null;
  readonly assignedName: string | null;
  readonly followUpOn: string | null;
  readonly submissionCount: number;
  readonly createdAt: Date;
  readonly lastActivityAt: Date;
  readonly latestReference: string | null;
  readonly needsReview: boolean;
  readonly suppressionMatch: boolean;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function whereClause(sql: Sql, actor: Actor, filters: LeadFilters, today: string) {
  const parts = [sql`true`];

  // Scope: staff never see leads assigned to someone else.
  if (!can(actor, 'lead.viewAll')) {
    parts.push(sql`(l.assigned_to = ${actor.id} or l.assigned_to is null)`);
  }

  const status = filters.status ?? 'open';
  if (status === 'open') parts.push(sql`l.closed_at is null`);
  else if (status === 'closed') parts.push(sql`l.closed_at is not null`);
  else if (isLeadStatus(status)) parts.push(sql`l.status = ${status}`);

  if (filters.kind === 'coverage' || filters.kind === 'team') parts.push(sql`l.kind = ${filters.kind}`);

  const assigned = filters.assigned ?? 'any';
  if (assigned === 'me') parts.push(sql`l.assigned_to = ${actor.id}`);
  else if (assigned === 'unassigned') parts.push(sql`l.assigned_to is null`);
  else if (UUID.test(assigned) && can(actor, 'lead.viewAll')) parts.push(sql`l.assigned_to = ${assigned}`);

  if (filters.due === 'overdue') parts.push(sql`l.follow_up_on < ${today}::date and l.closed_at is null`);
  else if (filters.due === 'today') parts.push(sql`l.follow_up_on = ${today}::date and l.closed_at is null`);
  else if (filters.due === 'week')
    parts.push(sql`l.follow_up_on between ${today}::date and ${today}::date + 7 and l.closed_at is null`);

  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    const pattern = likePattern(q);
    const digits = q.replace(/\D/g, '');
    parts.push(sql`(
      l.full_name ilike ${pattern}
      or l.email ilike ${pattern}
      or l.zip = ${q}
      ${digits.length >= 4 ? sql`or l.phone_e164 like ${likePattern(digits)}` : sql``}
      or exists (select 1 from allset.inquiries i where i.lead_id = l.id and i.reference = ${q.toUpperCase()})
    )`);
  }

  return parts.reduce((acc, part, index) => (index === 0 ? part : sql`${acc} and ${part}`));
}

export async function listLeads(
  sql: Sql,
  actor: Actor,
  filters: LeadFilters,
): Promise<{ rows: LeadRow[]; total: number; page: number; pages: number }> {
  const today = businessToday();
  const where = whereClause(sql, actor, filters, today);
  const page = Math.max(1, Math.min(10_000, Math.floor(filters.page ?? 1)));

  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from allset.leads l where ${where}`;
  const total = count?.n ?? 0;

  const rows = await sql<LeadRow[]>`
    select l.id, l.kind, l.full_name as "fullName", l.email, l.zip, l.contact_method as "contactMethod",
           l.phone_e164 as "phoneE164", l.coverage_interest as "coverageInterest",
           l.licensing_status as "licensingStatus", l.status, l.assigned_to as "assignedTo",
           u.display_name as "assignedName", l.follow_up_on as "followUpOn",
           l.submission_count as "submissionCount", l.created_at as "createdAt",
           l.last_activity_at as "lastActivityAt", l.needs_review as "needsReview",
           l.suppression_match as "suppressionMatch",
           (select i.reference from allset.inquiries i where i.lead_id = l.id order by i.created_at desc limit 1) as "latestReference"
    from allset.leads l
    left join allset.staff_users u on u.id = l.assigned_to
    where ${where}
    order by
      (l.closed_at is null) desc,
      (l.follow_up_on is not null and l.follow_up_on <= ${today}::date) desc,
      l.follow_up_on asc nulls last,
      l.last_submitted_at desc
    limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`;

  return { rows, total, page, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

// ── Detail ───────────────────────────────────────────────────────────────

export interface InquiryRecord {
  readonly id: string;
  readonly reference: string;
  readonly createdAt: Date;
  readonly sourcePath: string;
  readonly consentText: string;
  readonly consentVersion: string;
  readonly consentedAt: Date;
  readonly payload: Record<string, unknown>;
}

export interface NoteRecord {
  readonly id: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly authorName: string | null;
}

export interface TimelineEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly details: Record<string, unknown>;
}

export interface LeadDetail {
  readonly lead: LeadRow & { readonly closedAt: Date | null };
  readonly inquiries: InquiryRecord[];
  readonly notes: NoteRecord[];
  readonly timeline: TimelineEvent[];
  readonly canEdit: boolean;
}

async function visibleLead(sql: Sql | TransactionSql, actor: Actor, id: string, lock = false) {
  if (!UUID.test(id)) return null;
  const rows = lock
    ? await sql<{ id: string; assigned_to: string | null; status: LeadStatus; kind: string }[]>`
        select id, assigned_to, status, kind from allset.leads where id = ${id} for update`
    : await sql<{ id: string; assigned_to: string | null; status: LeadStatus; kind: string }[]>`
        select id, assigned_to, status, kind from allset.leads where id = ${id}`;
  const row = rows[0];
  if (!row || !canViewLead(actor, { assignedTo: row.assigned_to })) return null;
  return row;
}

export async function getLead(sql: Sql, actor: Actor, id: string): Promise<LeadDetail | null> {
  const access = await visibleLead(sql, actor, id);
  if (!access) return null;

  const [lead] = await sql<(LeadRow & { closedAt: Date | null })[]>`
    select l.id, l.kind, l.full_name as "fullName", l.email, l.zip, l.contact_method as "contactMethod",
           l.phone_e164 as "phoneE164", l.coverage_interest as "coverageInterest",
           l.licensing_status as "licensingStatus", l.status, l.assigned_to as "assignedTo",
           u.display_name as "assignedName", l.follow_up_on as "followUpOn",
           l.submission_count as "submissionCount", l.created_at as "createdAt",
           l.last_activity_at as "lastActivityAt", l.needs_review as "needsReview",
           l.suppression_match as "suppressionMatch", l.closed_at as "closedAt",
           (select i.reference from allset.inquiries i where i.lead_id = l.id order by i.created_at desc limit 1) as "latestReference"
    from allset.leads l
    left join allset.staff_users u on u.id = l.assigned_to
    where l.id = ${id}`;
  if (!lead) return null;

  const inquiries = await sql<InquiryRecord[]>`
    select id, reference, created_at as "createdAt", source_path as "sourcePath", consent_text as "consentText",
           consent_version as "consentVersion", consented_at as "consentedAt", payload
    from allset.inquiries where lead_id = ${id} order by created_at desc`;
  const notes = await sql<NoteRecord[]>`
    select n.id, n.body, n.created_at as "createdAt", u.display_name as "authorName"
    from allset.lead_notes n left join allset.staff_users u on u.id = n.author_id
    where n.lead_id = ${id} order by n.created_at desc`;
  const timeline = await sql<TimelineEvent[]>`
    select id::text, occurred_at as "occurredAt", actor_label as "actorLabel", action, details
    from allset.audit_events
    where entity_type = 'lead' and entity_id = ${id}
    order by occurred_at desc limit 100`;

  return { lead, inquiries, notes, timeline, canEdit: canEditLead(actor, { assignedTo: lead.assignedTo }) };
}

// ── Changes ──────────────────────────────────────────────────────────────

export class LeadNotFound extends Error {
  constructor() {
    super('That lead doesn’t exist or isn’t yours to see.');
    this.name = 'LeadNotFound';
  }
}

export async function updateStatus(sql: Sql, actor: Actor, id: string, status: string): Promise<void> {
  if (!isLeadStatus(status)) throw new PermissionError('Unknown status.');
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canEditLead(actor, { assignedTo: lead.assigned_to })) {
      throw new PermissionError('Assign this lead to yourself before changing it.');
    }
    if (lead.status === status) return;
    const closing = CLOSED_STATUSES.includes(status);
    try {
      await tx`savepoint reopen`;
      await tx`
        update allset.leads
        set status = ${status},
            closed_at = ${closing ? sql`coalesce(closed_at, now())` : null},
            follow_up_on = ${closing ? null : sql`follow_up_on`},
            last_activity_at = now(), updated_at = now()
        where id = ${id}`;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        await tx`rollback to savepoint reopen`;
        throw new PermissionError('This person already has another open lead of this kind. Update that one instead.');
      }
      throw error;
    }
    if (status === 'do_not_contact') {
      const [contact] = await tx<{ email_normalized: string; phone_e164: string | null }[]>`
        select email_normalized, phone_e164 from allset.leads where id = ${id}`;
      if (contact) await suppress(tx, { emailNormalized: contact.email_normalized, phoneE164: contact.phone_e164 }, actor.id);
    }
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'lead.status_changed',
      entityType: 'lead',
      entityId: id,
      details: { from: lead.status, to: status },
    });
  });
}

/** Staff compared the details and kept the lead's current ones. */
export async function markReviewed(sql: Sql, actor: Actor, id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canEditLead(actor, { assignedTo: lead.assigned_to })) {
      throw new PermissionError('Assign this lead to yourself before changing it.');
    }
    await tx`update allset.leads set needs_review = false, updated_at = now() where id = ${id}`;
    await recordAudit(tx, { actor: auditActor(actor), action: 'lead.details_kept', entityType: 'lead', entityId: id });
  });
}

/**
 * Staff confirmed with the person that a later submission's details are
 * right, and adopt them. Only details from this lead's own inquiries can be
 * applied, and they are re-validated.
 */
export async function applyInquiryDetails(sql: Sql, actor: Actor, id: string, inquiryId: string): Promise<void> {
  if (!UUID.test(inquiryId)) throw new PermissionError('Unknown request.');
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canEditLead(actor, { assignedTo: lead.assigned_to })) {
      throw new PermissionError('Assign this lead to yourself before changing it.');
    }
    const [inquiry] = await tx<{ reference: string; payload: Record<string, unknown> }[]>`
      select reference, payload from allset.inquiries where id = ${inquiryId} and lead_id = ${id}`;
    if (!inquiry) throw new PermissionError('That request isn’t part of this lead.');
    const p = inquiry.payload;
    const str = (key: string): string | null => {
      const value = p[key];
      return typeof value === 'string' ? value : null;
    };
    const method = str('contactMethod');
    const zip = normalizeZip(str('zip') ?? '');
    const phone = str('phone') ? normalizeUsPhone(str('phone')!) : null;
    const name = str('fullName');
    if (!name || !zip || !method || !(CONTACT_METHODS as readonly string[]).includes(method) || (method !== 'email' && !phone)) {
      throw new PermissionError('Those details are incomplete, so they can’t be applied.');
    }
    const interest = str('coverageInterest');
    const licensing = str('licensingStatus');
    await tx`
      update allset.leads set
        full_name = ${name.slice(0, 100)},
        zip = ${zip},
        contact_method = ${method},
        phone_e164 = ${phone},
        coverage_interest = ${lead.kind === 'coverage' && interest && (COVERAGE_INTERESTS as readonly string[]).includes(interest) ? interest : sql`coverage_interest`},
        licensing_status = ${lead.kind === 'team' && licensing && (LICENSING_STATUSES as readonly string[]).includes(licensing) ? licensing : sql`licensing_status`},
        needs_review = false,
        last_activity_at = now(),
        updated_at = now()
      where id = ${id}`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'lead.details_updated',
      entityType: 'lead',
      entityId: id,
      entityRef: inquiry.reference,
    });
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function setFollowUp(sql: Sql, actor: Actor, id: string, date: string | null): Promise<void> {
  if (date !== null) {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new PermissionError('Enter a valid date.');
    }
    const year = Number(date.slice(0, 4));
    if (year < 2020 || year > 2100) throw new PermissionError('Enter a date between 2020 and 2100.');
  }
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canEditLead(actor, { assignedTo: lead.assigned_to })) {
      throw new PermissionError('Assign this lead to yourself before changing it.');
    }
    if (date !== null && CLOSED_STATUSES.includes(lead.status)) {
      throw new PermissionError('Reopen the lead before scheduling a follow-up.');
    }
    await tx`
      update allset.leads set follow_up_on = ${date}, last_activity_at = now(), updated_at = now()
      where id = ${id}`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: date ? 'lead.follow_up_set' : 'lead.follow_up_cleared',
      entityType: 'lead',
      entityId: id,
      details: { follow_up_on: date },
    });
  });
}

export async function assignLead(sql: Sql, actor: Actor, id: string, target: string | null): Promise<void> {
  if (target !== null && !UUID.test(target)) throw new PermissionError('Unknown team member.');
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canAssign(actor, { assignedTo: lead.assigned_to }, target)) {
      throw new PermissionError(
        actor.role === 'staff'
          ? 'You can claim unassigned leads or release your own. Ask an owner to reassign.'
          : 'You can’t make that assignment.',
      );
    }
    if (lead.assigned_to === target) return;
    if (target !== null) {
      const [member] = await tx`
        select 1 from allset.staff_users where id = ${target} and is_active and password_hash is not null`;
      if (!member) throw new PermissionError('That team member can’t take leads right now.');
    }
    await tx`
      update allset.leads set assigned_to = ${target}, last_activity_at = now(), updated_at = now()
      where id = ${id}`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: target === null ? 'lead.unassigned' : target === actor.id ? 'lead.claimed' : 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      details: { from: lead.assigned_to, to: target },
    });
  });
}

export const NOTE_MAX = 4000;

export async function addNote(sql: Sql, actor: Actor, id: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new PermissionError('Write something before saving the note.');
  if (text.length > NOTE_MAX) throw new PermissionError(`Notes can be up to ${NOTE_MAX} characters.`);
  await sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    if (!canEditLead(actor, { assignedTo: lead.assigned_to })) {
      throw new PermissionError('Assign this lead to yourself before adding notes.');
    }
    const [note] = await tx<{ id: string }[]>`
      insert into allset.lead_notes (lead_id, author_id, body) values (${id}, ${actor.id}, ${text}) returning id`;
    await tx`update allset.leads set last_activity_at = now(), updated_at = now() where id = ${id}`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'lead.note_added',
      entityType: 'lead',
      entityId: id,
      details: { record_id: note!.id, length: text.length },
    });
  });
}

/**
 * Permanent deletion — for a person's deletion request or a mistaken entry.
 * The owner must type one of the lead's references to confirm. The audit
 * trail keeps that a deletion happened and by whom, not who was deleted.
 */
export async function deleteLead(
  sql: Sql,
  actor: Actor,
  id: string,
  confirmation: string,
  options: { readonly suppress?: boolean } = {},
): Promise<{ reference: string }> {
  if (!can(actor, 'lead.delete')) throw new PermissionError('Only an owner can delete a lead.');
  return sql.begin(async (tx) => {
    const lead = await visibleLead(tx, actor, id, true);
    if (!lead) throw new LeadNotFound();
    const refs = await tx<{ reference: string }[]>`
      select reference from allset.inquiries where lead_id = ${id} order by created_at desc`;
    const typed = confirmation.trim().toUpperCase();
    const match = refs.find((r) => r.reference === typed);
    if (!match) throw new PermissionError('Type one of this lead’s reference numbers exactly to confirm.');
    if (options.suppress) {
      const [contact] = await tx<{ email_normalized: string; phone_e164: string | null }[]>`
        select email_normalized, phone_e164 from allset.leads where id = ${id}`;
      if (contact) await suppress(tx, { emailNormalized: contact.email_normalized, phoneE164: contact.phone_e164 }, actor.id);
    }
    await tx`delete from allset.leads where id = ${id}`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'lead.deleted',
      entityType: 'lead',
      entityId: id,
      entityRef: match.reference,
      details: { kind: lead.kind, inquiries_deleted: refs.length, added_to_do_not_contact: Boolean(options.suppress) },
    });
    return { reference: match.reference };
  });
}

// ── Dashboard ────────────────────────────────────────────────────────────

export interface DashboardCounts {
  readonly newUnassigned: number;
  readonly mine: number;
  readonly overdue: number;
  readonly dueToday: number;
  readonly openTotal: number;
}

export async function dashboardCounts(sql: Sql, actor: Actor): Promise<DashboardCounts> {
  const today = businessToday();
  const scope = can(actor, 'lead.viewAll')
    ? sql`true`
    : sql`(l.assigned_to = ${actor.id} or l.assigned_to is null)`;
  const [row] = await sql<DashboardCounts[]>`
    select
      count(*) filter (where l.assigned_to is null and l.status = 'new')::int as "newUnassigned",
      count(*) filter (where l.assigned_to = ${actor.id})::int as mine,
      count(*) filter (where l.follow_up_on < ${today}::date)::int as overdue,
      count(*) filter (where l.follow_up_on = ${today}::date)::int as "dueToday",
      count(*)::int as "openTotal"
    from allset.leads l
    where l.closed_at is null and ${scope}`;
  return row ?? { newUnassigned: 0, mine: 0, overdue: 0, dueToday: 0, openTotal: 0 };
}
