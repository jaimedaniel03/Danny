import { afterEach, describe, expect, it, vi } from 'vitest';
import { inquiriesOpen } from './gate';
import { submitCoverageInquiry, submitTeamInquiry } from './actions';
import { initialInquiryState } from '@/components/forms/inquiry-initial';

afterEach(() => {
  vi.unstubAllEnvs();
});

function filledForm(): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries({
    fullName: 'Closed Gate',
    email: 'gate@example.com',
    zip: '60601',
    contactMethod: 'email',
    coverageInterest: 'life',
    consent: 'yes',
    idempotencyKey: crypto.randomUUID(),
  })) form.set(k, v);
  return form;
}

describe('the pre-launch gate', () => {
  it('keeps forms closed while required business facts are unverified', () => {
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', '');
    expect(inquiriesOpen()).toBe(false);
    expect(initialInquiryState('coverage').status).toBe('closed');
    // Only the exact value opens it.
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', '1');
    expect(inquiriesOpen()).toBe(false);
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', 'true');
    expect(inquiriesOpen()).toBe(true);
    expect(initialInquiryState('coverage').status).toBe('idle');
  });

  it('stays closed without a database, even on a preview that allows inquiries', () => {
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', 'true');
    vi.stubEnv('DATABASE_URL', '');
    expect(inquiriesOpen()).toBe(false);
  });

  it('renders a closed form without needing the signing secret', () => {
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', '');
    vi.stubEnv('APP_SECRET', '');
    expect(initialInquiryState('team')).toMatchObject({ status: 'closed', formToken: '' });
  });

  it('refuses a posted form on the server, not just by hiding it', async () => {
    vi.stubEnv('ALLOW_PRELAUNCH_INQUIRIES', '');
    vi.stubEnv('APP_SECRET', '');
    const previous = initialInquiryState('coverage');
    // Returns before touching the request or the database.
    expect((await submitCoverageInquiry(previous, filledForm())).status).toBe('closed');
    expect((await submitTeamInquiry(initialInquiryState('team'), filledForm())).status).toBe('closed');
  });
});
