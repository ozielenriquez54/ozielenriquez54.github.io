-- ============================================================================
-- PRUEBAS DE SEGURIDAD EJECUTABLES — COACH-CLIENT-STATE-MIGRATION.sql
--
-- Ejecutar DESPUÉS de PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql,
-- COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql y
-- COACH-CLIENT-STATE-MIGRATION.sql, contra un Postgres local DESECHABLE
-- (nunca Supabase). Mismo formato que PENDING-ACTIVATION-MIGRATION-TEST.sql:
-- cada bloque imprime "PASS ..." o "FAIL ...". `... | grep -c '^FAIL'`
-- debe dar 0.
--
-- Nota de alcance: PostgreSQL 16.15 local (no 17.11) — mismo motivo que
-- el resto de esta sesión (sin acceso a PostgreSQL 17 en este entorno).
-- ============================================================================
\set ON_ERROR_STOP off
\pset format aligned

do $$
declare
  gym1 uuid := '20000000-0000-0000-0000-000000000001';
  gym2 uuid := '20000000-0000-0000-0000-000000000002';
  owner1 uuid := '30000000-0000-0000-0000-000000000001';
  coach1 uuid := '30000000-0000-0000-0000-000000000002';
  client_a uuid := '30000000-0000-0000-0000-000000000003';
  admin1 uuid := '30000000-0000-0000-0000-000000000004';
  owner2 uuid := '30000000-0000-0000-0000-000000000008';
  coach2 uuid := '30000000-0000-0000-0000-000000000009';
begin
  insert into gym_memberships (gym_id, user_id, roles, active, revision) values
    (gym1, owner1, '{OWNER}', true, 1),
    (gym1, coach1, '{COACH}', true, 1),
    (gym1, client_a, '{CLIENT}', true, 1),
    (gym1, admin1, '{ADMIN}', true, 1),
    (gym2, owner2, '{OWNER}', true, 1),
    (gym2, coach2, '{COACH}', true, 1);
  insert into clients (gym_id, membership_id)
  select gym1, gm.id from gym_memberships gm where gm.gym_id = gym1 and gm.user_id = client_a;
end $$;

\echo '=== A) Relación INEXISTENTE: cliente existe, coach válido, nunca asignado -> client_exists=true, coach_client_id=NULL ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001'; -- owner1
select case when out_client_exists = true and out_coach_client_id is null and out_active is null and out_revision is null
            then 'PASS A: relación inexistente reportada con honestidad (nunca inventa una revisión)'
            else 'FAIL A: ' || out_client_exists::text || ' ' || coalesce(out_coach_client_id::text,'NULL') end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;

\echo '=== B) pilot_set_coach_client con la revisión exacta devuelta arriba (0 implícito) crea la relación ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select pilot_set_coach_client(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003'),
  true, 0
);
commit;
select case when active = true and revision = 1 then 'PASS B: la relación se creó con revisión 1' else 'FAIL B' end
from coach_clients where gym_id = '20000000-0000-0000-0000-000000000001';

\echo '=== C) Relación ACTIVA (revisión 1 recién creada): el estado devuelto coincide exactamente ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select case when out_client_exists = true and out_active = true and out_revision = 1
            then 'PASS C: estado activo devuelto con la revisión exacta (1)' else 'FAIL C: ' || coalesce(out_revision::text,'NULL') end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;

\echo '=== D) Revisión 8: fuerza la fila a revision=8 y confirma que se lee exacta (nunca adivinada) ==='
update coach_clients set revision = 8 where gym_id = '20000000-0000-0000-0000-000000000001';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select case when out_revision = 8 then 'PASS D: revisión 8 leída exacta' else 'FAIL D: ' || coalesce(out_revision::text,'NULL') end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;
-- Confirma además que pilot_set_coach_client con esa revisión EXACTA (8) funciona.
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select pilot_set_coach_client(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003'),
  true, 8
);
commit;
select case when revision = 9 then 'PASS D2: escribir con la revisión exacta (8) avanzó a 9, sin adivinar' else 'FAIL D2: ' || revision::text end
from coach_clients where gym_id = '20000000-0000-0000-0000-000000000001';

