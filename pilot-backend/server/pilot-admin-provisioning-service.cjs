'use strict';
// Servicio de alta de clientes para coaches autorizados (Twogramms, piloto).
//
// Contratos reales confirmados (firmas de función verificadas contra el
// esquema real de Supabase):
//   pilot_set_membership(p_gym_id uuid, p_user_id uuid, p_roles pilot_role[],
//                         p_active boolean, p_expected_revision bigint)
//     - crea la membresía si no existe; crea automáticamente el registro en
//       `clients` cuando el rol CLIENT queda activo. Esta capa NUNCA
//       inserta en `clients` directamente (ver setMembership más abajo).
//   pilot_set_coach_client(p_gym_id uuid, p_coach_membership_id uuid,
//                           p_client_membership_id uuid, p_active boolean,
//                           p_expected_revision bigint)
//     - exige que ambas membresías (coach y cliente) sean del MISMO gym_id y
//       que el cliente ya tenga registro en `clients` — por eso se llama
//       siempre DESPUÉS de pilot_set_membership, nunca antes ni en paralelo.
// Ambas usan concurrencia optimista: `p_expected_revision` debe coincidir
// con la revisión actual de la fila. Un desajuste se reporta con SQLSTATE
// 40001 ("serialization_failure") — el único código de conflicto que este
// archivo ya reconocía — y se interpreta como REVISION_CONFLICT: se vuelve a
// leer la fila y se reintenta con la revisión fresca, un número acotado de
// veces, para no duplicar la operación ni reintentar indefinidamente.
//
// Identidad y service_role:
//  - pilot_set_membership y pilot_set_coach_client se llaman SIEMPRE con la
//    sesión del propio coach (token reenviado, clave publicable) — nunca con
//    service_role. Eso es lo que arma `pilot_private.lock_admin` por
//    gimnasio dentro de Postgres con la identidad correcta; saltarlo con
//    service_role rompería esa serialización, así que esta capa no lo hace
//    en ningún punto de este archivo.
//  - service_role (vía la Admin API pública y documentada de Supabase) se
//    usa EXCLUSIVAMENTE para resolver/crear la cuenta Auth del cliente por
//    correo (GoTrueAdminApi.listUsers para buscar, inviteUserByEmail para
//    crear) — nunca para las RPC de arriba, nunca en el navegador, y el
//    cliente admin que las usa no se expone fuera de su función.
//
// Autorización (corregido tras 2ª auditoría): dar de alta clientes requiere
// membresía OWNER o ADMIN activa en ESE gimnasio — COACH por sí solo NO
// tiene permiso para esta operación; COACH solo puede ser el DESTINO de la
// asignación (PROVISIONER_ROLES vs. COACH_CAPABLE_ROLES, más abajo). El
// backend valida esto ANTES de tocar la Admin API de Supabase (ver
// addClient: authorizeCaller/authorizeTargetCoach corren antes que
// resolveOrCreateAuthUser). La discrepancia con pilot-auth.js (que exigía
// literalmente el rol 'COACH' para acceder a la página Coach, dejando
// inalcanzable esta función para un OWNER/ADMIN sin ese rol) se corrigió
// ahí: la vista Coach ahora acepta COACH/OWNER/ADMIN para su propio acceso
// de página — esto NUNCA otorga el rol COACH en los datos, solo amplía qué
// roles reales pueden ver esa página; el permiso administrativo de ESTE
// módulo sigue siendo exclusivamente OWNER/ADMIN, separado del permiso
// clínico/de coacheo.
//
// Relaciones (corregido tras 2ª auditoría — la 1ª corrección fue
// incorrecta y se revierte aquí):
//   - `pilot_set_coach_client` recibe `p_client_membership_id` = el id en
//     `gym_memberships` del cliente (NO el id de su fila en `clients`).
//     setCoachClient() pasa `clientMembershipId` tal cual a la RPC.
//   - Para CONSULTAR una asignación existente (antes de escribir, para la
//     concurrencia optimista), hay que resolver primero `clients.id` a
//     partir de `(gym_id, membership_id)` — `clients` es la tabla que
//     `pilot_set_membership` crea automáticamente al activar CLIENT, con
//     su propio id y una columna `membership_id` que referencia
//     `gym_memberships.id`. Con ese `clients.id` resuelto, la consulta a
//     `coach_clients` filtra por su columna `client_id` — NUNCA por una
//     columna `client_membership_id` (esa columna no existe en
//     `coach_clients`; solo existía en la implementación anterior de este
//     archivo, que confundía el id de escritura con el de lectura).
//
// Profiles (rediseñado tras 2ª auditoría — NO es un reintento con espera):
//   - `pilot_ensure_profile()` es estrictamente de autoservicio: se llama
//     SIN argumentos y opera sobre quien la invoca (ver pilot-auth.js:
//     `client.rpc('pilot_ensure_profile')`, sin parámetros). Esta capa
//     JAMÁS la ejecuta con la sesión del OWNER/ADMIN pretendiendo crear el
//     perfil de otra persona — sería un uso incorrecto de esa RPC, no una
//     forma válida de "forzar" el perfil del invitado.
//   - Esta capa tampoco asume que existe un trigger en `auth.users` que
//     cree `profiles` automáticamente al invitar. Si existe, no lo
//     reemplaza ni lo desactiva. Si no existe, el único momento en que
//     `profiles.id` del invitado puede llegar a existir es cuando ESA
//     persona inicia sesión por primera vez y su PROPIA sesión pasa por el
//     flujo normal de `pilot-auth.js` (que si puede llamar
//     `pilot_ensure_profile()` en autoservicio, en modo no-solo-lectura).
//   - Por eso `pilot_set_membership` puede fallar (FK, `23503`) la primera
//     vez para un correo recién invitado o para uno existente que nunca
//     inició sesión. Esto NO se reintenta con esperas artificiales (eso
//     asumiría un trigger). Se reporta como resultado normal
//     `PENDING_PROFILE` (no como error): la invitación ya se envió (o ya
//     existía la cuenta), y repetir la MISMA llamada a `addClient` más
//     adelante — después de que esa persona inicie sesión al menos una
//     vez — retoma y completa membresía + asignación de forma idempotente,
//     sin reenviar ninguna invitación (resolveOrCreateAuthUser encuentra la
//     cuenta ya existente vía `listUsers` y nunca vuelve a invitar).
//
// Activación automática (nueva, sobre infraestructura PROPUESTA, NO
// aplicada a Supabase real — ver pilot-backend/deployment/
// PENDING-ACTIVATION-MIGRATION.sql):
//   - Cuando addClient() cae en PENDING_PROFILE, además guarda (upsert,
//     por `(gym_id, user_id)` — nunca duplica) una fila persistente en
//     `pilot_pending_activations` con quién la autorizó (`created_by`,
//     el propio OWNER/ADMIN que llamó) y a qué coach quedó destinada.
//   - Esa fila la consume, EN SU PROPIO NOMBRE, el cliente cuando inicia
//     sesión por primera vez — vía `pilot_resume_pending_activation()`
//     (RPC de autoservicio, llamada desde `pilot-auth.js`, NUNCA desde
//     este servicio) — sin que ningún OWNER/ADMIN tenga que repetir la
//     acción manualmente.
//   - Esta capa NUNCA llama a `pilot_resume_pending_activation()`: esa RPC
//     es exclusiva de la sesión del propio cliente. Este archivo solo
//     ESCRIBE la solicitud pendiente, con la sesión del OWNER/ADMIN que ya
//     se autorizó más arriba — no con service_role, no saltándose nada.
//   - Si `pilot_pending_activations` todavía no existe (la migración
//     propuesta no se aplicó), el intento de guardar la solicitud falla
//     silenciosamente (se captura, no se relanza): PENDING_PROFILE se
//     sigue reportando igual, simplemente sin el beneficio de la
//     reanudación automática — nunca se simula que la migración ya está
//     aplicada cuando no lo está.
//
// ======================= CONTRATO NO VERIFICADO =========================
// Ninguno de estos puntos se puede cerrar con mocks en memoria: hace falta
// una base de datos Postgres desechable y separada de producción (p. ej.
// una réplica del esquema en un proyecto de Supabase aparte, o un Postgres
// local con las mismas funciones/triggers aplicados) para observar el
// comportamiento real de las RPC, triggers y RLS.
//
//  1) Nombres exactos de columna: `revision` en `gym_memberships`,
//     `coach_clients` y `clients`; `coach_membership_id` y `client_id` en
//     `coach_clients`; `membership_id` en `clients`. Se infieren de la
//     descripción textual confirmada de las RPC (p_expected_revision ->
//     revision, etc.), con el mismo criterio que ya está confirmado para
//     p_gym_id -> gym_id. Si algún nombre real difiere, Postgres/PostgREST
//     lo señala de inmediato al leer (columna inexistente) y el único
//     cambio necesario es ese nombre en el `.select()` correspondiente.
//  2) Qué `p_expected_revision` espera la RPC la PRIMERA vez que se crea una
//     fila que nunca existió. Se usa 0. Si el valor real esperado es otro,
//     la RPC devuelve 40001 en el primer intento y el mecanismo de
//     reintento ya implementado se autocorrige leyendo la revisión real.
//  3) Resolución de una cuenta Auth EXISTENTE por correo: la Admin API de
//     Supabase instalada aquí (@supabase/auth-js, confirmado localmente en
//     node_modules) no expone un filtro por correo en `listUsers()`, solo
//     paginación (`GET /auth/v1/admin/users?page=&per_page=`). Se buscan
//     hasta 5 páginas de 200 usuarios (1000 en total) antes de darse por
//     vencido.
//  4) Si existe un trigger en `auth.users` que cree `profiles`
//     automáticamente. Deliberadamente NO se asume (ver sección Profiles
//     arriba) — si existe, `PENDING_PROFILE` se resuelve solo en el
//     siguiente intento; si no existe, requiere que la persona invitada
//     inicie sesión primero (lo cual, en este despliegue, también depende
//     de si `pilot-auth.js` corre en modo `readOnly` — ver nota de
//     PROVISIONING-GAP.md sobre esto, que NO se modifica en este módulo).
//  5) Si RLS permite que un OWNER/ADMIN lea la fila de `clients` de otro
//     usuario del mismo gimnasio (necesario para resolver la consulta de
//     `coach_clients` antes de escribir). Si RLS lo bloquea, el error es
//     inmediato y explícito (PROVISIONING_RESULT_UNKNOWN), nunca una
//     asignación incorrecta o silenciosa.
// ==========================================================================

