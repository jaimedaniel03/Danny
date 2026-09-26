import type { Metadata } from 'next';
import { requireOwnerPage } from '@/allset/auth/session-cookie';
import { db } from '@/allset/db/client';
import { adminSetupToken, cronSecret, emailConfig, publicBaseUrl, resendWebhookSecret, siteIndexable } from '@/allset/env';
import { isLaunchReady, launchChecklist } from '@/allset/content/facts';
import { notificationHealth } from '@/allset/notifications/outbox';

export const metadata: Metadata = { title: 'Launch checklist' };

interface RuntimeCheck {
  readonly label: string;
  readonly done: boolean;
  readonly why: string;
}

export default async function LaunchPage() {
  await requireOwnerPage('launch.view', '/admin/launch');
  const facts = launchChecklist();
  const health = await notificationHealth(db());

  const runtime: RuntimeCheck[] = [
    { label: 'Email alerts configured (RESEND_API_KEY, NOTIFY_FROM)', done: emailConfig() !== null, why: 'Without it, nobody is emailed about new requests.' },
    { label: 'At least one confirmed alert recipient', done: health.confirmedRecipients > 0, why: 'Alerts go only to addresses that confirmed.' },
    { label: 'Delivery tracking webhook secret set (RESEND_WEBHOOK_SECRET)', done: Boolean(resendWebhookSecret()), why: 'Lets the desk show “delivered” and “bounced”, not just “sent”.' },
    { label: 'Scheduled jobs secret set (CRON_SECRET)', done: Boolean(cronSecret()), why: 'Retries alerts and runs the retention purge daily.' },
    { label: 'Public address set (PUBLIC_BASE_URL)', done: Boolean(publicBaseUrl()), why: 'Used in emailed links and search metadata.' },
    { label: 'Setup token removed (ADMIN_SETUP_TOKEN)', done: !adminSetupToken(), why: 'The first owner exists; the bootstrap secret should not linger.' },
    { label: 'Indexing switched on (SITE_INDEXABLE=true)', done: siteIndexable(), why: 'Only after every required fact below is verified.' },
  ];

  return (
    <>
      <h1 className="admin-title">Launch checklist</h1>
      <p className="admin-sub">
        The site shows only verified business facts and hides anything unconfirmed. Until every
        required item is done it tells search engines not to index it, even if indexing is switched on.
      </p>
      <p className={`notice ${isLaunchReady() ? 'notice--success' : 'notice--warning'}`} role="status">
        {isLaunchReady()
          ? 'Every required business fact is verified.'
          : 'Not ready for public launch: required business facts are missing.'}
      </p>

      <section className="panel" aria-labelledby="facts-title">
        <h2 id="facts-title" className="panel__title">
          Business facts (edit src/allset/content/facts.ts with who verified each one, when, and the source)
        </h2>
        <ul role="list" className="checklist">
          {facts.map((item) => (
            <li key={item.key}>
              <span
                className={`check-state ${item.done ? 'check-state--done' : item.requiredForLaunch ? 'check-state--todo' : 'check-state--optional'}`}
                aria-hidden="true"
              >
                {item.done ? '✓' : item.requiredForLaunch ? '!' : '–'}
              </span>
              <span>
                <strong>{item.label}</strong>{' '}
                <span className="muted">
                  ({item.done ? 'verified' : item.requiredForLaunch ? 'required, missing' : 'optional, missing'})
                </span>
                <br />
                <span className="fine-print">{item.why}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" aria-labelledby="runtime-title">
        <h2 id="runtime-title" className="panel__title">
          Deployment settings
        </h2>
        <ul role="list" className="checklist">
          {runtime.map((item) => (
            <li key={item.label}>
              <span className={`check-state ${item.done ? 'check-state--done' : 'check-state--todo'}`} aria-hidden="true">
                {item.done ? '✓' : '!'}
              </span>
              <span>
                <strong>{item.label}</strong> <span className="muted">({item.done ? 'done' : 'not done'})</span>
                <br />
                <span className="fine-print">{item.why}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
