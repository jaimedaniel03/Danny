/**
 * Whether the site accepts inquiries.
 *
 * A public site must not collect requests on behalf of a business that has
 * not yet shown who it is (legal entity, licenses, contact). So forms are
 * open only when every launch-required fact is verified — or, for a private
 * pre-launch deployment that staff are testing behind access protection,
 * when ALLOW_PRELAUNCH_INQUIRIES=true is set deliberately.
 *
 * Enforced in the server action, not just by hiding the form.
 */

import 'server-only';
import { isLaunchReady } from '@/allset/content/facts';

export function inquiriesOpen(): boolean {
  return isLaunchReady() || process.env['ALLOW_PRELAUNCH_INQUIRIES'] === 'true';
}
