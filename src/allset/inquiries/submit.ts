/**
 * Saving an inquiry. The order of operations is the point:
 *
 *   1. Replay check — a retry with the same idempotency key gets the original
 *      reference back and writes nothing.
 *   2. Rate limits — per hashed IP and per hashed email.
 *   3. One transaction: fold into the person's open lead (or open one), store
 *      the inquiry with its consent evidence, queue alerts, audit. Commit.
 *   4. Only then report success.
 *
 * Nothing about delivery (email alerts) can make step 3 fail: the alerts are
 * rows in the same transaction, sent afterwards.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { newReference } from '@/allset/crypto';
import { hit, LIMITS } from '@/allset/ratelimit';
import { recordAudit } from '@/allset/audit';
import { enqueueLeadAlerts } from '@/allset/notifications/outbox';
import { consentWording } from './consent';
import type { ValidInquiry } from './fields';

export interface SubmitContext {
  readonly ip: string;
  readonly ipHash: string;
  readonly userAgent: string | null;
  readonly sourcePath: string;
}

export type SubmitOutcome =
  | { readonly kind: 'accepted'; readonly reference: string; readonly leadId: string; readonly replay: boolean; readonly merged: boolean }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isIdempotencyKey(value: string): boolean {
  return UUID.test(value);
}

class ReplayDuringTransaction extends Error {}

async function findReplay(sql: Sql, key: string): Promise<{ reference: string; lead_id: string } | undefined> {
  const [row] = await sql<{ reference: string; lead_id: string }[]>`
    select reference, lead_id from allset.inquiries where idempotency_key = ${key}`;
  return row;
}

export async function submitInquiry(
  sql: Sql,
  inquiry: ValidInquiry,
  idempotencyKey: string,
  ctx: SubmitContext,
): Promise<SubmitOutcome> {
  if (!isIdempotencyKey(idempotencyKey)) throw new Error('invalid idempotency key');

  const replay = await findReplay(sql, idempotencyKey);
  if (replay) return { kind: 'accepted', reference: replay.reference, leadId: replay.lead_id, replay: true, merged: false };

  for (const [limit, key] of [
    [LIMITS.inquiryPerIpShort, ctx.ip],
    [LIMITS.inquiryPerIpDay, ctx.ip],
    [LIMITS.inquiryPerEmailHour, inquiry.emailNormalized],
  ] as const) {
    const result = await hit(sql, limit, key);
    if (!result.allowed) return { kind: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds };
  }

  const consent = consentWording(inquiry.kind);
  const payload = {
    fullName: inquiry.fullName,
    email: inquiry.email,
    zip: inquiry.zip,
    contactMethod: inquiry.contactMethod,
    phone: inquiry.phoneE164,
    coverageInterest: inquiry.coverageInterest,
    licensingStatus: inquiry.licensingStatus,
    disclosureAcknowledged: inquiry.kind === 'team' ? inquiry.disclosureAck : undefined,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reference = newReference();
    try {
      return await sql.begin(async (tx) => {
        const [lead] = await tx<{ id: string; inserted: boolean }[]>`
          insert into allset.leads (
            kind, full_name, email, email_normalized, zip, contact_method, phone_e164,
            coverage_interest, licensing_status
          ) values (
            ${inquiry.kind}, ${inquiry.fullName}, ${inquiry.email}, ${inquiry.emailNormalized}, ${inquiry.zip},
            ${inquiry.contactMethod}, ${inquiry.phoneE164}, ${inquiry.coverageInterest}, ${inquiry.licensingStatus}
          )
          on conflict (kind, email_normalized) where closed_at is null
          do update set
            full_name = excluded.full_name,
            email = excluded.email,
            zip = excluded.zip,
            contact_method = excluded.contact_method,
            phone_e164 = excluded.phone_e164,
            coverage_interest = excluded.coverage_interest,
            licensing_status = excluded.licensing_status,
            submission_count = allset.leads.submission_count + 1,
            last_submitted_at = now(),
            last_activity_at = now(),
            updated_at = now()
          returning id, (xmax = 0) as inserted`;
        if (!lead) throw new Error('lead upsert returned no row');

        const saved = await tx<{ reference: string }[]>`
          insert into allset.inquiries (
            reference, idempotency_key, lead_id, kind, payload,
            consent_text, consent_version, consented_at, source_path, ip_hash, user_agent
          ) values (
            ${reference}, ${idempotencyKey}, ${lead.id}, ${inquiry.kind}, ${tx.json(JSON.parse(JSON.stringify(payload)) as Record<string, string | boolean | null>)},
            ${consent.text}, ${consent.version}, now(), ${ctx.sourcePath}, ${ctx.ipHash}, ${ctx.userAgent}
          )
          on conflict (idempotency_key) do nothing
          returning reference`;
        // A concurrent request with the same key won the race. Roll back our
        // lead update and hand back the winner's reference instead.
        if (saved.length === 0) throw new ReplayDuringTransaction();

        const alerts = await enqueueLeadAlerts(tx, lead.id, reference);
        await recordAudit(tx, {
          actor: null,
          action: lead.inserted ? 'inquiry.received' : 'inquiry.received_merged',
          entityType: 'lead',
          entityId: lead.id,
          entityRef: reference,
          details: { kind: inquiry.kind, alerts_queued: alerts, consent_version: consent.version },
        });

        return { kind: 'accepted' as const, reference, leadId: lead.id, replay: false, merged: !lead.inserted };
      });
    } catch (error) {
      if (error instanceof ReplayDuringTransaction) {
        const winner = await findReplay(sql, idempotencyKey);
        if (winner) return { kind: 'accepted', reference: winner.reference, leadId: winner.lead_id, replay: true, merged: false };
        throw error;
      }
      const e = error as { code?: string; constraint_name?: string };
      // A reference collision (1 in ~10^12) — draw another and try again.
      if (e.code === '23505' && e.constraint_name === 'inquiries_reference_key') continue;
      throw error;
    }
  }
  throw new Error('could not allocate a unique reference');
}