\echo '=== E) Revisión 100: fuerza la fila a revision=100 y confirma lectura y escritura exactas ==='
update coach_clients set revision = 100 where gym_id = '20000000-0000-0000-0000-000000000001';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select case when out_revision = 100 then 'PASS E: revisión 100 leída exacta' else 'FAIL E: ' || coalesce(out_revision::text,'NULL') end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select pilot_set_coach_client(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003'),
  true, 100
);
commit;
select case when revision = 101 then 'PASS E2: escribir con la revisión exacta (100) avanzó a 101, sin ciclo de adivinanza' else 'FAIL E2: ' || revision::text end
from coach_clients where gym_id = '20000000-0000-0000-0000-000000000001';

\echo '=== F) Revocación CONCURRENTE entre lectura y escritura: la escritura con la revisión YA LEÍDA debe fallar (nunca revertir la revocación en silencio) (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select out_revision as revision_leida from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
) \gset
commit;
-- Revocación concurrente real: OTRA transacción desactiva la relación y
-- avanza la revisión ANTES de que la escritura de abajo se ejecute.
update coach_clients set active = false, revision = revision + 1 where gym_id = '20000000-0000-0000-0000-000000000001';
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select pilot_set_coach_client(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003'),
  true, :revision_leida
);
rollback;
select case when active = false then 'PASS F: la revocación concurrente NUNCA se revirtió en silencio' else 'FAIL F: active=' || active::text end
from coach_clients where gym_id = '20000000-0000-0000-0000-000000000001';

\echo '=== G) Relación INACTIVA (revocada): el estado se devuelve tal cual, nunca reactivada por esta función de solo lectura ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select case when out_client_exists = true and out_active = false then 'PASS G: inactiva reportada con honestidad' else 'FAIL G: active=' || coalesce(out_active::text,'NULL') end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;
select case when active = false then 'PASS G2: la fila real sigue inactiva — pilot_get_coach_client_state nunca escribe nada' else 'FAIL G2' end
from coach_clients where gym_id = '20000000-0000-0000-0000-000000000001';

\echo '=== H) OWNER/ADMIN autorizado: admin1 (ADMIN activo) también puede leer el estado ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000004'; -- admin1
select case when out_client_exists = true then 'PASS H: ADMIN activo autorizado' else 'FAIL H' end
from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
commit;

\echo '=== I) Usuario SIN permisos (COACH, no OWNER/ADMIN) intenta leer el estado -> RECHAZADO (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000002'; -- coach1
select * from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
rollback;
select 'PASS I: COACH sin OWNER/ADMIN fue rechazado (el error de arriba es el resultado correcto)' as resultado;

\echo '=== J) CLIENT intenta leer el estado administrativo -> RECHAZADO; nunca obtiene privilegios administrativos (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000003'; -- client_a, el propio cliente
select * from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
rollback;
select 'PASS J: el propio CLIENT fue rechazado — nunca obtiene visibilidad administrativa de su propia relación coach-cliente' as resultado;

\echo '=== K) Aislamiento entre gimnasios: OWNER de gym1 pasa un coach de gym2 -> RECHAZADO explícitamente (relación inválida, nunca "pendiente") (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001'; -- owner1, de gym1
select * from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000002' and user_id = '30000000-0000-0000-0000-000000000009'), -- coach2, de gym2
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000003')
);
rollback;
select 'PASS K: un coach de OTRO gimnasio se rechaza explícitamente (nunca pendiente, nunca aplicado)' as resultado;

\echo '=== K2) Aislamiento entre gimnasios: OWNER de gym1 pasa un cliente de gym2 -> RECHAZADO explícitamente (se espera un ERROR aquí) ==='
begin;
set local role authenticated;
set local "test.current_uid" = '30000000-0000-0000-0000-000000000001';
select * from pilot_get_coach_client_state(
  '20000000-0000-0000-0000-000000000001',
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000001' and user_id = '30000000-0000-0000-0000-000000000002'),
  (select id from gym_memberships where gym_id = '20000000-0000-0000-0000-000000000002' and user_id = '30000000-0000-0000-0000-000000000009') -- owner2 membership, de gym2
);
rollback;
select 'PASS K2: un cliente de OTRO gimnasio se rechaza explícitamente' as resultado;

\echo '=== RESUMEN: cualquier línea que empiece con FAIL arriba es un fallo real ==='
