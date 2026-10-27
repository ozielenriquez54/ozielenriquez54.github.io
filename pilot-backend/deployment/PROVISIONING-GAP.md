# Alta de clientes — estado y pendientes (preprod-docker-test)

Implementado y probado localmente (sin tocar Supabase real). Resume lo que
queda por confirmar antes de usar esto contra la base de datos de verdad.

**5ª ronda: activación automática.** Las rondas 3–4 dejaban la reanudación
como una acción manual (el OWNER/ADMIN tenía que volver a pulsar "Agregar
cliente" después de que el cliente iniciara sesión). Esa ronda la
automatiza — **pero depende de infraestructura SQL que todavía no existe
en Supabase real.** No se declara el flujo terminado de extremo a extremo:
ver la sección "Bloqueo real" más abajo.

## 17ª ronda: 1 hallazgo P2 de Codex sobre el commit `7121958738fac35ec8ccbbdb086274a231cfbe82` (revisión 0 con relación coach-cliente YA existente)

**`validateCoachClientStateRow()` aceptaba `out_revision=0` (y `-0`,
numéricamente igual) incluso cuando `out_coach_client_id` NO era nulo** —
es decir, cuando la RPC afirmaba que YA existía una relación coach-cliente.
`pilot_set_coach_client` SIEMPRE crea la primera fila con `revision=1` y
la incrementa en cada escritura posterior (ver el stub confirmado en
`COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql`) — una relación existente
con revisión 0 nunca es un estado real; 0 solo es válido como el valor
IMPLÍCITO que `setCoachClient()` usa para la PRIMERA asignación, cuando
`out_coach_client_id` es `null` (y por lo tanto `out_revision` también lo
es). Corregido exigiendo `out_revision > 0` (`-0 > 0` ya es `false` en JS,
así que no hace falta un caso especial) exclusivamente cuando existe
relación — el caso "sin relación todavía" sigue sin tocarse.

**Pruebas ejecutadas esta ronda:**
- `npm test`: **181/181 PASS, 0 FAIL** (6 pruebas nuevas: revisión 0 y -0
  con relación existente → `PROVISIONING_RESULT_UNKNOWN`; revisión 1 y
  100 con relación existente → `PROVISIONED`, escritura con esa revisión
  exacta; creación sin relación → `PROVISIONED` con revisión 0 implícita
  confirmada explícitamente en el argumento de la escritura).
- Sin pruebas SQL esta ronda: el fix es exclusivamente de validación
  defensiva en la capa JS, sin cambios en ningún archivo `.sql` — no
  aplica repetir baterías que no dependen de este cambio.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`, y este archivo.

## 16ª ronda: 3 hallazgos P2 de Codex sobre el commit `17a1ad1ed78329e23300add454ce9d3e4eb2765e` (consistencia de estados, validación estricta de IDs/revisiones, cardinalidad de la RPC)

**1) Consistencia de estados.** `validateCoachClientStateRow()` validaba el
TIPO de cada campo y la coherencia entre id/activo/revisión entre sí, pero
nunca su coherencia con `out_profile_exists`/`out_client_exists` — una
respuesta con `out_profile_exists=false` pero `out_client_exists=true` (o
con una relación coach-cliente "fantasma" sin perfil ni cliente) pasaba
como válida. Corregido exigiendo las 3 implicaciones reales entre los
cuatro estados posibles de la RPC (ver COACH-CLIENT-STATE-MIGRATION.sql):
perfil ausente implica cliente ausente; cliente ausente implica ninguna
relación coach-cliente; una relación exige perfil Y cliente presentes.

**2) Validación estricta de identificadores y revisiones.** `out_coach_client_id`
solo se comprobaba como `typeof === 'string'` (aceptaba `''`, `'no-es-un-uuid'`,
cualquier string); `out_revision` solo se comprobaba como `typeof === 'number'`
(aceptaba negativos, fraccionarios, `NaN`, `Infinity` y valores fuera del
rango entero seguro de JS, donde un `bigint` real de Postgres ya no se
representa sin pérdida). Corregido reutilizando el mismo regex `UUID` que
el resto del archivo ya usa para validar entradas, y exigiendo
`Number.isSafeInteger(valor) && valor >= 0` para la revisión.

**3) Cardinalidad de respuesta RPC.** `Array.isArray(state.data) ?
state.data[0] : state.data` tomaba el primer elemento sin comprobar nunca
cuántas filas había — cero filas u más de una elegían una fila en
silencio. Corregido con `extractCoachClientStateRow()`: un arreglo debe
tener longitud EXACTAMENTE 1 (nunca se usa el índice 0 a ciegas); un
objeto plano no-null (la forma que usan los mocks de este archivo) se
acepta como esa única fila; cualquier otra forma (null, string, number,
arreglo de algo que no sea un objeto) se rechaza.

**Pruebas ejecutadas esta ronda:**
- `npm test`: **175/175 PASS, 0 FAIL** (22 pruebas nuevas: 4 de
  consistencia de estados, 4 de formato UUID, 7 de validación de
  revisión, 6 de cardinalidad/estructura, y 1 confirmando que exactamente
  una fila envuelta en un arreglo SÍ se acepta y procesa normalmente —
  las 15+ reproducciones pedidas, todas confirmando
  `PROVISIONING_RESULT_UNKNOWN`, cero llamadas a `pilot_set_coach_client`
  y cero activaciones pendientes guardadas).
- SQL: sin cambios esta ronda (el fix es exclusivamente de validación
  defensiva en la capa JS). Reconfirmado sin regresión:
  `COACH-CLIENT-STATE-MIGRATION-TEST.sql` **18/18 PASS, 0 FAIL**;
  `PENDING-ACTIVATION-MIGRATION-TEST.sql` (BD separada) **28/28 PASS, 0
  FAIL**.
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`): PASS.
- Confirmado explícitamente que las protecciones de permisos (OWNER/ADMIN
  vs. COACH/CLIENT), concurrencia (revocación concurrente →
  `REVISION_CONFLICT`, sin reintento ni reversión silenciosa) y lectura
  de revisiones exactas (0/8/100) siguen funcionando sin cambios.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`, y este archivo.

## 15ª ronda: 1 hallazgo P2 de Codex sobre el commit `a8e22a3b6f97838ecbdf496e0670185397807e2a` (`!row.out_profile_exists` trataba cualquier valor falsy como perfil ausente)

**`setCoachClient()` (`pilot-admin-provisioning-service.cjs:493`).**
`if (!row.out_profile_exists) fail('PROFILE_NOT_FOUND', 404);` usaba la
negación genérica de JS, que trata CUALQUIER valor falsy (`undefined`,
`null`, `0`, `''`, `NaN`) igual que `false` — así que una respuesta
MALFORMADA de `pilot_get_coach_client_state` (campo ausente, en `null`, o
con un tipo incompatible, por ejemplo por una versión distinta de la RPC
o un contrato roto) creaba una activación pendiente exactamente igual que
un perfil genuinamente ausente, sin ninguna forma de distinguir "sé con
certeza que no existe" de "no puedo confiar en esta respuesta". Corregido
con `validateCoachClientStateRow()`, que exige el TIPO exacto de cada
campo obligatorio de la respuesta (boolean estricto para
`out_profile_exists`/`out_client_exists`; string o null para
`out_coach_client_id`; boolean o null para `out_active`; number o null
para `out_revision`) y la consistencia cruzada entre ellos (si hay
`out_coach_client_id`, `out_active`/`out_revision` deben venir ambos
definidos; si no hay, deben venir ambos en `null`) ANTES de que
`setCoachClient()` decida nada. Cualquier desviación se reporta como
`PROVISIONING_RESULT_UNKNOWN` (503) — el mismo código que este archivo ya
usa en otros puntos para "no se puede confirmar el resultado" — sin crear
ninguna activación pendiente ni llegar a llamar `pilot_set_coach_client`.
Solo `out_profile_exists === false` (estrictamente) sigue significando
"perfil ausente, genuinamente pendiente".

**Pruebas ejecutadas esta ronda:**
- `npm test`: **153/153 PASS, 0 FAIL** (13 pruebas nuevas: `false`/`true`
  explícitos vía `rpcOverride`, y 11 variantes de respuesta inválida —
  `null`, `undefined`, campo ausente, tipos incompatibles, objeto vacío,
  fila completa `null`, e inconsistencia cruzada entre campos — todas
  confirmando `PROVISIONING_RESULT_UNKNOWN`, cero llamadas a
  `pilot_set_coach_client` y cero activaciones pendientes guardadas).
- SQL: sin cambios esta ronda (el fix es exclusivamente de validación
  defensiva en la capa JS — la columna `out_profile_exists boolean` de
  Postgres ya garantiza su tipo en el origen). Reconfirmado sin regresión:
  `COACH-CLIENT-STATE-MIGRATION-TEST.sql` **18/18 PASS, 0 FAIL**;
  `PENDING-ACTIVATION-MIGRATION-TEST.sql` (BD separada) **28/28 PASS, 0
  FAIL**.
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`): PASS.
- Confirmado explícitamente que las protecciones de concurrencia
  (revocación concurrente entre lectura y escritura → `REVISION_CONFLICT`,
  sin reintento ni reversión silenciosa) y de permisos (OWNER/ADMIN vs.
  COACH/CLIENT) siguen funcionando sin cambios.

