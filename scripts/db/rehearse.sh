#!/usr/bin/env bash
# Rehearses the All Set Check migration and a backup + restore, on a
# disposable Postgres, before anything touches a real database.
#
#   TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres scripts/db/rehearse.sh
#
# 1. Applies supabase/migrations/0003_allset_site.sql to a fresh database
#    (it is self-contained: it needs neither 0001/0002 nor Supabase's auth schema).
# 2. Proves it can't be applied twice by accident (it fails loudly).
# 3. Checks the result against the committed fingerprint and least-privilege
#    rules (scripts/db/verify.sh), so the fingerprint can't drift from the
#    migration unnoticed.
#    The dump is of schema allset only: restoring into another cluster needs
#    the role allset_app to exist there first (the migration's opening block).
# 4. Seeds synthetic rows, takes a pg_dump (custom format), restores it into a
#    second fresh database, and compares schema, constraints, policies,
#    grants, functions, triggers and row counts between the two.
# Both databases are dropped at the end.
set -euo pipefail

: "${TEST_DATABASE_ADMIN_URL:?Set TEST_DATABASE_ADMIN_URL to a superuser URL on a disposable Postgres}"
ADMIN="$TEST_DATABASE_ADMIN_URL"
STAMP="$(date +%s)"
SRC="allset_rehearse_src_${STAMP}"
DST="allset_rehearse_dst_${STAMP}"
DUMP="$(mktemp -d)/allset.dump"
url_for() { python3 -c "import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(p._replace(path='/'+sys.argv[2]).geturl())" "$ADMIN" "$1"; }
SRC_URL="$(url_for "$SRC")"
DST_URL="$(url_for "$DST")"

cleanup() {
  psql "$ADMIN" -qc "drop database if exists ${SRC}" >/dev/null 2>&1 || true
  psql "$ADMIN" -qc "drop database if exists ${DST}" >/dev/null 2>&1 || true
  rm -f "$DUMP"
}
trap cleanup EXIT

echo "== 1. Apply the migration to a fresh database"
psql "$ADMIN" -qc "create database ${SRC}"
psql "$SRC_URL" -q -v ON_ERROR_STOP=1 -f supabase/migrations/0003_allset_site.sql
echo "applied: $(psql "$SRC_URL" -Atc "select count(*) from pg_tables where schemaname = 'allset'") tables in schema allset"

echo "== 2. A second application fails instead of silently diverging"
if psql "$SRC_URL" -q -v ON_ERROR_STOP=1 -f supabase/migrations/0003_allset_site.sql >/dev/null 2>&1; then
  echo "FAIL: the migration applied twice"; exit 1
else
  echo "ok: re-applying is refused"
fi

echo "== 3. The fresh database matches the committed fingerprint and is least-privilege"
scripts/db/verify.sh "$SRC_URL"
# ...and the check catches drift: a stray grant, and an app role that skips RLS.
psql "$SRC_URL" -q -v ON_ERROR_STOP=1 -c "grant select on allset.leads to public"
if scripts/db/verify.sh "$SRC_URL" >/dev/null 2>&1; then echo "FAIL: verify missed a stray grant"; exit 1; fi
psql "$SRC_URL" -q -v ON_ERROR_STOP=1 -c "revoke select on allset.leads from public"
psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "alter role allset_app bypassrls"
if scripts/db/verify.sh "$SRC_URL" >/dev/null 2>&1; then
  psql "$ADMIN" -qc "alter role allset_app nobypassrls"; echo "FAIL: verify missed BYPASSRLS on the app role"; exit 1
fi
psql "$ADMIN" -q -v ON_ERROR_STOP=1 -c "alter role allset_app nobypassrls"
scripts/db/verify.sh "$SRC_URL" >/dev/null
echo "ok: verify fails on a stray grant and on BYPASSRLS, and passes once they're undone"

echo "== 4. Seed synthetic rows"
psql "$SRC_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
insert into allset.staff_users (email, display_name, role, password_hash) values ('owner@example.invalid', 'Rehearsal Owner', 'owner', 'scrypt$1$1$1$x$y');
insert into allset.leads (kind, full_name, email, email_normalized, zip, state, contact_method, coverage_interest, is_synthetic)
  values ('coverage', 'Rehearsal Person', 'person@example.invalid', 'person@example.invalid', '60601', 'IL', 'email', 'life', true);
insert into allset.inquiries (reference, idempotency_key, lead_id, kind, payload, consent_text, consent_version, consented_at, consent_channels, source_path)
  select 'ASC-AB12-CD34', gen_random_uuid(), id, 'coverage', '{}'::jsonb, 'I agree.', 'coverage-v1-rehearsal', now(), array['email'], '/contact' from allset.leads;
insert into allset.contact_suppressions (value_hash, kind, basis) values ('rehearsal-hash', 'email', 'explicit_opt_out');
insert into allset.audit_events (action, details) values ('rehearsal.seeded', '{}');
SQL

# What must survive a restore: the schema fingerprint plus row counts.
snapshot() {
  psql "$1" -At -v ON_ERROR_STOP=1 -f scripts/db/fingerprint.sql
  psql "$1" -At -v ON_ERROR_STOP=1 -c "select 'rows ' || relname || ' ' || n_live_tup from pg_stat_user_tables where schemaname = 'allset' and n_live_tup > 0 order by 1"
}

psql "$SRC_URL" -qc "analyze" >/dev/null
BEFORE="$(snapshot "$SRC_URL")"

echo "== 5. Back up (pg_dump, custom format) and restore into a fresh database"
pg_dump --format=custom --schema=allset --file="$DUMP" "$SRC_URL"
echo "dump: $(du -h "$DUMP" | cut -f1)"
psql "$ADMIN" -qc "create database ${DST}"
pg_restore --exit-on-error --dbname="$DST_URL" "$DUMP"
psql "$DST_URL" -qc "analyze" >/dev/null
AFTER="$(snapshot "$DST_URL")"

echo "== 6. Compare"
COUNT="$(echo "$BEFORE" | wc -l)"
echo "objects checked: ${COUNT}"
# An empty or truncated snapshot would "match" trivially; refuse it.
if [ "$COUNT" -lt 300 ]; then
  echo "FAIL: the snapshot is too small to prove anything (${COUNT} lines)"; exit 1
fi
if [ "$BEFORE" = "$AFTER" ]; then
  echo "ok: schema, constraints, indexes, policies, RLS, grants, functions, triggers and row counts match"
else
  echo "FAIL: restored database differs"; diff <(echo "$BEFORE") <(echo "$AFTER") | head -40; exit 1
fi

echo "== 7. The restored copy still enforces its rules"
if psql "$DST_URL" -q -v ON_ERROR_STOP=1 -c "update allset.inquiries set consent_text = 'edited'" >/dev/null 2>&1; then
  echo "FAIL: consent evidence was editable after restore"; exit 1
else
  echo "ok: consent evidence is still immutable"
fi
if psql "$DST_URL" -q -v ON_ERROR_STOP=1 -c "delete from allset.audit_events" >/dev/null 2>&1; then
  echo "FAIL: audit events were deletable after restore"; exit 1
else
  echo "ok: the audit trail is still append-only"
fi
echo "REHEARSAL PASSED"
