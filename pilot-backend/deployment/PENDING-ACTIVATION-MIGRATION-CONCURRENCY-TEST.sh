#!/usr/bin/env bash
# Prueba de concurrencia REAL (dos conexiones Postgres separadas) para
# pilot_resume_pending_activation(). Ejecutar DESPUÉS de aplicar
# PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql y PENDING-ACTIVATION-MIGRATION.sql
# contra un Postgres local DESECHABLE. NUNCA ejecutar contra Supabase.
#
# Uso: PGDATABASE=twogramms_disposable_test ./PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh
# (ajustar PGHOST/PGUSER/PGPASSWORD si la conexión local lo requiere)
#
# Qué prueba: mientras una sesión (A) mantiene bloqueada la fila pendiente
# (simulando que ya está a mitad de aplicarla), una segunda sesión (B)
# llama a la misma función concurrentemente. B debe devolver 0 filas de
# inmediato (FOR UPDATE SKIP LOCKED) — nunca bloquearse, nunca duplicar la
# membresía ni la asignación cuando A termine.
set -euo pipefail

GYM="20000000-0000-0000-0000-000000000003"
OWNER="30000000-0000-0000-0000-000000000009"
COACH="30000000-0000-0000-0000-00000000000a"
CLIENT="30000000-0000-0000-0000-00000000000b"

psql -v ON_ERROR_STOP=1 <<SQL
insert into gym_memberships (gym_id, user_id, roles, active, revision) values
  ('$GYM', '$OWNER', '{OWNER}', true, 1),
  ('$GYM', '$COACH', '{COACH}', true, 1);
insert into pilot_pending_activations (gym_id, user_id, coach_membership_id, created_by, status)
select '$GYM', '$CLIENT', gm.id, '$OWNER', 'pending'
from gym_memberships gm where gm.gym_id = '$GYM' and gm.user_id = '$COACH';
SQL

psql <<SQL > /tmp/concurrency-session-a.log 2>&1 &
begin;
set local "test.current_uid" = '$CLIENT';
select pg_sleep(0);
select id, status from pilot_pending_activations where gym_id = '$GYM' for update;
select pg_sleep(2);
select * from pilot_resume_pending_activation();
commit;
SQL
A_PID=$!

sleep 1
psql > /tmp/concurrency-session-b.log 2>&1 <<SQL
set role authenticated;
set "test.current_uid" = '$CLIENT';
select * from pilot_resume_pending_activation();
SQL

wait "$A_PID"

echo "--- Sesión A (sostuvo el candado, reanudó tras la espera) ---"
cat /tmp/concurrency-session-a.log
echo "--- Sesión B (intentó reanudar MIENTRAS A sostenía el candado) ---"
cat /tmp/concurrency-session-b.log

ROWS=$(psql -t -A -v ON_ERROR_STOP=1 -c "select count(*) from gym_memberships where gym_id = '$GYM' and user_id = '$CLIENT';")
LINKS=$(psql -t -A -v ON_ERROR_STOP=1 -c "select count(*) from coach_clients where gym_id = '$GYM';")
if [ "$ROWS" = "1" ] && [ "$LINKS" = "1" ]; then
  echo "PASS concurrencia: exactamente una membresía y una asignación, sin duplicados"
else
  echo "FAIL concurrencia: membresías=$ROWS asignaciones=$LINKS (se esperaba 1 y 1)"
fi

rm -f /tmp/concurrency-session-a.log /tmp/concurrency-session-b.log
