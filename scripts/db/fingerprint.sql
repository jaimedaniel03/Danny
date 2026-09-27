-- The shape supabase/migrations/0003_allset_site.sql defines, one sorted line
-- per object: columns, constraints, indexes, policies, RLS flags, grants,
-- functions and triggers in schema allset. No data.
--
-- scripts/db/verify.sh compares a live database against the committed copy
-- (scripts/db/allset-schema.fingerprint); scripts/db/rehearse.sh keeps that
-- copy in step with the migration.
--
-- Grants held by an object's owner are left out (the owner differs between a
-- plain Postgres and Supabase); every other grantee is listed, so an extra
-- role with rights on these tables shows up as a difference.
select 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' default=' || coalesce(column_default, '-')
  from information_schema.columns where table_schema = 'allset'
-- Redundant parentheses in a deparsed CHECK differ between an original and a
-- restored copy (same expression, different deparse), so they're dropped.
union all select 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || contype::text || ' '
    || regexp_replace(pg_get_constraintdef(oid), '[()[:space:]]', '', 'g')
  from pg_constraint where connamespace = 'allset'::regnamespace
union all select 'index ' || indexname || ' ' || indexdef from pg_indexes where schemaname = 'allset'
union all select 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',')
    || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
  from pg_policies where schemaname = 'allset'
union all select 'rls ' || relname || ' enabled=' || relrowsecurity::text || ' forced=' || relforcerowsecurity::text
  from pg_class where relnamespace = 'allset'::regnamespace and relkind = 'r'
union all select 'schema-grant allset ' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ' ' || a.privilege_type
  from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'allset' and a.grantee <> n.nspowner
union all select 'grant ' || c.relname || ' ' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ' ' || a.privilege_type
  from pg_class c, aclexplode(c.relacl) a
  where c.relnamespace = 'allset'::regnamespace and c.relkind in ('r', 'S') and a.grantee <> c.relowner
union all select 'function ' || p.proname || ' security_definer=' || p.prosecdef::text || ' body_md5=' || md5(p.prosrc)
  from pg_proc p where p.pronamespace = 'allset'::regnamespace
union all select 'function-grant ' || p.proname || ' ' || case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end || ' ' || a.privilege_type
  from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  where p.pronamespace = 'allset'::regnamespace and a.grantee <> p.proowner
union all select 'trigger ' || tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
  from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'allset'::regnamespace)
order by 1;
