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
import { adminSetupToken, isProduction, publicBaseUrl } from '@/allset/env';
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
  recordSignedIn,
  signIn,
} from '@/allset/auth/accounts';
import {
  confirmEnrollment,
  createChallenge,
  regenerateRecoveryCodes,
  rememberDevice,
  resetMfa,
  startEnrollment,
  verifyChallenge,
} from '@/allset/auth/mfa';
import { createSession, revokeAllSessions, revokeSession } from '@/allset/auth/sessions';
import {
  actorForAction,
  clearMfaCookie,
  clearSessionCookie,
  readDeviceToken,
  readMfaToken,
  readSessionToken,
  safeReturnPath,
  SEARCH_COOKIE,
  setDeviceCookie,
  setMfaCookie,
  setSessionCookie,
} from '@/allset/auth/session-cookie';
import { cookies } from 'next/headers';
import { findInvite } from '@/allset/auth/accounts';
import {
  addNote,
  applyInquiryDetails,
  assignLead,
  deleteLead,
  LeadNotFound,
  markReviewed,
  setFollowUp,
  updateStatus,
} from '@/allset/leads/repo';
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

async function startSession(staffId: string, mfaVerified: boolean): Promise<void> {
  const ctx = await requestContext();
  const session = await createSession(db(), staffId, { ipHash: ctx.ipHash, userAgent: ctx.userAgent, mfaVerified });
  await setSessionCookie(session.token, session.expiresAt);
}

function tryAgainIn(seconds: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((seconds ?? 900) / 60));
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// ── Sign-in, setup, invites ──────────────────────────────────────────────

/** Step one: the password. A right one leads to the code step (or, for a new account, to setting it up). */
export async function signInAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const email = text(form, 'email', 254).trim();
  const password = text(form, 'password', 256);
  const next = safeReturnPath(text(form, 'next', 300));
  if (!email || !password) return fail('Enter your email and password.');

  let destination: string;
  try {
    const ctx = await requestContext();
    const result = await signIn(db(), email, password, { ip: ctx.ip, deviceToken: await readDeviceToken() });
    if (!result.ok) {
      // One generic message whichever limit applied, and one for any wrong combination.
      if (result.reason === 'throttled') return fail(`Too many sign-in attempts. Try again in ${tryAgainIn(result.retryAfterSeconds)}.`);
      return fail('That email and password don’t match an active account.');
    }
    if (result.next === 'mfa') {
      const challenge = await createChallenge(db(), result.staffId, result.deviceId);
      await setMfaCookie(challenge.token, challenge.expiresAt);
      destination = `/admin/login/verify?next=${encodeURIComponent(next)}`;
    } else {
      // A brand-new account: this session can reach only the setup page.
      await startSession(result.staffId, false);
      destination = '/admin/two-step';
    }
  } catch (error) {
    return explain(error, 'admin.sign_in_failed');
  }
  redirect(destination);
}

/** Step two: a code from the authenticator app, or a one-time recovery code. */
export async function verifyCodeAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const next = safeReturnPath(text(form, 'next', 300));
  const code = text(form, 'code', 20);
  const recoveryCode = text(form, 'recoveryCode', 40);
  if (!code.trim() && !recoveryCode.trim()) return fail('Enter the 6-digit code from your authenticator app, or a recovery code.');
  let destination = next;
  try {
    const token = await readMfaToken();
    const result = await verifyChallenge(db(), token ?? '', { code, recoveryCode });
    if (!result.ok) {
      if (result.reason === 'expired') {
        await clearMfaCookie();
        return fail('This sign-in has expired. Start again with your email and password.', { secret: 'expired' });
      }
      if (result.reason === 'throttled') return fail(`Too many attempts. Try again in ${tryAgainIn(result.retryAfterSeconds)}.`);
      return fail(recoveryCode.trim() ? 'That recovery code isn’t valid or was already used.' : 'That code isn’t right. Use the newest code from your app.');
    }
    await clearMfaCookie();
    await startSession(result.staffId, true);
    const device = await rememberDevice(db(), result.staffId, await readDeviceToken());
    await setDeviceCookie(device.token, device.expiresAt);
    await recordSignedIn(db(), result.staffId, { usedRecoveryCode: result.usedRecoveryCode });
    if (result.usedRecoveryCode) destination = `/admin/two-step?recovery_used=${result.recoveryCodesLeft ?? 0}`;
  } catch (error) {
    return explain(error, 'admin.verify_code_failed');
  }
  redirect(destination);
}

/** Two-step setup: begin (or restart). */
export async function startEnrollmentAction(_previous?: ActionState, _form?: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction({ allowUnverified: true });
    await startEnrollment(db(), actor);
  } catch (error) {
    return explain(error, 'admin.mfa_start_failed');
  }
  revalidatePath('/admin/two-step');
  return ok('Scan the code, then enter the 6-digit code your app shows.');
}

