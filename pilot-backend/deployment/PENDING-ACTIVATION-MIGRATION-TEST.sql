-- ============================================================================
-- PRUEBAS DE SEGURIDAD EJECUTABLES — PENDING-ACTIVATION-MIGRATION.sql
--
-- Ejecutar DESPUÉS de PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql y de la
-- propia PENDING-ACTIVATION-MIGRATION.sql, contra un Postgres local
-- DESECHABLE (nunca Supabase). Ver el encabezado del archivo de andamio
-- para el procedimiento completo.
--
-- Cómo leer el resultado: cada bloque imprime una línea "PASS ..." o
-- "FAIL ..."; los bloques marcados "(se espera un ERROR aquí)" imprimen
-- además un ERROR de Postgres esperado (RLS/GRANT rechazando la
-- operación) — eso es correcto, no un fallo del script. Para una
-- verificación automatizada: `... | grep -c '^FAIL'` debe dar 0.
--
-- Nota de alcance: esto se ejecutó contra PostgreSQL 16.15 (no 17.11, que
-- es lo que usó la auditoría de Codex) — PostgreSQL 17 no está disponible
-- en este entorno (no está en los repositorios de Ubuntu 24.04 incluidos,
-- y el acceso a apt.postgresql.org está bloqueado por el proxy de salida
-- de esta sesión). Las causas corregidas (GRANT de tabla, ambigüedad de
-- variable/columna, reemplazo de roles, bloqueo ante revocación
-- concurrente) son semántica estable de PL/pgSQL y RLS entre versiones
-- menores, pero esta diferencia de versión se deja explícita en vez de
-- asumida — quien tenga acceso a un Postgres 17.11 real debe volver a
-- correr este archivo ahí antes de aplicar la migración a Supabase.
-- ============================================================================
\set ON_ERROR_STOP off
\pset format aligned

do $$
declare
  gym1 uuid := '20000000-0000-0000-0000-000000000001';
  gym2 uuid := '20000000-0000-0000-0000-000000000002';
  owner1 uuid := '30000000-0000-0000-0000-000000000001';
  admin1 uuid := '30000000-0000-0000-0000-000000000004';
  coach1 uuid := '30000000-0000-0000-0000-000000000002';
  owner_as_client uuid := '30000000-0000-0000-0000-000000000007';
  owner2 uuid := '30000000-0000-0000-0000-000000000008';
begin
  insert into gym_memberships (gym_id, user_id, roles, active, revision) values
    (gym1, owner1, '{OWNER}', true, 1),
    (gym1, admin1, '{ADMIN}', true, 1),
    (gym1, coach1, '{COACH}', true, 1),
    (gym1, owner_as_client, '{OWNER}', true, 1),
    (gym2, owner2, '{OWNER}', true, 1);
end $$;

\echo '=== A) OWNER crea la solicitud pendiente (debe permitirse) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001'; -- owner1
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003',
       gm.id, '30000000-0000-0000-0000-000000000001', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000001' and gm.user_id = '30000000-0000-0000-0000-000000000002';
commit;
select case when count(*) = 1 then 'PASS A: OWNER pudo crear la solicitud' else 'FAIL A' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000003';

\echo '=== B) ADMIN crea la solicitud pendiente para otro cliente (debe permitirse) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000004'; -- admin1
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000005',
       gm.id, '30000000-0000-0000-0000-000000000004', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000001' and gm.user_id = '30000000-0000-0000-0000-000000000002';
commit;
select case when count(*) = 1 then 'PASS B: ADMIN pudo crear la solicitud' else 'FAIL B' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000005';

