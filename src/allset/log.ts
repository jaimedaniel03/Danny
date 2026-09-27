/**
 * Structured logging that cannot carry personal data.
 *
 * Log lines go to the hosting provider, which is outside the retention policy
 * we publish. So the logger only accepts scalar fields, rejects any field
 * whose name suggests personal data, and reduces errors to their class and
 * database error code — a Postgres error message can quote the offending
 * value ("Key (email)=(...) already exists"), so the message itself is
 * never logged.
 */

type Scalar = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, Scalar>>;

const FORBIDDEN_WORDS = new Set([
  'email', 'phone', 'name', 'zip', 'address', 'ip', 'password', 'token', 'secret',
  'body', 'note', 'message', 'cookie', 'authorization', 'ssn', 'dob',
]);

/** `fullName`, `email_normalized`, `IPs`, `x-auth-token` → their words, so any spelling is caught. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function forbiddenKey(key: string): boolean {
  return keyWords(key).some((word) => FORBIDDEN_WORDS.has(word) || (word.endsWith('s') && FORBIDDEN_WORDS.has(word.slice(0, -1))));
}

// A value can carry personal data under an innocent key ("detail", "reason").
const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_SHAPED = /(?:\+?\d[\s().-]*){10,}/;
const SECRET_SHAPED = /[A-Za-z0-9_-]{32,}/;
// Row ids are how a failure gets traced; they're not secrets or phone numbers.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function forbiddenValue(value: string): boolean {
  // A uuid can also start with ten-plus digits between dashes, which reads as a phone number.
  const rest = value.replace(UUID, ' ');
  return EMAIL_SHAPED.test(rest) || PHONE_SHAPED.test(rest) || SECRET_SHAPED.test(rest);
}

function scrub(fields: LogFields | undefined): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (forbiddenKey(key) || (typeof value === 'string' && forbiddenValue(value))) {
      out[key] = '[withheld]';
      continue;
    }
    out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return out;
}

export function describeError(error: unknown): Record<string, Scalar> {
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; code?: unknown; constraint_name?: unknown };
    return {
      error_class: typeof e.name === 'string' ? e.name : 'Error',
      error_code: typeof e.code === 'string' ? e.code : undefined,
      error_constraint: typeof e.constraint_name === 'string' ? e.constraint_name : undefined,
    };
  }
  return { error_class: typeof error };
}

function emit(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, Scalar>): void {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  info(event: string, fields?: LogFields): void {
    emit('info', event, scrub(fields));
  },
  warn(event: string, fields?: LogFields): void {
    emit('warn', event, scrub(fields));
  },
  error(event: string, error?: unknown, fields?: LogFields): void {
    emit('error', event, { ...scrub(fields), ...(error === undefined ? {} : describeError(error)) });
  },
};
