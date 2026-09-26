import { describe, expect, it } from 'vitest';
import { ipFrom, rateLimitKey } from './request';

describe('rate-limit keys', () => {
  it('uses an IPv4 address as is, including when mapped into IPv6', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups every IPv6 address in one /64 under a single key', () => {
    const key = rateLimitKey('2001:db8:aa:bb:1:2:3:4');
    expect(key).toBe('2001:db8:aa:bb::/64');
    expect(rateLimitKey('2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff')).toBe(key);
    expect(rateLimitKey('2001:db8:aa:bb::9')).toBe(key);
    expect(rateLimitKey('2001:DB8:AA:BB::')).toBe(key);
  });

  it('expands compressed zeros before taking the prefix', () => {
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('2001:db8:aa:bc::1')).not.toBe(rateLimitKey('2001:db8:aa:bb::1'));
  });

  it('prefers the platform-set x-real-ip, then the first x-forwarded-for hop', () => {
    const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;
    expect(ipFrom(headers({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '203.0.113.9' }))).toBe('198.51.100.1');
    expect(ipFrom(headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(ipFrom(headers({ 'x-forwarded-for': '2001:db8:aa:bb::5' }))).toBe('2001:db8:aa:bb::/64');
    expect(ipFrom(headers({}))).toBe('unknown');
  });
});
