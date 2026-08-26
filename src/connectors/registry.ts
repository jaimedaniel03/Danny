/**
 * Connector registry.
 *
 * Every connector available to this project, what it would do, and — the part
 * that matters — whether it should be in the build at all.
 *
 * The brief asked for "every connector." Here is every connector. It is also
 * worth saying plainly, since this registry is where the temptation lives: an
 * integration is not free. Each one is an OAuth token to rotate, a rate limit to
 * respect, a schema that changes under you, a vendor whose outage becomes your
 * outage, and — for anything touching a consumer's insurance data — a row in the
 * data-processing inventory a carrier will ask to see before they appoint you.
 *
 * So each entry carries a `tier`:
 *
 *   CORE       — the product does not function without it. Build now.
 *   SUPPORTING — real leverage, but after CORE works end to end.
 *   MARGINAL   — plausible use, low value per unit of maintenance. Behind a flag.
 *   CUT        — no defensible role here. Listed for completeness and so nobody
 *                relitigates it in three months.
 *
 * If you take one thing from this file: eleven of these are CORE or SUPPORTING.
 * Wiring all twenty-one is not ambition, it is a maintenance burden wearing
 * ambition's coat.
 */

export type ConnectorTier = 'CORE' | 'SUPPORTING' | 'MARGINAL' | 'CUT';

export type Subsystem =
  | 'lead_supply'
  | 'crm'
  | 'telephony'
  | 'voice'
  | 'data_platform'
  | 'analytics'
  | 'comms'
  | 'documents'
  | 'design'
  | 'infrastructure'
  | 'automation'
  | 'conversational';

export interface ConnectorSpec {
  readonly name: string;
  readonly tier: ConnectorTier;
  readonly subsystem: Subsystem;
  /** What it does for Danny specifically. */
  readonly role: string;
  /** Where it plugs in. */
  readonly integrationPoint: string;
  /** What breaks, costs, or bites. Written before you find out the hard way. */
  readonly caveat: string;
  /** Phase from docs/07-ROADMAP.md when it lands. Null for CUT. */
  readonly phase: number | null;
}

