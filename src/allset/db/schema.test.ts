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
    state: 'IL',
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
        consent_channels: sql.array(['email']),
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

  it('records consent channels only from the allowed set', async () => {
    const sql = db();
    const leadId = await insertLead(uniqueEmail());
    const row = (channels: string[]) => ({
      reference: `ASC-${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[ILOU]/g, 'A')}-AB12`,
      idempotency_key: crypto.randomUUID(),
      lead_id: leadId,
      kind: 'coverage',
      payload: sql.json({ zip: '60601' }),
      consent_text: 'I agree.',
      consent_version: 'test-v1',
      consented_at: new Date(),
      consent_channels: sql.array(channels),
      source_path: '/contact',
    });
    await expect(sql`insert into allset.inquiries ${sql(row(['fax']))}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`insert into allset.inquiries ${sql(row([]))}`).rejects.toMatchObject({ code: '23514' });
    await sql`delete from allset.leads where id = ${leadId}`;
  });

  it('accepts a do-not-contact entry only with a stated basis', async () => {
    const sql = db();
    await expect(
      sql`insert into allset.contact_suppressions (value_hash, kind, basis) values (${crypto.randomUUID()}, 'email', 'just_because')`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`insert into allset.contact_suppressions (value_hash, kind) values (${crypto.randomUUID()}, 'email')`,
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('refuses a lead without a valid state', async () => {
    await expect(insertLead(uniqueEmail(), { state: 'Illinois' })).rejects.toMatchObject({ code: '23514' });
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

  it('gives a role without the app grant no way into any table', async () => {
    const tables = [
      'staff_users', 'staff_sessions', 'staff_devices', 'staff_mfa_challenges', 'staff_recovery_codes',
      'leads', 'inquiries', 'lead_notes', 'audit_events', 'rate_limits', 'notification_recipients',
      'notifications', 'webhook_events', 'contact_suppressions',
    ];
    for (const table of tables) {
      await expect(outsider!.unsafe(`select * from allset.${table} limit 1`), table).rejects.toMatchObject({ code: '42501' });
      await expect(outsider!.unsafe(`delete from allset.${table}`), table).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('forces row-level security on every table, with a policy only for the app role', async () => {
    const admin = postgres(process.env['ALLSET_TEST_ADMIN_URL']!, { max: 1, onnotice: () => {} });
    try {
      const rows = await admin<{ relname: string; rls: boolean; forced: boolean; policies: string[] }[]>`
        select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
               coalesce(array_agg(p.polname) filter (where p.polname is not null), '{}') as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'allset' and c.relkind = 'r'
        group by c.relname, c.relrowsecurity, c.relforcerowsecurity`;
      expect(rows.length).toBeGreaterThanOrEqual(14);
      for (const row of rows) {
        expect(row, row.relname).toMatchObject({ rls: true, forced: true, policies: ['allset_app_only'] });
      }
    } finally {
      await admin.end();
    }
  });
});