const {snapshotCommand} = require('./gateway-safety.cjs');

class ProvisioningError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ProvisioningError(code, status); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
// Códigos SQLSTATE de Postgres que podemos interpretar con seguridad sin
// reenviar el mensaje crudo del servidor (mismo principio que pilot-auth.js).
// 40001 (conflicto de revisión) y 23503 (llave foránea) tienen su propio
// mapeo explícito en mapRpcError, abajo.
const PG_STATUS = { '42501': 403, '23514': 422, '22023': 400 };
// Quién puede EJECUTAR el alta de clientes (corregido: COACH no tiene este
// permiso, solo puede ser el destino de la asignación).
const PROVISIONER_ROLES = ['OWNER', 'ADMIN'];
// Quién puede ser el COACH destino de una asignación.
const COACH_CAPABLE_ROLES = ['COACH', 'OWNER', 'ADMIN'];

function object(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) {
    fail('INVALID_PROVISIONING_COMMAND');
  }
}
function requireUuid(value, code) { if (typeof value !== 'string' || !UUID.test(value)) fail(code); return value; }
function requireEmail(value) { if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) fail('INVALID_EMAIL'); return value.trim().toLowerCase(); }
function requireName(value) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) fail('INVALID_NAME'); return value.trim(); }
function parseCommand(raw) { try { return snapshotCommand(raw); } catch { fail('INVALID_PROVISIONING_COMMAND'); } }