export const CONNECTORS: readonly ConnectorSpec[] = [
  // ── CORE ───────────────────────────────────────────────────────────────────
  {
    name: 'Supabase',
    tier: 'CORE',
    subsystem: 'data_platform',
    role:
      'System of record. Contacts, consent ledger, call records, transcripts, ' +
      'quotes, audit log. Row-level security is the multi-tenant boundary once ' +
      'more than one agency is on the platform.',
    integrationPoint: 'src/db/*, supabase/migrations/*',
    caveat:
      'Consent and transcript tables hold PII and, on health lines, PHI. That ' +
      'means a signed BAA before a single Medicare or ACA call, encryption at ' +
      'rest, and a retention job that actually runs. Postgres will happily store ' +
      'a HIPAA violation for you forever.',
    phase: 1,
  },
  {
    name: 'HubSpot',
    tier: 'CORE',
    subsystem: 'crm',
    role:
      'Where the human producers live. Danny writes call outcomes, transcripts, ' +
      'quote artifacts, and next-action tasks onto the contact record; reads back ' +
      'ownership and pipeline stage so it never calls an account a human is working.',
    integrationPoint: 'src/connectors/hubspot.ts — bidirectional sync, webhook-driven',
    caveat:
      'HubSpot is not what insurance agencies actually run on. They run on an AMS ' +
      '— Applied Epic, EZLynx, HawkSoft, Vertafore AMS360. HubSpot gets you to a ' +
      'demo; AMS integration is what gets you a renewal. Treat HubSpot as the ' +
      'design-partner path and budget for AMS connectors by Phase 4.',
    phase: 1,
  },
  {
    name: 'Zapier',
    tier: 'CORE',
    subsystem: 'automation',
    role:
      'The escape hatch. 9,000+ apps means every design partner\'s weird stack — ' +
      'their AMS, their e-sign, their scheduling tool — is reachable on day one ' +
      'without a bespoke integration. This is how you say yes in a sales call.',
    integrationPoint: 'src/connectors/zapier.ts — outbound webhooks on disposition events',
    caveat:
      'Latency and reliability are both "eventually". Never put a compliance ' +
      'check or a consent write behind a Zap. Outcomes and notifications only.',
    phase: 2,
  },
  {
    name: 'Gmail',
    tier: 'CORE',
    subsystem: 'comms',
    role:
      'The follow-up leg. Quote summary, appointment confirmation, and — most ' +
      'importantly — the written consent capture link when a call surfaces a lead ' +
      'Danny is not yet permitted to call back.',
    integrationPoint: 'src/connectors/gmail.ts — post-call, triggered by disposition',
    caveat:
      'Email adds CAN-SPAM obligations on top of TCPA: functioning unsubscribe, ' +
      'physical postal address, honest subject lines, opt-outs honoured in 10 days. ' +
      'Also, sending from a personal Gmail torches your domain reputation the first ' +
      'time volume goes up. Use a dedicated sending domain with SPF, DKIM, and DMARC.',
    phase: 2,
  },
  {
    name: 'GitHub',
    tier: 'CORE',
    subsystem: 'infrastructure',
    role:
      'Source of truth for code and, more to the point, for the compliance suite. ' +
      'CI runs `compliance:selftest` on every PR and blocks merge on failure. The ' +
      'commit history is itself an audit artifact: it shows when each control was ' +
      'introduced and that none were removed.',
    integrationPoint: '.github/workflows/ci.yml',
    caveat:
      'Branch protection on main is not optional once real numbers are dialed. ' +
      'A merged PR that weakens the gate is a compliance incident.',
    phase: 1,
  },
  {
    name: 'Vercel',
    tier: 'CORE',
    subsystem: 'infrastructure',
    role:
      'Hosts the dashboard, the consent-capture forms, and the Twilio webhook ' +
      'endpoints. Preview deploys give each design partner a URL to poke at.',
    integrationPoint: 'Next.js app, vercel.json',
    caveat:
      'Serverless functions are the wrong shape for a live media stream. The ' +
      'realtime voice loop needs a persistent WebSocket process — Fly.io, Railway, ' +
      'or a container on ECS. Vercel hosts the control plane; something else hosts ' +
      'the call. Designing as if Vercel can do both is the most common way this ' +
      'architecture fails at week six.',
    phase: 1,
  },

  // ── SUPPORTING ─────────────────────────────────────────────────────────────
  {
    name: 'Apollo.io',
    tier: 'SUPPORTING',
    subsystem: 'lead_supply',
    role:
      'Commercial lines only. Finds the owner or CFO at businesses in a target ' +
      'NAICS and revenue band, enriches firmographics, and — genuinely useful — ' +
      'its conversation-intelligence endpoints give a second opinion on call ' +
      'outcomes alongside our own tonality pipeline.',
    integrationPoint: 'src/connectors/apollo.ts — commercial prospecting only',
    caveat:
      'Read this twice: an Apollo contact has given you NO consent. Zero. It is a ' +
      'B2B database, not a consent ledger. Those numbers may be dialed by a human ' +
      'producer, subject to DNC scrubbing; they may never be dialed by Danny. The ' +
      'gate enforces this and it will look like a bug to whoever bought the seats.',
    phase: 3,
  },
  {
    name: 'Sprouts Data Intelligence',
    tier: 'SUPPORTING',
    subsystem: 'lead_supply',
    role:
      'Second-source enrichment and ICP scoring for commercial. Phone and email ' +
      'append, account lookup, intent signals to rank the commercial call list.',
    integrationPoint: 'src/connectors/sprouts.ts — enrichment, list ranking',
    caveat:
      'Same consent problem as Apollo, plus an append-specific one: an appended ' +
      'phone number has no provenance you can show a court. Appended numbers are ' +
      'permanently ineligible for AI dialing in this system.',
    phase: 3,
  },
  {
    name: 'Vibe Prospecting',
    tier: 'SUPPORTING',
    subsystem: 'lead_supply',
    role:
      'Local-business discovery with event triggers. The genuinely valuable ' +
      'signal here is timing: a new business license, a new location, a hiring ' +
      'spike. Commercial insurance is bought at moments, not on Tuesdays.',
    integrationPoint: 'src/connectors/vibe.ts — trigger-based commercial list building',
    caveat:
      'Consent status identical to Apollo and Sprouts: human-dialable, never ' +
      'AI-dialable. Also verify the event data is fresh — a "new business" signal ' +
      'that is nine months stale is worse than no signal.',
    phase: 3,
  },
  {
    name: 'Coupler.io',
    tier: 'SUPPORTING',
    subsystem: 'analytics',
    role:
      'Pipes call outcomes, spend, and conversion into a warehouse and out to ' +
      'whatever BI the agency already uses. Answers the only question a principal ' +
      'actually asks: what did this cost per bound policy, by line, this month?',
    integrationPoint: 'src/connectors/coupler.ts — scheduled export of the metrics view',
    caveat:
      'Export the aggregate view, never raw transcripts. The moment call content ' +
      'lands in a general-purpose BI tool it is outside your retention controls ' +
      'and inside somebody\'s spreadsheet.',
    phase: 4,
  },
  {
    name: 'Supermetrics',
    tier: 'SUPPORTING',
    subsystem: 'analytics',
    role:
      'Closes the loop between ad spend and bound policies. If the agency buys ' +
      'shared or exclusive leads through paid channels, this is what tells you ' +
      'which source produces consent records that actually convert.',
    integrationPoint: 'src/connectors/supermetrics.ts — cost-per-bound-policy attribution',
    caveat:
      'Only earns its place once there is paid acquisition to attribute. Before ' +
      'that it is a dashboard with nothing behind it.',
    phase: 4,
  },
  {
    name: 'Google Drive',
    tier: 'SUPPORTING',
    subsystem: 'documents',
    role:
      'Document custody: signed voice releases, producer license certificates, ' +
      'carrier appointment letters, ACORD forms, and the quarterly compliance ' +
      'evidence pack.',
    integrationPoint: 'src/connectors/drive.ts — write-through on document events',
    caveat:
      'Drive sharing defaults are a data-breach generator. Every compliance ' +
      'artifact goes in a restricted shared drive with explicit membership, ' +
      'never "anyone with the link".',
    phase: 3,
  },
  {
    name: 'MyChatBot',
    tier: 'SUPPORTING',
    subsystem: 'conversational',
    role:
      'The consent front door, and a genuinely underrated one. A website widget ' +
      'or WhatsApp thread where a prospect asks about a quote is an *inbound* ' +
      'interaction — which is where you legitimately capture the written consent ' +
      'that makes Danny able to call them at all. It manufactures the input the ' +
      'rest of the system is starved of.',
    integrationPoint: 'src/connectors/mychatbot.ts — consent capture → consents table',
    caveat:
      'The consent language in the widget has to be reviewed by counsel and ' +
      'version-stamped. Capturing the wrong disclosure text at scale means ' +
      'discovering later that none of your consent is good.',
    phase: 3,
  },

  // ── MARGINAL ───────────────────────────────────────────────────────────────
  {
    name: 'Canva',
    tier: 'MARGINAL',
    subsystem: 'design',
    role:
      'Generates the one-page quote comparison PDF emailed after a call, from a ' +
      'brand template with the agency\'s logo.',
    integrationPoint: 'src/connectors/canva.ts — post-call collateral',
    caveat:
      'A templated HTML-to-PDF renderer does this with no vendor dependency and ' +
      'no round trip. Use Canva only if a design partner insists on their own ' +
      'brand kit living there.',
    phase: 5,
  },
  {
    name: 'Adobe for Creativity',
    tier: 'MARGINAL',
    subsystem: 'design',
    role:
      'Two things earn a look: `media_enhance_speech` for cleaning voice-clone ' +
      'reference audio recorded in an imperfect room, and document merge for ' +
      'bulk-personalized policy review mailers.',
    integrationPoint: 'scripts/enroll-voice.ts — optional reference audio cleanup',
    caveat:
      'Enhancement changes timbre. A clone enrolled on enhanced audio can sound ' +
      'subtly unlike the person it is meant to be. Re-record instead where you can.',
    phase: 5,
  },
  {
    name: 'Figma',
    tier: 'MARGINAL',
    subsystem: 'design',
    role: 'Design system for the producer dashboard and the consent-capture forms.',
    integrationPoint: 'Design-time only. No runtime dependency.',
    caveat:
      'Zero product surface. Valuable to whoever designs the UI, invisible to the ' +
      'running system.',
    phase: 4,
  },
  {
    name: 'MindMap AI',
    tier: 'MARGINAL',
    subsystem: 'documents',
    role:
      'Renders the objection-handling decision tree as a visual artifact for ' +
      'training human producers and for reviewing coverage of the tree.',
    integrationPoint: 'Design-time. Export → prompts/objections.md',
    caveat: 'A useful thinking tool. Not a system component.',
    phase: 5,
  },
  {
    name: 'Refine.ink',
    tier: 'MARGINAL',
    subsystem: 'documents',
    role:
      'Proofreads long-form compliance documentation — the AI governance policy, ' +
      'the carrier appointment packet, the SOC 2 narrative.',
    integrationPoint: 'Manual, ad hoc.',
    caveat:
      'It is an academic proofreader. It will not catch a legal error, and a ' +
      'well-proofread wrong disclosure is still a wrong disclosure.',
    phase: 5,
  },
  {
    name: 'OutlierKit',
    tier: 'MARGINAL',
    subsystem: 'analytics',
    role:
      'YouTube research. Only defensible use: if the agency runs a content ' +
      'channel as an inbound-lead engine, this informs what to make.',
    integrationPoint: 'None. Marketing research.',
    caveat:
      'Unrelated to the calling product. Do not let it into the roadmap on the ' +
      'grounds that it is technically a connector.',
    phase: null,
  },

  // ── CUT ────────────────────────────────────────────────────────────────────
  {
    name: 'Indeed',
    tier: 'CUT',
    subsystem: 'lead_supply',
    role:
      'Arguable at the edges: job-posting velocity is a real commercial-lines ' +
      'buying signal, and hiring producers is a real need. Neither justifies an ' +
      'integration before Phase 5.',
    integrationPoint: 'None.',
    caveat:
      'Scraping employment data to infer business size, then pricing insurance ' +
      'off it, walks toward the algorithmic-discrimination provisions of Colorado ' +
      'SB 21-169 and the NAIC AI model bulletin. Not worth the exposure for a weak signal.',
    phase: null,
  },
  {
    name: 'Otto Travel',
    tier: 'CUT',
    subsystem: 'automation',
    role: 'Books flights, hotels, and rental cars.',
    integrationPoint: 'None.',
    caveat:
      'No relationship to insurance outreach whatsoever. Included here because ' +
      'the brief said every connector, and the honest answer for this one is no.',
    phase: null,
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

export function byTier(tier: ConnectorTier): readonly ConnectorSpec[] {
  return CONNECTORS.filter((c) => c.tier === tier);
}

export function buildOrder(): readonly ConnectorSpec[] {
  return [...CONNECTORS]
    .filter((c) => c.phase !== null)
    .sort((a, b) => (a.phase ?? 99) - (b.phase ?? 99));
}

/**
 * Lead sources whose contacts may never be dialed by an AI voice, regardless of
 * what any other part of the system believes. Cross-checked by the gate: a
 * contact whose only provenance is one of these can never acquire an
 * `AI_DIALABLE` consent basis through enrichment alone.
 */
export const NEVER_AI_DIALABLE_SOURCES: ReadonlySet<string> = new Set([
  'Apollo.io',
  'Sprouts Data Intelligence',
  'Vibe Prospecting',
  'Indeed',
]);

export const REGISTRY_SUMMARY = {
  total: CONNECTORS.length,
  core: byTier('CORE').length,
  supporting: byTier('SUPPORTING').length,
  marginal: byTier('MARGINAL').length,
  cut: byTier('CUT').length,
} as const;
