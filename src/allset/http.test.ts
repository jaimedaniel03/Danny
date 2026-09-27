import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasBearer, isSameOrigin } from './http';

function post(headers: Record<string, string>): Request {
  return new Request('https://allsetcheck.example/api/admin/export', { method: 'POST', headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isSameOrigin (CSRF guard for route handlers)', () => {
  it('accepts a request whose Origin is the configured site', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example');
    expect(isSameOrigin(post({ origin: 'https://allsetcheck.example', host: 'allsetcheck.example' }))).toBe(true);
  });

  it('refuses a cross-site Origin, a missing Origin and an opaque "null" Origin', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example');
    expect(isSameOrigin(post({ origin: 'https://evil.example', host: 'allsetcheck.example' }))).toBe(false);
    expect(isSameOrigin(post({ host: 'allsetcheck.example' }))).toBe(false);
    expect(isSameOrigin(post({ origin: 'null', host: 'allsetcheck.example' }))).toBe(false);
  });

  it('never trusts X-Forwarded-Host, with or without PUBLIC_BASE_URL', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example');
    expect(
      isSameOrigin(post({ origin: 'https://evil.example', host: 'allsetcheck.example', 'x-forwarded-host': 'evil.example' })),
    ).toBe(false);
    vi.stubEnv('PUBLIC_BASE_URL', '');
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('VERCEL_URL', '');
    vi.stubEnv('VERCEL_BRANCH_URL', '');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '');
    expect(
      isSameOrigin(post({ origin: 'https://evil.example', host: 'allsetcheck.example', 'x-forwarded-host': 'evil.example' })),
    ).toBe(false);
    expect(isSameOrigin(post({ origin: 'https://allsetcheck.example', host: 'allsetcheck.example' }))).toBe(true);
  });

  it('prefers PUBLIC_BASE_URL over a spoofed Host header', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example');
    expect(isSameOrigin(post({ origin: 'https://evil.example', host: 'evil.example' }))).toBe(false);
  });

  it('refuses a malformed Origin', () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://allsetcheck.example');
    expect(isSameOrigin(post({ origin: 'not a url', host: 'allsetcheck.example' }))).toBe(false);
  });
});

describe('hasBearer', () => {
  it('matches only the exact secret', () => {
    const secret = 'c'.repeat(40);
    expect(hasBearer(new Request('https://x.example', { headers: { authorization: `Bearer ${secret}` } }), secret)).toBe(true);
    expect(hasBearer(new Request('https://x.example', { headers: { authorization: `Bearer ${secret}x` } }), secret)).toBe(false);
    expect(hasBearer(new Request('https://x.example', { headers: { authorization: secret } }), secret)).toBe(false);
    expect(hasBearer(new Request('https://x.example'), secret)).toBe(false);
    expect(hasBearer(new Request('https://x.example', { headers: { authorization: 'Bearer ' } }), undefined)).toBe(false);
  });
});