function validateAddClientCommand(raw) {
  const command = parseCommand(raw);
  object(command, ['email', 'name', 'coachId', 'gymId']);
  return {
    email: requireEmail(command.email), name: requireName(command.name),
    coachId: requireUuid(command.coachId, 'INVALID_COACH'), gymId: requireUuid(command.gymId, 'INVALID_GYM'),
  };
}
function validateResendCommand(raw) {
  const command = parseCommand(raw);
  object(command, ['email', 'gymId']);
  return { email: requireEmail(command.email), gymId: requireUuid(command.gymId, 'INVALID_GYM') };
}
function validateStatusQuery(email, gymId) {
  return { email: requireEmail(email), gymId: requireUuid(gymId, 'INVALID_GYM') };
}

// Ventana fija simple por actor autenticado (no por IP: un coach detrás de
// NAT compartida no debe bloquear a otro). Suficiente para un panel interno
// de pocos coaches; no requiere estado distribuido.
function createRateLimiter({ max = 8, windowMs = 60000 } = {}) {
  const hits = new Map();
  return actor => {
    const now = Date.now();
    const list = (hits.get(actor) ?? []).filter(t => now - t < windowMs);
    if (list.length >= max) fail('RATE_LIMIT_EXCEEDED', 429);
    list.push(now);
    hits.set(actor, list);
  };
}

