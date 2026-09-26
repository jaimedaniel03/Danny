import { afterAll, describe } from 'vitest';
import { closeDb, db } from '@/allset/db/client';

/**
 * `describe` for suites that need Postgres. Skips, visibly, when the run has
 * no TEST_DATABASE_ADMIN_URL; CI always sets it.
 */
export const describeDb: typeof describe = process.env['DATABASE_URL']
  ? describe
  : (describe.skip as typeof describe);

if (process.env['DATABASE_URL']) {
  afterAll(async () => {
    await closeDb();
  });
}

let counter = 0;
/** An email no other test in this run will use. */
export function uniqueEmail(label = 'person'): string {
  counter += 1;
  return `${label}.${process.pid}.${Date.now().toString(36)}.${counter}@example.com`;
}

export { db };
