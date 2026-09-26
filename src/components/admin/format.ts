import { STATUS_LABELS, CLOSED_STATUSES, type LeadStatus } from '@/allset/leads/repo';
import { businessTimeZone } from '@/allset/env';

export function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: businessTimeZone(),
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

export function formatDate(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!parts) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))),
  );
}

export function statusTagClass(status: LeadStatus): string {
  if (status === 'new') return 'tag tag--new';
  if (status === 'do_not_contact') return 'tag tag--dnc';
  if (CLOSED_STATUSES.includes(status)) return 'tag tag--closed';
  return 'tag tag--open';
}

export function statusLabel(status: LeadStatus): string {
  return STATUS_LABELS[status];
}

const ACTION_LABELS: Record<string, string> = {
  'inquiry.received': 'Inquiry received',
  'inquiry.received_merged': 'Submitted again (folded into this lead)',
  'lead.status_changed': 'Status changed',
  'lead.follow_up_set': 'Follow-up scheduled',
  'lead.follow_up_cleared': 'Follow-up cleared',
  'lead.claimed': 'Claimed',
  'lead.assigned': 'Assigned',
  'lead.unassigned': 'Released to the shared list',
  'lead.note_added': 'Note added',
  'lead.deleted': 'Deleted',
  'lead.exported': 'Leads exported',
  'auth.signed_in': 'Signed in',
  'auth.sign_in_failed': 'Failed sign-in',
  'auth.locked': 'Account locked after failed sign-ins',
  'staff.invited': 'Team member invited',
  'staff.owner_created_via_setup': 'First owner created',
  'staff.password_set': 'Password set from invite link',
  'staff.password_reset_issued': 'Password reset issued',
  'staff.password_changed': 'Password changed',
  'staff.role_changed': 'Role changed',
  'staff.deactivated': 'Account deactivated',
  'staff.reactivated': 'Account reactivated',
  'recipient.added': 'Alert recipient added',
  'recipient.confirmed': 'Alert recipient confirmed',
  'recipient.removed': 'Alert recipient removed',
  'recipient.confirmation_resent': 'Alert confirmation resent',
  'alerts.test_sent': 'Test alert sent',
  'retention.run': 'Retention purge ran',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Readable detail line for an audit event. Details never hold personal data. */
export function detailLine(action: string, details: Record<string, unknown>): string {
  const from = details['from'];
  const to = details['to'];
  if (action === 'lead.status_changed' && typeof from === 'string' && typeof to === 'string') {
    return `${STATUS_LABELS[from as LeadStatus] ?? from} → ${STATUS_LABELS[to as LeadStatus] ?? to}`;
  }
  if (action === 'lead.follow_up_set' && typeof details['follow_up_on'] === 'string') {
    return `for ${formatDate(details['follow_up_on'])}`;
  }
  if (action === 'staff.role_changed') return `${String(from)} → ${String(to)}`;
  if (action === 'lead.exported') return `${String(details['rows'])} rows`;
  if (action === 'lead.deleted') return `${String(details['inquiries_deleted'])} inquiries removed`;
  return '';
}
