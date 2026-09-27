import type { Metadata } from 'next';
import { requireOwnerPage } from '@/allset/auth/session-cookie';
import { db } from '@/allset/db/client';
import { emailConfig, resendWebhookSecret } from '@/allset/env';
import { listRecipients } from '@/allset/notifications/recipients';
import { notificationHealth } from '@/allset/notifications/outbox';
import { ActionForm, Submit } from '@/components/admin/ActionForm';
import { formatDateTime } from '@/components/admin/format';
import {
  addRecipientAction,
  removeRecipientAction,
  resendConfirmationAction,
  retryFailedAction,
  sendTestAlertAction,
} from '@/allset/admin/actions';

export const metadata: Metadata = { title: 'Alerts' };

const STATUS_TEXT: Record<string, string> = {
  pending: 'Queued',
  sending: 'Sending',
  sent: 'Accepted by the email provider — delivery not yet confirmed',
  delayed: 'Delivery delayed — the provider is still trying',
  delivered: 'Delivered (confirmed by the provider)',
  bounced: 'Bounced',
  failed: 'Failed',
  canceled: 'Canceled before sending',
};

const KIND_TEXT: Record<string, string> = {
  lead_received: 'New inquiry',
  recipient_confirmation: 'Confirmation email',
  test_alert: 'Test alert',
};

export default async function AlertsPage() {
  await requireOwnerPage('alerts.manage', '/admin/alerts');
  const sql = db();
  const recipients = await listRecipients(sql);
  const health = await notificationHealth(sql);
  const log = await sql<
    { id: string; kind: string; status: string; attempts: number; last_error: string | null; created_at: Date; email: string; subject_ref: string | null }[]
  >`
    select n.id, n.kind, n.status, n.attempts, n.last_error, n.created_at, r.email, n.subject_ref
    from allset.notifications n join allset.notification_recipients r on r.id = n.recipient_id
    order by n.created_at desc limit 50`;
  const configured = emailConfig() !== null;

  return (
    <>
      <h1 className="admin-title">New-inquiry alerts</h1>
      <p className="admin-sub">
        When someone sends a form, each confirmed address below gets a short email with a reference
        number and a link here — never the person’s details. Every request is saved and visible in
        Leads whether or not an email goes out.
      </p>

      {!configured ? (
        <div className="notice notice--error" role="alert">
          <p className="notice__title">Email is not configured on this deployment</p>
          <p>
            Set <code>RESEND_API_KEY</code> and <code>NOTIFY_FROM</code> (a sender on a domain verified with
            Resend). Until then every alert fails, and each failure is listed below.
          </p>
        </div>
      ) : null}
      {configured && !resendWebhookSecret() ? (
        <p className="notice notice--warning">
          Delivery tracking is off: without <code>RESEND_WEBHOOK_SECRET</code>, alerts show as “accepted by the
          email provider” but never as “delivered” or “bounced”.
        </p>
      ) : null}

      <section className="panel" aria-labelledby="recipients-title">
        <h2 id="recipients-title" className="panel__title">
          Recipients ({health.confirmedRecipients} confirmed)
        </h2>
        <ActionForm action={addRecipientAction} className="inline-form" aria-label="Add a recipient">
          <div className="field">
            <label className="field__label" htmlFor="recipient-email">
              Email address
            </label>
            <input id="recipient-email" name="email" type="email" className="input" autoComplete="off" required />
          </div>
          <Submit>Add and send confirmation</Submit>
        </ActionForm>
        {recipients.length === 0 ? (
          <p className="muted">No recipients yet.</p>
        ) : (
          <ul role="list" className="stack">
            {recipients.map((r) => (
              <li key={r.id} className="inline-form">
                <span className="inline-form__grow">
                  <strong>{r.email}</strong>
                  <br />
                  <span className="muted">
                    {r.disabledAt
                      ? 'Removed'
                      : r.confirmedAt
                        ? `Confirmed ${formatDateTime(r.confirmedAt)}`
                        : 'Waiting for confirmation'}
                    {r.lastError && !r.disabledAt ? ` · last problem: ${r.lastError}` : ''}
                  </span>
                </span>
                {!r.disabledAt && !r.confirmedAt ? (
                  <ActionForm action={resendConfirmationAction} aria-label={`Resend confirmation to ${r.email}`}>
                    <input type="hidden" name="recipientId" value={r.id} />
                    <Submit variant="secondary">Resend confirmation</Submit>
                  </ActionForm>
                ) : null}
                {!r.disabledAt ? (
                  <ActionForm action={removeRecipientAction} aria-label={`Remove ${r.email}`}>
                    <input type="hidden" name="recipientId" value={r.id} />
                    <Submit variant="quiet">Remove</Submit>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="verify-title">
        <h2 id="verify-title" className="panel__title">
          Check that alerts arrive
        </h2>
        <p>
          {health.pending} queued · {health.awaitingDelivery} accepted, awaiting delivery confirmation · {health.failed} failed or bounced
          {health.lastFailureReason ? ` · last problem: ${health.lastFailureReason}` : ''}
        </p>
        <div className="inline-form">
          <ActionForm action={sendTestAlertAction} aria-label="Send a test alert">
            <Submit>Send a test alert</Submit>
          </ActionForm>
          <ActionForm action={retryFailedAction} aria-label="Retry failed alerts">
            <Submit variant="secondary">Retry failed alerts now</Submit>
          </ActionForm>
        </div>
      </section>

      <section aria-labelledby="log-title">
        <h2 id="log-title" className="panel__title">
          Delivery log (latest 50)
        </h2>
        {log.length === 0 ? (
          <p className="muted">Nothing sent yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption className="visually-hidden">Recent alert deliveries</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What</th>
                  <th scope="col">To</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {log.map((n) => (
                  <tr key={n.id}>
                    <td data-label="When">{formatDateTime(n.created_at)}</td>
                    <td data-label="What">
                      {KIND_TEXT[n.kind] ?? n.kind}
                      {n.subject_ref ? ` · ${n.subject_ref}` : ''}
                    </td>
                    <td data-label="To">{n.email}</td>
                    <td data-label="Result">
                      <span className={n.status === 'failed' || n.status === 'bounced' ? 'tag tag--dnc' : n.status === 'delivered' ? 'tag tag--open' : 'tag tag--closed'}>
                        {STATUS_TEXT[n.status] ?? n.status}
                      </span>
                      {n.last_error ? <div className="muted">{n.last_error}</div> : null}
                      {n.attempts > 1 ? <div className="muted">{n.attempts} attempts</div> : null}
                    </td>
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
