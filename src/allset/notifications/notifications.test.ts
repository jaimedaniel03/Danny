import { createHmac } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { DeliveryError, setTransportForTests, type EmailTransport, type OutgoingEmail } from './transport';
import { deliverPending, retryFailed } from './outbox';
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
    { kind: 'team', fullName: 'Sam Lee', email, emailNormalized: email, zip: '10001', contactMethod: 'email', phoneE164: null, coverageInterest: null, licensingStatus: 'not_licensed', disclosureAck: true },
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
    const token = new URL(confirmation!.text.match(/https?:\S+/)![0]).searchParams.get('token')!;

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

  it('rejects duplicate and malformed recipient addresses', async () => {
    const actor = await owner();
    const address = uniqueEmail('dup');
    expect((await addRecipient(db(), actor, address)).ok).toBe(true);
    expect(await addRecipient(db(), actor, address.toUpperCase())).toMatchObject({ ok: false });
    expect(await addRecipient(db(), actor, 'not-an-email')).toMatchObject({ ok: false });
    await db()`update allset.notification_recipients set disabled_at = now() where lower(email) = lower(${address})`;
  });

  it('marks alerts delivered or bounced from provider events', async () => {
    const [recipient] = await db()<{ id: string }[]>`
      insert into allset.notification_recipients (email, confirmed_at, disabled_at) values (${uniqueEmail('hook')}, now(), now()) returning id`;
    const messageId = `msg_${crypto.randomUUID()}`;
    const [n] = await db()<{ id: string }[]>`
      insert into allset.notifications (kind, recipient_id, status, provider_message_id)
      values ('recipient_confirmation', ${recipient!.id}, 'sent', ${messageId}) returning id`;
    expect(await applyDeliveryEvent(db(), { type: 'email.delivered', data: { email_id: messageId } })).toBe('updated');
    expect(await applyDeliveryEvent(db(), { type: 'email.bounced', data: { email_id: messageId } })).toBe('updated');
    const [row] = await db()<{ status: string; last_error: string }[]>`select status, last_error from allset.notifications where id = ${n!.id}`;
    expect(row).toMatchObject({ status: 'bounced', last_error: expect.stringMatching(/bounced/) });
    expect(await applyDeliveryEvent(db(), { type: 'email.delivered', data: { email_id: 'msg_unknown' } })).toBe('unknown_message');
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