**Sin commit ni push esta ronda** (no autorizado). Archivo modificado:
`pilot-backend/server/pilot-admin-provisioning-service.cjs` (más
`pilot-backend/tests/pilot-admin-provisioning.test.cjs` y este archivo).

## 14ª ronda: 2 hallazgos P2 de Codex sobre el commit `206d95e3f300f749efd7c7b42fe2f322717dc199` (clasificación de 23503, cliente inexistente confundido con perfil pendiente)

**1) Error 23503 clasificado incorrectamente (`pilot-admin-provisioning-service.cjs:313,568`).**
`mapRpcError` traducía CUALQUIER violación de llave foránea (23503), sin
importar de qué RPC viniera, al mismo código genérico
(`RELATED_RECORD_NOT_FOUND`), y `addClient()` convertía SIEMPRE ese código
en `PENDING_PROFILE` con una activación pendiente guardada — incluso
cuando la membresía y el perfil YA existían y lo que de verdad falló fue
la escritura de `pilot_set_coach_client` (un error de integridad real,
nunca "todavía no existe"). Corregido eliminando el mapeo genérico: cada
llamada decide ahora su propio significado para 23503 según en qué punto
del flujo ocurre — en `setMembership` (la PRIMERA escritura, antes de que
exista cualquier membresía confirmada) sigue significando "perfil
ausente" (`PROFILE_NOT_FOUND`, pendiente genuino); en `setCoachClient`
(que corre DESPUÉS de que `setMembership` ya confirmó membresía+perfil)
significa una inconsistencia real (`CLIENT_RECORD_MISSING`, 409), que
`addClient()` propaga explícito SIN guardar ninguna activación pendiente.

**2) Cliente inexistente confundido con perfil pendiente
(`COACH-CLIENT-STATE-MIGRATION.sql:137`, `pilot-admin-provisioning-service.cjs:458`).**
`pilot_get_coach_client_state` solo comprobaba `clients`, e INFERÍA (sin
verificarlo nunca) que su ausencia significaba "el perfil todavía no
existe" — pero para cuando esta función se llama, la membresía del
cliente YA está confirmada (por la propia validación de la función) y,
por construcción, el perfil también debería existir ya. Si `clients` de
todos modos faltaba, eso era una inconsistencia administrativa real
(el alta nunca terminó de crear esa fila), nunca "pendiente". Corregido
agregando una comprobación EXPLÍCITA de la existencia del perfil
(`public.profiles`, nombre/columna SIN confirmar en esta sesión — mismo
punto no verificado que `pilot_private.lock_admin`) antes de mirar
`clients`, con tres estados ahora distinguibles sin ambigüedad: perfil
ausente (`out_profile_exists=false`, genuinamente pendiente), perfil Y
membresía presentes pero `clients` ausente (`out_client_exists=false`,
inconsistencia administrativa — `CLIENT_RECORD_MISSING`, nunca
programa una reanudación automática) y cliente válido (ambos presentes).

**Pruebas ejecutadas esta ronda:**
- `npm test`: **140/140 PASS, 0 FAIL** (3 pruebas reescritas para los
  nuevos códigos + 1 prueba nueva para el caso defensivo "perfil ausente"
  detectado directamente por la RPC).
- SQL (`COACH-CLIENT-STATE-MIGRATION-TEST.sql`, contra PostgreSQL 16.15
  local desechable, recreada desde cero — la función cambió su tabla de
  retorno, así que la migración ahora hace `drop function` antes de
  `create function`): **18/18 PASS, 0 FAIL** (15 previas + 3 nuevas:
  perfil ausente, `clients` ausente con perfil válido, cliente válido).
- SQL de regresión (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, sin cambios
  esta ronda, base de datos separada): **28/28 PASS, 0 FAIL** — las
  protecciones de revisión, revocación concurrente y permisos de rondas
  anteriores siguen intactas (nunca se reintrodujeron).
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`, sin
  cambios esta ronda): PASS.

**Pendiente (no se puede cerrar sin acceso a Supabase real):**
- Confirmar el nombre real de la tabla `profiles` y de su columna de
  enlace con `gym_memberships.user_id` antes de aplicar
  `COACH-CLIENT-STATE-MIGRATION.sql` — ver la cabecera de ese archivo.
- Mismos pendientes ya documentados en la 13ª ronda (`pilot_private.lock_admin`,
  nombres de columna de `gym_memberships`/`clients`/`coach_clients`).
- Probar en un proyecto de Supabase DESECHABLE antes de producción.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`nutrika/pilot-admin-provisioning-ui.js`,
`pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`,
`pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION.sql`,
`pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql`,
`pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION-TEST.sql`, y este
archivo.

## 13ª ronda: hallazgos de Codex sobre `setCoachClient()` en el commit `e6554ff` (reemplaza la adivinanza de revisiones de la ronda anterior)

La 12ª ronda (punto 2, más abajo) "resolvió" el bloqueo de RLS sobre
`coach_clients` ADIVINANDO la revisión con un ciclo local de 0 a 8
intentos, dejando que la propia RPC `pilot_set_coach_client` rechazara
(40001) cada intento equivocado. Codex auditó ESE commit (`e6554ff`) y
señaló correctamente que la adivinanza en sí misma era el problema: un
ciclo que prueba revisiones no es concurrencia optimista real (no hay
lectura previa que anclar), no distingue "revisión alta legítima" de
"relación inválida", y no tiene forma de negarse a reintentar — si la
revisión real crece más rápido que el límite del ciclo, el alta
simplemente falla con `REVISION_CONFLICT` sin que exista un bug: es un
límite arbitrario disfrazado de protección. Tres correcciones, estrictamente
acotadas a `setCoachClient()`:

**1) Elimina la adivinanza — RPC administrativa de solo lectura nueva.**
`pilot_get_coach_client_state(p_gym_id, p_coach_membership_id,
p_client_membership_id)` (`COACH-CLIENT-STATE-MIGRATION.sql`, PROPUESTA,
no aplicada a Supabase real) devuelve exclusivamente
`(out_client_exists, out_coach_client_id, out_active, out_revision)` —
nunca una fila completa de `clients` ni ningún otro dato clínico.
`SECURITY DEFINER`, pero la autorización real y verificada dentro de la
propia función es una comprobación explícita contra `gym_memberships`
(OWNER/ADMIN activo de ESE gimnasio exacto) — nunca se confía en que la
capa JS ya validó nada. También llama a `pilot_private.lock_admin(p_gym_id)`
para la serialización por gimnasio que las RPC ya confirmadas dicen usar,
pero **esa firma sigue sin confirmar en esta sesión** (sin acceso a
Supabase real) — documentado explícitamente en la cabecera del archivo
como lo único de esta migración que quien la aplique debe verificar antes
de desplegar; si la firma real es distinta, la función no compila/falla
al aplicarse, nunca se comporta mal en silencio. `setCoachClient()` ahora
llama a esta RPC una vez, lee la revisión EXACTA devuelta, y llama a
`pilot_set_coach_client` una sola vez con esa revisión — sin ciclos.

**2) Concurrencia: `REVISION_CONFLICT` sin reintento y sin revertir una
revocación.** Si la revisión cambia entre la lectura y la escritura (otra
sesión revocó o modificó la relación mientras tanto), `pilot_set_coach_client`
devuelve 40001 y la capa JS lo propaga como `REVISION_CONFLICT` (409) de
inmediato — nunca vuelve a leer ni reintenta con otra revisión. Si el
estado leído ya es una relación INACTIVA (`out_active === false`),
`setCoachClient()` falla explícitamente con el nuevo código
`BLOCKED_INACTIVE_RELATIONSHIP` (409) antes de intentar escribir nada —
reactivar una relación revocada exige una decisión administrativa
explícita, nunca un efecto lateral de "agregar cliente" (mismo patrón que
`BLOCKED_PRIVILEGED_ROLE` en `setMembership`, de una ronda anterior).
Probado con una revocación CONCURRENTE real contra PostgreSQL (lectura,
luego una transacción SEPARADA desactiva y avanza la revisión, luego el
intento de escritura con la revisión YA LEÍDA) — confirmado que
`active=false` nunca se revierte.

**3) `23503` ya no se interpreta siempre como `PENDING_PROFILE`.** La RPC
nueva distingue explícitamente "el cliente todavía no tiene perfil"
(`out_client_exists=false`, genuinamente pendiente) de "la relación
gimnasio/coach/cliente es inválida" (coach o cliente de otro gimnasio, o
membresía inexistente) — esto último ahora lanza
`INVALID_COACH_RELATIONSHIP`/`INVALID_CLIENT_RELATIONSHIP` (22023,
mapeados a HTTP 422), nunca se oculta como un simple "pendiente".

**Pruebas ejecutadas esta ronda:**
- `npm test`: **139/139 PASS, 0 FAIL** (reescritas las pruebas que
  asumían la adivinanza; nueva prueba de revocación concurrente entre
  lectura y escritura sin reintento ni reversión silenciosa).
- SQL nuevo (`COACH-CLIENT-STATE-MIGRATION-TEST.sql`, contra PostgreSQL
  16.15 local desechable — recreada desde cero, con sus propios
  stubs de prueba para `pilot_private.lock_admin` y `pilot_set_coach_client`
  en `COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql`): **15/15 PASS, 0
  FAIL** — revisiones 0/8/100 leídas y escritas exactas (nunca
  adivinadas), revocación concurrente real entre lectura y escritura
  (`REVISION_CONFLICT`, sin reversión), OWNER y ADMIN activos
  autorizados, COACH y el propio CLIENT rechazados sin privilegios
  administrativos, aislamiento de gimnasio para coach y para cliente
  (relación inválida explícita, nunca "pendiente"), relación inexistente/
  inactiva/activa.
- SQL de regresión (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, sin cambios
  esta ronda, en una base de datos separada para evitar colisión de UUIDs
  con la batería nueva): **28/28 PASS, 0 FAIL** — las protecciones P0/P1
  de rondas anteriores siguen intactas.
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`, sin
  cambios esta ronda, dos conexiones Postgres reales): PASS — sin
  duplicados, sin bloqueo cruzado.

