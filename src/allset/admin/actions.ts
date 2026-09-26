'use server';

/**
 * Every server action behind the lead desk.
 *
 * Each one re-establishes who is asking (actorForAction) and lets the
 * repository enforce what they may do; nothing trusts the page that rendered
 * the form. Next.js rejects cross-origin action posts (Origin must match
 * Host), and the session cookie is SameSite=Lax, so actions are not
 * reachable by a forged cross-site form.
 */

import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/allset/db/client';
import { adminSetupToken, publicBaseUrl } from '@/allset/env';
import { log } from '@/allset/log';
import { requestContext } from '@/allset/request';
import { hit, LIMITS } from '@/allset/ratelimit';
import { PermissionError, can } from '@/allset/auth/roles';
import {
  acceptInvite,
  changePassword,
  createFirstOwner,
  inviteStaff,
  issuePasswordReset,
  setActive,
  setRole,
  signIn,
} from '@/allset/auth/accounts';
import { createSession, revokeAllSessions, revokeSession } from '@/allset/auth/sessions';
import {
  actorForAction,
  clearSessionCookie,
  readSessionToken,
  safeReturnPath,
  setSessionCookie,
} from '@/allset/auth/session-cookie';
import { addNote, assignLead, deleteLead, LeadNotFound, setFollowUp, updateStatus } from '@/allset/leads/repo';
import { addRecipient, confirmRecipient, removeRecipient, resendConfirmation } from '@/allset/notifications/recipients';
import { deliverPending, enqueueTestAlerts, retryFailed } from '@/allset/notifications/outbox';
import type { ActionState } from './action-state';

function text(form: FormData, name: string, max = 500): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const ok = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ status: 'ok', message, ...extra });
const fail = (message: string, extra: Partial<ActionState> = {}): ActionState => ({ status: 'error', message, ...extra });

function explain(error: unknown, event: string): ActionState {
  if (error instanceof PermissionError || error instanceof LeadNotFound) return fail(error.message);
  log.error(event, error);
  return fail('Something went wrong and nothing was changed. Try again, and tell an owner if it keeps happening.');
}

async function startSession(staffId: string): Promise<void> {
  const ctx = await requestContext();
  const session = await createSession(db(), staffId, { ipHash: ctx.ipHash, userAgent: ctx.userAgent });
  await setSessionCookie(session.token, session.expiresAt);
}

// ── Sign-in, setup, invites ──────────────────────────────────────────────

