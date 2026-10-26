-- ============================================================================
-- ANDAMIO DE PRUEBA — SOLO PARA UN POSTGRES LOCAL DESECHABLE.
-- NUNCA ejecutar esto contra Supabase, real ni de prueba: recrea de forma
-- APROXIMADA el esquema que PENDING-ACTIVATION-MIGRATION.sql asume ya
-- existente en el proyecto real (gym_memberships, clients, coach_clients,
-- el tipo pilot_role, y auth.uid()). En Supabase real, `auth.uid()` ya
-- existe (lee el JWT de la sesión); aquí se sustituye por un stub basado
-- en una variable de sesión (`test.current_uid`) para poder simular
-- distintos usuarios en una misma conexión de prueba.
--
-- Uso (PostgreSQL 16 o 17, en una base de datos creada solo para esto):
--   createdb twogramms_disposable_test
--   psql -d twogramms_disposable_test -f PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql
--   psql -d twogramms_disposable_test -f PENDING-ACTIVATION-MIGRATION.sql
--   psql -d twogramms_disposable_test -f PENDING-ACTIVATION-MIGRATION-TEST.sql
-- ============================================================================

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select current_setting('test.current_uid', true)::uuid $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'pilot_role') then
    create type pilot_role as enum ('OWNER', 'ADMIN', 'COACH', 'CLIENT');
  end if;
end $$;

create table if not exists gym_memberships (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null,
  user_id uuid not null,
  roles pilot_role[] not null default '{}',
  active boolean not null default true,
  revision bigint not null default 0,
  unique (gym_id, user_id)
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null,
  membership_id uuid not null references gym_memberships(id),
  unique (gym_id, membership_id)
);

create table if not exists coach_clients (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null,
  coach_membership_id uuid not null references gym_memberships(id),
  client_id uuid not null references clients(id),
  active boolean not null default true,
  revision bigint not null default 0,
  unique (gym_id, coach_membership_id, client_id)
);

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public to authenticated;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
-- Lectura de las tablas de dominio ya existentes, para que las políticas
-- RLS de PENDING-ACTIVATION-MIGRATION.sql (que las consultan) funcionen.
grant select on gym_memberships, clients, coach_clients to authenticated;
