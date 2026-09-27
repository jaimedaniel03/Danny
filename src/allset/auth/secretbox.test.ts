import { describe, expect, it, vi } from 'vitest';
import { open, seal } from './secretbox';

describe('secretbox', () => {
  it('round-trips, and a fresh IV each time hides equal secrets', () => {
    const a = seal('totp-secret', 'JBSWY3DPEHPK3PXP');
    const b = seal('totp-secret', 'JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(open('totp-secret', a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses tampering, the wrong purpose, and another APP_SECRET', () => {
    const box = seal('totp-secret', 'JBSWY3DPEHPK3PXP');
    const [v, iv, body] = box.split('.');
    const flipped = `${v}.${iv}.${body!.slice(0, -2)}${body!.endsWith('A') ? 'B' : 'A'}${body!.slice(-1)}`;
    expect(open('totp-secret', flipped)).toBeNull();
    expect(open('other-purpose', box)).toBeNull();
    expect(open('totp-secret', 'garbage')).toBeNull();
    vi.stubEnv('APP_SECRET', 'a-completely-different-app-secret-0123456789');
    expect(open('totp-secret', box)).toBeNull();
    vi.unstubAllEnvs();
  });
});