export async function signInAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const email = text(form, 'email', 254).trim();
  const password = text(form, 'password', 256);
  const next = safeReturnPath(text(form, 'next', 300));
  if (!email || !password) return fail('Enter your email and password.');

  let staffId: string;
  try {
    const ctx = await requestContext();
    const result = await signIn(db(), email, password, { ip: ctx.ip });
    if (!result.ok) {
      if (result.reason === 'rate_limited') {
        const minutes = Math.ceil((result.retryAfterSeconds ?? 900) / 60);
        return fail(`Too many sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
      if (result.reason === 'locked') return fail('This account is locked for 15 minutes after several failed attempts.');
      return fail('That email and password don’t match an active account.');
    }
    staffId = result.staffId;
    await startSession(staffId);
  } catch (error) {
    return explain(error, 'admin.sign_in_failed');
  }
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    try {
      await revokeSession(db(), token);
    } catch (error) {
      log.error('admin.sign_out_failed', error);
    }
  }
  await clearSessionCookie();
  redirect('/admin/login?signed_out=1');
}

export async function setupAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const ctx = await requestContext();
    const limit = await hit(db(), LIMITS.setupPerIp, ctx.ip);
    if (!limit.allowed) return fail('Too many attempts. Wait an hour and try again.');
    const result = await createFirstOwner(db(), adminSetupToken(), text(form, 'token', 200), {
      email: text(form, 'email', 254),
      displayName: text(form, 'displayName', 100),
      password: text(form, 'password', 256),
    });
    if (!result.ok) return fail('Check the highlighted fields.', { fieldErrors: result.errors });
    await startSession(result.value.staffId);
  } catch (error) {
    return explain(error, 'admin.setup_failed');
  }
  redirect('/admin');
}

export async function acceptInviteAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const password = text(form, 'password', 256);
  if (password !== text(form, 'confirm', 256)) {
    return fail('The two passwords don’t match.', { fieldErrors: { confirm: 'The two passwords don’t match.' } });
  }
  try {
    const result = await acceptInvite(db(), text(form, 'token', 200), password);
    if (!result.ok) return fail('Check the highlighted fields.', { fieldErrors: result.errors });
    await startSession(result.value.staffId);
  } catch (error) {
    return explain(error, 'admin.accept_invite_failed');
  }
  redirect('/admin');
}

export async function confirmRecipientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const result = await confirmRecipient(db(), text(form, 'token', 200));
    return result === 'confirmed'
      ? ok('Confirmed. This address will now receive an email whenever a new inquiry arrives.')
      : fail('This link has expired or was already used. Ask an owner to send a new one.');
  } catch (error) {
    return explain(error, 'admin.confirm_recipient_failed');
  }
}

// ── Leads ────────────────────────────────────────────────────────────────

function leadPath(id: string): string {
  return `/admin/leads/${id}`;
}

export async function updateStatusAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  try {
    const actor = await actorForAction();
    await updateStatus(db(), actor, id, text(form, 'status', 40));
    revalidatePath(leadPath(id));
    return ok('Status updated.');
  } catch (error) {
    return explain(error, 'admin.update_status_failed');
  }
}

export async function followUpAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  const clear = text(form, 'intent', 20) === 'clear';
  const date = text(form, 'followUpOn', 20).trim();
  try {
    const actor = await actorForAction();
    if (!clear && !date) return fail('Choose a date, or clear the follow-up.');
    await setFollowUp(db(), actor, id, clear ? null : date);
    revalidatePath(leadPath(id));
    return ok(clear ? 'Follow-up cleared.' : 'Follow-up date saved.');
  } catch (error) {
    return explain(error, 'admin.follow_up_failed');
  }
}

export async function assignAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  const raw = text(form, 'assignee', 64);
  try {
    const actor = await actorForAction();
    const target = raw === 'me' ? actor.id : raw === '' || raw === 'none' ? null : raw;
    await assignLead(db(), actor, id, target);
    revalidatePath(leadPath(id));
    revalidatePath('/admin/leads');
    return ok(target === null ? 'Lead is unassigned.' : target === actor.id ? 'Lead assigned to you.' : 'Lead reassigned.');
  } catch (error) {
    return explain(error, 'admin.assign_failed');
  }
}

export async function noteAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  try {
    const actor = await actorForAction();
    await addNote(db(), actor, id, text(form, 'body', 5000));
    revalidatePath(leadPath(id));
    return ok('Note saved.');
  } catch (error) {
    return explain(error, 'admin.note_failed');
  }
}

export async function deleteLeadAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  let reference: string;
  try {
    const actor = await actorForAction();
    ({ reference } = await deleteLead(db(), actor, id, text(form, 'confirmation', 40)));
    revalidatePath('/admin/leads');
  } catch (error) {
    return explain(error, 'admin.delete_failed');
  }
  redirect(`/admin/leads?deleted=${encodeURIComponent(reference)}`);
}

// ── Team ─────────────────────────────────────────────────────────────────

function inviteLink(token: string): string {
  return `${publicBaseUrl() ?? ''}/admin/invite?token=${encodeURIComponent(token)}`;
}

export async function inviteAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const role = text(form, 'role', 10) === 'owner' ? 'owner' : 'staff';
    const result = await inviteStaff(db(), actor, {
      email: text(form, 'email', 254),
      displayName: text(form, 'displayName', 100),
      role,
    });
    if (!result.ok) return fail('Check the highlighted fields.', { fieldErrors: result.errors });
    revalidatePath('/admin/team');
    return ok('Account created. Send this one-time link to them privately; it works once, for 48 hours.', {
      secret: inviteLink(result.value.inviteToken),
    });
  } catch (error) {
    return explain(error, 'admin.invite_failed');
  }
}

export async function resetPasswordAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const { inviteToken } = await issuePasswordReset(db(), actor, text(form, 'staffId', 64));
    revalidatePath('/admin/team');
    return ok('Their old password no longer works. Send them this one-time link to set a new one.', {
      secret: inviteLink(inviteToken),
    });
  } catch (error) {
    return explain(error, 'admin.reset_failed');
  }
}

export async function roleAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const role = text(form, 'role', 10) === 'owner' ? 'owner' : 'staff';
    await setRole(db(), actor, text(form, 'staffId', 64), role);
    revalidatePath('/admin/team');
    return ok(`Role changed to ${role}.`);
  } catch (error) {
    return explain(error, 'admin.role_failed');
  }
}

export async function activeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const active = text(form, 'active', 10) === 'true';
    await setActive(db(), actor, text(form, 'staffId', 64), active);
    revalidatePath('/admin/team');
    return ok(active ? 'Account reactivated.' : 'Account deactivated. Their open leads went back to the shared list.');
  } catch (error) {
    return explain(error, 'admin.active_failed');
  }
}

// ── Alerts ───────────────────────────────────────────────────────────────

async function ownerForAlerts() {
  const actor = await actorForAction();
  if (!can(actor, 'alerts.manage')) throw new PermissionError('Only an owner can change alert settings.');
  return { actor, audit: { id: actor.id, label: `${actor.displayName} (${actor.role})` } };
}

function deliverSoon(): void {
  after(async () => {
    try {
      await deliverPending(db(), 10);
    } catch (error) {
      log.error('notification.deliver_after_admin_failed', error);
    }
  });
}

export async function addRecipientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { audit } = await ownerForAlerts();
    const result = await addRecipient(db(), audit, text(form, 'email', 254));
    if (!result.ok) return fail(result.error);
    deliverSoon();
    revalidatePath('/admin/alerts');
    return ok('Added. A confirmation email is on its way; alerts start once the link in it is clicked.');
  } catch (error) {
    return explain(error, 'admin.add_recipient_failed');
  }
}

export async function removeRecipientAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { audit } = await ownerForAlerts();
    const removed = await removeRecipient(db(), audit, text(form, 'recipientId', 64));
    revalidatePath('/admin/alerts');
    return removed ? ok('Removed. No more alerts will go to that address.') : fail('That address was already removed.');
  } catch (error) {
    return explain(error, 'admin.remove_recipient_failed');
  }
}

export async function resendConfirmationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const { audit } = await ownerForAlerts();
    const queued = await resendConfirmation(db(), audit, text(form, 'recipientId', 64));
    if (!queued) return fail('That address is already confirmed or was removed.');
    deliverSoon();
    revalidatePath('/admin/alerts');
    return ok('A new confirmation email is on its way.');
  } catch (error) {
    return explain(error, 'admin.resend_confirmation_failed');
  }
}

export async function retryFailedAction(): Promise<ActionState> {
  try {
    await ownerForAlerts();
    const count = await retryFailed(db());
    const report = await deliverPending(db(), 25);
    revalidatePath('/admin/alerts');
    revalidatePath('/admin');
    return report.failed > 0
      ? fail(`Retried ${count}. ${report.sent} sent, ${report.failed} failed again — see the reason below.`)
      : ok(`Retried ${count}. ${report.sent} sent${report.retrying ? `, ${report.retrying} will retry shortly` : ''}.`);
  } catch (error) {
    return explain(error, 'admin.retry_failed');
  }
}

export async function sendTestAlertAction(): Promise<ActionState> {
  try {
    const { audit } = await ownerForAlerts();
    const queued = await enqueueTestAlerts(db(), audit);
    if (queued === 0) return fail('There are no confirmed recipients to test. Add and confirm one first.');
    const report = await deliverPending(db(), 25);
    revalidatePath('/admin/alerts');
    return report.failed > 0
      ? fail(`Test alert failed for ${report.failed} of ${queued} recipient${queued === 1 ? '' : 's'}. See the delivery log.`)
      : ok(`Test alert sent to ${report.sent} recipient${report.sent === 1 ? '' : 's'}. “Delivered” appears once the provider confirms.`);
  } catch (error) {
    return explain(error, 'admin.test_alert_failed');
  }
}

// ── Account ──────────────────────────────────────────────────────────────

export async function changePasswordAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const next = text(form, 'next', 256);
  if (next !== text(form, 'confirm', 256)) {
    return fail('The new passwords don’t match.', { fieldErrors: { confirm: 'The new passwords don’t match.' } });
  }
  try {
    const actor = await actorForAction();
    const result = await changePassword(db(), actor, text(form, 'current', 256), next);
    if (!result.ok) return fail('Check the highlighted fields.', { fieldErrors: result.errors });
    return ok('Password changed. Any other devices were signed out.');
  } catch (error) {
    return explain(error, 'admin.change_password_failed');
  }
}

export async function signOutEverywhereAction(): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const count = await revokeAllSessions(db(), actor.id, actor.sessionId);
    return ok(count === 0 ? 'No other devices were signed in.' : `Signed out ${count} other device${count === 1 ? '' : 's'}.`);
  } catch (error) {
    return explain(error, 'admin.sign_out_everywhere_failed');
  }
}
