import { createHmac } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { DeliveryError, parseRetryAfter, setTransportForTests, type EmailTransport, type OutgoingEmail } from './transport';
import { ALERTS_PER_HOUR_CAP, deliverPending, enqueueLeadAlerts, retryFailed } from './outbox';
import { addRecipient, confirmRecipient } from './recipients';
import { applyDeliveryEvent, verifySvixSignature } from './webhook';
import { submitInquiry } from '@/allset/inquiries/submit';
import { hashPassword } from '@/allset/auth/password';
import type { AuditActor } from '@/allset/audit';

class Recorder implements EmailTransport {
  readonly sent: OutgoingEmail[] = [];
  constructor(private readonly fail?: DeliveryError) {}
  async send(email: OutgoingEmail) {
    if (this.fail) throw this.fail;
    this.sent.push(email);
    return { providerId: `msg_${crypto.randomUUID()}` };
  }
}

async function owner(): Promise<AuditActor> {
  const email = uniqueEmail('alerts-owner');
  const [row] = await db()<{ id: string }[]>`
    insert into allset.staff_users (email, display_name, role, password_hash)
    values (${email}, 'Alerts Owner', 'owner', ${await hashPassword('irrelevant but long')}) returning id`;
  return { id: row!.id, label: 'Alerts Owner (owner)' };
}

async function newLead(): Promise<{ leadId: string; reference: string }> {
  const email = uniqueEmail('alerted');
  const outcome = await submitInquiry(
    db(),
    { kind: 'team', fullName: 'Sam Lee', email, emailNormalized: email, zip: '10001', state: 'NY', contactMethod: 'email', phoneE164: null, coverageInterest: null, licensingStatus: 'not_licensed', disclosureAck: true },
    crypto.randomUUID(),
    { ip: `n-${email}`, ipHash: 'h', userAgent: null, sourcePath: '/team' },
  );
  if (outcome.kind !== 'accepted') throw new Error('not accepted');
  return outcome;
}

afterEach(() => setTransportForTests(null));

