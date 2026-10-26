-- ============================================================================
-- PROPUESTA DE MIGRACIÓN — NO APLICADA A SUPABASE REAL.
--
-- Este archivo es una PROPUESTA para habilitar la activación automática de
-- clientes invitados en Twogramms (preprod-docker-test). Nadie en esta
-- sesión tiene acceso a Supabase real: este SQL no se ha ejecutado contra
-- ninguna base de datos de Supabase, ni real ni de prueba. El código
-- Node.js de `pilot-backend/server/pilot-admin-provisioning-service.cjs` y
-- `nutrika/pilot-auth.js` que depende de esta tabla y esta función está
-- escrito y probado contra MOCKS que asumen este contrato — si esta
-- migración no se aplica (o se aplica distinta), esas dos piezas
-- simplemente no tendrán efecto: ver el try/catch alrededor de cada
-- llamada, diseñado para degradar sin romper nada si esta infraestructura
-- no existe todavía.
--
-- VERSIÓN 2 — corrige 6 fallos confirmados por una auditoría de Codex
-- contra PostgreSQL 17.11 (ver los comentarios junto a cada corrección,
-- más abajo, para el detalle exacto de cada uno):
--   1. Permiso denegado al crear la solicitud pendiente (faltaba GRANT de
--      tabla — RLS no sustituye al GRANT, son capas independientes).
--   2-3. "column reference is ambiguous" al ejecutar
--      pilot_resume_pending_activation() — los parámetros OUT de
--      `returns table(...)` coincidían con nombres de columna reales.
--      Corregido renombrando los OUT params Y calificando cada columna
--      con un alias de tabla en todo el cuerpo — sin depender de
--      `plpgsql.variable_conflict` (una configuración de sesión, nunca
--      de este archivo).
--   4. Comprobación de autoría de la solicitud: sin cambios de fondo
--      respecto a la v1 (ya revalidaba created_by), pero ahora con
--      bloqueo (`for share`) — ver punto 6.
--   5. Protección del último OWNER: la v1 reemplazaba por completo el
--      arreglo de roles al reanudar (`set roles = array['CLIENT']`),
--      pudiendo eliminar un rol OWNER/ADMIN/COACH preexistente de la
--      misma persona. Corregido: ahora se AGREGA CLIENT sin quitar nada.
--   6. Coordinación con revocaciones concurrentes: las comprobaciones de
--      autorización no bloqueaban la fila leída, permitiendo una
--      revocación intercalada entre el chequeo y la aplicación.
--      Corregido con `for share` en ambas lecturas.
--
-- Las seis correcciones se probaron contra PostgreSQL 16.15 local
-- desechable (no 17.11 — no se dispone de esa versión exacta en este
-- entorno; las causas corregidas son semántica estable de PL/pgSQL/RLS,
-- no específica de una versión menor, pero se deja la diferencia de
-- versión explícita en vez de asumir equivalencia). Escenarios probados:
-- OWNER y ADMIN pueden crear la solicitud; COACH y CLIENT NO pueden
-- crearla ni modificar la de otro; un CLIENT que reanuda nunca afecta la
-- solicitud de otro usuario; revocar al autorizador o al coach destino
-- cancela la solicitud en vez de aplicarla; un usuario que ya es OWNER
-- conserva ese rol al agregársele CLIENT; dos reanudaciones concurrentes
-- de la misma solicitud nunca duplican nada (`FOR UPDATE SKIP LOCKED`
-- verificado con dos conexiones reales, no simulado); y una solicitud que
-- mezcla gimnasios nunca se aplica. Ver PROVISIONING-GAP.md para el
-- detalle completo de cada corrida.
--
-- VERSIÓN 3 — corrige los hallazgos de la auditoría de Codex sobre el
-- commit `9462850` (versión 2, ya subida a preprod-docker-test):
--   P0. "Restauración de privilegios" (v2, líneas 317-318): el camino de
--       reanudación REACTIVABA (`active = true`) una membresía propia ya
--       existente sin mirar si esa membresía, estando INACTIVA, conservaba
--       un rol OWNER o ADMIN (p. ej. {ADMIN, CLIENT} tras una revocación
--       parcial) — restaurando privilegios administrativos por autoservicio,
--       sin ninguna decisión administrativa explícita. Corregido: se agrega
--       una comprobación ANTES de tocar la fila; si la membresía propia está
--       inactiva y retiene OWNER/ADMIN, la solicitud se marca
--       'blocked_privileged_role' (nuevo valor de `status`, distinto de
--       'cancelled' para que quede auditable por separado) y NO se aplica
--       ningún cambio — la membresía queda exactamente como estaba. Repárese
--       en que esto es distinto de los OWNER/ADMIN *activos* que resuelven
--       conservar su rol al agregárseles CLIENT (protección del último
--       OWNER, v2): ahí la membresía YA estaba activa; aquí el problema es
--       reactivar una que no lo estaba.
--   P1. "Autoría falsificable" (v2, líneas 105-125): la política RLS exigía
--       que quien escribe sea OWNER/ADMIN del gimnasio, pero nunca exigía
--       que el valor de `created_by` fuera la propia identidad de quien
--       escribe — cualquier OWNER/ADMIN del gimnasio podía crear o
--       modificar una solicitud atribuyéndosela a OTRO OWNER/ADMIN
--       (falsificando quién autorizó realmente el alta). Corregido:
--       `with check` ahora exige también `created_by = auth.uid()` — la
--       autoría queda ligada de forma no falsificable a quien realmente
--       ejecuta la escritura. Esto también cierra, como efecto secundario
--       correcto, la reapertura/reutilización de una solicitud cancelada o
--       completada: reabrirla exige que quien lo haga se autoatribuya como
--       nuevo autorizador (su propio auth.uid()), nunca conservar la
--       autoría de otra persona sin su acción.
--   P1 (corregido en esta ronda — revierte la decisión "SIN cambio" de la
--       ronda anterior). "Coach sin rol COACH" (v2, línea 289): una ronda
--       anterior de esta sesión dejó esto sin cambiar, razonando que
--       OWNER/ADMIN como sustituto de COACH replicaba el contrato ya usado
--       en `pilot-admin-provisioning-service.cjs` (`COACH_CAPABLE_ROLES`).
--       Esa suposición era incorrecta: se recibió confirmación DIRECTA del
--       contrato real de `pilot_set_coach_client` en Supabase —
--       `'COACH'::public.pilot_role = any(coach.roles)` — que exige COACH
--       LITERAL, nunca OWNER/ADMIN como sustituto. Corregido aquí Y en
--       `COACH_CAPABLE_ROLES` (que pasa de `['COACH','OWNER','ADMIN']` a
--       `['COACH']`). Reglas resultantes, sin ambigüedad:
--         1. OWNER/ADMIN activos pueden ADMINISTRAR altas (sin cambios).
--         2. El coach ASIGNADO debe tener COACH activo en ese gimnasio —
--            ni OWNER ni ADMIN, por sí solos, son un destino válido.
--         3. Un OWNER/ADMIN que TAMBIÉN tiene COACH en su arreglo de roles
--            sigue siendo un destino válido — porque tiene COACH, no por
--            ser OWNER/ADMIN.
--   P1. Integración Render: `server/render-readonly.cjs` nunca conectaba el
--       servicio de alta de clientes (`createProvisioningInfrastructure`,
--       de pilot-admin-provisioning-service.cjs) al arranque real de
--       Render — la ruta y el JS de autoservicio de alta existían y estaban
--       probados (111 tests), pero jamás se exponían fuera de los tests.
--       Corregido en ese archivo (no en este SQL): `prepareRender()` ahora
--       construye y pasa `adminProvisioningService` a `createPilotServer`,
--       conservando `readOnly:true` para toda función clínica (diario,
--       macros, tracking) y sin habilitar `localAdmin`.
--   P2. Endurecimiento SQL: `search_path` de la función pasa de `public` a
--       `''` (vacío) — el máximo endurecimiento posible contra secuestro de
--       objetos vía `search_path` — y cada referencia al tipo `pilot_role`
--       se califica explícitamente como `public.pilot_role`, en vez de
--       depender de que `public` siga siendo el único esquema en el path.
--       (`pg_catalog` sigue disponible siempre, aunque el path esté vacío —
--       es un comportamiento estable de PostgreSQL, no algo que dependa de
--       esta migración — por eso `now()`, `array[...]`, etc. no necesitan
--       calificarse.)
--
-- Quien aplique esto debe:
--   1. Confirmar los nombres reales de columna en gym_memberships/clients/
--      coach_clients (ver el contrato no verificado en
--      pilot-admin-provisioning-service.cjs) y ajustar los nombres aquí si
--      difieren.
--   2. Revisar si ya existe una convención de "revision"/"lock_admin"
--      distinta a la asumida aquí (pilot_private.lock_admin) y adaptar.
--   3. Probar esto en un proyecto de Supabase DESECHABLE (idealmente ya
--      en PostgreSQL 17.11, para cerrar la diferencia de versión de esta
--      ronda), nunca en producción directamente.
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
  -- 'blocked_privileged_role' (P0, auditoría sobre el commit 9462850): la
  -- reanudación encontró que la membresía propia del solicitante ya existe,
  -- está INACTIVA y conserva OWNER/ADMIN — nunca se reactiva sola; queda
  -- aquí, distinta de 'cancelled', para que una revisión administrativa
  -- explícita la encuentre y decida.
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled', 'blocked_privileged_role')),
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
        and gm.roles && array['OWNER', 'ADMIN']::public.pilot_role[]
    )
  )
  with check (
    -- P1 (Codex, SQL:105-125 de la v2, commit 9462850): "autoría
    -- falsificable" — antes, cualquier OWNER/ADMIN del gimnasio podía
    -- escribir `created_by` con el id de OTRO OWNER/ADMIN, atribuyéndole
    -- una autorización que esa persona nunca dio. Se exige que
    -- `created_by` sea, siempre, la propia identidad de quien ejecuta el
    -- INSERT/UPDATE — nunca una ajena. Esto también vuelve segura la
    -- reapertura/reutilización: reabrir una solicitud cancelada o
    -- completada para reasignarla exige que quien lo hace se autoatribuya
    -- como nuevo autorizador (su propio auth.uid()), nunca conservando la
    -- autoría de otra persona sin su acción.
    pilot_pending_activations.created_by = auth.uid()
    and exists (
      select 1 from public.gym_memberships gm
      where gm.gym_id = pilot_pending_activations.gym_id
        and gm.user_id = auth.uid()
        and gm.active = true
        and gm.roles && array['OWNER', 'ADMIN']::public.pilot_role[]
    )
  );

