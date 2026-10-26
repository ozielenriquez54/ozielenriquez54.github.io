-- ============================================================================
-- ANDAMIO DE PRUEBA — SOLO PARA UN POSTGRES LOCAL DESECHABLE.
-- NUNCA ejecutar esto contra Supabase, real ni de prueba.
--
-- Complemento de PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql (que ya crea
-- gym_memberships/clients/coach_clients/pilot_role/auth.uid()) — agrega
-- dos stubs que COACH-CLIENT-STATE-MIGRATION.sql (y sus pruebas)
-- necesitan y que esta sesión nunca ha definido en ningún esquema local:
--
--   1. `pilot_private.lock_admin` — mecanismo de serialización por
--      gimnasio mencionado en rondas anteriores como algo que ya usan
--      las RPC confirmadas, pero esta sesión NUNCA ha visto su firma ni
--      definición real (sin acceso a Supabase real para confirmarlo).
--      Este stub usa un bloqueo advisory por gimnasio — suficiente para
--      ejercer la serialización localmente, NO la implementación real.
--
--   2. `pilot_set_coach_client` — la RPC real ya CONFIRMADA (por firma,
--      no por implementación) en pilot-admin-provisioning-service.cjs:
--      "pilot_set_coach_client(p_gym_id uuid, p_coach_membership_id uuid,
--      p_client_membership_id uuid, p_active boolean, p_expected_revision
--      bigint) — exige que ambas membresías sean del mismo gym_id y que
--      el cliente ya tenga registro en `clients`; concurrencia optimista
--      por `p_expected_revision`, SQLSTATE 40001 si no coincide." Esta
--      sesión nunca ha visto su definición real (vive en Supabase real,
--      sin acceso aquí) — este stub reproduce ESE contrato ya confirmado
--      (resuelve `clients.id` internamente, compara p_expected_revision
--      exacto, 40001 si no coincide, 23503 si `clients` no existe) para
--      poder probar COACH-CLIENT-STATE-MIGRATION.sql de punta a punta
--      contra un Postgres real — no es, ni pretende ser, el código fuente
--      real de esa RPC.
--
-- Uso (en ese orden, sobre una base de datos creada solo para esto):
--   createdb twogramms_disposable_test
--   psql -d twogramms_disposable_test -f PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql
--   psql -d twogramms_disposable_test -f COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql
--   psql -d twogramms_disposable_test -f COACH-CLIENT-STATE-MIGRATION.sql
--   psql -d twogramms_disposable_test -f COACH-CLIENT-STATE-MIGRATION-TEST.sql
-- ============================================================================

create schema if not exists pilot_private;

create or replace function pilot_private.lock_admin(p_gym_id uuid) returns void
language sql
as $$ select pg_advisory_xact_lock(hashtext(p_gym_id::text)) $$;

grant usage on schema pilot_private to authenticated;
grant execute on function pilot_private.lock_admin(uuid) to authenticated;

create or replace function public.pilot_set_coach_client(
  p_gym_id uuid, p_coach_membership_id uuid, p_client_membership_id uuid,
  p_active boolean, p_expected_revision bigint
) returns void
language plpgsql
security definer
as $$
declare
  v_client_id uuid;
  v_row_id uuid;
  v_current_revision bigint;
begin
  select c.id into v_client_id from clients c where c.gym_id = p_gym_id and c.membership_id = p_client_membership_id;
  if v_client_id is null then
    raise exception 'RELATED_RECORD_NOT_FOUND' using errcode = '23503';
  end if;
  select cc.id, cc.revision into v_row_id, v_current_revision
  from coach_clients cc
  where cc.gym_id = p_gym_id and cc.coach_membership_id = p_coach_membership_id and cc.client_id = v_client_id;
  if v_row_id is null then
    if p_expected_revision <> 0 then
      raise exception 'REVISION_CONFLICT' using errcode = '40001';
    end if;
    insert into coach_clients (gym_id, coach_membership_id, client_id, active, revision)
    values (p_gym_id, p_coach_membership_id, v_client_id, p_active, 1);
  else
    if v_current_revision <> p_expected_revision then
      raise exception 'REVISION_CONFLICT' using errcode = '40001';
    end if;
    update coach_clients set active = p_active, revision = v_current_revision + 1 where id = v_row_id;
  end if;
end;
$$;

grant execute on function public.pilot_set_coach_client(uuid, uuid, uuid, boolean, bigint) to authenticated;
