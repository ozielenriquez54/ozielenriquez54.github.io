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
// COACH_CAPABLE_ROLES (corregido: el destino de una asignación exige COACH
// LITERAL, confirmado contra el contrato real de `pilot_set_coach_client`
// en Supabase: `'COACH'::public.pilot_role = any(coach.roles)`). Una ronda
// anterior de esta sesión asumió, sin esa confirmación directa, que
// OWNER/ADMIN podían sustituir a COACH como destino — esa suposición era
// incorrecta y se revierte aquí. Las tres reglas, ahora separadas sin
// ambigüedad:
//   1. OWNER/ADMIN activos pueden EJECUTAR el alta (administrar).
//   2. El coach ASIGNADO debe tener el rol COACH activo en ese gimnasio —
//      ni OWNER ni ADMIN, por sí solos, son un destino válido.
//   3. Un OWNER/ADMIN que TAMBIÉN tiene COACH en su arreglo de roles (la
//      misma persona con dos roles) SÍ puede ser el destino — porque tiene
//      COACH, no por ser OWNER/ADMIN.
//
// Relaciones (corregido tras 2ª auditoría — la 1ª corrección fue
// incorrecta y se revierte aquí; vuelto a corregir tras la auditoría
// sobre el commit a201ed1, "alta directa bloqueada por RLS" — ver
// setCoachClient más abajo):
//   - `pilot_set_coach_client` recibe `p_client_membership_id` = el id en
//     `gym_memberships` del cliente (NO el id de su fila en `clients`) —
//     la propia RPC resuelve `clients.id` internamente. setCoachClient()
//     pasa `clientMembershipId` tal cual a la RPC, SIN leer `clients` ni
//     `coach_clients` primero: esa lectura, con la sesión del propio
//     OWNER/ADMIN, depende de un permiso de lectura CLÍNICO (RLS sobre
//     `clients`) que la mayoría de los OWNER/ADMIN no tienen — solo el
//     propio cliente o su coach YA asignado. En vez de leer, se adivina
//     la revisión esperada con un contador local (0, 1, 2, ...) y se deja
//     que la propia RPC confirme o rechace cada intento (40001 si no
//     coincide) — nunca se construye una columna `client_membership_id`
//     en `coach_clients` (no existe ahí; solo existía en la
//     implementación anterior, que confundía el id de escritura con el
//     de lectura).
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
//  5) (Confirmado como riesgo real por una auditoría de Codex sobre el
//     commit a201ed1, "alta directa bloqueada por RLS" — ya corregido,
//     ver setCoachClient): este punto predecía que RLS probablemente NO
//     deja a un OWNER/ADMIN leer `clients` de un usuario que no es su
//     cliente asignado (casi con certeza solo el propio cliente o su
//     coach YA asignado). Por eso setCoachClient() ya NUNCA lee `clients`
//     ni `coach_clients` — ver el comentario de esa función. Sigue sin
//     poder confirmarse contra el esquema real qué exactamente permite esa
//     RLS (no hay acceso a Supabase real en esta sesión), pero ya no
//     importa para este flujo: no depende de ese permiso en absoluto.
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
// Quién puede ser el COACH destino de una asignación — COACH LITERAL,
// confirmado contra el contrato real de `pilot_set_coach_client` en
// Supabase (`'COACH'::public.pilot_role = any(coach.roles)`). OWNER/ADMIN
// NUNCA sustituyen a COACH aquí; si la misma persona también tiene COACH
// en su arreglo de roles, pasa por tenerlo, no por ser OWNER/ADMIN.
const COACH_CAPABLE_ROLES = ['COACH'];

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
  // gimnasio con el rol COACH literal (nunca OWNER/ADMIN como sustituto —
  // ver COACH_CAPABLE_ROLES), y devuelve el id real de esa membresía (lo
  // exige pilot_set_coach_client como p_coach_membership_id — nunca un
  // user_id).
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

  function mapRpcError(rpcError) {
    const code = rpcError?.code;
    if (code === '40001') return new ProvisioningError('REVISION_CONFLICT', 409);
    // P2 (auditoría sobre el commit 206d95e, "error 23503 clasificado
    // incorrectamente"): aquí YA NO se traduce 23503 a un código genérico.
    // Antes CUALQUIER violación de llave foránea, viniera de la RPC que
    // fuera, se interpretaba igual ("registro relacionado no encontrado")
    // y addClient() lo convertía SIEMPRE en PENDING_PROFILE — incluso
    // cuando la membresía y el perfil ya existían y lo que de verdad
    // falló fue la escritura de la asignación coach-cliente (un fallo de
    // integridad real, no "todavía no existe"). Cada llamada que puede
    // recibir 23503 (ver setMembership y setCoachClient más abajo) ahora
    // decide su propio significado ANTES de llegar aquí, según en qué
    // punto del flujo ocurre — nunca con un mapeo único por código.
    if (code === '22023' && rpcError?.message === 'INVALID_COACH_RELATIONSHIP') return new ProvisioningError('INVALID_COACH_RELATIONSHIP', 422);
    if (code === '22023' && rpcError?.message === 'INVALID_CLIENT_RELATIONSHIP') return new ProvisioningError('INVALID_CLIENT_RELATIONSHIP', 422);
    const status = typeof code === 'string' && Object.hasOwn(PG_STATUS, code) ? PG_STATUS[code] : undefined;
    return status ? new ProvisioningError(code, status) : new ProvisioningError('PROVISIONING_RESULT_UNKNOWN', 503);
  }

  // Lee la revisión actual, intenta escribir con ella, y si la RPC responde
  // REVISION_CONFLICT (40001) vuelve a leer y reintenta con la revisión
  // fresca — acotado, para no reintentar indefinidamente ni duplicar la
  // operación si el conflicto persiste por otra razón.
  // `write` recibe la FILA completa leída (o null si no existía), no solo
  // la revisión — setMembership la necesita para decidir qué roles
  // conservar (ver P1 "sobrescritura de roles" más abajo) sin una segunda
  // lectura fuera de este ciclo de reintento.
  async function withRevisionRetry(read, write, check, maxAttempts = 4) {
    let row = await read();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      check();
      try {
        return await write(row);
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
  // Si la RPC falla por violación de llave foránea (23503) — típicamente
  // porque `profiles.id` del usuario todavía no existe — NO se reintenta
  // aquí con esperas (ver nota de "Profiles" al inicio del archivo): se
  // lanza explícitamente como PROFILE_NOT_FOUND (nunca el código genérico
  // RELATED_RECORD_NOT_FOUND que existía antes de la auditoría sobre el
  // commit 206d95e) para que addClient() lo traduzca en un resultado
  // PENDING_PROFILE, nunca en un bucle. Esta es la ÚNICA llamada de este
  // archivo donde un 23503 significa genuinamente "todavía no existe": es
  // la PRIMERA escritura del flujo, antes de que exista cualquier
  // membresía o perfil confirmados — ver setCoachClient más abajo, donde
  // un 23503 en ESE punto significa algo completamente distinto.
  // Roles que esta capa NUNCA debe pisar ni reactivar como efecto
  // secundario de "agregar cliente" (ver el bloqueo explícito más abajo).
  const PRIVILEGED_ROLES = ['OWNER', 'ADMIN', 'COACH'];

  async function setMembership(client, { gymId, userId }, check) {
    await withRevisionRetry(
      () => readMembershipRow(client, gymId, userId, check),
      async row => {
        const expectedRevision = row?.revision ?? 0;
        const existingRoles = row?.roles ?? [];
        // P1 (auditoría sobre el commit 26fd7fc, "sobrescritura de roles"):
        // la versión anterior llamaba siempre con p_roles=['CLIENT'], que
        // REEMPLAZA por completo el arreglo de roles de la RPC real — si el
        // correo invitado ya tenía una membresía OWNER/ADMIN/COACH en ESTE
        // gimnasio, quedaba reducido a solo CLIENT, perdiendo ese rol.
        // Corregido: se CONSERVA el arreglo existente y solo se agrega
        // CLIENT si faltaba (nunca se reemplaza a ciegas — mismo criterio
        // que la protección del último OWNER en
        // pilot_resume_pending_activation(), PENDING-ACTIVATION-MIGRATION.sql).
        //
        // Además, si esa membresía YA existe, está INACTIVA (revocada) y
        // conserva un rol privilegiado, esta operación administrativa de
        // "agregar cliente" NUNCA la reactiva como efecto secundario — eso
        // sería restaurar privilegios sin una decisión explícita de
        // reactivarlos (se rechaza, no se asume); quien quiera reactivar a
        // esa persona debe hacerlo con una acción administrativa dedicada,
        // no agregándola por accidente como "nuevo cliente".
        if (row && !row.active && PRIVILEGED_ROLES.some(r => existingRoles.includes(r))) {
          fail('BLOCKED_PRIVILEGED_ROLE', 409);
        }
        const roles = existingRoles.includes('CLIENT') ? existingRoles : [...existingRoles, 'CLIENT'];
        const call = await client.rpc('pilot_set_membership', { p_gym_id: gymId, p_user_id: userId, p_roles: roles, p_active: true, p_expected_revision: expectedRevision });
        check();
        if (call.error) {
          if (call.error.code === '23503') fail('PROFILE_NOT_FOUND', 404);
          throw mapRpcError(call.error);
        }
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
  // gym_memberships del cliente (NUNCA el de `clients`) — la propia RPC
  // resuelve `clients.id` internamente a partir de ese id de membresía.
  //
  // P1 (auditoría sobre el commit a201ed1, "alta directa bloqueada por
  // RLS"): la versión anterior LEÍA `clients` (datos clínicos) con la
  // sesión del propio OWNER/ADMIN para conocer la revisión actual de
  // `coach_clients` antes de escribir — bloqueado por RLS para cualquier
  // OWNER/ADMIN que no fuera ya el coach asignado. Una corrección
  // intermedia "adivinaba" la revisión con un contador local (0..7) en
  // vez de leerla — Codex señaló correctamente (auditoría sobre el commit
  // e6554ff) que esto es frágil: nunca sabe la revisión REAL, puede
  // agotar los intentos sin motivo, y no distingue una revocación
  // concurrente de un simple desajuste.
  //
  // Corregido con una RPC de SOLO LECTURA administrativa dedicada,
  // `pilot_get_coach_client_state` (ver COACH-CLIENT-STATE-MIGRATION.sql):
  // devuelve exactamente id/activo/revisión de `coach_clients` (nunca
  // datos clínicos), restringida a OWNER/ADMIN activo de ESE gimnasio.
  // Con la revisión EXACTA ya conocida:
  //   - si no existe ninguna relación todavía, se escribe con revisión 0
  //     (primera vez) — sin adivinar nada.
  //   - si existe una relación INACTIVA (revocada), esta función NUNCA la
  //     reactiva sola: "agregar cliente" no es una decisión administrativa
  //     explícita de reactivar algo que alguien revocó a propósito (mismo
  //     criterio que BLOCKED_PRIVILEGED_ROLE en setMembership).
  //   - si la escritura responde REVISION_CONFLICT (40001) — alguien
  //     cambió la fila entre esta lectura y esta escritura (p. ej. una
  //     revocación concurrente) — se reporta tal cual, SIN reintentar
  //     automáticamente con otra revisión: nunca se arriesga a revertir
  //     en silencio ese cambio concurrente.
  //
  // P2 (auditoría sobre el commit 206d95e, "cliente inexistente confundido
  // con perfil pendiente"): esta función se llama SIEMPRE después de que
  // setMembership() ya confirmó (postcondición propia, más arriba) que la
  // membresía existe, está activa y tiene el rol CLIENT — es decir, el
  // PERFIL de esa persona ya existía cuando pilot_set_membership corrió.
  // `pilot_get_coach_client_state` ahora distingue, de forma explícita y
  // verificada dentro de la propia RPC (ver COACH-CLIENT-STATE-MIGRATION.sql),
  // tres estados en vez de dos:
  //   - out_profile_exists=false: el perfil NO existe (caso defensivo —
  //     no debería ocurrir dado lo anterior, pero si ocurre es genuinamente
  //     "pendiente", nunca un error de integridad).
  //   - out_profile_exists=true, out_client_exists=false: el perfil Y la
  //     membresía YA existen, pero `clients` nunca se creó para esa
  //     membresía — esto es una INCONSISTENCIA ADMINISTRATIVA real (algo
  //     en el alta nunca terminó de crear ese registro), NUNCA "perfil
  //     pendiente": nada en el flujo normal vuelve a crear esa fila por sí
  //     solo, así que addClient() NUNCA debe programar aquí una
  //     reanudación automática (eso solo ocultaría el problema, repitiendo
  //     el mismo fallo cada vez que se reintente).
  //   - out_profile_exists=true, out_client_exists=true: estado normal —
  //     continúa igual que antes (coach_client existente o primera
  //     asignación).
  async function setCoachClient(client, { gymId, coachMembershipId, clientMembershipId }, check) {
    const state = await client.rpc('pilot_get_coach_client_state', { p_gym_id: gymId, p_coach_membership_id: coachMembershipId, p_client_membership_id: clientMembershipId });
    check();
    if (state.error) throw mapRpcError(state.error);
    const row = Array.isArray(state.data) ? state.data[0] : state.data;
    if (!row) fail('PROVISIONING_RESULT_UNKNOWN', 503);
    if (!row.out_profile_exists) fail('PROFILE_NOT_FOUND', 404);
    if (!row.out_client_exists) fail('CLIENT_RECORD_MISSING', 409);
    if (row.out_coach_client_id !== null && row.out_active === false) {
      fail('BLOCKED_INACTIVE_RELATIONSHIP', 409);
    }
    const expectedRevision = row.out_coach_client_id !== null ? row.out_revision : 0;
    const call = await client.rpc('pilot_set_coach_client', { p_gym_id: gymId, p_coach_membership_id: coachMembershipId, p_client_membership_id: clientMembershipId, p_active: true, p_expected_revision: expectedRevision });
    check();
    if (call.error) {
      // Un 23503 AQUÍ nunca significa "todavía no existe": el estado leído
      // arriba ya confirmó que `clients` existía en ese instante — si la
      // escritura falla igual por llave foránea, es una carrera real (la
      // fila desapareció entre la lectura y la escritura) o un error de
      // integridad genuino, nunca un perfil pendiente. Se reporta explícito,
      // SIN guardar ninguna activación pendiente (ver addClient más abajo).
      if (call.error.code === '23503') fail('CLIENT_RECORD_MISSING', 409);
      throw mapRpcError(call.error);
    }
    return call;
  }

  // Confirma que ESE correo (ya resuelto a un id Auth real) tiene una
  // solicitud de activación PENDIENTE y VIGENTE en ESE gimnasio exacto —
  // P1 (auditoría sobre el commit 26fd7fc, "invitaciones sin autorización
  // suficiente"; endurecido tras la auditoría sobre el commit 60afc33,
  // "reenvío de invitaciones inválidas"): antes, resendInvite solo exigía
  // que el LLAMADOR fuera OWNER/ADMIN de `gymId`, sin comprobar que el
  // correo a reenviar tuviera ninguna relación con ese gimnasio — cualquier
  // OWNER/ADMIN de CUALQUIER gimnasio podía usar este endpoint para
  // invitar/reenviar a un correo arbitrario vía la Admin API de Supabase.
  // La primera corrección exigió `status='pending'` en ESE gym_id/user_id,
  // pero no revalidaba si esa autorización SEGUÍA siendo válida — una
  // solicitud puede quedar marcada `pending` en la tabla mientras su
  // autorizador original fue revocado o su coach destino ya no es COACH
  // activo ahí (exactamente las mismas comprobaciones que
  // pilot_resume_pending_activation() hace al completarla; resendInvite
  // debe exigir lo mismo ANTES de reenviar, no solo al completar). Si
  // `pilot_pending_activations` no existe todavía (migración propuesta no
  // aplicada) o cualquiera de estas comprobaciones falla, se falla cerrado:
  // nunca se asume una autorización que no se puede comprobar en vivo.
  async function authorizePendingActivation(client, gymId, userId, check) {
    const pending = await client.from('pilot_pending_activations').select('id,status,created_by,coach_membership_id').eq('gym_id', gymId).eq('user_id', userId).eq('status', 'pending');
    check();
    if (pending.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const row = pending.data?.[0];
    if (!row) fail('NO_PENDING_ACTIVATION', 422);

    // El administrador que autorizó originalmente debe seguir siendo
    // OWNER/ADMIN activo EN ESE gimnasio — si fue revocado después, la
    // solicitud sigue diciendo "pending" pero ya no tiene una autorización
    // vigente detrás.
    const authorizer = await client.from('gym_memberships').select('user_id,gym_id,roles,active').eq('user_id', row.created_by).eq('gym_id', gymId).eq('active', true);
    check();
    if (authorizer.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const authorizerRoles = authorizer.data?.[0]?.roles ?? [];
    if (!PROVISIONER_ROLES.some(r => authorizerRoles.includes(r))) fail('NO_PENDING_ACTIVATION', 422);

    // El coach destino debe seguir siendo COACH literal activo EN ESE
    // MISMO gimnasio (mismo criterio que authorizeTargetCoach/
    // COACH_CAPABLE_ROLES) — nunca OWNER/ADMIN como sustituto, y nunca un
    // coach de otro gimnasio.
    const coach = await client.from('gym_memberships').select('id,gym_id,roles,active').eq('id', row.coach_membership_id).eq('gym_id', gymId).eq('active', true);
    check();
    if (coach.error) fail('PROVISIONING_SERVICE_UNAVAILABLE', 503);
    const coachRoles = coach.data?.[0]?.roles ?? [];
    if (!COACH_CAPABLE_ROLES.some(r => coachRoles.includes(r))) fail('NO_PENDING_ACTIVATION', 422);
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
    //
    // P2 (auditoría sobre el commit 206d95e, "error 23503 clasificado
    // incorrectamente"): SOLO PROFILE_NOT_FOUND (perfil genuinamente
    // ausente) se convierte en PENDING_PROFILE con una activación pendiente
    // guardada. Cualquier otro fallo del paso 3/4 — en particular
    // CLIENT_RECORD_MISSING, cuando la membresía y el perfil YA existían
    // pero la asignación coach-cliente no pudo completarse por una
    // inconsistencia real — se propaga tal cual, como error explícito, SIN
    // guardar ninguna activación pendiente: guardarla implicaría que algo
    // la resolverá sola en un futuro login, y nada en el flujo normal
    // vuelve a crear `clients` por sí mismo, así que "reintentarlo después"
    // solo repetiría el mismo fallo en silencio.
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
          if (e instanceof ProvisioningError && e.code === 'PROFILE_NOT_FOUND') {
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
    // para crear cuentas nuevas. Requiere capacidad admin configurada Y una
    // solicitud de activación pendiente y vigente para ESE correo en ESE
    // gimnasio (ver authorizePendingActivation): nunca reenvía/invita un
    // correo sin relación verificable con el gimnasio del llamador.
    async resendInvite({ token, command, signal }) {
      const input = validateResendCommand(command);
      return run(token, signal, async ({ client, actor, check }) => {
        rateLimiter(actor);
        await authorizeCaller(client, actor, input.gymId, check);
        check();
        if (!createAdminInvite || !findUserByEmail) fail('ADMIN_INVITE_UNAVAILABLE', 503);
        const existing = await findUserByEmail(input.email);
        check();
        if (!existing) fail('NO_PENDING_ACTIVATION', 422);
        await authorizePendingActivation(client, input.gymId, existing.id, check);
        check();
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

  // P1 (auditoría sobre el commit 26fd7fc, "callback de invitación"): la
  // versión anterior llamaba a `inviteUserByEmail` sin `redirectTo`, así que
  // el enlace de invitación dependía del "Site URL"/callback GLOBAL
  // configurado en el panel de Supabase — nunca validado por este servidor,
  // y potencialmente distinto por entorno (preproducción vs. producción).
  // Se construye aquí, SIEMPRE, a partir de `config.publicOrigin` — la
  // ÚNICA fuente posible: una variable de entorno del SERVIDOR
  // (PILOT_PUBLIC_ORIGIN), ya validada estrictamente por loadPilotConfig
  // (https, un host exacto, sin path/query/hash) — más la ruta fija real
  // `/auth/callback.html` (la misma que pilot-auth.js exige del lado del
  // cliente). Ni `email` ni `metadata` (los únicos datos que llegan desde
  // el navegador a esta capa) participan en absoluto en esta URL.
  function inviteRedirectTo() {
    if (!config.publicOrigin) fail('PILOT_PUBLIC_ORIGIN_REQUIRED', 503);
    const url = new URL('/auth/callback.html', config.publicOrigin);
    // Defensa en profundidad: revalida el resultado final, sin asumir que
    // la validación de loadPilotConfig en otro archivo sigue vigente para
    // siempre ni que new URL(...) no pudo introducir nada inesperado.
    if (url.protocol !== 'https:' || url.origin !== config.publicOrigin || url.pathname !== '/auth/callback.html' || url.search || url.hash) {
      fail('PILOT_PUBLIC_ORIGIN_REQUIRED', 503);
    }
    return url.toString();
  }

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
          // P1 (auditoría sobre el commit a201ed1/e6554ff): `clients` y
          // `coach_clients` ya NO se leen directamente desde esta sesión
          // (datos clínicos) — toda esa resolución pasa por
          // pilot_get_coach_client_state (lectura administrativa
          // restringida, nunca clínica) y pilot_set_coach_client
          // (escritura ya existente). Se retiran del allowlist en vez de
          // dejarlas "por si acaso": una ruta que el código nunca usa no
          // debe seguir permitida.
          const allowed = ['/auth/v1/user', '/rest/v1/gym_memberships', '/rest/v1/pilot_pending_activations', '/rest/v1/rpc/pilot_set_membership', '/rest/v1/rpc/pilot_set_coach_client', '/rest/v1/rpc/pilot_get_coach_client_state'];
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
        const result = await adminClient.auth.admin.inviteUserByEmail(email, { data: metadata, redirectTo: inviteRedirectTo() });
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