-- FALLO CONFIRMADO (Codex, PostgreSQL 17.11; reproducido también en local
-- 16.15): "permission denied for table pilot_pending_activations" al
-- intentar crear la solicitud. RLS no sustituye al GRANT de tabla — son
-- capas independientes y ambas deben otorgar acceso. La versión anterior
-- de este archivo habilitaba RLS y creaba la política, pero JAMÁS otorgaba
-- el privilegio base de SELECT/INSERT/UPDATE a `authenticated`, así que
-- Postgres rechazaba la operación antes de llegar a evaluar la política.
-- Se revoca explícitamente de `public`/`anon` primero para que el límite
-- de acceso quede auditable sin depender de que nadie nunca les otorgue
-- nada por accidente.
revoke all on public.pilot_pending_activations from public;
grant select, insert, update on public.pilot_pending_activations to authenticated;
-- Sin DELETE: cancelar o completar una solicitud es un UPDATE de `status`,
-- nunca borrar la fila — se conserva como historial auditable.

-- El cliente NUNCA recibe esta política ni este GRANT: su único punto de
-- contacto con esta tabla es la función de la sección 2 (SECURITY
-- DEFINER), que opera en su nombre sin exponerle las filas directamente.


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
--
-- FALLO CONFIRMADO (Codex, PG 17.11; reproducido en local 16.15):
-- "column reference ... is ambiguous ... It could refer to either a
-- PL/pgSQL variable or a table column." La versión anterior declaraba
-- `returns table (status text, gym_id uuid, coach_membership_id uuid)`,
-- y esos tres nombres son EXACTAMENTE columnas reales de
-- pilot_pending_activations/gym_memberships/coach_clients. PL/pgSQL
-- convierte cada columna de `returns table` en un parámetro OUT implícito
-- con ESE nombre, visible en todo el cuerpo de la función — así que
-- cualquier referencia SIN calificar a `status` o `gym_id` dentro de una
-- consulta quedaba ambigua entre el parámetro OUT y la columna real. La
-- prueba de Codex lo "resolvía" con `plpgsql.variable_conflict=use_column`
-- (una configuración de SESIÓN, no de esta función) — se elimina aquí la
-- ambigüedad en el propio SQL, de dos maneras independientes y
-- redundantes a propósito:
--   1. los parámetros OUT se renombran con el prefijo out_ (nunca
--      coinciden con ningún nombre de columna real, ahora ni en el
--      futuro);
--   2. además, CADA tabla en el cuerpo de la función se referencia con un
--      alias explícito y cada columna se califica con ese alias — así que
--      aunque alguien reintroduzca un nombre de columna igual a un futuro
--      parámetro OUT, no habría ninguna referencia sin calificar que
--      pudiera volver a ser ambigua.
--
-- FALLO CONFIRMADO adicional ("protección del último OWNER"): la versión
-- anterior, al reanudar, hacía `set roles = array['CLIENT']` — es decir,
-- REEMPLAZABA por completo el arreglo de roles de la fila de
-- gym_memberships del usuario que inicia sesión. Si esa persona YA tenía
-- una membresía con rol OWNER/ADMIN/COACH en ese gimnasio (por ejemplo, el
-- único OWNER del gimnasio fue invitado también como cliente, o cambió de
-- correo), esto le ELIMINABA silenciosamente ese rol, pudiendo dejar al
-- gimnasio sin ningún OWNER activo. Se corrige agregando CLIENT al
-- arreglo existente (nunca reemplazando), igual en espíritu a como
-- pilot_set_membership debe comportarse según su contrato confirmado
-- (gestiona roles, no los sustituye a ciegas).
--
-- FALLO CONFIRMADO adicional ("coordinación con revocaciones"): las
-- comprobaciones de autorización (si created_by sigue siendo OWNER/ADMIN,
-- si el coach destino sigue siendo válido) se hacían con un SELECT simple,
-- sin bloqueo — una revocación concurrente (otra transacción cambiando esa
-- misma fila de gym_memberships) podía intercalarse entre la comprobación
-- y la aplicación del cambio. Se agrega `for share` a ambas lecturas: una
-- revocación concurrente (que necesita un bloqueo más fuerte para
-- escribir) debe esperar a que esta transacción termine, o esta
-- transacción espera si la revocación ya estaba en curso — nunca se
-- aplica una autorización a medio revocar.
-- ----------------------------------------------------------------------------

