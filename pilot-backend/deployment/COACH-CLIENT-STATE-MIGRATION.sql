-- ============================================================================
-- PROPUESTA DE MIGRACIÓN — NO APLICADA A SUPABASE REAL.
--
-- Corrige los hallazgos de Codex sobre `setCoachClient()` en
-- pilot-admin-provisioning-service.cjs (commit e6554fffdd90ea50cc9e405d05fcc53b714d83d2):
-- esa función necesitaba conocer la revisión ACTUAL de `coach_clients`
-- antes de escribir (concurrencia optimista), pero leer `clients`/
-- `coach_clients` con la sesión del propio OWNER/ADMIN estaba bloqueado
-- por RLS (datos clínicos, solo legibles por el propio cliente o su coach
-- YA asignado) — la ronda anterior "resolvía" esto ADIVINANDO la revisión
-- con un ciclo 0..7, lo cual Codex señaló correctamente como frágil e
-- incorrecto:
--   1. El ciclo de adivinanza se elimina por completo.
--   2. Esta función (`pilot_get_coach_client_state`) resuelve, de forma
--      administrativa y SEGURA, exactamente lo que la capa JS necesita
--      (id/activo/revisión de `coach_clients`, si existe) — nunca datos
--      clínicos adicionales, nunca una fila completa de `clients`.
--   3. Restringida a OWNER/ADMIN ACTIVOS del gimnasio exacto — la
--      comprobación se hace EXPLÍCITAMENTE contra `gym_memberships`
--      dentro de la propia función (nunca se confía en que la capa que
--      llama ya validó nada, porque esta función es SECURITY DEFINER).
--   4. Distingue explícitamente "el perfil del cliente todavía no existe"
--      (genuinamente pendiente) de "la relación gimnasio/coach/cliente es
--      inválida" (coach o cliente de otro gimnasio, o inexistente) — la
--      capa JS ya NO interpreta cualquier 23503 como "pendiente".
--   5. Nunca reactiva sola una relación coach-cliente INACTIVA: devuelve
--      su estado tal cual, y la capa JS decide (ver
--      pilot-admin-provisioning-service.cjs) — reactivarla exige una
--      acción administrativa explícita, no un efecto secundario de
--      "agregar cliente".
--   6. `pilot_set_coach_client` (RPC ya existente, confirmada) sigue
--      siendo la ÚNICA que escribe — esta función nunca escribe nada, es
--      de solo lectura administrativa.
--
-- Como toda esta sesión: nadie aquí tiene acceso a Supabase real, este
-- SQL no se ha ejecutado contra ninguna base de datos real, y el código
-- Node.js que depende de esta función (pilot-admin-provisioning-service.cjs)
-- está escrito y probado contra MOCKS que asumen este contrato — si esta
-- migración no se aplica (o se aplica distinta), `setCoachClient()`
-- simplemente falla con PROVISIONING_SERVICE_UNAVAILABLE (RPC
-- desconocida), nunca con una asignación incorrecta o silenciosa.
--
-- ⚠️ `pilot_private.lock_admin` — SIN CONFIRMAR EN ESTA SESIÓN. Se
-- menciona en comentarios de rondas anteriores (ver
-- pilot-admin-provisioning-service.cjs y PROVISIONING-GAP.md) como el
-- mecanismo de serialización por gimnasio que ya usan las RPC
-- confirmadas (`pilot_set_membership`/`pilot_set_coach_client`), pero
-- esta sesión NUNCA ha visto su firma ni su definición real — no hay
-- acceso a Supabase real para confirmarlo. La llamada de abajo
-- (`pilot_private.lock_admin(p_gym_id)`) usa la firma más simple y
-- plausible dado el nombre y el uso descrito; quien aplique esto DEBE
-- confirmar/ajustar esa llamada contra la definición real antes de
-- desplegar — si la firma real es distinta, esta función simplemente no
-- compilará/fallará al aplicarse, nunca se comportará mal en silencio.
-- Mientras tanto, el límite de seguridad REAL y verificado de esta
-- función es la comprobación explícita de OWNER/ADMIN activo contra
-- `gym_memberships`, no `lock_admin` (que aquí es, como mucho, una
-- serialización adicional, no la única barrera de autorización).
--
-- Quien aplique esto debe:
--   1. Confirmar/ajustar la llamada a `pilot_private.lock_admin` (ver
--      arriba).
--   2. Confirmar los nombres reales de columna en gym_memberships/
--      clients/coach_clients (mismo punto no verificado que el resto de
--      esta sesión).
--   3. Probar esto en un proyecto de Supabase DESECHABLE antes que en
--      producción.
-- ============================================================================

