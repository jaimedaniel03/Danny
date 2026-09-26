/**
 * Business facts — the only place the site learns anything about the
 * business that a regulator, a customer, or a court could hold it to.
 *
 * The rule: a fact renders only if it is verified. Each verified fact
 * records who confirmed it, when, and from what source (a license lookup, a
 * carrier contract, a signed testimonial release). Anything unconfirmed stays
 * `null` or empty, the public page hides that section entirely, and the
 * owner-only launch checklist lists it as outstanding.
 *
 * Nothing here is filled with a plausible placeholder. A blank is honest; an
 * invented license number or testimonial is not.
 *
 * To add a fact: fill the value, set verifiedBy / verifiedOn / source, run
 * `npm test` (the schema test rejects incomplete records), and deploy.
 */

import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const verification = {
  /** The person who checked it, e.g. "Owner, reviewed against state DOI lookup". */
  verifiedBy: z.string().trim().min(3),
  verifiedOn: isoDate,
  /** Where the proof lives: a URL, a document name, a record id. */
  source: z.string().trim().min(3),
};

function verified<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value, ...verification }).strict();
}

const stateCode = z.string().regex(/^[A-Z]{2}$/);

const FactsSchema = z
  .object({
    /** Registered legal name of the business, as on the state filing. */
    legalEntity: verified(
      z.object({ name: z.string().min(2), entityType: z.string().min(2), formationState: stateCode }).strict(),
    ).nullable(),

    /** Producer / agency licenses. Only lines actually licensed appear. */
    licenses: z.array(
      verified(
        z
          .object({
            state: stateCode,
            holder: z.string().min(2),
            licenseNumber: z.string().min(2),
            lines: z.array(z.enum(['life', 'health'])).min(1),
          })
          .strict(),
      ),
    ),

    npn: verified(z.string().regex(/^\d{4,10}$/)).nullable(),

    /** States where the team is licensed and actively takes clients. */
    serviceArea: verified(z.object({ states: z.array(stateCode).min(1) }).strict()).nullable(),

    /** Carriers the team is appointed with. Logos only with a written right to use them. */
    carriers: z.array(
      verified(
        z
          .object({
            name: z.string().min(2),
            lines: z.array(z.enum(['life', 'health'])).min(1),
            logoPermission: z.boolean(),
          })
          .strict(),
      ),
    ),

    /** How the business is paid for helping a family (plain-language disclosure). */
    compensation: verified(z.object({ summary: z.string().min(40) }).strict()).nullable(),

    contact: z
      .object({
        phone: verified(z.string().regex(/^\+1\d{10}$/)).nullable(),
        email: verified(z.string().email()).nullable(),
        mailingAddress: verified(z.string().min(10)).nullable(),
        hours: verified(z.string().min(5)).nullable(),
      })
      .strict(),

    /** The founders' own account, approved by them word for word. */
    founderStory: verified(
      z
        .object({
          headline: z.string().min(5),
          paragraphs: z.array(z.string().min(20)).min(1),
          founders: z.array(z.object({ name: z.string().min(2), role: z.string().min(2) }).strict()).min(1),
        })
        .strict(),
    ).nullable(),

    /** Published only with written permission and the person's exact words. */
    testimonials: z.array(
      verified(
        z
          .object({
            quote: z.string().min(10),
            attribution: z.string().min(2),
            /** e.g. "Health coverage client, 2026". */
            context: z.string().min(3),
            permissionOn: isoDate,
            /** Where the signed permission is stored. */
            permissionRecord: z.string().min(3),
            /** Required disclosure if the person was paid or is related to the team. */
            materialConnection: z.string().nullable(),
          })
          .strict(),
      ),
    ),

    /** Numbers or outcomes the site states. Each needs evidence on file. */
    proofPoints: z.array(
      verified(z.object({ claim: z.string().min(5), evidence: z.string().min(5) }).strict()),
    ),

    /** Specific terms for the team role, disclosed before anyone signs up. */
    teamRole: verified(
      z
        .object({
          title: z.string().min(3),
          relationship: z.string().min(10),
          licensing: z.string().min(20),
          training: z.string().min(20),
          pay: z.string().min(20),
          expenses: z.array(z.object({ item: z.string().min(3), cost: z.string().min(1) }).strict()).min(1),
          chargebacks: z.string().min(20),
          upline: z.string().nullable(),
        })
        .strict(),
    ).nullable(),

    /** Counsel's sign-off on the privacy policy and terms. */
    legalReview: verified(z.object({ reviewer: z.string().min(3), documents: z.array(z.string()).min(1) }).strict()).nullable(),
  })
  .strict()
  .superRefine((facts, ctx) => {
    // Serving a state without a license there is unlicensed solicitation.
    const licensed = new Set(facts.licenses.map((l) => l.value.state));
    for (const state of facts.serviceArea?.value.states ?? []) {
      if (!licensed.has(state)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['serviceArea', 'value', 'states'],
          message: `${state} is in the service area but has no license on record`,
        });
      }
    }
  });

export type BusinessFacts = z.infer<typeof FactsSchema>;