**Pendiente (no se puede cerrar sin acceso a Supabase real):**
- Confirmar la firma real de `pilot_private.lock_admin` antes de aplicar
  `COACH-CLIENT-STATE-MIGRATION.sql` — ver la cabecera de ese archivo.
- Confirmar los nombres reales de columna en `gym_memberships`/`clients`/
  `coach_clients` (mismo punto no verificado que el resto de esta
  sesión).
- Probar la migración en un proyecto de Supabase DESECHABLE antes que en
  producción.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados o
creados: `pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`,
`pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION.sql` (nuevo),
`pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION-TEST-SCHEMA.sql`
(nuevo), `pilot-backend/deployment/COACH-CLIENT-STATE-MIGRATION-TEST.sql`
(nuevo), y este archivo.

## 12ª ronda: 2 pendientes P2 de Codex sobre el commit `a201ed1` (clasificación de errores, alta bloqueada por RLS)

**1) Clasificación incorrecta de errores (`pilot-auth.js:86,184`).** La
ronda anterior distinguía "fallo de red" de "fallo real" mirando si
`resume.error.code` estaba vacío — pero un HTTP 500 sin código SQL
reconocido TAMBIÉN llega con `code` vacío/ausente, así que ese chequeo
clasificaba un fallo de SERVIDOR real como si fuera un problema de red.
Corregido usando `resume.status` (el código HTTP real que el SDK
conserva, confirmado leyendo @supabase/postgrest-js/PostgrestBuilder.ts:
`status:0` ÚNICAMENTE cuando el fetch nunca llegó a completarse; el
código HTTP real en cualquier otro caso) — `status===0` → red,
`status===404` → tolerado ("no existe todavía"), cualquier otro →
`ACTIVATION_FAILED`. Se agregó `'23505'` (unique_violation) al conjunto de
códigos SQL reconocidos y conservados por el fetch wrapper (antes se
descartaba en silencio junto con cualquier código no reconocido). Pruebas
nuevas: HTTP 500 sin código reconocido (ya NO se confunde con red), 23505
conservado, 42501 conservado, y la forma REAL en que el SDK resuelve una
falla de red (`{error, status:0}`, no una excepción).

**2) Alta directa bloqueada por RLS (`pilot-admin-provisioning-service.cjs:435`).**
`setCoachClient()` leía `clients` (datos clínicos) con la sesión del
propio OWNER/ADMIN para confirmar que la fila existía y conocer la
revisión actual de `coach_clients` antes de escribir. RLS sobre `clients`
casi con certeza solo permite leer al propio cliente o a su coach YA
asignado — un OWNER/ADMIN que nunca fue ese coach exacto no podía leer
esa fila aunque existiera, y la operación ADMINISTRATIVA terminaba
reportando `PENDING_PROFILE` para un cliente que ya existía. Esto era,
de hecho, el riesgo que el punto 5 de "CONTRATO NO VERIFICADO" (al inicio
del archivo, desde rondas anteriores) ya predecía sin poder confirmarlo.
Corregido para NUNCA depender de esa lectura clínica, sin ampliar RLS ni
dar acceso privilegiado al CLIENT, y sin cambiar el contrato de las RPC
existentes:
  - la existencia de `clients` ya no se verifica con un SELECT propio —
    se deja que la propia RPC `pilot_set_coach_client` la valide (su
    llave foránea sobre `client_id`, resuelta internamente) y reporte
    23503 si falta, con el mismo mapeo ya establecido
    (`RELATED_RECORD_NOT_FOUND`).
  - la revisión de `coach_clients` tampoco se lee: se intenta
    optimistamente con un contador local (0, 1, 2, ..., hasta 8 intentos)
    en vez de releer la fila — mismo principio de concurrencia optimista,
    sin necesitar ningún permiso de lectura clínica adicional. Un número
    adivinado mal nunca aplica a ciegas: la propia RPC lo rechaza
    (40001) y se reintenta con el siguiente.
Pruebas nuevas: un OWNER nunca antes asignado reasigna a un cliente YA
EXISTENTE a un coach válido, con `from()` envuelto para que CUALQUIER
intento de leer `clients`/`coach_clients` directamente falle la prueba
(demuestra que el código nunca lo intenta, no solo que el mock lo
permite); y el límite explícito de la adivinanza (revisión muy alta →
`REVISION_CONFLICT` honesto, acotado, nunca a ciegas ni indefinido).

**Pruebas ejecutadas esta ronda:**
- `npm test`: **139/139 PASS** (136 previas + 3 nuevas: HTTP 500
  real/23505 conservado + fetch real 23505, OWNER no asignado sin leer
  clínico, límite de reintentos).
- SQL (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, sin cambios esta ronda):
  **28/28 PASS, 0 FAIL** — reconfirma que las protecciones P0/P1 de
  rondas anteriores siguen intactas.
- Concurrencia: PASS.

