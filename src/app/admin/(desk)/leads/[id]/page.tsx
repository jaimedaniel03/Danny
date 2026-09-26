import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireActor } from '@/allset/auth/session-cookie';
import { can } from '@/allset/auth/roles';
import { db } from '@/allset/db/client';
import { RETENTION } from '@/allset/retention';
import { listAssignable } from '@/allset/auth/accounts';
import { getLead, LEAD_STATUSES, NOTE_MAX, STATUS_LABELS } from '@/allset/leads/repo';
import {
  CONTACT_METHOD_LABELS,
  COVERAGE_INTEREST_LABELS,
  LICENSING_STATUS_LABELS,
  type CoverageInterest,
  type LicensingStatus,
} from '@/allset/inquiries/fields';
import { formatPhone } from '@/allset/content/format';
import { ActionForm, Submit } from '@/components/admin/ActionForm';
import { actionLabel, detailLine, formatDate, formatDateTime, statusLabel, statusTagClass } from '@/components/admin/format';
import {
  applyDetailsAction,
  assignAction,
  deleteLeadAction,
  followUpAction,
  markReviewedAction,
  noteAction,
  updateStatusAction,
} from '@/allset/admin/actions';

function payloadLine(payload: Record<string, unknown>): string {
  const get = (k: string): string | null => {
    const value = payload[k];
    return typeof value === 'string' ? value : null;
  };
  const method = get('contactMethod');
  const interest = get('coverageInterest');
  const licensing = get('licensingStatus');
  const phone = get('phone');
  return [
    get('fullName'),
    get('email'),
    phone ? formatPhone(phone) : null,
    get('zip') ? `ZIP ${get('zip')}` : null,
    method && method in CONTACT_METHOD_LABELS ? `prefers ${CONTACT_METHOD_LABELS[method as keyof typeof CONTACT_METHOD_LABELS].toLowerCase()}` : null,
    interest ? COVERAGE_INTEREST_LABELS[interest as CoverageInterest] : null,
    licensing ? LICENSING_STATUS_LABELS[licensing as LicensingStatus] : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export const metadata: Metadata = { title: 'Lead' };

interface Props {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ reviewed?: string | string[] }>;
}

const REVIEWED: Record<string, string> = {
  updated: 'Contact details updated from that request.',
  kept: 'Kept the current details.',
};

export default async function LeadPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { reviewed } = await searchParams;
  const reviewedMessage = typeof reviewed === 'string' ? REVIEWED[reviewed] : undefined;
  const actor = await requireActor(`/admin/leads/${id}`);
  const sql = db();
  const detail = await getLead(sql, actor, id);
  // Not visible and not existing look the same from the outside.
  if (!detail) notFound();

  const { lead, inquiries, notes, timeline, canEdit } = detail;
  const owner = can(actor, 'lead.reassign');
  const team = owner ? await listAssignable(sql) : [];
  const qualifier = lead.coverageInterest
    ? COVERAGE_INTEREST_LABELS[lead.coverageInterest as CoverageInterest]
    : lead.licensingStatus
      ? LICENSING_STATUS_LABELS[lead.licensingStatus as LicensingStatus]
      : '—';

  return (
    <>
      <p>
        <Link href="/admin/leads" className="target">
          ← All leads
        </Link>
      </p>
      <header>
        <p className="eyebrow">{lead.kind === 'coverage' ? 'Coverage request' : 'Team inquiry'}</p>
        <h1 className="admin-title">{lead.fullName}</h1>
        <p>
          <span className={statusTagClass(lead.status)}>{statusLabel(lead.status)}</span>{' '}
          <span className="muted">
            {lead.latestReference} · received {formatDateTime(lead.createdAt)}
            {lead.submissionCount > 1 ? ` · submitted ${lead.submissionCount} times` : ''}
          </span>
        </p>
      </header>

      {reviewedMessage ? (
        <p className="notice notice--success" role="status">
          {reviewedMessage}
        </p>
      ) : null}

      {lead.suppressionMatch && lead.status !== 'do_not_contact' ? (
        <div className="notice notice--error" role="note">
          <p className="notice__title">This email or phone number asked us not to make contact before.</p>
          <p>
            Someone may have used another person’s details. Before reaching out, confirm this request
            really came from them — for example by replying only to the email address on the request.
          </p>
        </div>
      ) : null}

      {lead.needsReview ? (
        <div className="notice notice--warning" role="note">
          <p className="notice__title">A later request has different details.</p>
          <p>
            The lead still uses its original contact details. Compare the requests below and confirm with
            the person before switching to the newer ones.
          </p>
          {canEdit ? (
            <ActionForm action={markReviewedAction} aria-label="Keep current details">
              <input type="hidden" name="leadId" value={lead.id} />
              <Submit variant="secondary">Keep the current details</Submit>
            </ActionForm>
          ) : null}
        </div>
      ) : null}

      {lead.status === 'do_not_contact' ? (
        <p className="notice notice--error" role="note">
          <strong>Do not contact.</strong> This person asked not to be contacted. Don’t call, text or email them.
        </p>
      ) : null}

      <div className="split">
        <div className="stack">
          <section className="panel" aria-labelledby="contact-title">
            <h2 id="contact-title" className="panel__title">
              How to reach them
            </h2>
            <dl className="dl">
              <dt>Prefers</dt>
              <dd>{CONTACT_METHOD_LABELS[lead.contactMethod]}</dd>
              <dt>Email</dt>
              <dd>
                <a href={`mailto:${lead.email}`}>{lead.email}</a>
              </dd>
              {lead.phoneE164 ? (
                <>
                  <dt>Phone</dt>
                  <dd>
                    <a href={`tel:${lead.phoneE164}`}>{formatPhone(lead.phoneE164)}</a>
                  </dd>
                </>
              ) : null}
              <dt>ZIP</dt>
              <dd>{lead.zip}</dd>
              <dt>{lead.kind === 'coverage' ? 'Wants help with' : 'Licensing'}</dt>
              <dd>{qualifier}</dd>
              <dt>Assigned to</dt>
              <dd>{lead.assignedName ?? 'Nobody yet'}</dd>
              <dt>Follow up</dt>
              <dd>{lead.followUpOn ? formatDate(lead.followUpOn) : 'Not scheduled'}</dd>
            </dl>
          </section>

          <section className="panel" aria-labelledby="notes-title">
            <h2 id="notes-title" className="panel__title">
              Notes
            </h2>
            {canEdit ? (
              <ActionForm action={noteAction} aria-label="Add a note">
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="field">
                  <label className="field__label" htmlFor="note-body">
                    Add a note
                  </label>
                  <p className="field__hint" id="note-hint">
                    What was said and what happens next. Don’t record medical details or Social Security numbers.
                  </p>
                  <textarea id="note-body" name="body" className="textarea" maxLength={NOTE_MAX} required aria-describedby="note-hint" />
                </div>
                <Submit>Save note</Submit>
              </ActionForm>
            ) : (
              <p className="muted">Claim this lead to add notes.</p>
            )}
            {notes.length === 0 ? (
              <p className="muted">No notes yet.</p>
            ) : (
              <ul role="list" className="timeline">
                {notes.map((note) => (
                  <li key={note.id}>
                    <span className="muted">
                      {note.authorName ?? 'Former team member'} · {formatDateTime(note.createdAt)}
                    </span>
                    <p className="note">{note.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="inquiries-title">
            <h2 id="inquiries-title" className="panel__title">
              What they sent, and what they agreed to
            </h2>
            <ul role="list" className="stack">
              {inquiries.map((inquiry) => (
                <li key={inquiry.id}>
                  <p>
                    <strong>{inquiry.reference}</strong>{' '}
                    <span className="muted">
                      · {formatDateTime(inquiry.createdAt)} · from {inquiry.sourcePath}
                    </span>
                  </p>
                  <p className="fine-print">{payloadLine(inquiry.payload)}</p>
                  {lead.needsReview && canEdit ? (
                    <ActionForm action={applyDetailsAction} aria-label={`Use details from ${inquiry.reference}`}>
                      <input type="hidden" name="leadId" value={lead.id} />
                      <input type="hidden" name="inquiryId" value={inquiry.id} />
                      <Submit variant="quiet">Use these details</Submit>
                    </ActionForm>
                  ) : null}
                  <div className="consent-record">
                    <p>
                      Agreed {formatDateTime(inquiry.consentedAt)} to wording version{' '}
                      <code>{inquiry.consentVersion}</code>:
                    </p>
                    <p>“{inquiry.consentText}”</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="stack">
          <section className="panel" aria-labelledby="work-title">
            <h2 id="work-title" className="panel__title">
              Work this lead
            </h2>

            {owner ? (
              <ActionForm action={assignAction} aria-label="Assign lead">
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="field">
                  <label className="field__label" htmlFor="assignee">
                    Assigned to
                  </label>
                  <select id="assignee" name="assignee" className="select" defaultValue={lead.assignedTo ?? 'none'}>
                    <option value="none">Nobody (shared list)</option>
                    {team.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.displayName}
                      </option>
                    ))}
                  </select>
                </div>
                <Submit variant="secondary">Save assignment</Submit>
              </ActionForm>
            ) : lead.assignedTo === null ? (
              <ActionForm action={assignAction} aria-label="Claim lead">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="assignee" value="me" />
                <Submit>Claim this lead</Submit>
              </ActionForm>
            ) : lead.assignedTo === actor.id ? (
              <ActionForm action={assignAction} aria-label="Release lead">
                <input type="hidden" name="leadId" value={lead.id} />
                <input type="hidden" name="assignee" value="none" />
                <Submit variant="secondary">Release to the shared list</Submit>
              </ActionForm>
            ) : null}

            {canEdit ? (
              <>
                <ActionForm action={updateStatusAction} aria-label="Change status">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <div className="field">
                    <label className="field__label" htmlFor="status">
                      Status
                    </label>
                    <select id="status" name="status" className="select" defaultValue={lead.status}>
                      {LEAD_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Submit variant="secondary">Save status</Submit>
                </ActionForm>

                <ActionForm action={followUpAction} aria-label="Follow-up date">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <div className="field">
                    <label className="field__label" htmlFor="followUpOn">
                      Follow up on
                    </label>
                    <input id="followUpOn" name="followUpOn" type="date" className="input" defaultValue={lead.followUpOn ?? ''} />
                  </div>
                  <div className="inline-form">
                    <Submit variant="secondary" name="intent" value="set">
                      Save date
                    </Submit>
                    {lead.followUpOn ? (
                      <Submit variant="quiet" name="intent" value="clear">
                        Clear
                      </Submit>
                    ) : null}
                  </div>
                </ActionForm>
              </>
            ) : (
              <p className="muted">
                {lead.assignedTo === null ? 'Claim this lead to change its status or schedule a follow-up.' : 'Only the assigned person or an owner can change this lead.'}
              </p>
            )}
          </section>

          <section className="panel" aria-labelledby="history-title">
            <h2 id="history-title" className="panel__title">
              History
            </h2>
            <ol role="list" className="timeline">
              {timeline.map((event) => (
                <li key={event.id}>
                  <span>
                    <strong>{actionLabel(event.action)}</strong> {detailLine(event.action, event.details)}
                  </span>
                  <span className="muted">
                    {event.actorLabel ?? 'Website'} · {formatDateTime(event.occurredAt)}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {can(actor, 'lead.delete') ? (
            <section className="panel" aria-labelledby="delete-title">
              <h2 id="delete-title" className="panel__title">
                Delete permanently
              </h2>
              <p className="fine-print">
                For a deletion request or a mistaken entry. Removes this lead, its notes and its consent
                records. The audit log keeps only that a deletion happened.
              </p>
              <ActionForm action={deleteLeadAction} aria-label="Delete lead">
                <input type="hidden" name="leadId" value={lead.id} />
                <div className="field">
                  <label className="field__label" htmlFor="confirmation">
                    Type the reference <strong>{lead.latestReference}</strong> to confirm
                  </label>
                  <input id="confirmation" name="confirmation" className="input" autoComplete="off" required />
                </div>
                <label className="choice choice--plain">
                  <input
                    type="checkbox"
                    name="suppress"
                    value="yes"
                    defaultChecked={lead.status === 'do_not_contact'}
                  />
                  <span>
                    They also asked us not to contact them. Keep a one-way code of their email and phone for{' '}
                    {RETENTION.suppressionYears} years so a future request in their name is flagged. Leave
                    this unchecked if they only asked to be deleted.
                  </span>
                </label>
                <Submit variant="danger" pendingLabel="Deleting…">
                  Delete this lead
                </Submit>
              </ActionForm>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
