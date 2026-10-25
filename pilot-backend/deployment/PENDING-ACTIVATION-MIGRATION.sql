-- ============================================================================
-- PROPUESTA DE MIGRACIÓN — NO APLICADA A SUPABASE REAL.
--
-- Este archivo es una PROPUESTA para habilitar la activación automática de
-- clientes invitados en Twogramms (preprod-docker-test). Nadie en esta
-- sesión tiene acceso a Supabase real: este SQL no se ha ejecutado contra
-- ninguna base de datos, ni real ni de prueba. El código Node.js de
-- `pilot-backend/server/pilot-admin-provisioning-service.cjs` y
-- `nutrika/pilot-auth.js` que depende de esta tabla y esta función está
-- escrito y probado contra MOCKS que asumen este contrato — si esta
-- migración no se aplica (o se aplica distinta), esas dos piezas
-- simplemente no tendrán efecto: ver el try/catch alrededor de cada
-- llamada, diseñado para degradar sin romper nada si esta infraestructura
-- no existe todavía.
--
-- Quien aplique esto debe:
--   1. Confirmar los nombres reales de columna en gym_memberships/clients/
--      coach_clients (ver el contrato no verificado en
--      pilot-admin-provisioning-service.cjs) y ajustar los nombres aquí si
--      difieren.
--   2. Revisar si ya existe una convención de "revision"/"lock_admin"
--      distinta a la asumida aquí (pilot_private.lock_admin) y adaptar.
--   3. Probar esto en un proyecto de Supabase DESECHABLE, nunca en
--      producción directamente.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Tabla: solicitud de activación pendiente.
--
-- Una fila = "un OWNER/ADMIN ya autorizó esta asignación; falta que
-- profiles.id de este usuario exista para poder completarla." Nunca se
-- expone a RLS para el rol `authenticated` en general — ni el cliente ni
-- ningún otro usuario pueden leer o escribir esta tabla directamente. Solo
-- la función SECURITY DEFINER de la sección 2 la toca en nombre del
-- cliente, y el backend de Twogramms (con la sesión del propio OWNER/ADMIN,
-- nunca con service_role) la escribe a través de PostgREST normal, sujeto
-- a las políticas de la sección 1b.
-- ----------------------------------------------------------------------------

create table if not exists public.pilot_pending_activations (
  id uuid primary key default gen_random_uuid(),
  gym_id uuid not null,
  user_id uuid not null,                  -- el cliente invitado (auth.users.id)
  coach_membership_id uuid not null,      -- gym_memberships.id del coach destino, fijado en el momento de autorizar
  created_by uuid not null,               -- gym_memberships.user_id del OWNER/ADMIN que autorizó esto
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Como máximo UNA solicitud pendiente por (gimnasio, cliente) — repetir
  -- el alta para el mismo correo nunca duplica una fila, solo actualiza
  -- coach_membership_id/created_by si cambió (ver upsert en el backend).
  unique (gym_id, user_id)
);

comment on table public.pilot_pending_activations is
  'Solicitudes de alta ya autorizadas por un OWNER/ADMIN, pendientes de que profiles.id del invitado exista. Nunca se otorgan privilegios al cliente: solo pilot_resume_pending_activation() la consume, en su propio nombre, tras revalidar que el autorizador original sigue siendo OWNER/ADMIN activo.';

-- 1b) RLS: cerrada por defecto. Solo políticas explícitas para OWNER/ADMIN
-- del gimnasio correspondiente (quien ya pudo ejecutar pilot_set_membership
-- de todas formas, así que esto no amplía su superficie de permisos).
alter table public.pilot_pending_activations enable row level security;

create policy pilot_pending_activations_owner_admin_rw
  on public.pilot_pending_activations
  for all
  using (
    exists (
      select 1 from public.gym_memberships gm
      where gm.gym_id = pilot_pending_activations.gym_id
        and gm.user_id = auth.uid()
        and gm.active = true
        and gm.roles && array['OWNER', 'ADMIN']::pilot_role[]
    )
  )
  with check (
    exists (
      select 1 from public.gym_memberships gm
      where gm.gym_id = pilot_pending_activations.gym_id
        and gm.user_id = auth.uid()
        and gm.active = true
        and gm.roles && array['OWNER', 'ADMIN']::pilot_role[]
    )
  );

-- El cliente NUNCA recibe una política de lectura/escritura sobre esta
-- tabla: su único punto de contacto es la función de la sección 2, que
-- opera en su nombre sin exponerle las filas directamente.


-- ----------------------------------------------------------------------------
-- 2) Función: reanudación automática, de autoservicio.
--
-- Diseño deliberado — por qué NO reutiliza pilot_set_membership/
-- pilot_set_coach_client directamente: esas RPC (según el contrato ya
-- confirmado) autorizan comprobando el rol de auth.uid() EN EL MOMENTO DE
-- LA LLAMADA. Si el cliente las invocara directamente, fallarían (su propio
-- auth.uid() nunca es OWNER/ADMIN) — y si se les diera service_role para
-- forzar esa comprobación, eso SÍ sería "saltarse pilot_private.lock_admin
-- con service_role", exactamente lo que esta tarea prohíbe.
--
-- En vez de eso, esta función es SECURITY DEFINER, pero:
--   (a) solo puede actuar sobre la fila cuyo `user_id` sea EXACTAMENTE
--       auth.uid() — nunca un id ajeno;
--   (b) antes de aplicar nada, REVALIDA en vivo que `created_by` sigue
--       siendo OWNER/ADMIN activo en `gym_id` — la autorización original
--       se respeta, pero no se confía ciegamente en que sigue vigente para
--       siempre (si ese OWNER/ADMIN fue removido después, la solicitud no
--       se aplica);
--   (c) usa `FOR UPDATE SKIP LOCKED` para que dos llamadas concurrentes
--       (dos pestañas, doble verify()) nunca dupliquen ni compitan: la
--       segunda simplemente no encuentra fila que bloquear y no hace nada;
--   (d) marca la fila como 'completed' en la MISMA transacción que aplica
--       los cambios, así que un fallo a mitad de camino deja la fila en
--       'pending' (recuperable: el próximo login reintenta) en vez de en un
--       estado a medias.
--
-- Nombres de columna asumidos para gym_memberships/clients/coach_clients:
-- ver el contrato no verificado en pilot-admin-provisioning-service.cjs.
-- Si difieren, hay que ajustar esta función — el resto de la propuesta
-- (tabla, políticas, llamada desde el cliente) no cambia.
-- ----------------------------------------------------------------------------