**Variables necesarias para un Supabase aislado (sin crear nada todavía)**
— ver la lista completa en el informe de esta ronda. Confirmado: ningún
archivo de producción conserva el ref/URL compartido hardcodeado salvo
`pilot-config.cjs` (su propio *valor por defecto*, nunca usado cuando se
configura un proyecto aislado) — `pilot-http.cjs` (CSP) y `pilot-auth.js`
ya derivan todo de `config.supabaseUrl`/`config.projectRef`, confirmado
con una prueba de integración real (servidor + cliente reales) que
verifica que ni la CSP ni `/pilot-config.json` mencionan el proyecto
compartido cuando se configura uno aislado.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`nutrika/pilot-auth.js`, `pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/tests/pilot-auth.test.cjs`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`, y este archivo.

## 11ª ronda: 5 hallazgos de Codex sobre el commit `60afc33` (COACH revocado, reenvío, proyecto Supabase aislado)

**P1 — Reactivación de COACH revocado (SQL:415 de la v del commit 60afc33).**
El bloqueo "P0" (restauración de privilegios) que impide reactivar sola una
membresía propia inactiva solo comprobaba OWNER/ADMIN — un COACH revocado
(`roles={COACH}`, `active=false`) pasaba de largo y se reactivaba igual,
quedando `{COACH, CLIENT}` activo sin ninguna decisión administrativa.
Corregido añadiendo `'COACH'` al arreglo de roles bloqueados en
`PENDING-ACTIVATION-MIGRATION.sql`; esto ya era consistente con el
equivalente en JS (`PRIVILEGED_ROLES` en
`pilot-admin-provisioning-service.cjs`, que sí incluía COACH desde la 10ª
ronda) — la inconsistencia estaba solo en el lado SQL. Regresión SQL
agregada (P0d/P0e/P0f): `{COACH}` inactivo nunca pasa a `{COACH,CLIENT}`
activo.

**P1 — Reenvío de invitaciones inválidas (`pilot-admin-provisioning-service.cjs:463`).**
`resendInvite` (corregido en la 10ª ronda para exigir `status='pending'`
en ese `gym_id`/`user_id`) no revalidaba si esa autorización SEGUÍA siendo
válida — una solicitud puede seguir marcada `pending` en la tabla aunque su
autorizador original fue revocado o su coach destino ya no es COACH activo
ahí. Corregido: `authorizePendingActivation` ahora también revalida en
vivo que `created_by` sigue siendo OWNER/ADMIN activo en ese gimnasio, y
que `coach_membership_id` sigue siendo COACH literal activo en ESE MISMO
gimnasio — mismas comprobaciones que `pilot_resume_pending_activation()`
hace al completar, pero exigidas ANTES de reenviar. Pruebas negativas
agregadas: autorizador revocado, coach inactivo, coach de otro gimnasio.

**P1 — Configuración de Supabase aislado (`pilot-config.cjs` y `pilot-auth.js`).**
El project ref/URL de Supabase estaban hardcodeados en AMBOS archivos —
`pilot-config.cjs` solo aceptaba que las variables de entorno
CONFIRMARAN el proyecto compartido (cualquier otro valor se rechazaba), y
`pilot-auth.js` exigía literalmente ese mismo ref fijo del lado del
navegador, así que ni siquiera corrigiendo el servidor habría sido
posible usar un proyecto Supabase realmente distinto para una
preproducción aislada. Corregido: `pilot-config.cjs` acepta
`PILOT_SUPABASE_PROJECT_REF`+`PILOT_SUPABASE_URL` dados JUNTOS y
mutuamente consistentes (formato real de project ref validado, 20
caracteres alfanuméricos en minúscula) para apuntar a un proyecto
distinto; sin ninguna de las dos variables, sigue usando el compartido
por defecto — el valor de producción no cambia. `pilot-auth.js` valida la
ESTRUCTURA de lo que el servidor le entrega (en vez de un valor fijo), y
deriva `storageKeyFor(projectRef)` en vez de una clave de almacenamiento
fija. **Se encontró, al verificar con un arranque real, un tercer archivo
con el mismo problema que no estaba en el hallazgo:** la
Content-Security-Policy de `pilot-http.cjs` tenía el origen de Supabase
hardcodeado en `connect-src` — aunque el servidor y el cliente ya
aceptaran un proyecto aislado, el navegador habría bloqueado toda
conexión a ese otro origen por violar la CSP. Corregido: la CSP se
construye por request a partir de `config.supabaseUrl`. Pruebas nuevas:
`pilot-config.test.cjs` (configuración aislada válida y combinaciones
rechazadas: solo una variable, formato de ref inválido, ref/URL
mezclados) y una prueba de integración real en `render-readonly.test.cjs`
(servidor real + `pilot-auth.js` real aceptando un proyecto aislado, con
la CSP reflejándolo).

**P2 — Error de red (`pilot-auth.js:155`).** El código asumía que un
fallo de red real durante `pilot_resume_pending_activation()` se vería
como una EXCEPCIÓN lanzada — pero el SDK de Supabase instalado, por
configuración por defecto (nunca se llama `.throwOnError()` en este
archivo), NO lanza ante un fallo de fetch: lo captura internamente y
resuelve `{error}` con `code` VACÍO, confirmado leyendo el código fuente
instalado de `@supabase/postgrest-js` (`PostgrestBuilder.ts`). Esto hacía
que un fallo de red real cayera en la misma rama que un error de
activación genuino (`ACTIVATION_FAILED`), nunca distinguido como
`ACTIVATION_NETWORK_ERROR`. Corregido: se distingue `code===''` (red) de
`code==='PILOT_NOT_FOUND'` (tolerado) y de cualquier otro código (fallo
real). Se conserva el `catch` original como defensa en profundidad. Prueba
nueva reproduciendo la forma REAL en que el SDK resuelve esto (no una
excepción simulada, que es lo que la prueba anterior de esta sesión
hacía).

**P2 — Selector multigimnasio (`pilot-admin-provisioning-ui.js:147`).**
`form.reset()` solo restaura los valores VISIBLES de los controles — nunca
dispara `change`, así que el listener del `<select>` de gimnasio no se
ejecutaba y la variable `gymId` (fuera del DOM) seguía apuntando al
gimnasio de la operación anterior aunque el selector ya se viera vacío
otra vez; un reenvío posterior sin volver a elegir gimnasio podía usar un
`gymId` distinto del que la interfaz mostraba. Corregido con
`resetGymSelection()`, llamada junto a `form.reset()`, que sincroniza
explícitamente el `<select>` y la variable al mismo estado que al montar.
Regresión agregada: selección → alta exitosa → reset → intento de
reenvío SIN re-seleccionar (rechazado) → selección explícita de OTRO
gimnasio → reenvío correcto a ESE gimnasio.

**Pruebas ejecutadas esta ronda:**
- `npm test`: **136/136 PASS** (131 previas + 5 nuevas: COACH revocado se
  cubre en SQL, no en JS; reenvío autorizador/coach inválido en JS;
  configuración aislada en `pilot-config.test.cjs` nuevo + integración
  real; red real del SDK; reset de selector multigimnasio).
- SQL (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, PostgreSQL 16.15 local
  desechable): **28/28 PASS, 0 FAIL** (25 previas + P0d/P0e/P0f nuevas).
- Concurrencia: PASS.
- Verificación manual de un arranque real de Render: `readOnly` clínico
  sigue cerrado, rutas administrativas antiguas siguen en 404, y la CSP
  usa el proyecto compartido por defecto cuando no se configura ninguno
  aislado.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION.sql`,