/**
 * The facts as confirmed today (2026-09-26): none.
 *
 * The owner supplied the brand name "All Set Check", the mission, and the
 * founders' ambition; those appear in page copy as the business's own
 * statements. Everything below requires evidence that has not been provided.
 */
const RAW_FACTS: BusinessFacts = {
  legalEntity: null,
  licenses: [],
  npn: null,
  serviceArea: null,
  carriers: [],
  compensation: null,
  contact: { phone: null, email: null, mailingAddress: null, hours: null },
  founderStory: null,
  testimonials: [],
  proofPoints: [],
  teamRole: null,
  legalReview: null,
};

export const FACTS: BusinessFacts = FactsSchema.parse(RAW_FACTS);

export function parseFacts(input: unknown): BusinessFacts {
  return FactsSchema.parse(input);
}

// ── Launch readiness ────────────────────────────────────────────────────

export interface ChecklistItem {
  readonly key: string;
  readonly label: string;
  readonly why: string;
  readonly requiredForLaunch: boolean;
  readonly done: boolean;
}

export function launchChecklist(facts: BusinessFacts = FACTS): readonly ChecklistItem[] {
  const licensedLines = new Set(facts.licenses.flatMap((l) => l.value.lines));
  return [
    {
      key: 'legalEntity',
      label: 'Registered legal entity name, type and formation state',
      why: 'Insurance advertising must identify who is soliciting. The footer, privacy policy and terms name the business.',
      requiredForLaunch: true,
      done: facts.legalEntity !== null,
    },
    {
      key: 'licenses',
      label: 'Producer/agency license numbers for each state and line (life, health)',
      why: 'Many states require the license number on advertising, and the site must not imply a license the team does not hold.',
      requiredForLaunch: true,
      done: facts.licenses.length > 0,
    },
    {
      key: 'lines',
      label: 'Licensed for both life and health (or copy narrowed to the licensed line)',
      why: 'The coverage page discusses both lines. Offering help with an unlicensed line is solicitation without a license.',
      requiredForLaunch: true,
      done: licensedLines.has('life') && licensedLines.has('health'),
    },
    {
      key: 'npn',
      label: 'National Producer Number',
      why: 'Lets visitors verify licensing through NIPR and state lookups.',
      requiredForLaunch: false,
      done: facts.npn !== null,
    },
    {
      key: 'serviceArea',
      label: 'States served',
      why: 'Visitors outside the licensed states need to know before they submit.',
      requiredForLaunch: true,
      done: facts.serviceArea !== null,
    },
    {
      key: 'contact',
      label: 'Business phone or email, and a mailing address',
      why: 'People need a way to reach a person, and the privacy policy needs a contact for data requests.',
      requiredForLaunch: true,
      done:
        (facts.contact.phone !== null || facts.contact.email !== null) && facts.contact.mailingAddress !== null,
    },
    {
      key: 'compensation',
      label: 'How the business is paid (commission disclosure)',
      why: 'Families should know how their advisor is paid before they trust a recommendation.',
      requiredForLaunch: true,
      done: facts.compensation !== null,
    },
    {
      key: 'carriers',
      label: 'Carrier appointments (and written logo permissions, if logos will show)',
      why: 'Naming a carrier implies a relationship that must exist; logos are trademarks.',
      requiredForLaunch: false,
      done: facts.carriers.length > 0,
    },
    {
      key: 'teamRole',
      label: 'Team role terms: relationship, licensing, training, pay, expenses, chargebacks',
      why: 'Recruits must see the real terms before signing up. The team page shows general facts until these exist.',
      requiredForLaunch: true,
      done: facts.teamRole !== null,
    },
    {
      key: 'founderStory',
      label: "Founders' story, approved word for word",
      why: 'The story page shows the mission only until the founders confirm their own account.',
      requiredForLaunch: false,
      done: facts.founderStory !== null,
    },
    {
      key: 'testimonials',
      label: 'Testimonials with written permission and exact wording',
      why: 'Hidden until at least one is verified. None are invented.',
      requiredForLaunch: false,
      done: facts.testimonials.length > 0,
    },
    {
      key: 'legalReview',
      label: 'Privacy policy and terms reviewed by counsel',
      why: 'The drafts describe what the system actually does, but they are not legal advice.',
      requiredForLaunch: true,
      done: facts.legalReview !== null,
    },
  ];
}

export function isLaunchReady(facts: BusinessFacts = FACTS): boolean {
  return launchChecklist(facts).every((item) => !item.requiredForLaunch || item.done);
}

/** The name the site uses for the business: the verified legal name, else the brand. */
export const BRAND_NAME = 'All Set Check';

export function businessName(facts: BusinessFacts = FACTS): string {
  return facts.legalEntity?.value.name ?? BRAND_NAME;
}

/** How a consent names the seller: the legal entity with its brand, once verified. */
export function sellerName(facts: BusinessFacts = FACTS): string {
  return facts.legalEntity ? `${facts.legalEntity.value.name} (${BRAND_NAME})` : BRAND_NAME;
}