create or replace function public.pilot_resume_pending_activation()
returns table (status text, gym_id uuid, coach_membership_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_request record;
  v_membership_id uuid;
  v_membership_revision bigint;
  v_client_id uuid;
  v_coach_still_authorized boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Bloquea la fila pendiente propia (si existe) para que una segunda
  -- llamada concurrente no la vea disponible mientras esta la procesa.
  select * into v_request
  from public.pilot_pending_activations
  where user_id = v_uid and status = 'pending'
  order by created_at asc
  limit 1
  for update skip locked;

  if v_request is null then
    -- Nada pendiente (o ya la está procesando otra llamada concurrente):
    -- no es un error, simplemente no hay nada que reanudar todavía.
    return;
  end if;

  -- (b) Revalida en vivo la autorización administrativa original.
  select exists (
    select 1 from public.gym_memberships gm
    where gm.gym_id = v_request.gym_id
      and gm.user_id = v_request.created_by
      and gm.active = true
      and gm.roles && array['OWNER', 'ADMIN']::pilot_role[]
  ) into v_coach_still_authorized;

  if not v_coach_still_authorized then
    -- El autorizador original ya no es OWNER/ADMIN activo: se cancela en
    -- vez de aplicar una autorización que ya no es válida.
    update public.pilot_pending_activations
      set status = 'cancelled', revision = revision + 1
      where id = v_request.id;
    return query select 'cancelled'::text, v_request.gym_id, v_request.coach_membership_id;
    return;
  end if;

  -- Confirma que el coach destino sigue activo en ese gimnasio (puede haber
  -- cambiado desde que se autorizó la solicitud).
  if not exists (
    select 1 from public.gym_memberships gm
    where gm.id = v_request.coach_membership_id
      and gm.gym_id = v_request.gym_id
      and gm.active = true
      and gm.roles && array['COACH', 'OWNER', 'ADMIN']::pilot_role[]
  ) then
    update public.pilot_pending_activations
      set status = 'cancelled', revision = revision + 1
      where id = v_request.id;
    return query select 'cancelled'::text, v_request.gym_id, v_request.coach_membership_id;
    return;
  end if;

  -- Aplica la membresía CLIENT (mismo efecto que pilot_set_membership,
  -- revisión optimista incluida) — profiles.id de v_uid YA existe en este
  -- punto porque esta función solo se llama después de pilot_ensure_profile().
  select id, revision into v_membership_id, v_membership_revision
  from public.gym_memberships
  where gym_id = v_request.gym_id and user_id = v_uid
  for update;

  if v_membership_id is null then
    insert into public.gym_memberships (gym_id, user_id, roles, active, revision)
    values (v_request.gym_id, v_uid, array['CLIENT']::pilot_role[], true, 1)
    returning id into v_membership_id;
  else
    update public.gym_memberships
      set roles = array['CLIENT']::pilot_role[], active = true, revision = v_membership_revision + 1
      where id = v_membership_id;
  end if;

  -- `clients` — igual que pilot_set_membership, se crea si no existía.
  select id into v_client_id from public.clients where gym_id = v_request.gym_id and membership_id = v_membership_id;
  if v_client_id is null then
    insert into public.clients (gym_id, membership_id) values (v_request.gym_id, v_membership_id) returning id into v_client_id;
  end if;

  -- Vincula coach-cliente (mismo efecto que pilot_set_coach_client).
  insert into public.coach_clients (gym_id, coach_membership_id, client_id, active, revision)
  values (v_request.gym_id, v_request.coach_membership_id, v_client_id, true, 1)
  on conflict (gym_id, coach_membership_id, client_id)
  do update set active = true, revision = coach_clients.revision + 1;

  update public.pilot_pending_activations
    set status = 'completed', completed_at = now(), revision = revision + 1
    where id = v_request.id;

  return query select 'completed'::text, v_request.gym_id, v_request.coach_membership_id;
end;
$$;

comment on function public.pilot_resume_pending_activation() is
  'Autoservicio: completa, si existe, la ÚNICA solicitud de activación pendiente de auth.uid(). Revalida en vivo que el autorizador original (created_by) sigue siendo OWNER/ADMIN activo del gimnasio antes de aplicar nada. Nunca actúa sobre otro usuario ni otorga rol OWNER/ADMIN al cliente.';

grant execute on function public.pilot_resume_pending_activation() to authenticated;

-- Nadie fuera de esta función necesita permisos directos sobre
-- pilot_pending_activations para que el flujo del cliente funcione — su
-- sesión solo necesita poder EJECUTAR esta función (grant de arriba), no
-- leer ni escribir la tabla.