create or replace function public.pilot_get_coach_client_state(
  p_gym_id uuid,
  p_coach_membership_id uuid,
  p_client_membership_id uuid
)
returns table (
  out_client_exists boolean,
  out_coach_client_id uuid,
  out_active boolean,
  out_revision bigint
)
language plpgsql
security definer
-- Endurecido igual que pilot_resume_pending_activation(): search_path
-- vacío, cada tipo/tabla calificado explícitamente con `public.`.
set search_path = ''
as $$
declare
  v_coach_membership_valid boolean;
  v_client_membership_valid boolean;
  v_client_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Única barrera de autorización REAL y verificada de esta función:
  -- OWNER/ADMIN activo EN ESE gimnasio exacto. No se confía en que la
  -- capa JS que llama ya lo validó — esta función es SECURITY DEFINER y
  -- puede ser invocada directamente por cualquier sesión autenticada.
  if not exists (
    select 1 from public.gym_memberships gm
    where gm.gym_id = p_gym_id
      and gm.user_id = auth.uid()
      and gm.active = true
      and gm.roles && array['OWNER', 'ADMIN']::public.pilot_role[]
  ) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  -- Serialización administrativa por gimnasio — ver la nota de cabecera:
  -- firma NO confirmada en esta sesión.
  perform pilot_private.lock_admin(p_gym_id);

  -- "Relación inválida" (coach de otro gimnasio, o inexistente) se
  -- distingue EXPLÍCITAMENTE de "no existe todavía" — nunca se oculta
  -- como un simple PENDING_PROFILE del lado de la capa JS.
  select exists (
    select 1 from public.gym_memberships gm
    where gm.id = p_coach_membership_id and gm.gym_id = p_gym_id
  ) into v_coach_membership_valid;
  if not v_coach_membership_valid then
    raise exception 'INVALID_COACH_RELATIONSHIP' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.gym_memberships gm
    where gm.id = p_client_membership_id and gm.gym_id = p_gym_id
  ) into v_client_membership_valid;
  if not v_client_membership_valid then
    raise exception 'INVALID_CLIENT_RELATIONSHIP' using errcode = '22023';
  end if;

  select c.id into v_client_id
  from public.clients c
  where c.gym_id = p_gym_id and c.membership_id = p_client_membership_id;

  if v_client_id is null then
    -- profiles.id del cliente todavía no existe (pilot_set_membership no
    -- pudo crear `clients` todavía) — esto SÍ es "pendiente", nunca un
    -- error de integridad.
    return query select false, null::uuid, null::boolean, null::bigint;
    return;
  end if;

  return query
    select true, cc.id, cc.active, cc.revision
    from public.coach_clients cc
    where cc.gym_id = p_gym_id
      and cc.coach_membership_id = p_coach_membership_id
      and cc.client_id = v_client_id;

  if not found then
    -- El cliente existe, pero nunca se le asignó ESTE coach — primera
    -- asignación (revisión 0 desde la perspectiva de la capa JS).
    return query select true, null::uuid, null::boolean, null::bigint;
  end if;
end;
$$;

comment on function public.pilot_get_coach_client_state(uuid, uuid, uuid) is
  'Lectura administrativa SEGURA (nunca clínica) del estado de coach_clients para un (gym, coach, cliente) exacto. Exclusiva para OWNER/ADMIN activo de ESE gimnasio. Nunca escribe nada — pilot_set_coach_client sigue siendo la única escritura. Distingue "cliente sin perfil todavía" de "relación coach/cliente inválida" explícitamente.';

revoke all on function public.pilot_get_coach_client_state(uuid, uuid, uuid) from public;
grant execute on function public.pilot_get_coach_client_state(uuid, uuid, uuid) to authenticated;
