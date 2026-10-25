# Alta de clientes — estado y pendientes (preprod-docker-test)

Implementado y probado localmente (sin tocar Supabase real). Resume lo que
queda por confirmar antes de usar esto contra la base de datos de verdad.

## Qué se construyó

- `pilot-backend/server/pilot-admin-provisioning-service.cjs`: capa de
  dominio, reescrita contra los contratos REALES confirmados de las RPC:
  - `pilot_set_membership(p_gym_id uuid, p_user_id uuid, p_roles pilot_role[], p_active boolean, p_expected_revision bigint)`
    — crea la membresía CLIENT y, con ella, el registro en `clients` por su
    cuenta. Esta capa nunca inserta en `clients` directamente.
  - `pilot_set_coach_client(p_gym_id uuid, p_coach_membership_id uuid, p_client_membership_id uuid, p_active boolean, p_expected_revision bigint)`
    — exige IDs reales de membresía (no `user_id`), ambas del mismo
    `gym_id`, y se llama siempre después de `pilot_set_membership`.
  - Ambas usan concurrencia optimista: se lee la revisión real antes de
    escribir, y un conflicto (SQLSTATE `40001`) se resuelve releyendo y
    reintentando con la revisión fresca, acotado a 4 intentos — nunca en
    bucle, nunca duplicando la operación.
  - `gym_id` se exige y se valida en TODAS las consultas y llamadas: el
    llamador debe tener membresía COACH/OWNER activa en ese gimnasio exacto,
    y el coach destino también, antes de escribir nada.
  - Las dos RPC se llaman SIEMPRE con la sesión propia del coach (token
    reenviado, clave publicable) — nunca con `service_role`, para no
    saltarse el mecanismo de bloqueo interno (`pilot_private.lock_admin`)
    que depende de la identidad real del llamador.
- `pilot-backend/server/pilot-admin-provisioning-http.cjs`: ruta HTTP
  (`POST /api/admin/clients`, `POST /api/admin/clients/resend-invite`,
  `GET /api/admin/clients/status`), mismo patrón de origen/bearer/cuerpo
  acotado que `manual-macros-http.cjs`/`diary-http.cjs`.
- `nutrika/pilot-admin-provisioning-ui.js`: formulario "Agregar cliente" en
  la vista Coach. El `gym_id` NO se pide a mano: se obtiene leyendo la propia
  membresía activa del coach (`gym_memberships`, ya legible sin modo admin);
  el servidor igual revalida que esa membresía sea COACH/OWNER activa en ese
  `gym_id` exacto.
- Cambios aditivos en `pilot-http.cjs` y `pilot-auth-ui.js`: todo detrás de
  un parámetro opcional `adminProvisioningService` — si no se pasa, el
  comportamiento es idéntico al actual. Deliberadamente independiente de
  `readOnly`: el piloto puede seguir con diario/macros/tracking cerrados y
  aun así tener esta alta habilitada.
- **Resolución/creación de la cuenta Auth del cliente**, exclusivamente en
  el servidor, con `service_role` leído solo de `PILOT_SUPABASE_SERVICE_KEY`
  (nunca de la clave publicable, que se rechaza por forma si alguien la
  confunde) y usado dentro de un cliente separado que nunca se expone fuera
  de esa función:
  - **Correo existente**: se busca por email con `auth.admin.listUsers()`
    (la única vía que expone la versión instalada de `@supabase/auth-js` —
    no hay filtro por correo, solo paginación), hasta 5 páginas de 200
    usuarios. Si se encuentra, se usa ese `user_id` real — nunca se llama a
    la Admin API para crear nada. Verificado explícitamente con
    `oziel.enriquez@complextraining.mx`: alta repetida, sin duplicar
    membresía ni asignación, sin tocar la Admin API.
  - **Correo nuevo**: se crea con `auth.admin.inviteUserByEmail` (invita y
    crea en un solo paso, documentado y confirmado contra el SDK instalado).
  - Si `PILOT_SUPABASE_SERVICE_KEY` no está configurada, el comportamiento
    es `USER_NOT_FOUND` directo sin intentar nada — opt-in explícito.
- 29 pruebas simuladas nuevas (`pilot-backend/tests/pilot-admin-provisioning.test.cjs`),
  ninguna toca la red real. Incluyen aislamiento entre gimnasios (un coach
  activo en otro gimnasio no puede operar en este), reintento de
  `REVISION_CONFLICT` acotado, y la paginación de `listUsers` deteniéndose
  al encontrar el correo. Las 63 pruebas previas siguen pasando sin cambios
  (92/92 en total).

## Lo que NO pude verificar (bloqueos reales, no asumidos)

1. **Nombres exactos de columna**: `revision` en `gym_memberships` y
   `coach_clients`, y `coach_membership_id`/`client_membership_id` en
   `coach_clients`. Se infieren 1:1 de los parámetros de las RPC
   (`p_expected_revision` → `revision`, etc.), con el mismo criterio que ya
   está confirmado para `p_gym_id` → `gym_id` y `p_user_id` → `user_id`. Si
   algún nombre real difiere, Postgres/PostgREST lo señala de inmediato al
   leer, y el único cambio necesario es ese nombre en el `.select()`
   correspondiente.
2. **Convención de `p_expected_revision` para una fila que nunca existió**
   (se usa `0`). Si el valor real esperado es otro, la RPC devuelve `40001`
   en el primer intento y el reintento ya implementado se autocorrige
   leyendo la revisión real — no bloquea el resultado final, solo agrega una
   vuelta extra la primera vez.
3. **Escala de la búsqueda de usuarios existentes por correo.** `listUsers`
   sin filtro por correo no escala bien si el proyecto crece mucho más allá
   del piloto actual (tope actual: 1000 usuarios revisados). Si eso pasa,
   conviene sustituirlo por una función dedicada en Postgres que busque por
   índice.

## Siguiente paso recomendado

Nada de lo anterior bloquea usar esto en `preprod-docker-test`: el único
modo en que un contrato equivocado se manifiesta es un error claro y
específico (columna inexistente, o `40001` resuelto solo), nunca un alta
silenciosamente incorrecta. Antes de usar esto contra producción real falta:

1. Confirmar los puntos 1 y 2 leyendo, en el SQL Editor del proyecto
   (`otswebncqidqthqplztj`), las columnas reales de `gym_memberships` y
   `coach_clients` (`\d gym_memberships`, `\d coach_clients`), y ajustar los
   nombres en los `.select()` si difieren.
2. Definir `PILOT_SUPABASE_SERVICE_KEY` únicamente en el entorno del
   servidor (Render), nunca en el cliente.
3. Decidir, con quien administre Supabase, si `auth.admin.inviteUserByEmail`
   + `listUsers` deben reemplazar por completo a `pilot-admin.js`, o si ese
   archivo original (no recuperable desde este entorno) tenía alguna
   validación adicional que deba preservarse.