describeDb('alerts', () => {
  it('only alerts an address after it confirms, and the alert carries no personal data', async () => {
    const actor = await owner();
    const transport = new Recorder();
    setTransportForTests(transport);
    const address = uniqueEmail('recipient');

    const added = await addRecipient(db(), actor, address);
    expect(added.ok).toBe(true);
    await deliverPending(db());
    const confirmation = transport.sent.find((m) => m.to === address);
    expect(confirmation?.subject).toMatch(/Confirm/);
    // The token rides in the fragment, which browsers never send to a server or a log.
    const link = new URL(confirmation!.text.match(/https?:\S+/)![0]);
    expect(link.search).toBe('');
    const token = new URLSearchParams(link.hash.slice(1)).get('token')!;

    // Before confirming, a new lead queues nothing for this address.
    const before = await newLead();
    const queued = await db()`select 1 from allset.notifications where lead_id = ${before.leadId}`;
    expect(queued).toHaveLength(0);

    expect(await confirmRecipient(db(), token)).toBe('confirmed');
    expect(await confirmRecipient(db(), token)).toBe('invalid');

    const lead = await newLead();
    await deliverPending(db());
    const alert = transport.sent.find((m) => m.subject.includes(lead.reference));
    expect(alert?.to).toBe(address);
    expect(alert?.text).toContain(`/admin/leads/${lead.leadId}`);
    expect(alert?.text).not.toMatch(/Sam Lee|alerted\./);
    const [row] = await db()<{ status: string; provider_message_id: string }[]>`
      select status, provider_message_id from allset.notifications where lead_id = ${lead.leadId}`;
    expect(row?.status).toBe('sent');
    expect(row?.provider_message_id).toMatch(/^msg_/);

    // Clean up so other tests' leads don't alert this address.
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.ok ? added.id : ''}`;
  });

  it('records a visible failure when email is not configured, and can retry it', async () => {
    const actor = await owner();
    setTransportForTests(new Recorder(new DeliveryError('Email alerts are not configured: set RESEND_API_KEY and NOTIFY_FROM.', false)));
    const added = await addRecipient(db(), actor, uniqueEmail('unconfigured'));
    if (!added.ok) throw new Error('add failed');
    await deliverPending(db());
    const [row] = await db()<{ status: string; last_error: string; id: string }[]>`
      select id, status, last_error from allset.notifications where recipient_id = ${added.id}`;
    expect(row).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/not configured/) });

    setTransportForTests(new Recorder());
    expect(await retryFailed(db(), [row!.id])).toBe(1);
    await deliverPending(db());
    const [after] = await db()<{ status: string }[]>`select status from allset.notifications where id = ${row!.id}`;
    expect(after?.status).toBe('sent');
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.id}`;
  });

  it('backs off and retries transient failures before giving up', async () => {
    const actor = await owner();
    setTransportForTests(new Recorder(new DeliveryError('The email provider is busy or unavailable. (HTTP 503)', true)));
    const added = await addRecipient(db(), actor, uniqueEmail('flaky'));
    if (!added.ok) throw new Error('add failed');
    await deliverPending(db());
    const [row] = await db()<{ status: string; attempts: number; next_attempt_at: Date }[]>`
      select status, attempts, next_attempt_at from allset.notifications where recipient_id = ${added.id}`;
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.id}`;
  });

  it('refuses an expired or unknown confirmation link, and loading the page never confirms', async () => {
    const actor = await owner();
    const transport = new Recorder();
    setTransportForTests(transport);
    const address = uniqueEmail('late-confirm');
    const added = await addRecipient(db(), actor, address);
    if (!added.ok) throw new Error('add failed');
    await deliverPending(db());
    const email = transport.sent.find((m) => m.to === address)!;
    const token = new URLSearchParams(new URL(email.text.match(/https?:\S+/)![0]).hash.slice(1)).get('token')!;
    // Only the button (a POST to the confirm action) confirms; nothing else touches the row.
    const [before] = await db()<{ confirmed_at: Date | null }[]>`select confirmed_at from allset.notification_recipients where id = ${added.id}`;
    expect(before?.confirmed_at).toBeNull();
    expect(await confirmRecipient(db(), 'not-the-token')).toBe('invalid');
    await db()`update allset.notification_recipients set confirm_expires_at = now() - interval '1 minute' where id = ${added.id}`;
    expect(await confirmRecipient(db(), token)).toBe('invalid');
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.id}`;
  });

  it('rejects duplicate and malformed recipient addresses', async () => {
    const actor = await owner();
    const address = uniqueEmail('dup');
    expect((await addRecipient(db(), actor, address)).ok).toBe(true);
    expect(await addRecipient(db(), actor, address.toUpperCase())).toMatchObject({ ok: false });
    expect(await addRecipient(db(), actor, 'not-an-email')).toMatchObject({ ok: false });
    await db()`update allset.notification_recipients set disabled_at = now() where lower(email) = lower(${address})`;
  });

  async function sentNotification(): Promise<{ id: string; messageId: string }> {
    const [recipient] = await db()<{ id: string }[]>`
      insert into allset.notification_recipients (email, confirmed_at, disabled_at) values (${uniqueEmail('hook')}, now(), now()) returning id`;
    const messageId = `msg_${crypto.randomUUID()}`;
    const [n] = await db()<{ id: string }[]>`
      insert into allset.notifications (kind, recipient_id, status, provider_message_id)
      values ('recipient_confirmation', ${recipient!.id}, 'sent', ${messageId}) returning id`;
    return { id: n!.id, messageId };
  }
  const statusOf = async (id: string) =>
    (await db()<{ status: string }[]>`select status from allset.notifications where id = ${id}`)[0]?.status;
  const event = (type: string, messageId: string) => ({ type, data: { email_id: messageId } });

  it('moves an accepted alert through delayed to delivered, and never backwards', async () => {
    const n = await sentNotification();
    expect(await applyDeliveryEvent(db(), event('email.delivery_delayed', n.messageId), `evt_${crypto.randomUUID()}`)).toBe('updated');
    expect(await statusOf(n.id)).toBe('delayed');
    expect(await applyDeliveryEvent(db(), event('email.delivered', n.messageId), `evt_${crypto.randomUUID()}`)).toBe('updated');
    expect(await statusOf(n.id)).toBe('delivered');
    // A late or reordered event doesn't undo delivery.
    expect(await applyDeliveryEvent(db(), event('email.delivery_delayed', n.messageId), `evt_${crypto.randomUUID()}`)).toBe('stale');
    expect(await applyDeliveryEvent(db(), event('email.bounced', n.messageId), `evt_${crypto.randomUUID()}`)).toBe('stale');
    expect(await statusOf(n.id)).toBe('delivered');
  });

  it('applies each provider event once, however many times it arrives', async () => {
    const n = await sentNotification();
    const id = `evt_${crypto.randomUUID()}`;
    expect(await applyDeliveryEvent(db(), event('email.bounced', n.messageId), id)).toBe('updated');
    expect(await applyDeliveryEvent(db(), event('email.bounced', n.messageId), id)).toBe('duplicate');
    const [row] = await db()<{ status: string; last_error: string }[]>`select status, last_error from allset.notifications where id = ${n.id}`;
    expect(row).toMatchObject({ status: 'bounced', last_error: expect.stringMatching(/bounced/) });
  });

  it('asks for a retry when an event names a message it has not recorded yet', async () => {
    const eventId = `evt_${crypto.randomUUID()}`;
    expect(await applyDeliveryEvent(db(), event('email.delivered', 'msg_unknown'), eventId)).toBe('unknown_message');
    // Nothing was recorded, so the provider's retry will be processed.
    expect(await db()`select 1 from allset.webhook_events where event_id = ${eventId}`).toHaveLength(0);
  });

  it('records a spam complaint without pretending the alert was not delivered', async () => {
    const n = await sentNotification();
    await applyDeliveryEvent(db(), event('email.delivered', n.messageId), `evt_${crypto.randomUUID()}`);
    expect(await applyDeliveryEvent(db(), event('email.complained', n.messageId), `evt_${crypto.randomUUID()}`)).toBe('updated');
    const [row] = await db()<{ status: string; last_error: string }[]>`select status, last_error from allset.notifications where id = ${n.id}`;
    expect(row).toMatchObject({ status: 'delivered', last_error: expect.stringMatching(/spam/) });
  });

  it('keeps one idempotency key and one confirmation link across retries', async () => {
    const actor = await owner();
    const flaky = new Recorder(new DeliveryError('Could not reach the email provider (network error or timeout).', true));
    const seen: OutgoingEmail[] = [];
    setTransportForTests({
      send: async (email) => {
        seen.push(email);
        return flaky.send(email);
      },
    });
    const added = await addRecipient(db(), actor, uniqueEmail('stable'));
    if (!added.ok) throw new Error('add failed');
    await deliverPending(db());
    await db()`update allset.notifications set next_attempt_at = now() where recipient_id = ${added.id}`;
    const recorder = new Recorder();
    setTransportForTests({
      send: async (email) => {
        seen.push(email);
        return recorder.send(email);
      },
    });
    await deliverPending(db());
    expect(seen).toHaveLength(2);
    expect(seen[1]!.idempotencyKey).toBe(seen[0]!.idempotencyKey);
    expect(seen[1]!.text).toBe(seen[0]!.text);
    // The link from the first (possibly delivered) attempt still confirms.
    const token = new URLSearchParams(new URL(seen[0]!.text.match(/https?:\S+/)![0]).hash.slice(1)).get('token')!;
    expect(await confirmRecipient(db(), token)).toBe('confirmed');
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.id}`;
  });

  it('waits at least as long as the provider asks after a 429', async () => {
    const actor = await owner();
    setTransportForTests(new Recorder(new DeliveryError('The email provider is busy or unavailable. (HTTP 429)', true, 45 * 60)));
    const added = await addRecipient(db(), actor, uniqueEmail('limited'));
    if (!added.ok) throw new Error('add failed');
    const before = Date.now();
    await deliverPending(db());
    const [row] = await db()<{ status: string; next_attempt_at: Date }[]>`
      select status, next_attempt_at from allset.notifications where recipient_id = ${added.id}`;
    expect(row?.status).toBe('pending');
    // The first backoff step is 1 minute; the provider asked for 45.
    expect(row!.next_attempt_at.getTime() - before).toBeGreaterThanOrEqual(44 * 60 * 1000);
    await db()`update allset.notification_recipients set disabled_at = now() where id = ${added.id}`;
  });

  it('stops queuing alert emails past the hourly ceiling, and records that it did', async () => {
    const lead = await newLead();
    class Rollback extends Error {}
    // Done inside a transaction that is rolled back, so the flood is invisible to other tests.
    await db()
      .begin(async (tx) => {
        const [recipient] = await tx<{ id: string }[]>`
          insert into allset.notification_recipients (email, confirmed_at) values (${uniqueEmail('flood')}, now()) returning id`;
        await tx`
          insert into allset.notifications (kind, recipient_id, subject_ref)
          select 'lead_received', ${recipient!.id}, 'ASC-0000-0000' from generate_series(1, ${ALERTS_PER_HOUR_CAP})`;
        expect(await enqueueLeadAlerts(tx, lead.leadId, lead.reference)).toBe(0);
        const [event] = await tx<{ details: Record<string, unknown> }[]>`
          select details from allset.audit_events where action = 'alerts.throttled' and entity_ref = ${lead.reference}`;
        expect(event?.details).toEqual({ cap: ALERTS_PER_HOUR_CAP });
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  });
});

it('verifies Svix webhook signatures and rejects tampering and replays', () => {
  const secret = `whsec_${Buffer.from('super-secret-signing-key').toString('base64')}`;
  const payload = '{"type":"email.delivered","data":{"email_id":"abc"}}';
  const id = 'msg_1';
  const now = 1_790_000_000;
  const sign = (body: string, ts: number) =>
    `v1,${createHmac('sha256', Buffer.from('super-secret-signing-key')).update(`${id}.${ts}.${body}`).digest('base64')}`;
  const headers = (ts: number, sig: string) => ({ id, timestamp: String(ts), signature: sig });

  expect(verifySvixSignature(secret, headers(now, sign(payload, now)), payload, now)).toBe(true);
  expect(verifySvixSignature(secret, headers(now, `v1,bogus ${sign(payload, now)}`), payload, now)).toBe(true);
  expect(verifySvixSignature(secret, headers(now, sign(payload, now)), payload.replace('abc', 'xyz'), now)).toBe(false);
  expect(verifySvixSignature(secret, headers(now - 3600, sign(payload, now - 3600)), payload, now)).toBe(false);
  expect(verifySvixSignature(secret, { id: null, timestamp: null, signature: null }, payload, now)).toBe(false);
});

it('reads Retry-After as seconds or a date, and ignores nonsense', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  expect(parseRetryAfter('120', now)).toBe(120);
  expect(parseRetryAfter('Sat, 26 Sep 2026 12:05:00 GMT', now)).toBe(300);
  expect(parseRetryAfter('Sat, 26 Sep 2026 11:00:00 GMT', now)).toBeNull();
  expect(parseRetryAfter('soon', now)).toBeNull();
  expect(parseRetryAfter(null, now)).toBeNull();
  expect(parseRetryAfter('999999', now)).toBe(6 * 60 * 60);
});
