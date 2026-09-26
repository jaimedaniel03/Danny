/**
 * Creates a throwaway database for this test run, applies the real migration
 * to it, and hands the suite a connection string for the restricted
 * `allset_app` role — so tests exercise the same grants and row-level
 * security production does, not a superuser's view of the world.
 *
 * Requires TEST_DATABASE_ADMIN_URL (a superuser URL on a disposable server).
 * Without it, database suites skip and say so.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    allsetDatabaseUrl: string;
    allsetAdminUrl: string;
  }
}

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user.name;
    parsed.password = user.password;
  }
  return parsed.toString();
}

export default async function setup(project: TestProject): Promise<(() => Promise<void>) | undefined> {
  const admin = process.env['TEST_DATABASE_ADMIN_URL'];
  if (!admin) {
    project.provide('allsetDatabaseUrl', '');
    project.provide('allsetAdminUrl', '');
    return undefined;
  }

  const name = `allset_test_${process.pid}_${Date.now().toString(36)}`;
  // The identifier is generated above from digits and letters only.
  const root = postgres(admin, { max: 1, onnotice: () => {} });
  await root.unsafe(`create database ${name}`);

  const migration = readFileSync(join(process.cwd(), 'supabase/migrations/0003_allset_site.sql'), 'utf8');
  const target = postgres(withDatabase(admin, name), { max: 1, onnotice: () => {} });
  await target.unsafe(migration);
  // A separate login role that inherits allset_app's grants and falls under
  // its row-level-security policy. Tests never touch allset_app's own
  // password, which a local dev database may be using.
  const loginRole = 'allset_test_login';
  const loginPassword = 'allset_test_login_only';
  await target.unsafe(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${loginRole}') then
        create role ${loginRole} login password '${loginPassword}' inherit;
      end if;
    end $$;
    grant allset_app to ${loginRole};`);
  await target.end();

  project.provide('allsetDatabaseUrl', withDatabase(admin, name, { name: loginRole, password: loginPassword }));
  project.provide('allsetAdminUrl', withDatabase(admin, name));

  return async () => {
    await root.unsafe(`drop database if exists ${name} with (force)`);
    await root.end();
  };
}
