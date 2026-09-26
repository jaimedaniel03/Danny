/**
 * The one Postgres connection pool for the site.
 *
 * Every query in src/allset is a postgres.js tagged template, which sends
 * values as bind parameters — string concatenation into SQL does not appear
 * anywhere in this layer, and `sql.unsafe` is banned by lint.
 *
 * `prepare: false` because production connects through Supabase's
 * transaction-mode pooler, where a prepared statement can land on a
 * different backend than the one that prepared it.
 */

import 'server-only';
import postgres from 'postgres';
import { databaseUrl } from '@/allset/env';

export type Sql = postgres.Sql;
export type TransactionSql = postgres.TransactionSql;

let pool: Sql | null = null;

export function db(): Sql {
  if (pool) return pool;
  pool = postgres(databaseUrl(), {
    max: Number(process.env['DATABASE_POOL_MAX'] ?? 3),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: 'allset-site' },
    types: {
      // Keep calendar dates as 'YYYY-MM-DD'. Parsing them into a Date would
      // shift a follow-up by a day for anyone west of UTC.
      date: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
  });
  return pool;
}

/** Test hook: close the pool so a suite can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end({ timeout: 5 });
}
