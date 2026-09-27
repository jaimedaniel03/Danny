/**
 * Whether the site takes inquiries, and in what mode.
 *
 *  - open: every launch-required business fact is verified (see
 *    content/facts.ts). Real requests from eligible states.
 *  - preview: before launch, for testing only. It needs all three of: the
 *    INTAKE_PREVIEW=true setting, a deployment that isn't production, and a
 *    staff member signed in (both steps) in the same browser. Everything sent
 *    is stored marked as synthetic. The public can never reach it, whatever
 *    the settings.
 *  - closed: anything else, and always without a database. The form shows the
 *    public notice instead of fields.
 *
 * Enforced in the server action, not just by hiding the form.
 */

import 'server-only';
import { isLaunchReady } from '@/allset/content/facts';
import { databaseConfigured, siteIndexable } from '@/allset/env';
import { verifiedActor } from '@/allset/auth/session-cookie';

export type IntakeMode = 'open' | 'preview' | 'closed';

/** Preview intake is possible on this deployment (it still needs a signed-in staff member). */
export function previewIntakeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['INTAKE_PREVIEW'] === 'true' && env['VERCEL_ENV'] !== 'production' && !siteIndexable();
}

export function intakeModeFor(input: {
  readonly databaseConfigured: boolean;
  readonly launchReady: boolean;
  readonly previewAllowed: boolean;
  readonly staffSignedIn: boolean;
}): IntakeMode {
  if (!input.databaseConfigured) return 'closed';
  if (input.launchReady) return 'open';
  if (input.previewAllowed && input.staffSignedIn) return 'preview';
  return 'closed';
}

export async function intakeMode(): Promise<IntakeMode> {
  const previewAllowed = previewIntakeAllowed();
  return intakeModeFor({
    databaseConfigured: databaseConfigured(),
    launchReady: isLaunchReady(),
    previewAllowed,
    // Only look up a session when it could matter.
    staffSignedIn: previewAllowed && databaseConfigured() ? Boolean(await verifiedActor()) : false,
  });
}