/** Two-step setup: finish with a code. Recovery codes come back once. */
export async function confirmEnrollmentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction({ allowUnverified: true });
    const result = await confirmEnrollment(db(), actor, text(form, 'code', 20));
    if (!result.ok) return fail(result.error, { fieldErrors: { code: result.error } });
    // No cookie is set here: setting one makes Next.js re-render the page,
    // which would drop the recovery codes before anyone could save them. The
    // browser is remembered at its next full sign-in instead.
    return ok('Two-step sign-in is on. Save these recovery codes now; they won’t be shown again.', { codes: result.recoveryCodes });
  } catch (error) {
    return explain(error, 'admin.mfa_confirm_failed');
  }
}

export async function regenerateRecoveryCodesAction(_previous?: ActionState, _form?: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    const codes = await regenerateRecoveryCodes(db(), actor);
    return ok('New recovery codes. The old ones no longer work. Save these now; they won’t be shown again.', { codes });
  } catch (error) {
    return explain(error, 'admin.recovery_codes_failed');
  }
}

export async function signOutAction(): Promise<void> {
  const token = await readSessionToken();
  let revoked = true;
  if (token) {
    try {
      await revokeSession(db(), token);
    } catch (error) {
      revoked = false;
      log.error('admin.sign_out_failed', error);
    }
  }
  await clearSessionCookie();
  // Don't claim a full sign-out if the server-side session survived.
  redirect(revoked ? '/admin/login?signed_out=1' : '/admin/login?signed_out=partial');
}

/**
 * Lead search. The filters that carry no personal data stay in the URL (so
 * links like "overdue follow-ups" work); the search text goes in a short-lived
 * cookie so names, emails and phone numbers never appear in request logs.
 */
export async function searchLeadsAction(form: FormData): Promise<void> {
  await actorForAction();
  const q = text(form, 'q', 100).trim();
  const jar = await cookies();
  jar.set(SEARCH_COOKIE, q, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'strict',
    path: '/',
    maxAge: q ? 3600 : 0,
  });
  const params = new URLSearchParams();
  for (const key of ['status', 'kind', 'assigned', 'due'] as const) {
    const value = text(form, key, 64);
    if (value) params.set(key, value);
  }
  if (q) params.set('search', '1');
  const query = params.toString();
  redirect(`/admin/leads${query ? `?${query}` : ''}`);
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
    // The new owner sets up two-step sign-in before anything else.
    await startSession(result.value.staffId, false);
  } catch (error) {
    return explain(error, 'admin.setup_failed');
  }
  redirect('/admin/two-step');
}

export async function acceptInviteAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const password = text(form, 'password', 256);
  if (password !== text(form, 'confirm', 256)) {
    return fail('The two passwords don’t match.', { fieldErrors: { confirm: 'The two passwords don’t match.' } });
  }
  let destination: string;
  try {
    const result = await acceptInvite(db(), text(form, 'token', 200), password);
    if (!result.ok) return fail('Check the highlighted fields.', { fieldErrors: result.errors });
    if (result.value.mfaEnabled) {
      // A reset never skips the second step: sign in with the new password and a code.
      destination = '/admin/login?password_set=1';
    } else {
      await startSession(result.value.staffId, false);
      destination = '/admin/two-step';
    }
  } catch (error) {
    return explain(error, 'admin.accept_invite_failed');
  }
  redirect(destination);
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

// Both review actions remove the form they were sent from (the flag clears),
// so their confirmation is shown by the page, not inside the form.
export async function markReviewedAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  try {
    const actor = await actorForAction();
    await markReviewed(db(), actor, id);
  } catch (error) {
    return explain(error, 'admin.mark_reviewed_failed');
  }
  revalidatePath(leadPath(id));
  redirect(`${leadPath(id)}?reviewed=kept`);
}

export async function applyDetailsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, 'leadId', 64);
  try {
    const actor = await actorForAction();
    await applyInquiryDetails(db(), actor, id, text(form, 'inquiryId', 64));
  } catch (error) {
    return explain(error, 'admin.apply_details_failed');
  }
  revalidatePath(leadPath(id));
  redirect(`${leadPath(id)}?reviewed=updated`);
}

// ── Team ─────────────────────────────────────────────────────────────────

// The token rides in the URL fragment, which browsers never send to the
// server — so it can't land in request logs or a Referer header.
function inviteLink(token: string): string {
  return `${publicBaseUrl() ?? ''}/admin/invite#token=${encodeURIComponent(token)}`;
}

/** Called by the invite page once it has read the token from the fragment. */
export async function inviteInfoAction(token: string): Promise<{ displayName: string; email: string } | null> {
  const invite = await findInvite(db(), token.slice(0, 100));
  return invite ? { displayName: invite.displayName, email: invite.email } : null;
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

// The button's own form disappears once two-step sign-in is off, so the
// confirmation is shown (and announced) by the page.
export async function resetMfaAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    const actor = await actorForAction();
    await resetMfa(db(), actor, text(form, 'staffId', 64));
  } catch (error) {
    return explain(error, 'admin.mfa_reset_failed');
  }
  revalidatePath('/admin/team');
  redirect('/admin/team?notice=mfa-reset');
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
