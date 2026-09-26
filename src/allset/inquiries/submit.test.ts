import { beforeEach, expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { submitInquiry, type SubmitContext } from './submit';
import { consentWording } from './consent';
import type { ValidInquiry } from './fields';

let ctxCounter = 0;
function ctx(): SubmitContext {
  ctxCounter += 1;
  // A distinct IP per test keeps per-IP limits from bleeding between tests.
  return { ip: `198.51.100.${ctxCounter}-${process.pid}-${Date.now()}`, ipHash: 'hash', userAgent: 'vitest', sourcePath: '/contact' };
}

function inquiry(email: string, over: Partial<ValidInquiry> = {}): ValidInquiry {
  return {
    kind: 'coverage',
    fullName: 'Test Person',
    email,
    emailNormalized: email.toLowerCase(),
    zip: '60601',
    contactMethod: 'email',
    phoneE164: null,
    coverageInterest: 'life',
    licensingStatus: null,
    disclosureAck: false,
    ...over,
  };
}

describeDb('saving an inquiry', () => {
  let context: SubmitContext;
  beforeEach(() => {
    context = ctx();
  });

  it('saves the lead, the inquiry and its consent evidence before reporting success', async () => {
    const email = uniqueEmail();
    const outcome = await submitInquiry(db(), inquiry(email), crypto.randomUUID(), context);
    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.reference).toMatch(/^ASC-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const [row] = await db()<{ consent_text: string; consent_version: string; consented_at: Date; status: string }[]>`
      select i.consent_text, i.consent_version, i.consented_at, l.status
      from allset.inquiries i join allset.leads l on l.id = i.lead_id
      where i.reference = ${outcome.reference}`;
    const wording = consentWording('coverage');
    expect(row?.consent_text).toBe(wording.text);
    expect(row?.consent_version).toBe(wording.version);
    expect(row?.consented_at).toBeInstanceOf(Date);
    expect(row?.status).toBe('new');
  });

  it('returns the original reference for a retry with the same idempotency key', async () => {
    const email = uniqueEmail();
    const key = crypto.randomUUID();
    const first = await submitInquiry(db(), inquiry(email), key, context);
    const second = await submitInquiry(db(), inquiry(email), key, context);
    expect(first.kind === 'accepted' && second.kind === 'accepted').toBe(true);
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;
    expect(second.reference).toBe(first.reference);
    expect(second.replay).toBe(true);
    const rows = await db()`select 1 from allset.inquiries where idempotency_key = ${key}`;
    expect(rows).toHaveLength(1);
  });

  it('handles a double submit racing on the same key without duplicating anything', async () => {
    const email = uniqueEmail();
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
      submitInquiry(db(), inquiry(email), key, context),
      submitInquiry(db(), inquiry(email), key, context),
    ]);
    expect(a.kind === 'accepted' && b.kind === 'accepted' && a.reference === b.reference).toBe(true);
    const [lead] = await db()<{ n: number; submissions: number }[]>`
      select count(*)::int as n, max(submission_count)::int as submissions
      from allset.leads where email_normalized = ${email.toLowerCase()}`;
    expect(lead?.n).toBe(1);
    expect(lead?.submissions).toBe(1);
  });

  it('folds a second submission from the same person into their open lead', async () => {
    const email = uniqueEmail();
    const first = await submitInquiry(db(), inquiry(email), crypto.randomUUID(), context);
    const second = await submitInquiry(
      db(),
      inquiry(email.toUpperCase(), { contactMethod: 'text', phoneE164: '+13125550199', coverageInterest: 'health' }),
      crypto.randomUUID(),
      context,
    );
    expect(first.kind === 'accepted' && second.kind === 'accepted').toBe(true);
    if (first.kind !== 'accepted' || second.kind !== 'accepted') return;
    expect(second.leadId).toBe(first.leadId);
    expect(second.merged).toBe(true);
    expect(second.reference).not.toBe(first.reference);
    const [lead] = await db()<{ submission_count: number; contact_method: string; phone_e164: string }[]>`
      select submission_count, contact_method, phone_e164 from allset.leads where id = ${first.leadId}`;
    expect(lead).toMatchObject({ submission_count: 2, contact_method: 'text', phone_e164: '+13125550199' });
  });

  it('keeps coverage and team inquiries from the same person separate', async () => {
    const email = uniqueEmail();
    const coverage = await submitInquiry(db(), inquiry(email), crypto.randomUUID(), context);
    const team = await submitInquiry(
      db(),
      inquiry(email, { kind: 'team', coverageInterest: null, licensingStatus: 'studying', disclosureAck: true }),
      crypto.randomUUID(),
      { ...context, sourcePath: '/team' },
    );
    expect(coverage.kind === 'accepted' && team.kind === 'accepted' && coverage.leadId !== team.leadId).toBe(true);
  });

  it('queues an alert for each confirmed recipient in the same transaction', async () => {
    const sql = db();
    const [recipient] = await sql<{ id: string }[]>`
      insert into allset.notification_recipients (email, confirmed_at) values (${uniqueEmail('alerts')}, now()) returning id`;
    const outcome = await submitInquiry(sql, inquiry(uniqueEmail()), crypto.randomUUID(), context);
    if (outcome.kind !== 'accepted') throw new Error('expected accepted');
    const alerts = await sql<{ status: string; subject_ref: string }[]>`
      select status, subject_ref from allset.notifications where lead_id = ${outcome.leadId} and recipient_id = ${recipient!.id}`;
    expect(alerts).toEqual([{ status: 'pending', subject_ref: outcome.reference }]);
    await sql`update allset.notification_recipients set disabled_at = now() where id = ${recipient!.id}`;
  });

  it('rate-limits repeated submissions from one connection without saving them', async () => {
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await submitInquiry(db(), inquiry(uniqueEmail()), crypto.randomUUID(), context));
    }
    expect(results.slice(0, 5).every((r) => r.kind === 'accepted')).toBe(true);
    expect(results[5]?.kind).toBe('rate_limited');
  });

  it('rejects a malformed idempotency key', async () => {
    await expect(submitInquiry(db(), inquiry(uniqueEmail()), 'not-a-uuid', context)).rejects.toThrow();
  });

  it('writes an audit event without personal data', async () => {
    const email = uniqueEmail();
    const outcome = await submitInquiry(db(), inquiry(email), crypto.randomUUID(), context);
    if (outcome.kind !== 'accepted') throw new Error('expected accepted');
    const [event] = await db()<{ action: string; details: Record<string, unknown> }[]>`
      select action, details from allset.audit_events where entity_ref = ${outcome.reference}`;
    expect(event?.action).toBe('inquiry.received');
    expect(JSON.stringify(event?.details)).not.toContain(email);
  });
});
