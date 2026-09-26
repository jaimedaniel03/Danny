// Creates a fresh database for the end-to-end suite from the real migration.
// Usage: TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/postgres node scripts/e2e/prepare-db.mjs
// Prints the DATABASE_URL the app server should use.
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const admin = process.env.TEST_DATABASE_ADMIN_URL;
if (!admin) {
  console.error('Set TEST_DATABASE_ADMIN_URL to a superuser URL on a disposable Postgres.');
  process.exit(1);
}
const name = process.env.E2E_DB_NAME ?? 'allset_e2e';
if (!/^[a-z0-9_]+$/.test(name)) throw new Error('bad database name');

const root = postgres(admin, { max: 1, onnotice: () => {} });
await root.unsafe(`drop database if exists ${name} with (force)`);
await root.unsafe(`create database ${name}`);
await root.end();

const url = new URL(admin);
url.pathname = `/${name}`;
const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
await db.unsafe(readFileSync('supabase/migrations/0003_allset_site.sql', 'utf8'));
await db.unsafe(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'allset_e2e_login') then
      create role allset_e2e_login login password 'allset_e2e_login_only' inherit;
    end if;
  end $$;
  grant allset_app to allset_e2e_login;`);
await db.end();

url.username = 'allset_e2e_login';
url.password = 'allset_e2e_login_only';
console.log(url.toString());
