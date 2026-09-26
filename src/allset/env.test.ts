import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseConfigured, publicBaseUrl } from './env';

afterEach(() => {
  vi.unstubAllEnvs();
});

function clearVercel(): void {
  for (const key of ['PUBLIC_BASE_URL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    vi.stubEnv(key, '');
  }
}

describe('public base URL', () => {
  it('prefers the configured address, without a trailing slash', () => {
    clearVercel();
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example/');
    vi.stubEnv('VERCEL_URL', 'ignored.vercel.app');
    expect(publicBaseUrl()).toBe('https://allsetcheck.example');
  });

  it('uses the stable branch address on a Vercel preview', () => {
    clearVercel();
    vi.stubEnv('VERCEL_ENV', 'preview');
    vi.stubEnv('VERCEL_URL', 'all-set-check-abc123.vercel.app');
    vi.stubEnv('VERCEL_BRANCH_URL', 'all-set-check-git-branch.vercel.app');
    expect(publicBaseUrl()).toBe('https://all-set-check-git-branch.vercel.app');
  });

  it('uses the production address on a production deployment', () => {
    clearVercel();
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('VERCEL_URL', 'all-set-check-abc123.vercel.app');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'all-set-check.vercel.app');
    expect(publicBaseUrl()).toBe('https://all-set-check.vercel.app');
  });

  it('is unset off Vercel with nothing configured', () => {
    clearVercel();
    expect(publicBaseUrl()).toBeUndefined();
  });
});

describe('database configuration', () => {
  it('reports whether a database URL is present', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(databaseConfigured()).toBe(false);
    vi.stubEnv('DATABASE_URL', 'postgres://x@y/z');
    expect(databaseConfigured()).toBe(true);
  });
});
