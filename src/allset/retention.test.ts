import { expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { RETENTION, runRetention } from './retention';

describeDb('retention', () => {
  it('deletes leads past the retention window with their inquiries, and keeps recent ones', async () => {
    const sql = db();
    const insert = async (monthsAgo: number) => {
      const email = uniqueEmail('retention');
      const [lead] = await sql<{ id: string }[]>`
        insert into allset.leads (kind, full_name, email, email_normalized, zip, state, contact_method, coverage_interest, last_activity_at)
        values ('coverage', 'Old Lead', ${email}, ${email}, '60601', 'IL', 'email', 'life', now() - make_interval(months => ${monthsAgo}))
        returning id`;
      return lead!.id;
    };
    const old = await insert(RETENTION.leadMonthsAfterLastActivity + 1);
    const recent = await insert(RETENTION.leadMonthsAfterLastActivity - 1);
    const report = await runRetention(sql);
    expect(report.leadsDeleted).toBeGreaterThanOrEqual(1);
    expect(await sql`select 1 from allset.leads where id = ${old}`).toHaveLength(0);
    expect(await sql`select 1 from allset.leads where id = ${recent}`).toHaveLength(1);
    const [event] = await sql<{ action: string }[]>`
      select action from allset.audit_events where action = 'retention.run' order by occurred_at desc limit 1`;
    expect(event?.action).toBe('retention.run');
  });
});
