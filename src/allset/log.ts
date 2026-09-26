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

const FORBIDDEN_KEY = /(^|_)(email|phone|name|zip|address|ip|password|token|secret|body|note|message)s?($|_)/i;

function scrub(fields: LogFields | undefined): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEY.test(key)) {
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
