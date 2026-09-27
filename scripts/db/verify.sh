#!/usr/bin/env bash
# Checks a database that has the All Set Check migration applied: its schema
# matches what the migration defines, and the app role holds no more than it
# needs. Read-only; run it after applying the migration, and after any change
# someone makes by hand.
#
#   scripts/db/verify.sh 'postgres://postgres:<password>@<host>:5432/postgres?sslmode=require'
#
# Connect as the schema owner (on Supabase, `postgres`): the checks read
# catalogs and ACLs a restricted role can't see. Exits non-zero on any failure.
set -euo pipefail

URL="${1:?Usage: scripts/db/verify.sh <postgres URL, as the schema owner>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FAILED=0
q() { psql "$URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
fail() { echo "FAIL: $*"; FAILED=1; }

echo "== Schema matches the migration"
ACTUAL="$(psql "$URL" -At -v ON_ERROR_STOP=1 -f "$HERE/fingerprint.sql")"
if [ "$ACTUAL" = "$(cat "$HERE/allset-schema.fingerprint")" ]; then
  echo "ok: $(echo "$ACTUAL" | wc -l) objects match scripts/db/allset-schema.fingerprint"
else
  fail "schema differs from the migration (< expected, > this database)"
  diff "$HERE/allset-schema.fingerprint" <(echo "$ACTUAL") | head -60 || true
fi

echo "== The app role is least-privilege"
ROLE="$(q "select rolsuper::text || ' ' || rolbypassrls::text || ' ' || rolcreaterole::text || ' ' || rolcreatedb::text || ' ' || rolcanlogin::text from pg_roles where rolname = 'allset_app'")"
if [ -z "$ROLE" ]; then
  fail "role allset_app does not exist"
else
  read -r SUPER BYPASS CREATEROLE CREATEDB LOGIN <<<"$ROLE"
  [ "$SUPER" = "false" ] || fail "allset_app is a superuser"
  [ "$BYPASS" = "false" ] || fail "allset_app bypasses row-level security"
  [ "$CREATEROLE" = "false" ] || fail "allset_app can create roles"
  [ "$CREATEDB" = "false" ] || fail "allset_app can create databases"
  [ "$(q "select count(*) from pg_auth_members where member = 'allset_app'::regrole")" = "0" ] \
    || fail "allset_app is a member of another role (it inherits that role's rights)"
  [ "$(q "select count(*) from pg_class where relowner = 'allset_app'::regrole")" = "0" ] \
    || fail "allset_app owns objects (an owner can alter or disable their security)"
  [ "$(q "select count(*) from pg_namespace where nspname <> 'allset' and nspname not like 'pg\_%' and nspname <> 'information_schema' and has_schema_privilege('allset_app', oid, 'USAGE')")" = "0" ] \
    || echo "note: allset_app can use other schemas: $(q "select string_agg(nspname, ', ') from pg_namespace where nspname <> 'allset' and nspname not like 'pg\_%' and nspname <> 'information_schema' and has_schema_privilege('allset_app', oid, 'USAGE')")"
  echo "role allset_app: login=${LOGIN} superuser=${SUPER} bypassrls=${BYPASS} createrole=${CREATEROLE} createdb=${CREATEDB}"
fi

echo "== Who else can read every lead (by design: platform admin roles; keep their credentials server-side)"
q "select rolname from pg_roles where (rolsuper or rolbypassrls) and rolname not like 'pg\_%' order by 1" | sed 's/^/  /'

echo "== Migration history (Supabase CLI), if present"
if [ "$(q "select to_regclass('supabase_migrations.schema_migrations') is not null")" = "t" ]; then
  q "select version || ' ' || coalesce(name, '') from supabase_migrations.schema_migrations order by version" | sed 's/^/  /'
else
  echo "  (no supabase_migrations.schema_migrations table; the fingerprint above is the version check)"
fi

if [ "$FAILED" = "0" ]; then echo "VERIFY PASSED"; else echo "VERIFY FAILED"; exit 1; fi
