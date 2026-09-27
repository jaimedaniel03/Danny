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
import { isSuppressed } from '@/allset/suppression';
import { acknowledgmentText, consentWording, TEAM_DISCLOSURE_ACK } from './consent';
import type { ValidInquiry } from './fields';

export interface SubmitContext {
  readonly ip: string;
  readonly ipHash: string;
  readonly userAgent: string | null;
  readonly sourcePath: string;
  /** A staff-only preview submission (made-up details). */
  readonly synthetic?: boolean;
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
    state: inquiry.state,
    contactMethod: inquiry.contactMethod,
    phone: inquiry.phoneE164,
    coverageInterest: inquiry.coverageInterest,
    licensingStatus: inquiry.licensingStatus,
    ...(inquiry.kind === 'team'
      ? {
          disclosureAcknowledged: inquiry.disclosureAck,
          disclosureText: acknowledgmentText(),
          disclosureVersion: TEAM_DISCLOSURE_ACK.version,
          disclosureTermsShown: TEAM_DISCLOSURE_ACK.termsShown,
        }
      : {}),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const reference = newReference();
    try {
      return await sql.begin(async (tx) => {
        const suppressed = await isSuppressed(tx, inquiry);
        // A repeat submission never rewrites the lead's contact details:
        // anyone who knows a person's email could otherwise redirect our
        // calls to a number of their choosing. New details are kept on the
        // inquiry, and the lead is flagged for a person to compare.
        const [lead] = await tx<{ id: string; inserted: boolean }[]>`
          insert into allset.leads (
            kind, full_name, email, email_normalized, zip, state, contact_method, phone_e164,
            coverage_interest, licensing_status, suppression_match, is_synthetic
          ) values (
            ${inquiry.kind}, ${inquiry.fullName}, ${inquiry.email}, ${inquiry.emailNormalized}, ${inquiry.zip},
            ${inquiry.state}, ${inquiry.contactMethod}, ${inquiry.phoneE164}, ${inquiry.coverageInterest},
            ${inquiry.licensingStatus}, ${suppressed}, ${ctx.synthetic === true}
          )
          on conflict (kind, email_normalized) where closed_at is null
          do update set
            submission_count = allset.leads.submission_count + 1,
            needs_review = allset.leads.needs_review or (
              (allset.leads.full_name, allset.leads.zip, allset.leads.state, allset.leads.contact_method,
               allset.leads.phone_e164, allset.leads.coverage_interest, allset.leads.licensing_status)
              is distinct from
              (excluded.full_name, excluded.zip, excluded.state, excluded.contact_method,
               excluded.phone_e164, excluded.coverage_interest, excluded.licensing_status)
            ),
            suppression_match = allset.leads.suppression_match or excluded.suppression_match,
            is_synthetic = allset.leads.is_synthetic or excluded.is_synthetic,
            last_submitted_at = now(),
            last_activity_at = now(),
            updated_at = now()
          returning id, (xmax = 0) as inserted`;
        if (!lead) throw new Error('lead upsert returned no row');

        const saved = await tx<{ reference: string }[]>`
          insert into allset.inquiries (
            reference, idempotency_key, lead_id, kind, payload,
            consent_text, consent_version, consented_at, consent_channels, source_path, ip_hash, user_agent
          ) values (
            ${reference}, ${idempotencyKey}, ${lead.id}, ${inquiry.kind}, ${tx.json(JSON.parse(JSON.stringify(payload)) as Record<string, string | boolean | null>)},
            ${consent.text}, ${consent.version}, now(), ${[inquiry.contactMethod]}, ${ctx.sourcePath},
            ${ctx.ipHash}, ${ctx.userAgent}
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
          details: { kind: inquiry.kind, alerts_queued: alerts, consent_version: consent.version, suppression_match: suppressed },
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