`PENDING-ACTIVATION-MIGRATION-TEST.sql`,
`pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/server/pilot-config.cjs`, `pilot-backend/server/pilot-http.cjs`,
`nutrika/pilot-auth.js`, `nutrika/pilot-admin-provisioning-ui.js`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`,
`pilot-backend/tests/pilot-auth.test.cjs`,
`pilot-backend/tests/render-readonly.test.cjs`, y el archivo nuevo
`pilot-backend/tests/pilot-config.test.cjs`.

## 10ª ronda: 5 hallazgos de Codex sobre el commit `26fd7fc` (servicio de alta, callback de invitación, UI)

Esta ronda corrige 5 hallazgos sobre el backend/frontend del alta de
clientes (`pilot-admin-provisioning-service.cjs`, `pilot-auth.js`,
`pilot-auth-ui.js`, `pilot-admin-provisioning-ui.js`) — ninguno toca
`PENDING-ACTIVATION-MIGRATION.sql` ni sus pruebas SQL, que se reejecutaron
para confirmar que las protecciones P0/P1 ya existentes (restauración de
privilegios, autoría falsificable, rol de coach literal) siguen intactas.

**P1 — Invitaciones sin autorización suficiente.** `resendInvite` solo
exigía que el llamador fuera OWNER/ADMIN de ALGÚN gimnasio (`gymId` lo
decide el propio llamador) — nunca comprobaba que el correo a reenviar
tuviera relación alguna con ese gimnasio. Cualquier OWNER/ADMIN de
cualquier gimnasio podía reenviar/invitar un correo arbitrario vía la
Admin API. Corregido: se resuelve el correo a un id Auth real
(`findUserByEmail`) y se exige una fila en `pilot_pending_activations` con
`gym_id` + `user_id` + `status='pending'` — si esa tabla no existe todavía
(migración no aplicada) o no hay fila, se falla cerrado
(`NO_PENDING_ACTIVATION`, nunca se asume autorización sin poder
comprobarla).

**P1 — Sobrescritura de roles.** `addClient` llamaba siempre
`pilot_set_membership` con `p_roles=['CLIENT']`, reemplazando por completo
cualquier rol existente de ese correo en ese gimnasio — si ya era
OWNER/ADMIN/COACH, lo perdía. Corregido: se conserva el arreglo existente y
solo se agrega CLIENT (mismo criterio que la protección del último OWNER
en `pilot_resume_pending_activation()`). Además, si esa membresía ya existe,
está INACTIVA y conserva un rol privilegiado, `addClient` la rechaza
explícitamente (`BLOCKED_PRIVILEGED_ROLE`) en vez de reactivarla como
efecto secundario de "agregar cliente".

**P1 — Callback de invitación.** `inviteUserByEmail` se llamaba sin
`redirectTo`, dependiendo del callback GLOBAL configurado en el dashboard
de Supabase (no validado por este servidor, potencialmente distinto por
entorno). Corregido: se construye siempre con `config.publicOrigin` (única
fuente: una variable de entorno del servidor, ya validada por
`loadPilotConfig`) + la ruta fija `/auth/callback.html`; sin
`PILOT_PUBLIC_ORIGIN` configurado, se rechaza (`PILOT_PUBLIC_ORIGIN_REQUIRED`)
en vez de invitar sin saber a dónde redirigir.

**P2 — Errores ocultos.** `pilot-auth.js` ignoraba CUALQUIER error al
llamar `pilot_resume_pending_activation()` (no solo "la función no existe
todavía"), y `pilot-auth-ui.js` no tenía mensaje propio para
`ACTIVATION_BLOCKED_PRIVILEGED_ROLE` (caía en el AUTH_FAILED genérico pese
a que `pilot-auth.js` ya lo distinguía desde la 8ª ronda). Corregido: el
fetch distingue 404 ("no existe todavía", único caso tolerado) de
cualquier otro error (`ACTIVATION_FAILED`) y de un fallo de red real
(`ACTIVATION_NETWORK_ERROR`); se agrega `ACTIVATION_CANCELLED` para cuando
la autorización original ya no es válida. Los 4 estados tienen mensaje
propio en la UI, sin filtrar información sensible.

**P2 — Multigimnasio.** `pilot-admin-provisioning-ui.js` tomaba
`memberships.data[0]` sin mirar si había más de una membresía activa
OWNER/ADMIN — un OWNER/ADMIN de varios gimnasios podía terminar dando de
alta en el gimnasio equivocado, en silencio. Corregido: con más de un
gimnasio elegible, se exige una selección explícita (sin preselección); el
backend sigue revalidando de todas formas que el `gymId` recibido sea
exactamente uno donde el actor es OWNER/ADMIN activo.

**Pruebas ejecutadas esta ronda:**
- `npm test`: **131/131 PASS** (115 previas + 16 nuevas: multigimnasio,
  resendInvite autorizado/no autorizado, sobrescritura de roles para
  OWNER/ADMIN/COACH/CLIENT existentes, redirectTo configurado/rechazado, y
  los nuevos estados de activación en pilot-auth.js y su UI real).
- SQL (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, PostgreSQL 16.15 local
  desechable, sin cambios de esta ronda): **25/25 PASS, 0 FAIL** — se
  reejecutó para confirmar que P0/P1 de rondas anteriores siguen intactos.
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`): PASS.
- Se encontró y corrigió, al VERIFICAR con un arranque real (no solo leer
  el código), un bug adicional no listado por Codex: la guarda de
  `readOnly` en `pilot-http.cjs` (de la 8ª ronda) usaba coincidencia por
  PREFIJO para el administrador antiguo — esto habría seguido bloqueando
  `/pilot-admin-provisioning-ui.js` si no se hubiera corregido ya en la 8ª
  ronda; se reconfirmó aquí que sigue con coincidencia EXACTA.

**Sin commit ni push esta ronda** (no autorizado). Archivos modificados:
`pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`nutrika/pilot-auth.js`, `nutrika/pilot-auth-ui.js`,
`nutrika/pilot-admin-provisioning-ui.js`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`,
`pilot-backend/tests/pilot-auth.test.cjs`,
`pilot-backend/tests/render-readonly.test.cjs`.

## 9ª ronda: corrección de la discrepancia de roles de coach (evidencia directa del contrato real)

La 8ª ronda dejó "coach sin rol COACH" SIN cambiar, razonando que
OWNER/ADMIN como sustituto de COACH replicaba el contrato ya usado en
`pilot-admin-provisioning-service.cjs` (`COACH_CAPABLE_ROLES`) — y pidió
explícitamente evidencia más reciente antes de tocarlo. Esa evidencia
llegó esta ronda, directamente: el contrato real de `pilot_set_coach_client`
en Supabase es `'COACH'::public.pilot_role = any(coach.roles)` — COACH
LITERAL, nunca OWNER/ADMIN como sustituto. La suposición de la 8ª ronda
era incorrecta y se revierte.

**Cambios:**
- `COACH_CAPABLE_ROLES` en `pilot-admin-provisioning-service.cjs`:
  `['COACH', 'OWNER', 'ADMIN']` → `['COACH']`. Comentarios actualizados
  (cabecera del archivo y junto a `authorizeTargetCoach`).
