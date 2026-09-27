import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './middleware';

describe('content security policy', () => {
  it('allows only nonced scripts and styles in production, with no unsafe keywords', () => {
    const csp = contentSecurityPolicy('abc123', { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'nonce-abc123'");
    expect(csp).not.toMatch(/unsafe-/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('adds eval only for the development server', () => {
    expect(contentSecurityPolicy('x', { dev: true })).toContain("'unsafe-eval'");
  });
});