\echo '=== C) COACH intenta crear una solicitud (debe RECHAZARSE) (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000002'; -- coach1
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'pending');
rollback;
select case when not exists (select 1 from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000006') then 'PASS C: COACH no pudo crear ninguna solicitud' else 'FAIL C' end;

\echo '=== D) CLIENT intenta modificar la solicitud propia (debe RECHAZARSE) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000003'; -- client_a (ya tiene una fila de la prueba A)
update pilot_pending_activations set coach_membership_id = '30000000-0000-0000-0000-000000000002' where user_id = '30000000-0000-0000-0000-000000000003';
commit;
select case when coach_membership_id <> '30000000-0000-0000-0000-000000000002' then 'PASS D: el CLIENT no pudo modificar su propia solicitud' else 'FAIL D' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000003';

\echo '=== D2) CLIENT intenta FABRICAR una solicitud autoasignándose como created_by (debe RECHAZARSE) (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000006'; -- un CLIENT sin ningún rol administrativo
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000006', 'pending');
rollback;
select case when not exists (select 1 from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000006') then 'PASS D2: un CLIENT no puede autoasignarse como autorizador de su propia solicitud' else 'FAIL D2' end;

\echo '=== D3) CLIENT intenta LEER la solicitud de otro usuario (debe ver 0 filas, nunca un error ni datos ajenos) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000006'; -- sin relación con la solicitud de client_a
select case when count(*) = 0 then 'PASS D3: un CLIENT no puede leer la solicitud de otro usuario' else 'FAIL D3' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000003';
commit;

\echo '=== E) CLIENT llama la reanudación mientras existe una solicitud de OTRO usuario (debe no afectarla) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000006'; -- sin ninguna solicitud propia
select case when count(*) = 0 then 'PASS E1: sin solicitud propia, no hay nada que reanudar' else 'FAIL E1' end
from pilot_resume_pending_activation();
commit;
select case when status = 'pending' then 'PASS E2: la solicitud de client_b (otro usuario) sigue intacta' else 'FAIL E2' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000005';

\echo '=== F) Revocación: created_by (owner1) ya no es OWNER/ADMIN activo -> se cancela, nunca se aplica ==='
update gym_memberships set active = false where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000001';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000003'; -- client_a, cuya solicitud la autorizó owner1
select case when out_status = 'cancelled' then 'PASS F: se canceló al revocar al autorizador original' else 'FAIL F: ' || coalesce(out_status, 'NULL') end
from pilot_resume_pending_activation();
commit;
select case when not exists (select 1 from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
            then 'PASS F2: nunca se otorgó membresía con autorización revocada' else 'FAIL F2' end;
update gym_memberships set active = true where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000001'; -- deja owner1 activo de nuevo
update pilot_pending_activations set status = 'pending' where user_id = '30000000-0000-0000-0000-000000000003'; -- recrea el estado pendiente para la prueba G

\echo '=== G) El coach destino ya no es válido en ese gimnasio -> se cancela ==='
update gym_memberships set active = false where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000003';
select case when out_status = 'cancelled' then 'PASS G: se canceló al desactivar al coach destino' else 'FAIL G: ' || coalesce(out_status, 'NULL') end
from pilot_resume_pending_activation();
commit;
update gym_memberships set active = true where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002';
update pilot_pending_activations set status = 'pending' where user_id = '30000000-0000-0000-0000-000000000003';

\echo '=== H) Protección del último OWNER: el "cliente" ya es OWNER -> CLIENT se agrega, OWNER no se pierde ==='
update pilot_pending_activations set user_id = '30000000-0000-0000-0000-000000000007' where user_id = '30000000-0000-0000-0000-000000000003' and status = 'pending';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000007';
select out_status from pilot_resume_pending_activation();
commit;
select case when roles @> array['OWNER','CLIENT']::pilot_role[] then 'PASS H: conserva OWNER y agrega CLIENT' else 'FAIL H: roles=' || roles::text end
from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000007';

\echo '=== I) Idempotencia: reanudar dos veces no duplica nada (la 2a no encuentra nada pendiente) ==='
select case when count(*) = 0 then 'PASS I: nada pendiente tras completarse' else 'FAIL I' end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000007' and status = 'pending';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000007';
select case when count(*) = 0 then 'PASS I2: segundo intento no reanuda nada' else 'FAIL I2' end from pilot_resume_pending_activation();
commit;

\echo '=== J) Acceso entre gimnasios: autorizador/coach de OTRO gimnasio nunca se aplica en este ==='
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000006', gm.id, '30000000-0000-0000-0000-000000000008', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000002' and gm.user_id = '30000000-0000-0000-0000-000000000008'; -- created_by y coach_membership_id son de gym2, pero gym_id de la fila es gym1
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000006';
select case when out_status = 'cancelled' then 'PASS J: una autorización de otro gimnasio nunca se aplica en este' else 'FAIL J: ' || coalesce(out_status,'NULL') end
from pilot_resume_pending_activation();
commit;
select case when not exists (select 1 from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000006')
            then 'PASS J2: sin membresía otorgada entre gimnasios' else 'FAIL J2' end;

\echo '=== P0) Restauración de privilegios: un ADMIN inactivo con roles {ADMIN,CLIENT} NO se reactiva solo (debe bloquearse) ==='
-- Simula una membresía ADMIN previamente revocada (active=false) que
-- conserva el rol ADMIN en el arreglo — exactamente el caso reportado por
-- Codex sobre el commit 9462850 (SQL:317-318 de esa versión).
insert into gym_memberships (gym_id, user_id, roles, active, revision) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-00000000000c', '{ADMIN,CLIENT}', false, 3);
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-00000000000c', gm.id, '30000000-0000-0000-0000-000000000004', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000001' and gm.user_id = '30000000-0000-0000-0000-000000000002'; -- coach1; created_by = admin1 (activo)
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-00000000000c';
select case when out_status = 'blocked_privileged_role' then 'PASS P0: la reanudación se niega a reactivar sola un ADMIN/OWNER inactivo' else 'FAIL P0: ' || coalesce(out_status,'NULL') end
from pilot_resume_pending_activation();
commit;
select case when active = false and roles = array['ADMIN','CLIENT']::pilot_role[] then 'PASS P0b: la membresía sigue inactiva, con sus roles intactos (no se restauró ADMIN)' else 'FAIL P0b: active=' || active::text || ' roles=' || roles::text end
from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-00000000000c';
select case when status = 'blocked_privileged_role' then 'PASS P0c: la solicitud queda marcada para revisión administrativa explícita' else 'FAIL P0c: ' || status end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-00000000000c';

\echo '=== P1) Autoría falsificable: un ADMIN intenta crear una solicitud atribuida a OTRO OWNER/ADMIN (debe RECHAZARSE) (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000004'; -- admin1
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-00000000000d', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'pending'); -- created_by = owner1, NO admin1
rollback;
select case when not exists (select 1 from pilot_pending_activations where user_id = '30000000-0000-0000-0000-00000000000d') then 'PASS P1: un ADMIN no puede atribuir la autoría de una solicitud a otro OWNER/ADMIN' else 'FAIL P1' end;

\echo '=== P1b) Autoría falsificable al reabrir: un ADMIN intenta reatribuir created_by de una solicitud EXISTENTE a otra persona (debe RECHAZARSE) (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000004'; -- admin1, autor real de la solicitud de la prueba B
update pilot_pending_activations set created_by = '30000000-0000-0000-0000-000000000001' where user_id = '30000000-0000-0000-0000-000000000005'; -- intenta atribuirla a owner1
rollback;
select case when created_by = '30000000-0000-0000-0000-000000000004' then 'PASS P1b: no se pudo reatribuir la autoría de una solicitud existente a otra persona' else 'FAIL P1b: created_by=' || created_by::text end
from pilot_pending_activations where user_id = '30000000-0000-0000-0000-000000000005';

\echo '=== K) Coach destino con OWNER activo pero SIN rol COACH -> se cancela (COACH literal, confirmado contra pilot_set_coach_client real) ==='
insert into gym_memberships (gym_id, user_id, roles, active, revision) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-00000000000e', '{OWNER}', true, 1);
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000010', gm.id, '30000000-0000-0000-0000-000000000004', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000001' and gm.user_id = '30000000-0000-0000-0000-00000000000e'; -- owner sin COACH; created_by = admin1
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000010';
select case when out_status = 'cancelled' then 'PASS K: un OWNER activo SIN rol COACH nunca es un destino válido' else 'FAIL K: ' || coalesce(out_status,'NULL') end
from pilot_resume_pending_activation();
commit;
select case when not exists (select 1 from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000010')
            then 'PASS K2: sin membresía otorgada (la solicitud se canceló, nunca se aplicó)' else 'FAIL K2' end;

\echo '=== L) Coach destino con OWNER activo que TAMBIÉN tiene COACH -> se aplica normalmente (pasa por tener COACH, no por ser OWNER) ==='
insert into gym_memberships (gym_id, user_id, roles, active, revision) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-00000000000f', '{OWNER,COACH}', true, 1);
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000011', gm.id, '30000000-0000-0000-0000-000000000004', 'pending'
from gym_memberships gm where gm.gym_id = '20000000-0000-0000-0000-000000000001' and gm.user_id = '30000000-0000-0000-0000-00000000000f'; -- OWNER+COACH; created_by = admin1
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000011';
select case when out_status = 'completed' then 'PASS L: un OWNER que TAMBIÉN tiene COACH sigue siendo un destino válido' else 'FAIL L: ' || coalesce(out_status,'NULL') end
from pilot_resume_pending_activation();
commit;
select case when exists (
    select 1 from coach_clients cc
    join gym_memberships coach_gm on coach_gm.id = cc.coach_membership_id
    join clients c on c.id = cc.client_id
    join gym_memberships client_gm on client_gm.id = c.membership_id
    where coach_gm.user_id = '30000000-0000-0000-0000-00000000000f' and client_gm.user_id = '30000000-0000-0000-0000-000000000011' and cc.active
  ) then 'PASS L2: queda vinculado al coach OWNER+COACH' else 'FAIL L2' end;

\echo '=== RESUMEN: cualquier línea que empiece con FAIL arriba es un fallo real ==='
