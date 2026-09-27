import { afterEach, describe, expect, it, vi } from 'vitest';
import { intakeModeFor, previewIntakeAllowed } from './gate';
import { submitCoverageInquiry, submitTeamInquiry } from './actions';
import type { InquiryState } from './state';

afterEach(() => {
  vi.unstubAllEnvs();
});

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

describe('the intake gate', () => {
  it('is closed without a database, whatever else is true', () => {
    expect(intakeModeFor({ databaseConfigured: false, launchReady: true, previewAllowed: true, staffSignedIn: true })).toBe('closed');
  });

  it('opens to the public only when every launch fact is verified', () => {
    expect(intakeModeFor({ databaseConfigured: true, launchReady: true, previewAllowed: false, staffSignedIn: false })).toBe('open');
    expect(intakeModeFor({ databaseConfigured: true, launchReady: false, previewAllowed: false, staffSignedIn: false })).toBe('closed');
  });

  it('offers a preview only to signed-in staff, and only where previews are allowed', () => {
    expect(intakeModeFor({ databaseConfigured: true, launchReady: false, previewAllowed: true, staffSignedIn: true })).toBe('preview');
    // The public never gets the preview, even with the setting on.
    expect(intakeModeFor({ databaseConfigured: true, launchReady: false, previewAllowed: true, staffSignedIn: false })).toBe('closed');
    expect(intakeModeFor({ databaseConfigured: true, launchReady: false, previewAllowed: false, staffSignedIn: true })).toBe('closed');
  });

  it('never allows a preview on a production deployment or an indexable site', () => {
    expect(previewIntakeAllowed(env({ INTAKE_PREVIEW: 'true', VERCEL_ENV: 'preview' }))).toBe(true);
    expect(previewIntakeAllowed(env({ INTAKE_PREVIEW: 'true' }))).toBe(true);
    expect(previewIntakeAllowed(env({ INTAKE_PREVIEW: 'true', VERCEL_ENV: 'production' }))).toBe(false);
    expect(previewIntakeAllowed(env({ INTAKE_PREVIEW: '1', VERCEL_ENV: 'preview' }))).toBe(false);
    expect(previewIntakeAllowed(env({ VERCEL_ENV: 'preview' }))).toBe(false);
    vi.stubEnv('SITE_INDEXABLE', 'true');
    expect(previewIntakeAllowed(env({ INTAKE_PREVIEW: 'true', VERCEL_ENV: 'preview' }))).toBe(false);
  });

  it('refuses a posted form on the server when closed, without touching the request or database', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('APP_SECRET', '');
    const form = new FormData();
    form.set('fullName', 'Closed Gate');
    form.set('idempotencyKey', crypto.randomUUID());
    const previous = { kind: 'coverage', idempotencyKey: crypto.randomUUID(), formToken: '', attempt: 0, preview: false, status: 'idle' } as InquiryState;
    expect(await submitCoverageInquiry(previous, form)).toMatchObject({ status: 'closed', formToken: '' });
    expect(await submitTeamInquiry({ ...previous, kind: 'team' }, form)).toMatchObject({ status: 'closed' });
  });
});