- `PENDING-ACTIVATION-MIGRATION.sql`: la comprobación de "¿el coach destino
  sigue siendo válido?" pasa de `gm.roles && array['COACH','OWNER','ADMIN']`
  a `'COACH' = any(gm.roles)`. Comentario de la 8ª ronda ("P1 evaluado, SIN
  cambio") reemplazado por la corrección real, con cita textual de la
  condición confirmada.
- Mock JS de reanudación (`pilot-admin-provisioning.test.cjs`,
  `applyResumePendingActivation`): mismo cambio en `coachStillValid`.
- Reglas finales, sin ambigüedad (las 3 pedidas esta ronda):
  1. OWNER/ADMIN activos administran altas (sin cambios).
  2. El coach asignado debe tener COACH activo en ese gimnasio — OWNER/ADMIN
     por sí solos NUNCA son un destino válido.
  3. Un OWNER/ADMIN que TAMBIÉN tiene COACH en su arreglo de roles sigue
     siendo un destino válido — por tener COACH, no por ser OWNER/ADMIN.

**Pruebas nuevas (todas ejecutadas, no simuladas):**
- JS (`pilot-admin-provisioning.test.cjs`): rechaza coach=OWNER sin COACH;
  rechaza coach=ADMIN sin COACH; acepta coach=OWNER+COACH (combinación).
- SQL (`PENDING-ACTIVATION-MIGRATION-TEST.sql`, contra PostgreSQL 16.15
  local desechable): K/K2 (OWNER activo sin COACH → se cancela, sin
  membresía otorgada), L/L2 (OWNER+COACH → se completa y queda vinculado).
- Concurrencia (`PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`):
  repetida tras el cambio, sin regresión.
- `npm test`: **115/115 PASS** (112 + 3 nuevas).

**Sin commit ni push esta ronda tampoco** (no autorizado). Archivos
modificados: `pilot-backend/server/pilot-admin-provisioning-service.cjs`,
`pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION.sql`,
`pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION-TEST.sql`,
`pilot-backend/tests/pilot-admin-provisioning.test.cjs`, y este archivo.

## 8ª ronda: hallazgos de la auditoría de Codex sobre el commit `9462850`

El commit `9462850` (7ª ronda, ya subido a `preprod-docker-test`) recibió una
nueva auditoría de Codex con 5 hallazgos. Esta ronda los corrige uno por
uno — SIN hacer commit ni push (no autorizado esta vez) — y deja uno
explícitamente SIN tocar, por contradecir un contrato ya confirmado.

**P0 — Restauración de privilegios (SQL:317-318 de la v2).** Una membresía
ADMIN INACTIVA con roles `{ADMIN, CLIENT}` podía reactivarse sola
(`active = true`) al reanudar, restaurando ADMIN sin ninguna decisión
administrativa. Corregido: antes de tocar la membresía propia, se
comprueba si ya existe, está inactiva y conserva OWNER/ADMIN — si es así,
la solicitud se marca `blocked_privileged_role` (nuevo valor de `status`,
distinto de `cancelled` para que una auditoría lo distinga) y NO se aplica
ningún cambio. Reproducido y verificado contra PostgreSQL 16.15 real
(escenario P0/P0b/P0c en `PENDING-ACTIVATION-MIGRATION-TEST.sql`) y, en
paralelo, en el mock JS (`pilot-admin-provisioning.test.cjs`, que tenía el
mismo patrón de bug y se corrigió igual).

**P1 — Autoría falsificable (SQL:105-125 de la v2).** La política RLS solo
exigía que quien escribe sea OWNER/ADMIN del gimnasio, nunca que
`created_by` fuera su propia identidad — cualquier OWNER/ADMIN podía
atribuir la autorización a OTRO OWNER/ADMIN. Corregido añadiendo
`created_by = auth.uid()` al `with check` de la política. Esto también
cierra, como efecto correcto, la reapertura/reutilización de una solicitud
cancelada o completada: reabrirla exige autoatribuirse como nuevo
autorizador. Verificado con dos escenarios reales (P1: INSERT falsificado
rechazado; P1b: UPDATE que intenta reatribuir una solicitud existente,
también rechazado) — ambos con el ERROR de RLS esperado, confirmado por
ejecución real, no asumido.

**P1 — "Coach sin rol COACH" (SQL:289 de la v2) — EVALUADO, SIN CAMBIO.**
Se pidió exigir el rol COACH literal y no aceptar OWNER/ADMIN como
sustituto. Esto contradice el contrato YA CONFIRMADO dos veces en este
mismo repositorio: `COACH_CAPABLE_ROLES = ['COACH','OWNER','ADMIN']` en
`pilot-admin-provisioning-service.cjs` (líneas ~169-173 y ~264-272),
usado en producción por el flujo real de alta de clientes
(`addClient`/`pilot_set_coach_client`). Cambiar esta línea del SQL
rompería la consistencia con ese flujo ya auditado, no sería una
corrección. Se documenta la discrepancia en el propio SQL en vez de
"corregir" algo que no está roto. Si Codex tiene evidencia MÁS RECIENTE de
que ese contrato cambió, hace falta esa evidencia específica antes de
tocar esta línea — no se inventa una corrección sin ella.

**P1 — Integración Render.** `server/render-readonly.cjs` nunca conectaba
el servicio de alta de clientes (`createProvisioningInfrastructure`) al
arranque real de Render — la ruta y el JS existían y estaban probados
(111 tests), pero nunca se exponían fuera de los tests. Corregido:
`prepareRender()` ahora construye y pasa `adminProvisioningService`.
**Al verificarlo con un arranque real (no solo leyendo el código) se
encontró un SEGUNDO bug, más concreto que el reportado por Codex:** la
guarda de `readOnly` en `pilot-http.cjs` bloqueaba cualquier ruta que
empezara con `/pilot-admin` por PREFIJO — lo cual también atrapaba, por
accidente, la ruta nueva y legítima `/pilot-admin-provisioning-ui.js`,
devolviendo 404 incluso con el servicio ya conectado. Corregido a
coincidencia EXACTA (`/admin.html`, `/pilot-admin.js`, `/pilot-admin-ui.js`)
en vez de por prefijo. Verificado con un servidor real escuchando en un
puerto efímero: `/pilot-admin-provisioning-ui.js` → 200 (8557 bytes),
`/admin.html`/`/pilot-admin.js`/`/pilot-admin-ui.js`/`/preview/*` → 404,
`/api/diary/save` y `/api/manual-macros/assign` → siguen cerrados. Prueba
de regresión permanente añadida a `render-readonly.test.cjs`.

**P2 — Endurecimiento SQL.** `search_path` de la función pasa de `public`
a `''` (vacío, el máximo endurecimiento contra secuestro de objetos vía
search_path) y cada referencia al tipo `pilot_role` se califica
explícitamente como `public.pilot_role` (antes dependía de que `public`
siguiera siendo el único esquema en el path). `pg_catalog` sigue siempre
disponible aunque el path esté vacío, así que `now()`/`array[...]` no
necesitan calificarse.

**P2 — "No ignores silenciosamente errores de activación".** El try/catch
tolerante de `pilot-auth.js` alrededor de `pilot_resume_pending_activation()`
sigue tolerando que la RPC no exista todavía (infraestructura no
aplicada) — eso es deliberado y no se tocó. Pero ahora SÍ distingue el
único estado con consecuencia de seguridad real: si la RPC devuelve
`out_status = 'blocked_privileged_role'`, `verify()` retorna
`{status:'ACTIVATION_BLOCKED_PRIVILEGED_ROLE'}` en vez de seguir como si
nada hubiera pasado. No se rediseñó la superficie completa de estados
(pendiente/completada/fallida para cada transición) — eso excede lo que
esta ronda pidió corregir con evidencia concreta (archivo/línea) y
arriesgaba romper el contrato ya probado de `verify()`.

**Pruebas ejecutadas esta ronda (todas contra PostgreSQL 16.15 local
desechable, nunca 17.11 — sigue sin estar disponible en este entorno — y
nunca Supabase real):**
- `npm test`: 112/112 PASS (111 + 1 nueva: P0 sobre el mock).
- `PENDING-ACTIVATION-MIGRATION-TEST.sql`: 22/22 PASS (18 de la ronda
  anterior + P0, P0b, P0c, P1, P1b nuevos).
- `PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh`: PASS (sin cambios de
  comportamiento esperados; se repitió para confirmar que los cambios de
  P0/P1/P2 no la rompieron).
- Arranque real de `prepareRender()` en un puerto efímero, con
  verificación manual de las rutas HTTP (ver P1 Render arriba).

**Sin commit ni push esta ronda** (no autorizado). Los archivos quedan
modificados en el árbol de trabajo: `PENDING-ACTIVATION-MIGRATION.sql`,
`PENDING-ACTIVATION-MIGRATION-TEST.sql`, `server/render-readonly.cjs`,
`server/pilot-http.cjs`, `nutrika/pilot-auth.js`,
`tests/pilot-admin-provisioning.test.cjs`, `tests/render-readonly.test.cjs`,
y este archivo.

## 7ª ronda: mismos 6 fallos reportados otra vez — causa real: nunca se confirmaron ni se subieron

Codex volvió a reportar los MISMOS 6 fallos de la 6ª ronda, ahora contra
PostgreSQL 17.11 desechable. Antes de asumir una regresión o un problema
específico de la versión 17, verifiqué el estado real de git:

```
$ git log --oneline -- pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION.sql
a1cc1ec feat: automatic client activation on first login   <- único commit
```

**El commit `a1cc1ec` (lo único que existe en `origin/preprod-docker-test`,
y por lo tanto lo único que Codex puede haber revisado desde un checkout
limpio de esa rama) contiene la VERSIÓN 1, sin corregir** —
`array['CLIENT']::pilot_role[]` (el reemplazo de roles), sin
`out_status`/alias de tabla, sin el `GRANT` de tabla. Las correcciones de
la 6ª ronda se hicieron, se verificaron, y se reportaron — pero nunca se
confirmó un commit ni se hizo push, porque esa ronda no lo autorizó
explícitamente. Es decir: **Codex (casi con toda certeza) volvió a probar
la misma versión rota que ya se había corregido en esta sesión, porque la
corrección nunca llegó al repositorio.** Esto no es una suposición sin
verificar — es lo que `git log`/`git diff HEAD` muestran directamente.

No tengo los pasos de reproducción detallados de Codex para esta ronda
(solo la misma lista de 6 puntos). Dado que esos 6 puntos son
EXACTAMENTE los de la 6ª ronda, y que la 6ª ronda ya los reprodujo y
corrigió uno por uno contra Postgres real (ver la sección de abajo), no
tiene sentido "adivinar" una causa nueva — la explicación más simple y
verificable (código corregido, pero jamás subido) ya está confirmada. Si
Codex efectivamente probó una versión que SÍ incluye las correcciones y
aun así falló, eso significaría un fallo nuevo y específico de PG 17.11
que esta sesión no puede reproducir sin PostgreSQL 17 (no disponible en
este entorno — ver más abajo) y sin los pasos exactos de Codex. En ese
caso, lo que falta es precisamente eso: **el informe/log detallado de
Codex para esta ronda** (consulta SQL exacta que falló, mensaje de error
completo, rol y usuario usados). Sin eso, no voy a inventar una sexta
corrección sobre algo que ya se corrigió y se verificó.

**Lo que SÍ hice esta ronda, de forma verificable:**
- Confirmé que el archivo en disco sigue siendo la versión corregida (no
  se revirtió nada).
- Intenté obtener PostgreSQL 17 local para cerrar la brecha de versión:
  no está en los repositorios de Ubuntu 24.04 de este entorno, y
  `apt.postgresql.org` (el repositorio oficial de PGDG que sí lo tiene)
  está bloqueado por el proxy de salida de esta sesión. Sigo sin poder
  probar contra 17.11 exactamente — se deja explícito, no se simula.
- Volví a ejecutar TODA la batería de escenarios contra PostgreSQL 16.15
  local desechable — 0 FAIL — y la convertí en **archivos permanentes,
  reproducibles por cualquiera** (antes eran scripts de sesión que se
  borraban al terminar):
  - `PENDING-ACTIVATION-MIGRATION-TEST-SCHEMA.sql` — andamio del esquema
    asumido (gym_memberships/clients/coach_clients/pilot_role/auth.uid()),
    solo para Postgres local desechable.
  - `PENDING-ACTIVATION-MIGRATION-TEST.sql` — los 10 escenarios (A–J) con
    salida PASS/FAIL legible, más DOS escenarios nuevos explícitos pedidos
    esta ronda: un CLIENT que intenta FABRICAR una solicitud
    autoasignándose como `created_by` (D2, RLS la rechaza igual que
    cualquier otro intento), y un CLIENT que intenta LEER la solicitud de
    otro usuario (D3, ve 0 filas).
  - `PENDING-ACTIVATION-MIGRATION-CONCURRENCY-TEST.sh` — la prueba de
    concurrencia con dos conexiones reales, ahora como script reutilizable
    en vez de una sesión manual.
- Ejecuté `npm test`: 111/111, sin cambios respecto a la ronda anterior
  (esta ronda no tocó ningún archivo `.cjs`/`.js`).

**Siguiente acción necesaria, antes de seguir iterando sobre "los mismos 6
fallos": confirmar (commit + push) la versión YA corregida a
`preprod-docker-test`, para que cualquier auditoría futura de Codex
revise el código corregido en vez de la v1 original.** Esto requiere tu
autorización explícita, igual que en rondas anteriores.

## 6ª ronda: corrección de la migración contra 6 fallos confirmados por Codex (PG 17.11)

La propuesta SQL de la 5ª ronda nunca se había ejecutado contra ningún
Postgres real — Codex la probó contra PostgreSQL 17.11 y confirmó 6
fallos. Esta ronda los corrige y, por primera vez, **verifica la migración
contra un PostgreSQL local real y desechable** (16.15 — no 17.11; no hay
esa versión exacta disponible en este entorno, pero las causas son
semántica estable de PL/pgSQL/RLS, no específica de una versión menor; se
deja la diferencia de versión explícita en vez de asumir equivalencia).

**Los 6 fallos y su causa real, confirmada reproduciendo cada uno antes de
corregirlo:**

1. **Permiso denegado al crear solicitudes.** RLS estaba habilitado y la
   política existía, pero nunca se otorgó el `GRANT` de tabla
   (SELECT/INSERT/UPDATE) a `authenticated`. RLS y GRANT son capas
   independientes: ambas deben autorizar, la política sola no basta.
   Reproducido literalmente (`ERROR: permission denied for table
   pilot_pending_activations`) antes de corregir.
2–3. **`pilot_resume_pending_activation()` fallaba con "column reference
   ... is ambiguous"**, y la prueba de Codex necesitó
   `plpgsql.variable_conflict=use_column` para pasar. Causa real: la
   función declaraba `returns table (status text, gym_id uuid,
   coach_membership_id uuid)` — esos tres nombres son EXACTAMENTE columnas
   reales de las tablas que la función consulta, y PL/pgSQL convierte cada
   columna de `returns table` en un parámetro OUT visible en todo el
   cuerpo. Cualquier referencia sin calificar a `status`/`gym_id` quedaba
   ambigua. Corregido de forma permanente, sin ninguna configuración de
   sesión: los OUT params se renombraron (`out_status`, `out_gym_id`,
   `out_coach_membership_id` — nunca coinciden con ninguna columna real) Y,
   además, cada tabla en el cuerpo de la función ahora tiene un alias
   explícito con cada columna calificada, para que ninguna futura columna
   pueda volver a crear esta ambigüedad.
4. **Comprobación de autoría.** La lógica de revalidar `created_by` ya
   existía desde la 5ª ronda; el fallo real reportado aquí es la misma
   ambigüedad de los puntos 2–3 (la consulta de autoría también usaba
   `gym_id` sin calificar en otro punto del cuerpo).
5. **Protección del último OWNER — fallo real confirmado, no solo de
   sintaxis.** Al reanudar, el código anterior hacía
   `set roles = array['CLIENT']`, es decir, REEMPLAZABA por completo el
   arreglo de roles de la persona que inicia sesión. Si esa persona ya
   tenía una fila de membresía con OWNER/ADMIN/COACH en ese gimnasio (por
   ejemplo, el único OWNER también fue invitado como cliente), esto le
   ELIMINABA ese rol silenciosamente — pudiendo dejar al gimnasio sin
   ningún OWNER activo. Corregido: ahora se AGREGA `CLIENT` al arreglo
   existente, nunca se reemplaza. Verificado con una prueba explícita
   (escenario H): un usuario que ya es OWNER conserva `{OWNER, CLIENT}`
   tras reanudar, no `{CLIENT}` a solas.
6. **Coordinación con revocaciones concurrentes.** Las comprobaciones de
   autorización (creador, coach destino) leían `gym_memberships` sin
   bloqueo, dejando una ventana donde una revocación concurrente podía
   intercalarse entre el chequeo y la aplicación del cambio. Corregido
   agregando `for share` a ambas lecturas, para que compitan
   correctamente con cualquier `UPDATE` concurrente sobre esa misma fila.

**Nada de esto se corrigió debilitando RLS ni otorgando permisos
excesivos**: el GRANT nuevo (punto 1) es exactamente el mínimo necesario
(SELECT/INSERT/UPDATE, nunca DELETE, nunca para `public`/`anon`) y sigue
filtrado por la MISMA política RLS de siempre; el cliente sigue sin ningún
acceso directo a la tabla, solo `EXECUTE` sobre la función (ahora también
con `REVOKE ALL FROM PUBLIC` explícito antes del grant, para que el límite
quede auditable).

### Resultado por escenario (PostgreSQL 16.15 local desechable, dos
### conexiones reales para concurrencia — nunca Supabase, nunca PG 17.11)
### Reproducible con los 3 archivos de prueba permanentes de la 7ª ronda.

| Escenario | Resultado |
|---|---|
| OWNER crea la solicitud pendiente | **PASS** |
| ADMIN crea la solicitud pendiente | **PASS** |
| COACH intenta crear una solicitud | **PASS** (RLS la rechaza: `permission denied`) |
| CLIENT intenta crear/modificar una solicitud, incluso la propia | **PASS** (RLS la filtra: `UPDATE 0`) |
| CLIENT intenta FABRICAR una solicitud autoasignándose `created_by` (7ª ronda) | **PASS** (RLS la rechaza igual) |
| CLIENT intenta LEER la solicitud de otro usuario (7ª ronda) | **PASS** (0 filas, nunca datos ajenos) |
| CLIENT reanuda mientras existe una solicitud de otro usuario | **PASS** (no la afecta; la suya no existe) |
| Revocación del autorizador (`created_by`) antes de reanudar | **PASS** (se cancela, nunca se aplica) |
| Revocación/desactivación del coach destino antes de reanudar | **PASS** (se cancela) |
| Protección del último OWNER (quien reanuda ya es OWNER) | **PASS** (conserva `{OWNER, CLIENT}`) |
| Idempotencia (segunda reanudación tras completarse) | **PASS** (no encuentra nada pendiente) |
| Acceso entre gimnasios (autorizador/coach de otro gimnasio) | **PASS** (se cancela, nunca se aplica) |
| Concurrencia real (dos conexiones simultáneas, `FOR UPDATE SKIP LOCKED`) | **PASS** (una completa, la otra no encuentra fila que bloquear; sin duplicados) |

Los mocks de `pilot-admin-provisioning.test.cjs` también se corrigieron
para reproducir el fallo real de "protección del último OWNER" (el mock de
`applySetMembership` reemplazaba el arreglo de roles igual que lo hacía la
versión 1 de la función SQL) — nueva prueba dedicada que falla con el
código anterior y pasa con el corregido.

## Qué cambia

- **`pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION.sql`** (nuevo,
  **propuesta, NO aplicada**): una tabla `pilot_pending_activations`
  (bloqueada por RLS para todos excepto OWNER/ADMIN del gimnasio
  correspondiente) y una función `pilot_resume_pending_activation()`
  (SECURITY DEFINER, autoservicio, otorgada a `authenticated`). Diseño
  explicado con comentarios dentro del propio archivo: por qué no
  reutiliza `pilot_set_membership`/`pilot_set_coach_client` directamente
  (esas RPC autorizan comprobando el rol de `auth.uid()` en el momento de
  la llamada, y el cliente nunca es OWNER/ADMIN), por qué revalida en vivo
  que el autorizador original sigue siendo OWNER/ADMIN activo (en vez de
  confiar ciegamente en una autorización histórica), y cómo evita
  condiciones de carrera (`FOR UPDATE SKIP LOCKED`).
- **`pilot-admin-provisioning-service.cjs`**: cuando `addClient` cae en
  `PENDING_PROFILE`, además intenta guardar (upsert por `gym_id,user_id`,
  nunca duplica) la solicitud en `pilot_pending_activations`, con la
  sesión del propio OWNER/ADMIN que ya se autorizó (nunca `service_role`).
  Si esa tabla todavía no existe, el intento falla en silencio — el
  resultado sigue siendo `PENDING_PROFILE`, solo que con
  `autoResumable: false` en vez de `true`, para que la UI sepa cuál
  mensaje mostrar y **nunca prometa algo que no puede cumplir**.
- **`pilot-auth.js`**: `verify()` llama `pilot_resume_pending_activation()`
  justo después de `pilot_ensure_profile()` — autoservicio, tolerante (si
  la función no existe todavía o no hay nada pendiente, no rompe la
  verificación normal). Si había una solicitud pendiente aplicable, la
  membresía y la asignación quedan completas en el MISMO `verify()` que
  crea el perfil — el cliente queda `AUTHORIZED` en su primer login, sin
  que el OWNER/ADMIN haga nada más.
- **`pilot-admin-provisioning-ui.js`**: el mensaje tras `PENDING_PROFILE`
  distingue `autoResumable` — si es `true`, dice que se completará solo;
  si es `false`, dice explícitamente que la activación automática no está
  disponible todavía y que hay que repetir la acción a mano.

## ⚠️ Bloqueo real: esto sigue sin funcionar contra Supabase real hasta aplicar la migración

**No se simula que esto funciona hoy contra Supabase.**
`PENDING-ACTIVATION-MIGRATION.sql` ahora SÍ se verificó — contra un
PostgreSQL 16.15 local y desechable, con las 11 pruebas de la tabla
arriba, incluida concurrencia real con dos conexiones — pero sigue sin
ejecutarse contra ningún Supabase (ni real ni de prueba): nadie en esta
sesión tiene ese acceso, y la versión real de Supabase (PostgreSQL 17.11,
según Codex) no está disponible aquí. Hasta que alguien con acceso real:
1. Confirme los nombres de columna reales de
   `gym_memberships`/`clients`/`coach_clients` (el archivo SQL los asume
   iguales a los ya usados en el resto de este módulo) y ajuste la función
   si difieren;
2. Pruebe la migración en un proyecto de Supabase **desechable** (PG
   17.11 real, para cerrar la diferencia de versión), nunca en producción
   directamente;
3. La aplique al proyecto real;

...el código Node.js seguirá funcionando exactamente como en la ronda
anterior: `addClient` devuelve `PENDING_PROFILE` con `autoResumable:
false`, y la reanudación sigue siendo manual (el OWNER/ADMIN repite
"Agregar cliente"). **Nada se rompe por no tener la migración aplicada** —
simplemente no se obtiene el beneficio de la activación automática todavía.

## Pruebas nuevas (14, sobre el contrato SQL PROPUESTO — nunca contra Supabase real)

- Activación automática de punta a punta: alta → solicitud persistida →
  primer login → perfil creado → reanudación automática → `AUTHORIZED`,
  sin segunda acción del OWNER/ADMIN.
- Idempotencia: un segundo login no duplica membresía ni asignación.
- Sesión expirada/inválida: `verify()` nunca intenta reanudar sin una
  sesión válida (cero llamadas RPC).
- Solicitudes manipuladas: `created_by` que ya no es OWNER/ADMIN activo,
  coach destino ya no válido, y una fila apuntando a otro gimnasio — las
  tres se cancelan en vez de aplicarse.
- Concurrencia: dos intentos de reanudación no duplican nada (la primera
  completa, la segunda no encuentra nada pendiente); una fila ya bloqueada
  (`SKIP LOCKED`) no se procesa dos veces en la misma ventana.
- 110 pruebas en total, ninguna toca la red real.

## Lo que NO pude verificar (ninguno se puede cerrar con mocks en memoria;
## hace falta una base de datos Postgres desechable, separada de producción)

1. Nombres exactos de columna en `clients`/`coach_clients`/`gym_memberships`
   (sin cambios respecto a rondas anteriores).
2. Si RLS permite exactamente las políticas propuestas en
   `PENDING-ACTIVATION-MIGRATION.sql` (la sintaxis asume un tipo
   `pilot_role[]` para `roles` — confirmar que coincide con el real).
3. Si `pilot_private.lock_admin` (mencionado en tareas anteriores como el
   mecanismo de serialización de las RPC existentes) necesita algún
   tratamiento especial dentro de `pilot_resume_pending_activation()` — la
   propuesta no lo toca ni lo reemplaza, solo evita necesitarlo al no pasar
   por `pilot_set_membership`/`pilot_set_coach_client` directamente; si eso
   resulta insuficiente en la práctica, hay que revisarlo con quien
   mantenga ese mecanismo.
4. Rendimiento/bloqueo real de `FOR UPDATE SKIP LOCKED` bajo concurrencia
   genuina (las pruebas de concurrencia de este módulo son deterministas,
   no una prueba de carga real).

## Siguiente paso recomendado

1. Revisar `PENDING-ACTIVATION-MIGRATION.sql` con quien administre
   Supabase; ajustar nombres de columna si difieren; probarlo en un
   proyecto desechable.
2. Aplicarlo al proyecto real cuando esté validado.
3. Confirmar que `autoResumable` pasa a `true` en un alta de prueba real
   después de aplicar la migración — si sigue en `false`, algo en los
   permisos de escritura de `pilot_pending_activations` no coincide con lo
   propuesto.
