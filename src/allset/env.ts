/**
 * Server-side configuration for the All Set Check site.
 *
 * Every secret is read here and nowhere else, and this module refuses to load
 * in a client bundle. A value that is required for a feature is checked when
 * the feature runs, not at import, so a missing email key breaks email alerts
 * (visibly, in the admin) rather than taking the whole site down.
 */

import 'server-only';

function read(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export class ConfigError extends Error {
  constructor(readonly variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = 'ConfigError';
  }
}

function required(name: string): string {
  const value = read(name);
  if (!value) throw new ConfigError(name, 'is not set');
  return value;
}

export function databaseUrl(): string {
  return required('DATABASE_URL');
}

/**
 * Keys every HMAC in the app: hashed IPs, rate-limit keys, form tokens.
 * Rotating it resets rate limits and invalidates open forms; nothing else.
 */
export function appSecret(): string {
  const value = required('APP_SECRET');
  if (value.length < 32) throw new ConfigError('APP_SECRET', 'must be at least 32 characters');
  return value;
}

/** Absolute origin used in emailed links, e.g. https://allsetcheck.com. */
export function publicBaseUrl(): string | undefined {
  const value = read('PUBLIC_BASE_URL');
  return value?.replace(/\/+$/, '');
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Indexing is opt-in. Until the business facts that insurance advertising
 * rules require are confirmed, the site asks search engines to stay away.
 */
export function siteIndexable(): boolean {
  return read('SITE_INDEXABLE') === 'true';
}

/** One-time bootstrap secret for creating the first owner. Unset it afterwards. */
export function adminSetupToken(): string | undefined {
  const value = read('ADMIN_SETUP_TOKEN');
  return value && value.length >= 32 ? value : undefined;
}

export interface EmailConfig {
  readonly apiKey: string;
  readonly from: string;
}

/** Null means email alerts are not configured; callers record that as a failure. */
export function emailConfig(): EmailConfig | null {
  const apiKey = read('RESEND_API_KEY');
  const from = read('NOTIFY_FROM');
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

export function resendWebhookSecret(): string | undefined {
  return read('RESEND_WEBHOOK_SECRET');
}

export function cronSecret(): string | undefined {
  const value = read('CRON_SECRET');
  return value && value.length >= 16 ? value : undefined;
}

/** IANA zone that decides what "due today" means for follow-ups. */
export function businessTimeZone(): string {
  return read('BUSINESS_TIMEZONE') ?? 'America/Chicago';
}