create or replace function public.pilot_resume_pending_activation()
returns table (out_status text, out_gym_id uuid, out_coach_membership_id uuid)
language plpgsql
security definer
-- P2 (endurecimiento, auditoría sobre el commit 9462850): search_path
-- vacío en vez de `public` — ya no basta con que `public` sea el único
-- esquema de la ruta; CADA referencia a un tipo/objeto no incorporado a
-- pg_catalog debe calificarse explícitamente (ver `public.pilot_role` más
-- abajo). pg_catalog sigue siempre disponible aunque el path esté vacío,
-- así que now()/array[...]/etc. no necesitan calificarse.
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_request record;
  v_membership_id uuid;
  v_membership_revision bigint;
  v_membership_roles public.pilot_role[];
  v_membership_active boolean;
  v_client_id uuid;
  v_coach_still_authorized boolean;
  v_coach_still_valid boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Bloquea la fila pendiente propia (si existe) para que una segunda
  -- llamada concurrente no la vea disponible mientras esta la procesa.
  select pa.* into v_request
  from public.pilot_pending_activations pa
  where pa.user_id = v_uid and pa.status = 'pending'
  order by pa.created_at asc
  limit 1
  for update skip locked;

  if v_request is null then
    -- Nada pendiente (o ya la está procesando otra llamada concurrente):
    -- no es un error, simplemente no hay nada que reanudar todavía.
    return;
  end if;

  -- Revalida en vivo la autorización administrativa original, con
  -- bloqueo (`for share`) para no competir con una revocación concurrente.
  select exists (
    select 1 from public.gym_memberships gm
    where gm.gym_id = v_request.gym_id
      and gm.user_id = v_request.created_by
      and gm.active = true
      and gm.roles && array['OWNER', 'ADMIN']::public.pilot_role[]
    for share
  ) into v_coach_still_authorized;

  if not v_coach_still_authorized then
    -- El autorizador original ya no es OWNER/ADMIN activo: se cancela en
    -- vez de aplicar una autorización que ya no es válida.
    update public.pilot_pending_activations pa
      set status = 'cancelled', revision = pa.revision + 1
      where pa.id = v_request.id;
    return query select 'cancelled'::text, v_request.gym_id, v_request.coach_membership_id;
    return;
  end if;

  -- Confirma que el coach destino sigue activo en ese gimnasio (puede
  -- haber cambiado desde que se autorizó la solicitud); mismo bloqueo.
  --
  -- P1 (corregido en esta ronda): COACH LITERAL, confirmado contra el
  -- contrato real de `pilot_set_coach_client` en Supabase —
  -- `'COACH'::public.pilot_role = any(coach.roles)`. OWNER/ADMIN NUNCA
  -- sustituyen a COACH como destino (una ronda anterior lo dejaba pasar,
  -- asumiendo sin confirmación directa que replicaba el contrato real —
  -- ver el detalle de la corrección al inicio del archivo). Un OWNER/ADMIN
  -- que TAMBIÉN tiene COACH en su arreglo de roles sigue siendo un destino
  -- válido — porque tiene COACH, no por ser OWNER/ADMIN.
  select exists (
    select 1 from public.gym_memberships gm
    where gm.id = v_request.coach_membership_id
      and gm.gym_id = v_request.gym_id
      and gm.active = true
      and 'COACH' = any(gm.roles)
    for share
  ) into v_coach_still_valid;

  if not v_coach_still_valid then
    update public.pilot_pending_activations pa
      set status = 'cancelled', revision = pa.revision + 1
      where pa.id = v_request.id;
    return query select 'cancelled'::text, v_request.gym_id, v_request.coach_membership_id;
    return;
  end if;

  -- Aplica la membresía CLIENT (mismo efecto que pilot_set_membership,
  -- revisión optimista incluida) — profiles.id de v_uid YA existe en este
  -- punto porque esta función solo se llama después de pilot_ensure_profile().
  select gm.id, gm.revision, gm.roles, gm.active into v_membership_id, v_membership_revision, v_membership_roles, v_membership_active
  from public.gym_memberships gm
  where gm.gym_id = v_request.gym_id and gm.user_id = v_uid
  for update;

  -- P0 (Codex, SQL:317-318 de la v2, commit 9462850): "restauración de
  -- privilegios" — si la membresía propia YA existe, está INACTIVA
  -- (revocada) y conserva OWNER/ADMIN, el camino de abajo la reactivaría
  -- sola (`active = true`) por el solo hecho de iniciar sesión, sin
  -- ninguna decisión administrativa explícita. Se bloquea aquí, antes de
  -- tocar la fila: la solicitud queda marcada para revisión administrativa
  -- (nunca se completa sola) y la membresía permanece sin cambios.
  if v_membership_id is not null and v_membership_active = false
     and v_membership_roles && array['OWNER', 'ADMIN']::public.pilot_role[] then
    update public.pilot_pending_activations pa
      set status = 'blocked_privileged_role', revision = pa.revision + 1
      where pa.id = v_request.id;
    return query select 'blocked_privileged_role'::text, v_request.gym_id, v_request.coach_membership_id;
    return;
  end if;

  if v_membership_id is null then
    insert into public.gym_memberships (gym_id, user_id, roles, active, revision)
    values (v_request.gym_id, v_uid, array['CLIENT']::public.pilot_role[], true, 1)
    returning id into v_membership_id;
  else
    -- Agrega CLIENT sin eliminar ningún rol existente (protección del
    -- último OWNER: nunca se reemplaza el arreglo de roles a ciegas).
    update public.gym_memberships gm
      set roles = case when 'CLIENT' = any(v_membership_roles) then v_membership_roles else v_membership_roles || 'CLIENT'::public.pilot_role end,
          active = true,
          revision = v_membership_revision + 1
      where gm.id = v_membership_id;
  end if;

  -- `clients` — igual que pilot_set_membership, se crea si no existía.
  select c.id into v_client_id from public.clients c where c.gym_id = v_request.gym_id and c.membership_id = v_membership_id;
  if v_client_id is null then
    insert into public.clients (gym_id, membership_id) values (v_request.gym_id, v_membership_id) returning id into v_client_id;
  end if;

  -- Vincula coach-cliente (mismo efecto que pilot_set_coach_client).
  insert into public.coach_clients (gym_id, coach_membership_id, client_id, active, revision)
  values (v_request.gym_id, v_request.coach_membership_id, v_client_id, true, 1)
  on conflict (gym_id, coach_membership_id, client_id)
  do update set active = true, revision = coach_clients.revision + 1;

  update public.pilot_pending_activations pa
    set status = 'completed', completed_at = now(), revision = pa.revision + 1
    where pa.id = v_request.id;

  return query select 'completed'::text, v_request.gym_id, v_request.coach_membership_id;
end;
$$;

comment on function public.pilot_resume_pending_activation() is
  'Autoservicio: completa, si existe, la ÚNICA solicitud de activación pendiente de auth.uid(). Revalida en vivo (con bloqueo) que el autorizador original (created_by) sigue siendo OWNER/ADMIN activo del gimnasio antes de aplicar nada. Nunca actúa sobre otro usuario, nunca reemplaza roles existentes (solo agrega CLIENT), nunca otorga rol OWNER/ADMIN al cliente, y nunca reactiva una membresía propia inactiva que conserve OWNER/ADMIN (status=blocked_privileged_role en ese caso, requiere acción administrativa explícita).';

revoke all on function public.pilot_resume_pending_activation() from public;
grant execute on function public.pilot_resume_pending_activation() to authenticated;

-- Nadie fuera de esta función necesita permisos directos sobre
-- pilot_pending_activations para que el flujo del CLIENTE funcione — su
-- sesión solo necesita poder EJECUTAR esta función (grant de arriba), no
-- leer ni escribir la tabla. El GRANT de tabla de la sección 1b es,
-- deliberadamente, solo para OWNER/ADMIN (vía su propia sesión normal,
-- nunca vía esta función).
