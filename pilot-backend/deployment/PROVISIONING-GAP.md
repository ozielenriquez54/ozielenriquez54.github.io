# Alta de clientes — estado y pendientes (preprod-docker-test)

Implementado y probado localmente (sin tocar Supabase real). Resume lo que
queda por confirmar antes de usar esto contra la base de datos de verdad.

**5ª ronda: activación automática.** Las rondas 3–4 dejaban la reanudación
como una acción manual (el OWNER/ADMIN tenía que volver a pulsar "Agregar
cliente" después de que el cliente iniciara sesión). Esa ronda la
automatiza — **pero depende de infraestructura SQL que todavía no existe
en Supabase real.** No se declara el flujo terminado de extremo a extremo:
ver la sección "Bloqueo real" más abajo.

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