function createProvisioningService({ createSession, findUserByEmail = null, createAdminInvite = null, timeoutMs = 15000, rateLimiter = createRateLimiter() }) {
  if (typeof createSession !== 'function') fail('INVALID_SERVICE_CONFIGURATION');

  // Mismo patrón que manual-macros-service.cjs: nunca se confía en una
  // identidad declarada por el cliente; se obtiene del propio token
  // reenviado a Supabase Auth.
  function run(token, signal, fn) {
    if (typeof token !== 'string' || !token || token.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(token)) {
      return Promise.reject(new ProvisioningError('AUTH_REQUIRED', 401));
    }
    const controller = new AbortController();
    let timer, onAbort;
    const check = () => { if (controller.signal.aborted) fail('PROVISIONING_RESULT_UNKNOWN', 503); };
    return new Promise((resolve, reject) => {
      let active = true;
      const finish = (err, value) => {
        if (!active) return;
        active = false; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.abort();
        err ? reject(err) : resolve(value);
      };
      onAbort = () => finish(new ProvisioningError('PROVISIONING_RESULT_UNKNOWN', 503));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, timeoutMs);
      Promise.resolve().then(async () => {
        check();
        const client = await createSession(token, controller.signal);
        check();
        const verified = await client.auth.getUser();
        check();
        if (verified.error || !UUID.test(verified.data?.user?.id ?? '')) fail('AUTH_REQUIRED', 401);
        return fn({ client, actor: verified.data.user.id, check });
      }).then(v => finish(null, v), e => finish(e instanceof ProvisioningError ? e : new ProvisioningError('PROVISIONING_SERVICE_UNAVAILABLE', 503)));
    });
  }

  // Confirma del lado del servidor que quien llama tiene membresía OWNER o
  // ADMIN activa EN ESE gimnasio exacto — COACH no tiene este permiso.
  async function authorizeCaller(client, actor, gymId, check) {
    const membership = await client.from('gym_memberships').select('user_id,gym_id,roles,active').eq('user_id', actor).eq('gym_id', gymId).eq('active', true);
    check();
    if (membership.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const roles = membership.data?.[0]?.roles ?? [];
    if (!PROVISIONER_ROLES.some(r => roles.includes(r))) fail('42501', 403);
  }

  // Confirma que el coach objetivo tiene una membresía activa EN EL MISMO
  // gimnasio con un rol que puede coachear (COACH, OWNER o ADMIN), y
  // devuelve el id real de esa membresía (lo exige pilot_set_coach_client
  // como p_coach_membership_id — nunca un user_id).
  async function authorizeTargetCoach(client, coachId, gymId, check) {
    const membership = await client.from('gym_memberships').select('id,user_id,gym_id,roles,active').eq('user_id', coachId).eq('gym_id', gymId).eq('active', true);
    check();
    if (membership.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const row = membership.data?.[0];
    if (!row || !COACH_CAPABLE_ROLES.some(r => row.roles?.includes(r))) fail('INVALID_COACH', 422);
    return row.id;
  }

  async function readMembershipRow(client, gymId, userId, check) {
    const r = await client.from('gym_memberships').select('id,roles,active,revision').eq('gym_id', gymId).eq('user_id', userId);
    check();
    if (r.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    return r.data?.[0] ?? null;
  }

  // `clients` es la tabla que `pilot_set_membership` crea automáticamente
  // al activar el rol CLIENT. Se lee (nunca se escribe) para resolver su id
  // a partir de (gym_id, membership_id) — necesario SOLO para poder
  // consultar `coach_clients` antes de escribir (ver nota de "Relaciones"
  // al inicio del archivo). La propia escritura de pilot_set_coach_client
  // sigue usando el id de gym_memberships, no el de `clients`.
  async function readClientRecordByMembership(client, gymId, membershipId, check) {
    const r = await client.from('clients').select('id').eq('gym_id', gymId).eq('membership_id', membershipId);
    check();
    if (r.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    return r.data?.[0] ?? null;
  }

  // Filtra por `client_id` (la fila de `clients`), NUNCA por una columna
  // `client_membership_id` — esa columna no existe en `coach_clients`.
  async function readCoachClientRow(client, gymId, coachMembershipId, clientRecordId, check) {
    const r = await client.from('coach_clients').select('id,revision').eq('gym_id', gymId).eq('coach_membership_id', coachMembershipId).eq('client_id', clientRecordId);
    check();
    if (r.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    return r.data?.[0] ?? null;
  }

  function mapRpcError(rpcError) {
    const code = rpcError?.code;
    if (code === '40001') return new ProvisioningError('REVISION_CONFLICT', 409);
    if (code === '23503') return new ProvisioningError('RELATED_RECORD_NOT_FOUND', 404);
    const status = typeof code === 'string' && Object.hasOwn(PG_STATUS, code) ? PG_STATUS[code] : undefined;
    return status ? new ProvisioningError(code, status) : new ProvisioningError('PROVISIONING_RESULT_UNKNOWN', 503);
  }

  // Lee la revisión actual, intenta escribir con ella, y si la RPC responde
  // REVISION_CONFLICT (40001) vuelve a leer y reintenta con la revisión
  // fresca — acotado, para no reintentar indefinidamente ni duplicar la
  // operación si el conflicto persiste por otra razón.
  async function withRevisionRetry(read, write, check, maxAttempts = 4) {
    let row = await read();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      check();
      try {
        return await write(row?.revision ?? 0);
      } catch (e) {
        if (!(e instanceof ProvisioningError) || e.code !== 'REVISION_CONFLICT' || attempt === maxAttempts) throw e;
        row = await read();
      }
    }
  }

  // Dos capacidades SEPARADAS y opcionales que tocan service_role, ambas a
  // través de la API pública/documentada de Supabase, nunca con una RPC
  // propia inventada. Si no están configuradas, el comportamiento es
  // USER_NOT_FOUND directo (nunca se intenta crear nada) — opt-in explícito.
  async function resolveOrCreateAuthUser(email, name, check) {
    if (findUserByEmail) {
      const found = await findUserByEmail(email);
      check();
      if (found) return { id: found.id, createdUser: false };
    }
    if (!createAdminInvite) fail('USER_NOT_FOUND', 404);
    let created;
    try { created = await createAdminInvite(email, { name }); }
    catch (e) { throw e instanceof ProvisioningError ? e : new ProvisioningError('ADMIN_INVITE_FAILED', 502); }
    check();
    if (!created || typeof created.id !== 'string' || !UUID.test(created.id)) fail('ADMIN_INVITE_FAILED', 502);
    return { id: created.id, createdUser: true };
  }

  // Asegura la membresía CLIENT activa del usuario en el gimnasio dado —
  // idempotente, con reintento de revisión. pilot_set_membership crea el
  // registro en `clients` por su cuenta: esta función nunca escribe ahí.
  // Si la RPC falla por "registro relacionado no encontrado" (23503) —
  // típicamente porque `profiles.id` del usuario todavía no existe — NO se
  // reintenta aquí con esperas (ver nota de "Profiles" al inicio del
  // archivo): el error se deja subir tal cual para que addClient() lo
  // traduzca en un resultado PENDING_PROFILE, nunca en un bucle.
  async function setMembership(client, { gymId, userId }, check) {
    await withRevisionRetry(
      () => readMembershipRow(client, gymId, userId, check),
      async expectedRevision => {
        const call = await client.rpc('pilot_set_membership', { p_gym_id: gymId, p_user_id: userId, p_roles: ['CLIENT'], p_active: true, p_expected_revision: expectedRevision });
        check();
        if (call.error) throw mapRpcError(call.error);
        return call;
      },
      check,
    );
    const membership = await readMembershipRow(client, gymId, userId, check);
    // No basta con que exista una fila: debe reflejar lo que acabamos de
    // pedir. Si no, algo más (otra solicitud concurrente, un error parcial)
    // dejó el estado en algo distinto de lo esperado.
    if (!membership || !membership.roles?.includes('CLIENT') || !membership.active) fail('PROVISIONING_RESULT_UNKNOWN', 503);
    return { membershipId: membership.id };
  }

  // Vincula coach y cliente. p_client_membership_id es el id en
  // gym_memberships del cliente (NUNCA el de `clients`) — pero para
  // CONSULTAR si ya existe una asignación (y su revisión real) hay que
  // resolver primero `clients.id` vía (gym_id, membership_id) y filtrar
  // `coach_clients` por su columna `client_id`. Si esa fila en `clients`
  // todavía no existe, es la misma situación de "perfil no listo todavía"
  // que setMembership — se deja subir como RELATED_RECORD_NOT_FOUND para
  // que addClient() la traduzca en PENDING_PROFILE, nunca con reintentos.
  async function setCoachClient(client, { gymId, coachMembershipId, clientMembershipId }, check) {
    const clientRecord = await readClientRecordByMembership(client, gymId, clientMembershipId, check);
    if (!clientRecord) fail('RELATED_RECORD_NOT_FOUND', 404);
    return withRevisionRetry(
      () => readCoachClientRow(client, gymId, coachMembershipId, clientRecord.id, check),
      async expectedRevision => {
        const call = await client.rpc('pilot_set_coach_client', { p_gym_id: gymId, p_coach_membership_id: coachMembershipId, p_client_membership_id: clientMembershipId, p_active: true, p_expected_revision: expectedRevision });
        check();
        if (call.error) throw mapRpcError(call.error);
        return call;
      },
      check,
    );
  }

  // Guarda (upsert por gym_id+user_id, nunca duplica) la solicitud de
  // activación pendiente que `pilot_resume_pending_activation()` consumirá
  // automáticamente en el primer login del cliente. Deliberadamente NUNCA
  // lanza: si la tabla propuesta todavía no existe en Supabase real (la
  // migración no se aplicó), PENDING_PROFILE sigue siendo el resultado —
  // solo se pierde el beneficio de la reanudación automática, nunca se
  // rompe el alta ni se simula una infraestructura que no está ahí.
  async function savePendingActivation(client, { gymId, userId, coachMembershipId, createdBy }, check) {
    try {
      const result = await client.from('pilot_pending_activations').upsert(
        { gym_id: gymId, user_id: userId, coach_membership_id: coachMembershipId, created_by: createdBy, status: 'pending' },
        { onConflict: 'gym_id,user_id' },
      );
      check();
      return !result?.error;
    } catch { return false; }
  }

  return {
    // Da de alta (o reutiliza) a un cliente dentro de un gimnasio concreto.
    // 1) autoriza al llamador y al coach destino EN ESE gimnasio;
    // 2) resuelve el id Auth real del correo (existente o recién creado);
    // 3) asegura la membresía CLIENT (pilot_set_membership crea `clients`);
    // 4) vincula coach-cliente por IDs de membresía (pilot_set_coach_client).
    // Repetir la misma solicitud no duplica nada: ambos pasos 3 y 4 son
    // upserts idempotentes por (gym_id, user_id) / (gym_id, coach, cliente).
    //
    // Si el paso 3 o 4 falla porque `profiles.id` del usuario todavía no
    // existe (ver "Profiles" al inicio del archivo), esto NO es un error:
    // se reporta como PENDING_PROFILE. La invitación (si correspondía) ya
    // se envió; repetir esta misma llamada después de que esa persona
    // inicie sesión por primera vez retoma y completa membresía/asignación
    // sin reenviar ninguna invitación (resolveOrCreateAuthUser la encuentra
    // vía listUsers en ese segundo intento).
    async addClient({ token, command, signal }) {
      const input = validateAddClientCommand(command);
      return run(token, signal, async ({ client, actor, check }) => {
        rateLimiter(actor);
        await authorizeCaller(client, actor, input.gymId, check);
        check();
        const coachMembershipId = await authorizeTargetCoach(client, input.coachId, input.gymId, check);
        check();

        const { id: userId, createdUser } = await resolveOrCreateAuthUser(input.email, input.name, check);
        check();

        let membership;
        try {
          membership = await setMembership(client, { gymId: input.gymId, userId }, check);
          check();
          await setCoachClient(client, { gymId: input.gymId, coachMembershipId, clientMembershipId: membership.membershipId }, check);
        } catch (e) {
          if (e instanceof ProvisioningError && e.code === 'RELATED_RECORD_NOT_FOUND') {
            const autoResumable = await savePendingActivation(client, { gymId: input.gymId, userId, coachMembershipId, createdBy: actor }, check);
            return { status: 'PENDING_PROFILE', email: input.email, coachId: input.coachId, gymId: input.gymId, createdUser, invite: createdUser, autoResumable };
          }
          throw e;
        }

        return { status: 'PROVISIONED', email: input.email, coachId: input.coachId, gymId: input.gymId, createdUser, invite: createdUser };
      });
    },

    // Reenvía la invitación de una cuenta que aún no inició sesión. Ya no
    // depende de pilot_set_membership (esa RPC no tiene concepto de
    // "reenviar") — vuelve a invocar la misma capacidad de Admin API usada
    // para crear cuentas nuevas. Requiere capacidad admin configurada.
    async resendInvite({ token, command, signal }) {
      const input = validateResendCommand(command);
      return run(token, signal, async ({ client, actor, check }) => {
        rateLimiter(actor);
        await authorizeCaller(client, actor, input.gymId, check);
        check();
        if (!createAdminInvite) fail('ADMIN_INVITE_UNAVAILABLE', 503);
        try { await createAdminInvite(input.email, {}); }
        catch (e) { throw e instanceof ProvisioningError ? e : new ProvisioningError('ADMIN_INVITE_FAILED', 502); }
        check();
        return { status: 'INVITE_RESENT', email: input.email };
      });
    },

    // Consulta de solo lectura del estado de activación dentro de un
    // gimnasio — no requiere rate limit tan estricto al no escribir nada.
    async clientStatus({ token, email, gymId, signal }) {
      const input = validateStatusQuery(email, gymId);
      return run(token, signal, async ({ client, actor, check }) => {
        await authorizeCaller(client, actor, input.gymId, check);
        check();
        const memberships = await client.from('gym_memberships').select('user_id,roles,active').eq('gym_id', input.gymId).eq('active', true);
        check();
        if (memberships.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
        return { email: input.email, gymId: input.gymId, knownMemberships: memberships.data?.length ?? 0 };
      });
    },
  };
}

module.exports = { createProvisioningService, createProvisioningInfrastructure, ProvisioningError };

// Busca una cuenta Auth existente por correo. La Admin API instalada aquí no
// expone filtro por correo — solo paginación — así que se recorren hasta
// `maxPages` páginas de `perPage` usuarios. Ver punto 3 del contrato no
// verificado al inicio del archivo.
async function findUserByEmailViaAdmin(adminClient, email, { perPage = 200, maxPages = 5 } = {}) {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= maxPages; page++) {
    const result = await adminClient.auth.admin.listUsers({ page, perPage });
    if (result.error) throw new ProvisioningError('ADMIN_LOOKUP_FAILED', 502);
    const users = result.data?.users ?? [];
    const match = users.find(u => typeof u?.email === 'string' && u.email.toLowerCase() === target);
    if (match) return { id: match.id };
    if (users.length < perPage) return null;
  }
  return null;
}

// Infraestructura real: igual patrón que createManualMacrosInfrastructure —
// reenvía el token del llamador con la clave PUBLICABLE (nunca service_role)
// para las RPC de dominio, y limita el fetch a las rutas exactas necesarias.
function createProvisioningInfrastructure({ env = process.env, fetchImpl = globalThis.fetch, createClient = require('@supabase/supabase-js').createClient } = {}) {
  const { loadPilotConfig } = require('./pilot-config.cjs');
  const config = loadPilotConfig(env);

  function createSession(token, signal) {
    if (!config.publicKey || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const client = createClient(config.supabaseUrl, config.publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
      db: { schema: 'public', retry: false },
      global: {
        headers: { Authorization: 'Bearer ' + token },
        fetch: async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
          const method = (init.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase();
          const allowed = ['/auth/v1/user', '/rest/v1/gym_memberships', '/rest/v1/coach_clients', '/rest/v1/clients', '/rest/v1/pilot_pending_activations', '/rest/v1/rpc/pilot_set_membership', '/rest/v1/rpc/pilot_set_coach_client'];
          const rpc = url.pathname.startsWith('/rest/v1/rpc/');
          // pilot_pending_activations es la ÚNICA tabla que este cliente
          // puede ESCRIBIR (upsert de la solicitud pendiente) — el resto
          // de las tablas siguen siendo de solo lectura desde aquí.
          const writableTable = url.pathname === '/rest/v1/pilot_pending_activations';
          const methodOk = rpc ? method === 'POST' : writableTable ? ['GET', 'HEAD', 'POST', 'PATCH'].includes(method) : ['GET', 'HEAD'].includes(method);
          if (signal.aborted || url.origin !== config.supabaseUrl || url.username || url.password || !allowed.includes(url.pathname) || !methodOk) {
            fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
          }
          return fetchImpl(input, { ...init, redirect: 'error', signal: init.signal ? AbortSignal.any([signal, init.signal, AbortSignal.timeout(10000)]) : AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        },
      },
    });
    return { auth: { getUser: () => client.auth.getUser(token) }, from: table => client.from(table), rpc: (name, args) => client.rpc(name, args) };
  }

  // Capacidad admin SEPARADA y opcional: solo se construye si
  // PILOT_SUPABASE_SERVICE_KEY está presente en el entorno del servidor. Si
  // no está, el comportamiento es USER_NOT_FOUND directo — opt-in explícito.
  // Un único cliente service_role, compartido SOLO dentro de esta función,
  // cuyo fetch permite exactamente dos rutas: invitar y listar usuarios.
  const admin = (() => {
    const serviceKey = env.PILOT_SUPABASE_SERVICE_KEY;
    if (!serviceKey) return { findUserByEmail: null, createAdminInvite: null };
    // Nunca aceptar por accidente la clave publicable en esta variable.
    if (!/^(eyJ[A-Za-z0-9._-]{20,}|sb_secret_[A-Za-z0-9_-]{20,})$/.test(serviceKey)) {
      throw new Error('PILOT_SUPABASE_SERVICE_KEY_REJECTED');
    }
    const adminClient = createClient(config.supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false },
      global: {
        // Allowlist de dos rutas exactas — este cliente nunca se expone
        // fuera de este bloque ni se reutiliza para leer tablas o llamar RPC.
        fetch: async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
          const method = (init.method ?? (typeof input === 'object' ? input.method : undefined) ?? 'GET').toUpperCase();
          const allowed = (url.pathname === '/auth/v1/invite' && method === 'POST') || (url.pathname === '/auth/v1/admin/users' && method === 'GET');
          if (url.origin !== config.supabaseUrl || url.username || url.password || !allowed) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
          return fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
        },
      },
    });
    return {
      findUserByEmail: email => findUserByEmailViaAdmin(adminClient, email),
      createAdminInvite: async (email, metadata) => {
        const result = await adminClient.auth.admin.inviteUserByEmail(email, { data: metadata });
        if (result.error) {
          // No reenviar el mensaje del servidor; mapear solo códigos conocidos.
          const code = result.error.code;
          if (code === 'email_exists' || result.error.status === 422) throw new ProvisioningError('ADMIN_INVITE_EMAIL_EXISTS', 409);
          throw new ProvisioningError('ADMIN_INVITE_FAILED', 502);
        }
        const id = result.data?.user?.id;
        if (typeof id !== 'string') throw new ProvisioningError('ADMIN_INVITE_FAILED', 502);
        return { id };
      },
    };
  })();

  return createProvisioningService({ createSession, findUserByEmail: admin.findUserByEmail, createAdminInvite: admin.createAdminInvite });
}
