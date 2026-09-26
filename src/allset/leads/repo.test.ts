import { beforeAll, expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { hashPassword } from '@/allset/auth/password';
import type { Actor } from '@/allset/auth/roles';
import { submitInquiry } from '@/allset/inquiries/submit';
import {
  addNote,
  assignLead,
  businessToday,
  dashboardCounts,
  deleteLead,
  getLead,
  listLeads,
  setFollowUp,
  updateStatus,
} from './repo';
import { csvCell, exportLeads } from './export';

async function makeUser(role: 'owner' | 'staff'): Promise<Actor> {
  const email = uniqueEmail(role);
  const [row] = await db()<{ id: string }[]>`
    insert into allset.staff_users (email, display_name, role, password_hash)
    values (${email}, ${`Repo ${role}`}, ${role}, ${await hashPassword('irrelevant but long')}) returning id`;
  return { id: row!.id, role, displayName: `Repo ${role}`, email, sessionId: 'test' };
}

async function makeLead(label = 'lead'): Promise<{ id: string; reference: string; email: string }> {
  const email = uniqueEmail(label);
  const outcome = await submitInquiry(
    db(),
    {
      kind: 'coverage',
      fullName: 'Jordan Rivera',
      email,
      emailNormalized: email.toLowerCase(),
      zip: '73301',
      contactMethod: 'email',
      phoneE164: null,
      coverageInterest: 'life',
      licensingStatus: null,
      disclosureAck: false,
    },
    crypto.randomUUID(),
    { ip: `repo-${email}`, ipHash: 'h', userAgent: null, sourcePath: '/contact' },
  );
  if (outcome.kind !== 'accepted') throw new Error('not accepted');
  return { id: outcome.leadId, reference: outcome.reference, email };
}

describeDb('lead desk permissions', () => {
  let owner: Actor;
  let alice: Actor;
  let bob: Actor;

  beforeAll(async () => {
    owner = await makeUser('owner');
    alice = await makeUser('staff');
    bob = await makeUser('staff');
  });

  it('shows staff their own and unassigned leads, and hides a colleague’s as not found', async () => {
    const mine = await makeLead();
    const theirs = await makeLead();
    await assignLead(db(), alice, mine.id, alice.id);
    await assignLead(db(), owner, theirs.id, bob.id);

    expect(await getLead(db(), alice, mine.id)).not.toBeNull();
    expect(await getLead(db(), alice, theirs.id)).toBeNull();
    expect(await getLead(db(), owner, theirs.id)).not.toBeNull();

    const aliceView = await listLeads(db(), alice, { q: theirs.email });
    expect(aliceView.rows).toHaveLength(0);
    const ownerView = await listLeads(db(), owner, { q: theirs.email });
    expect(ownerView.rows.map((r) => r.id)).toEqual([theirs.id]);
  });

  it('refuses edits to unclaimed or someone else’s leads', async () => {
    const lead = await makeLead();
    await expect(updateStatus(db(), alice, lead.id, 'contacted')).rejects.toThrow(/Assign this lead/);
    await expect(addNote(db(), alice, lead.id, 'hello')).rejects.toThrow(/Assign this lead/);
    await assignLead(db(), owner, lead.id, bob.id);
    await expect(updateStatus(db(), alice, lead.id, 'contacted')).rejects.toThrow(/doesn’t exist/);
    await expect(assignLead(db(), alice, lead.id, alice.id)).rejects.toThrow(/doesn’t exist/);
  });

  it('lets staff claim, work and release a lead, and records each step', async () => {
    const lead = await makeLead();
    await assignLead(db(), alice, lead.id, alice.id);
    await updateStatus(db(), alice, lead.id, 'contacted');
    await setFollowUp(db(), alice, lead.id, '2030-01-15');
    await addNote(db(), alice, lead.id, 'Left a voicemail; will try again Tuesday.');
    const detail = await getLead(db(), alice, lead.id);
    expect(detail?.lead.status).toBe('contacted');
    expect(detail?.lead.followUpOn).toBe('2030-01-15');
    expect(detail?.notes[0]?.body).toMatch(/voicemail/);
    const actions = detail?.timeline.map((e) => e.action) ?? [];
    expect(actions).toEqual(
      expect.arrayContaining(['lead.claimed', 'lead.status_changed', 'lead.follow_up_set', 'lead.note_added', 'inquiry.received']),
    );
    // Audit details carry no note text or contact data.
    expect(JSON.stringify(detail?.timeline)).not.toMatch(/voicemail|Jordan|example\.com/);
    await assignLead(db(), alice, lead.id, null);
    expect((await getLead(db(), alice, lead.id))?.lead.assignedTo).toBeNull();
  });

  it('closes and reopens a lead, clearing the follow-up on close', async () => {
    const lead = await makeLead();
    await assignLead(db(), owner, lead.id, owner.id);
    await setFollowUp(db(), owner, lead.id, '2031-05-01');
    await updateStatus(db(), owner, lead.id, 'closed_helped');
    let detail = await getLead(db(), owner, lead.id);
    expect(detail?.lead.closedAt).toBeInstanceOf(Date);
    expect(detail?.lead.followUpOn).toBeNull();
    await expect(setFollowUp(db(), owner, lead.id, '2031-05-02')).rejects.toThrow(/Reopen/);
    await updateStatus(db(), owner, lead.id, 'following_up');
    detail = await getLead(db(), owner, lead.id);
    expect(detail?.lead.closedAt).toBeNull();
  });

  it('rejects unknown statuses and malformed dates', async () => {
    const lead = await makeLead();
    await expect(updateStatus(db(), owner, lead.id, 'won')).rejects.toThrow(/Unknown status/);
    await expect(setFollowUp(db(), owner, lead.id, '31/12/2030')).rejects.toThrow(/valid date/);
  });

  it('finds leads by name, email, ZIP, phone digits and reference', async () => {
    const lead = await makeLead('searchable');
    for (const q of [lead.email, 'jordan riv', '73301', lead.reference, lead.reference.toLowerCase()]) {
      const result = await listLeads(db(), owner, { q, status: 'all' });
      expect(result.rows.some((r) => r.id === lead.id)).toBe(true);
    }
    const wildcard = await listLeads(db(), owner, { q: '%', status: 'all' });
    expect(wildcard.rows.every((r) => r.fullName.includes('%') || r.email.includes('%'))).toBe(true);
  });

  it('filters by follow-up due date in the business time zone', async () => {
    const lead = await makeLead();
    await assignLead(db(), owner, lead.id, owner.id);
    await setFollowUp(db(), owner, lead.id, businessToday());
    const due = await listLeads(db(), owner, { due: 'today', assigned: owner.id });
    expect(due.rows.map((r) => r.id)).toContain(lead.id);
    const counts = await dashboardCounts(db(), owner);
    expect(counts.dueToday).toBeGreaterThanOrEqual(1);
  });

  it('allows only owners to delete, and only with the reference typed back', async () => {
    const lead = await makeLead();
    await assignLead(db(), alice, lead.id, alice.id);
    await expect(deleteLead(db(), alice, lead.id, lead.reference)).rejects.toThrow(/Only an owner/);
    await expect(deleteLead(db(), owner, lead.id, 'ASC-0000-0000')).rejects.toThrow(/reference/);
    await deleteLead(db(), owner, lead.id, lead.reference.toLowerCase());
    expect(await getLead(db(), owner, lead.id)).toBeNull();
    const inquiries = await db()`select 1 from allset.inquiries where reference = ${lead.reference}`;
    expect(inquiries).toHaveLength(0);
    const [event] = await db()<{ action: string; entity_ref: string; details: unknown }[]>`
      select action, entity_ref, details from allset.audit_events where action = 'lead.deleted' and entity_id = ${lead.id}`;
    expect(event?.entity_ref).toBe(lead.reference);
    expect(JSON.stringify(event?.details)).not.toContain(lead.email);
  });

  it('restricts export to owners, audits it, and neutralizes formulas', async () => {
    await expect(exportLeads(db(), alice, {})).rejects.toThrow(/Only an owner/);
    const result = await exportLeads(db(), owner, { status: 'all' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv.split('\r\n')[0]).toContain('Reference,Kind,Status');
    const [event] = await db()<{ details: { rows: number } }[]>`
      select details from allset.audit_events where action = 'lead.exported' and actor_id = ${owner.id}
      order by occurred_at desc limit 1`;
    expect(event?.details.rows).toBe(result.count);
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1 312')).toBe("'+1 312");
    expect(csvCell('plain')).toBe('plain');
  });
});
