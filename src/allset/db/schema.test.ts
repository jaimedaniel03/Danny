/**
 * The database's own guarantees, tested against the real migration.
 *
 * Application code enforces most rules, but these are the ones the schema
 * enforces even if application code is wrong — so they get tested directly.
 */

import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';

async function insertLead(email: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const sql = db();
  const row = {
    kind: 'coverage',
    full_name: 'Test Person',
    email,
    email_normalized: email.toLowerCase(),
    zip: '60601',
    contact_method: 'email',
    coverage_interest: 'life',
    ...overrides,
  };
  const [lead] = await sql<{ id: string }[]>`insert into allset.leads ${sql(row)} returning id`;
  return lead!.id;
}

describeDb('allset schema guarantees', () => {
  it('allows only one open lead per person and kind', async () => {
    const email = uniqueEmail();
    await insertLead(email);
    await expect(insertLead(email)).rejects.toMatchObject({ code: '23505' });
    // A different kind for the same person is a different conversation.
    await expect(
      insertLead(email, { kind: 'team', coverage_interest: null, licensing_status: 'studying' }),
    ).resolves.toBeTypeOf('string');
  });

  it('permits a new open lead once the earlier one is closed', async () => {
    const email = uniqueEmail();
    const first = await insertLead(email);
    await db()`update allset.leads set status = 'closed_no_action', closed_at = now() where id = ${first}`;
    await expect(insertLead(email)).resolves.toBeTypeOf('string');
  });

  it('requires a phone number when the person chose phone or text', async () => {
    await expect(insertLead(uniqueEmail(), { contact_method: 'phone' })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insertLead(uniqueEmail(), { contact_method: 'text', phone_e164: '+13125550123' }),
    ).resolves.toBeTypeOf('string');
  });

  it('keeps closed_at in lockstep with terminal statuses', async () => {
    const id = await insertLead(uniqueEmail());
    await expect(
      db()`update allset.leads set status = 'closed_helped' where id = ${id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('treats consent evidence as immutable but deletable with its lead', async () => {
    const sql = db();
    const leadId = await insertLead(uniqueEmail());
    const [inquiry] = await sql<{ id: string }[]>`
      insert into allset.inquiries ${sql({
        reference: 'ASC-TEST-0001'.replace('TEST', 'AB12'),
        idempotency_key: crypto.randomUUID(),
        lead_id: leadId,
        kind: 'coverage',
        payload: sql.json({ zip: '60601' }),
        consent_text: 'I agree.',
        consent_version: 'test-v1',
        consented_at: new Date(),
        source_path: '/contact',
      })}
      returning id`;
    await expect(
      sql`update allset.inquiries set consent_text = 'edited' where id = ${inquiry!.id}`,
    ).rejects.toThrow(/immutable/);
    await sql`delete from allset.leads where id = ${leadId}`;
    const remaining = await sql`select 1 from allset.inquiries where id = ${inquiry!.id}`;
    expect(remaining).toHaveLength(0);
  });

  it('keeps the audit trail append-only', async () => {
    const sql = db();
    const [event] = await sql<{ id: string }[]>`
      insert into allset.audit_events (action, details) values ('test.event', '{}') returning id`;
    await expect(
      sql`update allset.audit_events set action = 'tampered' where id = ${event!.id}`,
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from allset.audit_events where id = ${event!.id}`).rejects.toThrow(
      /cannot be deleted/,
    );
  });
});

describeDb('access boundary', () => {
  let outsider: postgres.Sql | null = null;

  beforeAll(async () => {
    const admin = postgres(process.env['ALLSET_TEST_ADMIN_URL']!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'allset_outsider') then
          create role allset_outsider login password 'outsider_test_only';
        end if;
      end $$;`);
    await admin.end();
    const url = new URL(process.env['ALLSET_TEST_ADMIN_URL']!);
    url.username = 'allset_outsider';
    url.password = 'outsider_test_only';
    outsider = postgres(url.toString(), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await outsider?.end();
  });

  it('gives a role without the app grant no way into the schema', async () => {
    await expect(outsider!`select * from allset.leads`).rejects.toMatchObject({ code: '42501' });
    await expect(outsider!`select * from allset.staff_users`).rejects.toMatchObject({
      code: '42501',
    });
  });
});
