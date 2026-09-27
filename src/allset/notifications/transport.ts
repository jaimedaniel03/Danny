/**
 * Email transport. Production uses Resend's HTTP API directly (no SDK, one
 * fetch). Tests swap in a recorder. Errors are reduced to a status and a
 * short, data-free reason before they are stored or shown.
 */

import 'server-only';
import { emailConfig } from '@/allset/env';

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Stable per notification, so a retried send cannot deliver twice. */
  readonly idempotencyKey: string;
}

export interface EmailTransport {
  send(email: OutgoingEmail): Promise<{ readonly providerId: string }>;
}

export class DeliveryError extends Error {
  constructor(
    readonly reason: string,
    /** False when retrying cannot help (bad key, rejected address, no config). */
    readonly retryable: boolean,
    /** From the provider's Retry-After header: wait at least this long. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(reason);
    this.name = 'DeliveryError';
  }
}

class ResendTransport implements EmailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(email: OutgoingEmail): Promise<{ providerId: string }> {
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey,
        },
        body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DeliveryError('Could not reach the email provider (network error or timeout).', true);
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: unknown };
      if (typeof body.id !== 'string') throw new DeliveryError('Email provider accepted the message but returned no id.', true);
      return { providerId: body.id };
    }

    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter = retryable ? parseRetryAfter(response.headers.get('retry-after')) : null;
    const hint =
      response.status === 401 || response.status === 403
        ? 'The email API key was rejected.'
        : response.status === 422
          ? 'The provider rejected the message (check the sender domain and recipient address).'
          : retryable
            ? 'The email provider is busy or unavailable.'
            : 'The email provider refused the message.';
    throw new DeliveryError(`${hint} (HTTP ${response.status})`, retryable, retryAfter);
  }
}

/**
 * Retry-After is either seconds or an HTTP date. Anything unparseable, in the
 * past, or absurd is ignored (the outbox's own backoff still applies), and it
 * is capped so a bad header can't park an alert for days.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    seconds = Math.ceil((at - now) / 1000);
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, 6 * 60 * 60);
}

class UnconfiguredTransport implements EmailTransport {
  async send(): Promise<never> {
    throw new DeliveryError('Email alerts are not configured: set RESEND_API_KEY and NOTIFY_FROM.', false);
  }
}

let override: EmailTransport | null = null;

export function setTransportForTests(transport: EmailTransport | null): void {
  override = transport;
}

export function emailTransport(): EmailTransport {
  if (override) return override;
  const config = emailConfig();
  return config ? new ResendTransport(config.apiKey, config.from) : new UnconfiguredTransport();
}
