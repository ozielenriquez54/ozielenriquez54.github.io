'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const fs = require('node:fs');
const { createProvisioningService, ProvisioningError } = require('../server/pilot-admin-provisioning-service.cjs');
const { createPilotServer } = require('../server/pilot-http.cjs');

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
// OWNER/ADMIN son los únicos roles autorizados a EJECUTAR el alta (ver
// PROVISIONER_ROLES en el servicio). COACH solo puede ser el DESTINO de la
// asignación — nunca el llamador autorizado.
const OWNER = uuid(1), COACH = uuid(2), NON_COACH = uuid(3), ADMIN_ACTOR = uuid(4), OTHER_OWNER = uuid(5), OTHER_COACH = uuid(6);
const GYM = uuid(100), OTHER_GYM = uuid(101);
const ANA_ID = uuid(200), OZIEL_ID = uuid(201);
const OZIEL_EMAIL = 'oziel.enriquez@complextraining.mx';

// ---------------------------------------------------------------------------
// Base de datos simulada en memoria: nunca toca la red. Modela el
// comportamiento confirmado de las dos RPC reales (gym_id real, concurrencia
// optimista con `revision`) y la relación real (2ª corrección, revierte la
// 1ª): `pilot_set_coach_client` recibe por escritura el id en
// `gym_memberships` del cliente, pero `coach_clients` se consulta por su
// columna `client_id`, que referencia `clients.id` — y `clients.id` se
// resuelve por (gym_id, membership_id), nunca al revés. Los rangos de id
// (memberships 0-7/1000+, clients 8000+, coachClients 5000+) son
// deliberadamente distintos entre sí para que una prueba que confunda dos
// de estos ids falle de inmediato, no silenciosamente.
//
// `db.missingProfiles` modela que `profiles.id` de un usuario todavía no
// existe (invitación nunca aceptada, o cuenta recién creada): mientras su
// user_id esté en ese set, pilot_set_membership responde 23503 — nunca se
// asume un trigger ni un tiempo de espera. Los tests "aceptan" la
// invitación simulando el primer login con `db.missingProfiles.delete(id)`.
// Esto es un mock: no prueba que PostgreSQL/RLS/triggers reales se
// comporten así — ver el contrato no verificado en
// pilot-admin-provisioning-service.cjs.
// ---------------------------------------------------------------------------
function freshDb(extraMemberships = []) {
  return {
    memberships: [
      { id: uuid(1), gym_id: GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 },
      { id: uuid(2), gym_id: GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 },
      ...extraMemberships,
    ],
    coachClients: [],
    clients: [],
    missingProfiles: new Set(),
    pendingActivations: [], // modela pilot_pending_activations (propuesta, ver PENDING-ACTIVATION-MIGRATION.sql)
    lockedActivations: new Set(), // simula FOR UPDATE SKIP LOCKED para las pruebas de concurrencia
  };
}

// Simula pilot_resume_pending_activation(): autoservicio, solo actúa sobre
// la solicitud pendiente de ESTE userId, revalida en vivo que created_by
// sigue siendo OWNER/ADMIN activo y que el coach destino sigue siendo
// válido, y nunca aplica nada si otra "transacción" ya tiene la fila
// bloqueada (lockedActivations simula FOR UPDATE SKIP LOCKED).
function applyResumePendingActivation(db, userId) {
  const request = db.pendingActivations.find(r => r.user_id === userId && r.status === 'pending' && !db.lockedActivations.has(r.id));
  if (!request) return { data: null, error: null };
  db.lockedActivations.add(request.id);
  try {
    const authorizerStillValid = db.memberships.some(m => m.gym_id === request.gym_id && m.user_id === request.created_by && m.active && PROVISIONER_ROLES_FOR_TESTS.some(r => m.roles.includes(r)));
    // COACH literal, confirmado contra el contrato real de
    // pilot_set_coach_client ('COACH'::public.pilot_role = any(coach.roles))
    // — OWNER/ADMIN nunca sustituyen a COACH, ni aquí ni en el SQL real.
    const coachStillValid = db.memberships.some(m => m.id === request.coach_membership_id && m.gym_id === request.gym_id && m.active && m.roles.includes('COACH'));
    if (!authorizerStillValid || !coachStillValid) {
      request.status = 'cancelled';
      return { data: { status: 'cancelled', gym_id: request.gym_id, coach_membership_id: request.coach_membership_id }, error: null };
    }
    const existingMembership = db.memberships.find(m => m.gym_id === request.gym_id && m.user_id === userId);
    // P0 (Codex, auditoría sobre el commit 9462850, "restauración de
    // privilegios"): si la membresía propia ya existe, está INACTIVA
    // (revocada) y conserva OWNER/ADMIN (p. ej. roles=['ADMIN','CLIENT']),
    // nunca se reactiva sola por el solo hecho de reanudar — eso
    // restauraría privilegios administrativos sin ninguna decisión
    // administrativa explícita. Se bloquea antes de tocar la membresía.
    if (existingMembership && !existingMembership.active && PROVISIONER_ROLES_FOR_TESTS.some(r => existingMembership.roles.includes(r))) {
      request.status = 'blocked_privileged_role';
      return { data: { status: 'blocked_privileged_role', gym_id: request.gym_id, coach_membership_id: request.coach_membership_id }, error: null };
    }
    // Protección del último OWNER (corregido tras los fallos de Codex en
    // PG 17.11, ver PENDING-ACTIVATION-MIGRATION.sql): se AGREGA CLIENT al
    // arreglo de roles existente, nunca se reemplaza — si quien reanuda ya
    // tenía OWNER/ADMIN/COACH *activo*, ese rol no se pierde.
    const mergedRoles = existingMembership ? Array.from(new Set([...existingMembership.roles, 'CLIENT'])) : ['CLIENT'];
    applySetMembership(db, { p_gym_id: request.gym_id, p_user_id: userId, p_roles: mergedRoles, p_active: true, p_expected_revision: existingMembership?.revision ?? 0 });
    const membershipId = db.memberships.find(m => m.gym_id === request.gym_id && m.user_id === userId).id;
    applySetCoachClient(db, { p_gym_id: request.gym_id, p_coach_membership_id: request.coach_membership_id, p_client_membership_id: membershipId, p_active: true, p_expected_revision: 0 });
    request.status = 'completed';
    return { data: { status: 'completed', gym_id: request.gym_id, coach_membership_id: request.coach_membership_id }, error: null };
  } finally { db.lockedActivations.delete(request.id); }
}
const PROVISIONER_ROLES_FOR_TESTS = ['OWNER', 'ADMIN'];

function applySetMembership(db, { p_gym_id, p_user_id, p_roles, p_active, p_expected_revision }) {
  if (db.missingProfiles?.has(p_user_id)) {
    return { data: null, error: { code: '23503', message: 'profiles.id ausente (secreto interno)' } };
  }
  const row = db.memberships.find(m => m.gym_id === p_gym_id && m.user_id === p_user_id);
  const current = row ? row.revision : 0;
  if (p_expected_revision !== current) return { data: null, error: { code: '40001', message: 'revision conflict (secreto interno)' } };
  if (row) { row.roles = p_roles; row.active = p_active; row.revision = current + 1; }
  else db.memberships.push({ id: uuid(1000 + db.memberships.length), gym_id: p_gym_id, user_id: p_user_id, roles: p_roles, active: p_active, revision: 1 });
  // pilot_set_membership crea `clients` por su cuenta al activar CLIENT.
  // Su id y su `membership_id` (FK a gym_memberships.id) son columnas
  // DISTINTAS, a propósito, para que una confusión entre ambas falle ya.
  const membershipRow = db.memberships.find(m => m.gym_id === p_gym_id && m.user_id === p_user_id);
  if (p_roles.includes('CLIENT') && p_active && !db.clients.some(c => c.gym_id === p_gym_id && c.membership_id === membershipRow.id)) {
    db.clients.push({ id: uuid(8000 + db.clients.length), gym_id: p_gym_id, membership_id: membershipRow.id });
  }
  return { data: { ok: true }, error: null };
}

function applySetCoachClient(db, { p_gym_id, p_coach_membership_id, p_client_membership_id, p_active, p_expected_revision }) {
  const coach = db.memberships.find(m => m.id === p_coach_membership_id && m.gym_id === p_gym_id);
  // La RPC recibe el id de gym_memberships del cliente (p_client_membership_id)
  // y resuelve `clients` internamente — el mock hace lo mismo para decidir
  // si la relación es válida, pero guarda `client_id` (no la membresía) en
  // coach_clients, igual que el esquema real descrito por la auditoría.
  const clientRecord = db.clients.find(c => c.gym_id === p_gym_id && c.membership_id === p_client_membership_id);
  if (!coach || !clientRecord) {
    return { data: null, error: { code: '23503', message: 'relación inválida (secreto interno)' } };
  }
  const row = db.coachClients.find(c => c.gym_id === p_gym_id && c.coach_membership_id === p_coach_membership_id && c.client_id === clientRecord.id);
  const current = row ? row.revision : 0;
  if (p_expected_revision !== current) return { data: null, error: { code: '40001', message: 'revision conflict (secreto interno)' } };
  if (row) { row.active = p_active; row.revision = current + 1; }
  else db.coachClients.push({ id: uuid(5000 + db.coachClients.length), gym_id: p_gym_id, coach_membership_id: p_coach_membership_id, client_id: clientRecord.id, active: p_active, revision: 1 });
  return { data: { ok: true }, error: null };
}

// Simula pilot_get_coach_client_state() (ver COACH-CLIENT-STATE-MIGRATION.sql):
// lectura administrativa restringida a OWNER/ADMIN activo del gimnasio,
// nunca datos clínicos directos — devuelve exactamente lo que
// setCoachClient() necesita para escribir con la revisión exacta.
function applyGetCoachClientState(db, actor, { p_gym_id, p_coach_membership_id, p_client_membership_id }) {
  const authorizer = db.memberships.find(m => m.gym_id === p_gym_id && m.user_id === actor && m.active && (m.roles.includes('OWNER') || m.roles.includes('ADMIN')));
  if (!authorizer) return { data: null, error: { code: '42501', message: 'no autorizado (secreto interno)' } };
  const coachMembership = db.memberships.find(m => m.id === p_coach_membership_id);
  if (!coachMembership || coachMembership.gym_id !== p_gym_id) {
    return { data: null, error: { code: '22023', message: 'INVALID_COACH_RELATIONSHIP' } };
  }
  const clientMembership = db.memberships.find(m => m.id === p_client_membership_id);
  if (!clientMembership || clientMembership.gym_id !== p_gym_id) {
    return { data: null, error: { code: '22023', message: 'INVALID_CLIENT_RELATIONSHIP' } };
  }
  // P2 (auditoría sobre el commit 206d95e, "cliente inexistente confundido
  // con perfil pendiente"): el perfil se comprueba EXPLÍCITAMENTE primero
  // (igual que COACH-CLIENT-STATE-MIGRATION.sql), nunca se infiere de la
  // ausencia de `clients` — reutiliza el mismo db.missingProfiles que
  // applySetMembership ya usa para simular el 23503 de pilot_set_membership.
  if (db.missingProfiles?.has(clientMembership.user_id)) {
    return { data: { out_profile_exists: false, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }, error: null };
  }
  const clientRecord = db.clients.find(c => c.gym_id === p_gym_id && c.membership_id === p_client_membership_id);
  if (!clientRecord) {
    // Perfil Y membresía existen, pero `clients` nunca se creó —
    // inconsistencia administrativa, nunca "perfil pendiente".
    return { data: { out_profile_exists: true, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }, error: null };
  }
  const row = db.coachClients.find(c => c.gym_id === p_gym_id && c.coach_membership_id === p_coach_membership_id && c.client_id === clientRecord.id);
  if (!row) {
    return { data: { out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }, error: null };
  }
  return { data: { out_profile_exists: true, out_client_exists: true, out_coach_client_id: row.id, out_active: row.active, out_revision: row.revision }, error: null };
}

function fakeClient({ actor = OWNER, db, rpcOverride = null, rpcCalls = [] }) {
  function tableOps(rows) {
    let filters = [];
    const q = {
      select: () => q,
      eq(key, value) { filters.push([key, value]); return q; },
      then(resolve) { resolve({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)).map(r => ({ ...r })), error: null }); },
    };
    return q;
  }
  return {
    auth: { getUser: async () => (actor ? { data: { user: { id: actor } } } : { error: new Error('no session') }) },
    from(table) {
      // Lectura permitida en las tres tablas reales del dominio. Como
      // tableOps() solo expone select/eq/then (nunca insert/update/delete),
      // cualquier intento de ESCRIBIR en `clients` desde este código haría
      // fallar la prueba con un TypeError, no silenciosamente.
      if (table === 'gym_memberships') return tableOps(db.memberships);
      if (table === 'coach_clients') return tableOps(db.coachClients);
      if (table === 'clients') return tableOps(db.clients);
      if (table === 'pilot_pending_activations') {
        const q = tableOps(db.pendingActivations);
        q.upsert = async (row, { onConflict } = {}) => {
          const keys = (onConflict ?? 'id').split(',');
          const existing = db.pendingActivations.find(r => keys.every(k => r[k] === row[k]));
          if (existing) Object.assign(existing, row);
          else db.pendingActivations.push({ id: uuid(7000 + db.pendingActivations.length), revision: 0, ...row });
          return { data: null, error: null };
        };
        return q;
      }
      assert.fail('tabla inesperada: ' + table);
    },
    rpc(name, args) {
      rpcCalls.push([name, args]);
      const forced = rpcOverride?.(name, args, rpcCalls.length);
      if (forced) return Promise.resolve(forced);
      if (name === 'pilot_set_membership') return Promise.resolve(applySetMembership(db, args));
      if (name === 'pilot_set_coach_client') return Promise.resolve(applySetCoachClient(db, args));
      if (name === 'pilot_get_coach_client_state') return Promise.resolve(applyGetCoachClientState(db, actor, args));
      return Promise.resolve({ data: null, error: { code: '42883', message: 'función desconocida' } });
    },
  };
}

function service({ actor, db, rpcOverride, rpcCalls = [], rateLimiter, findUserByEmail, createAdminInvite } = {}) {
  return { api: createProvisioningService({ createSession: async () => fakeClient({ actor, db, rpcOverride, rpcCalls }), rateLimiter, findUserByEmail, createAdminInvite }), rpcCalls, db };
}

function findAna(email) { return email === 'ana@example.com' ? { id: ANA_ID } : null; }
function findOziel(email) { return email === OZIEL_EMAIL ? { id: OZIEL_ID } : null; }

let inviteSeq = 0;
function fakeAdminInvite({ fail = false } = {}) {
  const calls = [], createdIds = [];
  return { calls, createdIds, invite: async (email, metadata) => {
    calls.push([email, metadata]);
    if (fail) throw new Error('synthetic-admin-failure');
    const created = { id: uuid(9000 + ++inviteSeq) };
    createdIds.push(created.id);
    return created;
  } };
}

// ---------------------------------------------------------------------------
// addClient: flujo normal, idempotencia y uso de IDs reales de membresía.
// ---------------------------------------------------------------------------

test('provisiona un cliente que ya tiene cuenta Auth pero aún no es miembro del gimnasio', async () => {
  const db = freshDb();
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ANA@Example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  assert.equal(result.email, 'ana@example.com'); // normalizado
  assert.equal(result.createdUser, false);
  assert.equal(rpcCalls.length, 3);
  assert.equal(rpcCalls[0][0], 'pilot_set_membership');
  assert.deepEqual(rpcCalls[0][1], { p_gym_id: GYM, p_user_id: ANA_ID, p_roles: ['CLIENT'], p_active: true, p_expected_revision: 0 });
  const coachMembershipId = db.memberships.find(m => m.user_id === COACH).id;
  const anaMembershipId = db.memberships.find(m => m.user_id === ANA_ID).id;
  const anaClientRecord = db.clients.find(c => c.membership_id === anaMembershipId);
  assert.notEqual(anaClientRecord.id, ANA_ID); // el ID real de `clients` nunca es el user_id
  assert.notEqual(anaClientRecord.id, anaMembershipId); // ni el id de `gym_memberships`
  // P1 (auditoría sobre el commit e6554ff, "eliminar adivinanza de
  // revisiones"): antes de escribir, se lee el estado exacto vía la RPC
  // administrativa de solo lectura — nunca se adivina la revisión.
  assert.equal(rpcCalls[1][0], 'pilot_get_coach_client_state');
  assert.deepEqual(rpcCalls[1][1], { p_gym_id: GYM, p_coach_membership_id: coachMembershipId, p_client_membership_id: anaMembershipId });
  assert.equal(rpcCalls[2][0], 'pilot_set_coach_client');
  // p_client_membership_id debe ser el id en gym_memberships del cliente,
  // NUNCA el id de su fila en `clients` — esa es la relación corregida.
  assert.deepEqual(rpcCalls[2][1], { p_gym_id: GYM, p_coach_membership_id: coachMembershipId, p_client_membership_id: anaMembershipId, p_active: true, p_expected_revision: 0 });
  // Pero la fila de coach_clients SÍ debe quedar guardada con client_id
  // apuntando a `clients.id`, no a gym_memberships.id — así se consultará
  // después para detectar asignaciones existentes.
  assert.equal(db.coachClients[0].client_id, anaClientRecord.id);
  assert.notEqual(db.coachClients[0].client_id, anaMembershipId);
});

test('COACH por sí solo NO tiene permiso para dar de alta clientes (solo OWNER/ADMIN), aunque el coach destino sea válido', async () => {
  const db = freshDb();
  const { api, rpcCalls } = service({ db, actor: COACH, findUserByEmail: findAna }); // el propio COACH intenta ejecutar el alta
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === '42501' && e.status === 403);
  assert.equal(rpcCalls.length, 0);
});

test('ADMIN activo SÍ tiene permiso para dar de alta clientes', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ADMIN_ACTOR, roles: ['ADMIN'], active: true, revision: 1 }]);
  const { api } = service({ db, actor: ADMIN_ACTOR, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
});

test('reintentar la misma alta es idempotente: lee la revisión real y no duplica filas', async () => {
  const db = freshDb();
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  const command = { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM };
  await api.addClient({ token: 'tok', command });
  await api.addClient({ token: 'tok', command });
  assert.equal(db.memberships.filter(m => m.user_id === ANA_ID).length, 1);
  assert.equal(db.coachClients.length, 1);
  const membershipCalls = rpcCalls.filter(c => c[0] === 'pilot_set_membership');
  assert.equal(membershipCalls.length, 2);
  assert.equal(membershipCalls[0][1].p_expected_revision, 0); // primera alta: fila nueva
  assert.equal(membershipCalls[1][1].p_expected_revision, 1); // segunda vez: lee la revisión real ya existente
});

// ---------------------------------------------------------------------------
// P1 (auditoría sobre el commit 26fd7fc, "sobrescritura de roles"): addClient
// llamaba pilot_set_membership siempre con p_roles=['CLIENT'], REEMPLAZANDO
// por completo cualquier rol existente de ese correo en ese gimnasio. Si el
// correo invitado ya era OWNER/ADMIN/COACH ahí, perdía ese rol por completo.
// Corregido: se conserva el arreglo existente y solo se agrega CLIENT.
// ---------------------------------------------------------------------------
test('addClient CONSERVA el rol OWNER existente al agregar CLIENT (nunca lo reemplaza)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['OWNER'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.deepEqual(new Set(membership.roles), new Set(['OWNER', 'CLIENT']));
  assert.equal(membership.active, true);
  const call = rpcCalls.find(c => c[0] === 'pilot_set_membership');
  assert.deepEqual(new Set(call[1].p_roles), new Set(['OWNER', 'CLIENT']));
});

test('addClient CONSERVA el rol ADMIN existente al agregar CLIENT (nunca lo reemplaza)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['ADMIN'], active: true, revision: 1 }]);
  const { api } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.deepEqual(new Set(membership.roles), new Set(['ADMIN', 'CLIENT']));
});

test('addClient CONSERVA el rol COACH existente al agregar CLIENT (nunca lo reemplaza)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['COACH'], active: true, revision: 1 }]);
  const { api } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.deepEqual(new Set(membership.roles), new Set(['COACH', 'CLIENT']));
});

test('addClient sobre un CLIENT ya existente es idempotente: no duplica el rol ni pierde nada', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.deepEqual(membership.roles, ['CLIENT']); // ni duplicado ni perdido
});

test('addClient RECHAZA reactivar una membresía OWNER/ADMIN/COACH INACTIVA como efecto secundario de "agregar cliente"', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['ADMIN', 'CLIENT'], active: false, revision: 3 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(
    api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
    e => e.code === 'BLOCKED_PRIVILEGED_ROLE' && e.status === 409,
  );
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.equal(membership.active, false); // sigue inactiva, sin tocar
  assert.deepEqual(membership.roles, ['ADMIN', 'CLIENT']); // sus roles tampoco se tocaron
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_membership').length, 0); // nunca llegó a llamar la RPC
  assert.equal(db.coachClients.length, 0); // ni mucho menos a vincular un coach
});

test('addClient SÍ reactiva una membresía CLIENT inactiva sin roles privilegiados (sin bloqueo)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['CLIENT'], active: false, revision: 2 }]);
  const { api } = service({ db, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membership = db.memberships.find(m => m.user_id === ANA_ID);
  assert.equal(membership.active, true);
  assert.deepEqual(membership.roles, ['CLIENT']);
});

test('nunca inserta directamente en `clients`: cualquier intento de tocar otra tabla hace fallar la prueba', async () => {
  // Cubierto estructuralmente por fakeClient.from() en todas las pruebas de
  // este archivo (lanza assert.fail si se pide una tabla distinta de
  // gym_memberships/coach_clients/clients, y tableOps() solo expone
  // select/eq/then — nunca insert/update) — se deja como caso explícito.
  const db = freshDb();
  const { api } = service({ db, findUserByEmail: findAna });
  await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
});

// ---------------------------------------------------------------------------
// Aislamiento y permisos por gimnasio.
// ---------------------------------------------------------------------------

test('rechaza al llamador sin membresía OWNER/ADMIN activa EN ESE gimnasio, sin llegar a escribir', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, actor: NON_COACH, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === '42501' && e.status === 403);
  assert.equal(rpcCalls.length, 0);
});

test('un OWNER activo en OTRO gimnasio no puede operar en este, aunque sea owner en general', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: OTHER_GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 }]);
  // El único registro de OWNER en GYM se quita; solo existe en OTHER_GYM.
  db.memberships = db.memberships.filter(m => !(m.user_id === OWNER && m.gym_id === GYM));
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === '42501' && e.status === 403);
  assert.equal(rpcCalls.length, 0);
});

test('rechaza coach destino sin rol que pueda coachear en ese gimnasio, sin llegar a escribir', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: NON_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
});

test('rechaza coach destino que SÍ es coach activo pero en otro gimnasio', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: OTHER_GYM, user_id: OTHER_COACH, roles: ['COACH'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: OTHER_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Confirmado contra el contrato real de `pilot_set_coach_client` en
// Supabase: 'COACH'::public.pilot_role = any(coach.roles) — COACH LITERAL,
// nunca OWNER/ADMIN como sustituto (corrección sobre una suposición
// incorrecta de una ronda anterior de esta sesión).
// ---------------------------------------------------------------------------
test('rechaza coach destino con OWNER activo pero SIN rol COACH (OWNER/ADMIN administran, no sustituyen a COACH)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['OWNER'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: NON_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
});

test('rechaza coach destino con ADMIN activo pero SIN rol COACH', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['ADMIN'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: NON_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
});

test('acepta coach destino que es OWNER pero TAMBIÉN tiene COACH en su arreglo de roles (pasa por tener COACH, no por ser OWNER)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['OWNER', 'COACH'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: NON_COACH, gymId: GYM } });
  assert.deepEqual(rpcCalls.map(c => c[0]), ['pilot_set_membership', 'pilot_get_coach_client_state', 'pilot_set_coach_client']);
});

// ---------------------------------------------------------------------------
// Concurrencia optimista: REVISION_CONFLICT (40001) se reintenta leyendo la
// revisión real, acotado — nunca en bucle, nunca duplicando la operación.
// ---------------------------------------------------------------------------

test('REVISION_CONFLICT se resuelve solo: vuelve a leer y reintenta con la revisión fresca', async () => {
  const db = freshDb();
  let forcedOnce = false;
  const rpcOverride = (name) => {
    if (name === 'pilot_set_membership' && !forcedOnce) { forcedOnce = true; return { data: null, error: { code: '40001', message: 'secreto' } }; }
    return null;
  };
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  const membershipCalls = rpcCalls.filter(c => c[0] === 'pilot_set_membership');
  assert.equal(membershipCalls.length, 2); // 1 conflicto forzado + 1 reintento exitoso
  assert.equal(db.memberships.filter(m => m.user_id === ANA_ID).length, 1); // sin duplicar
});

test('REVISION_CONFLICT persistente se reporta tras un número acotado de reintentos, sin bucle infinito', async () => {
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_set_membership' ? { data: null, error: { code: '40001', message: 'secreto' } } : null;
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === 'REVISION_CONFLICT' && e.status === 409);
  const membershipCalls = rpcCalls.filter(c => c[0] === 'pilot_set_membership');
  assert.equal(membershipCalls.length, 4); // acotado: ni un intento más
  assert.ok(!JSON.stringify(membershipCalls).includes('secreto')); // no se filtra el mensaje crudo
});

// ---------------------------------------------------------------------------
// P2 (auditoría sobre el commit 206d95e3f300f749efd7c7b42fe2f322717dc199,
// "error 23503 clasificado incorrectamente" + "cliente inexistente
// confundido con perfil pendiente"): las tres pruebas que siguen cubren,
// explícitamente, los TRES estados que ahora distingue
// pilot_get_coach_client_state (ver COACH-CLIENT-STATE-MIGRATION.sql):
// perfil ausente (genuinamente pendiente), `clients` ausente con perfil Y
// membresía ya válidos (inconsistencia administrativa, NUNCA "pendiente"),
// y cliente válido (las pruebas de más arriba, p. ej. "provisiona un
// cliente que ya tiene cuenta Auth...", ya cubren este tercer estado).
// ---------------------------------------------------------------------------

test('setCoachClient: perfil AUSENTE (según pilot_get_coach_client_state) -> PENDING_PROFILE, nunca CLIENT_RECORD_MISSING', async () => {
  // Caso defensivo: en el flujo normal, setMembership() ya garantiza que
  // el perfil existe antes de llegar aquí (ver su propia postcondición) —
  // esta prueba fuerza la respuesta de la RPC directamente para probar
  // que setCoachClient() SÍ distingue este estado del de "clients ausente"
  // si, por lo que sea, llegara a ocurrir.
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_get_coach_client_state'
    ? { data: { out_profile_exists: false, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }, error: null }
    : null;
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PENDING_PROFILE');
  assert.equal(result.autoResumable, true);
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0);
});

test('un 23503 inesperado en pilot_set_coach_client (membresía y perfil YA válidos) se reporta como CLIENT_RECORD_MISSING explícito, nunca como PENDING_PROFILE ni con una activación pendiente guardada', async () => {
  // Por el momento en que esta RPC se llama, setMembership() YA confirmó
  // que la membresía existe, está activa y tiene CLIENT — un 23503 aquí es
  // una inconsistencia real (o una carrera entre la lectura del estado y
  // esta escritura), nunca "todavía no existe". addClient() debe
  // propagarlo explícito, SIN guardar ninguna activación pendiente:
  // guardarla sugeriría que se resolverá sola, y nada en el flujo normal
  // vuelve a crear ese registro.
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_set_coach_client' ? { data: null, error: { code: '23503', message: 'detalle-interno-secreto' } } : null;
  const { api } = service({ db, findUserByEmail: findAna, rpcOverride });
  await assert.rejects(
    api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
    e => { assert.ok(!JSON.stringify(e).includes('secreto')); return e.code === 'CLIENT_RECORD_MISSING' && e.status === 409; },
  );
  assert.equal(db.pendingActivations.length, 0);
});

test('setCoachClient reporta CLIENT_RECORD_MISSING (inconsistencia administrativa, nunca PENDING_PROFILE) si `clients` no tiene la fila del cliente aunque la membresía y el perfil YA existan, SIN leer `clients` con la sesión propia', async () => {
  // La RPC administrativa de solo lectura (pilot_get_coach_client_state)
  // distingue explícitamente este caso de "perfil ausente" — ver
  // COACH-CLIENT-STATE-MIGRATION.sql. Nunca se lee `clients` con la sesión
  // propia del OWNER/ADMIN, y nunca se llega a llamar pilot_set_coach_client
  // cuando esto ocurre.
  const db = freshDb();
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  // Fuerza que, tras la membresía, NUNCA aparezca la fila en `clients`
  // (simula justo la inconsistencia: la membresía quedó activa con CLIENT,
  // pero `clients` nunca se creó).
  const realPush = db.clients.push.bind(db.clients);
  db.clients.push = () => {}; // absorbe cualquier intento de "crearla" en el mock
  await assert.rejects(
    api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
    e => e.code === 'CLIENT_RECORD_MISSING' && e.status === 409,
  );
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_get_coach_client_state').length, 1);
  // pilot_set_coach_client NUNCA se llega a invocar: el estado ya dijo que
  // `clients` no existía, sin necesidad de intentar escribir.
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0);
  assert.equal(db.pendingActivations.length, 0); // nunca se guarda una reanudación automática para esto
  db.clients.push = realPush;
});

// ---------------------------------------------------------------------------
// P2 (auditoría sobre el commit a8e22a3b6f97838ecbdf496e0670185397807e2a,
// "`!row.out_profile_exists` interpreta `undefined`/`null` como ausencia de
// perfil"): `!valor` en JS trata CUALQUIER valor falsy (undefined, null, 0,
// '', NaN) como "el perfil no existe" — una respuesta MALFORMADA de la RPC
// (campo ausente, null, o con un tipo incompatible) creaba una activación
// pendiente igual que un perfil genuinamente ausente. validateCoachClientStateRow()
// ahora exige el tipo exacto de cada campo obligatorio antes de decidir
// nada; cualquier desviación se reporta como PROVISIONING_RESULT_UNKNOWN,
// SIN crear una activación pendiente ni llegar a llamar pilot_set_coach_client.
// ---------------------------------------------------------------------------

test('setCoachClient: out_profile_exists===false (estrictamente boolean) -> PENDING_PROFILE', async () => {
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_get_coach_client_state'
    ? { data: { out_profile_exists: false, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }, error: null }
    : null;
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PENDING_PROFILE');
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0);
});

test('setCoachClient: out_profile_exists===true con fila completa y válida -> PROVISIONED (escribe normalmente)', async () => {
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_get_coach_client_state'
    ? { data: { out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }, error: null }
    : null;
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 1);
});

for (const [label, malformedRow] of [
  ['out_profile_exists es null (no estrictamente false)', { out_profile_exists: null, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_profile_exists está AUSENTE del objeto (campo obligatorio faltante)', { out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_profile_exists es undefined explícito', { out_profile_exists: undefined, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_profile_exists tiene un tipo incompatible (string en vez de boolean)', { out_profile_exists: 'false', out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_profile_exists tiene un tipo incompatible (number en vez de boolean)', { out_profile_exists: 1, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_client_exists está AUSENTE del objeto', { out_profile_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_client_exists es null', { out_profile_exists: true, out_client_exists: null, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['la fila completa es null', null],
  ['la respuesta es un objeto vacío', {}],
  ['hay coach_client_id pero out_active/out_revision quedan en null (inconsistencia cruzada)', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: null, out_revision: null }],
  ['no hay coach_client_id pero out_revision SÍ viene definida (inconsistencia cruzada)', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: 3 }],
  // -------------------------------------------------------------------------
  // P2 (auditoría sobre el commit 17a1ad1, defecto 1 — "consistencia de
  // estados"): de los 5 campos, solo existen 4 combinaciones de ESTADO
  // válidas (ver COACH-CLIENT-STATE-MIGRATION.sql) — perfil ausente
  // implica cliente ausente; cliente ausente implica ninguna relación;
  // una relación exige perfil Y cliente presentes. Las 4 pruebas que
  // siguen violan cada una de esas implicaciones por separado (y la
  // última, las dos primeras juntas).
  // -------------------------------------------------------------------------
  ['out_profile_exists=false pero out_client_exists=true (contradice "sin perfil no puede haber clients")', { out_profile_exists: false, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }],
  ['out_profile_exists=false pero declara una relación coach-cliente existente', { out_profile_exists: false, out_client_exists: false, out_coach_client_id: uuid(5000), out_active: true, out_revision: 0 }],
  ['out_client_exists=false pero declara una relación coach-cliente existente', { out_profile_exists: true, out_client_exists: false, out_coach_client_id: uuid(5000), out_active: true, out_revision: 0 }],
  ['out_profile_exists=false Y out_client_exists=true Y además declara una relación (violación combinada)', { out_profile_exists: false, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: 0 }],
  // -------------------------------------------------------------------------
  // P2, defecto 2 — "validación estricta de identificadores y revisiones":
  // out_coach_client_id debe cumplir el formato UUID real (no basta con
  // ser string); out_revision debe ser un entero seguro no negativo (no
  // basta con ser number).
  // -------------------------------------------------------------------------
  ['out_coach_client_id es una cadena vacía (no un UUID real)', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: '', out_active: true, out_revision: 0 }],
  ['out_coach_client_id no tiene formato UUID', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: 'not-a-uuid', out_active: true, out_revision: 0 }],
  ['out_coach_client_id es un UUID truncado (un carácter corto)', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: '00000000-0000-0000-0000-00000000000', out_active: true, out_revision: 0 }],
  ['out_coach_client_id tiene caracteres no hexadecimales', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: '00000000-0000-0000-0000-0000000000zz', out_active: true, out_revision: 0 }],
  ['out_revision es negativa', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: -1 }],
  ['out_revision es fraccionaria', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: 1.5 }],
  ['out_revision es NaN', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: NaN }],
  ['out_revision es Infinity', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: Infinity }],
  ['out_revision es -Infinity', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: -Infinity }],
  ['out_revision excede el rango entero seguro de JavaScript', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: Number.MAX_SAFE_INTEGER + 1 }],
  ['out_revision tiene un tipo incompatible (string en vez de number)', { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: '3' }],
]) {
  test(`setCoachClient: respuesta inválida de pilot_get_coach_client_state (${label}) -> error explícito de contrato (PROVISIONING_RESULT_UNKNOWN), SIN activación pendiente ni escritura de asignación`, async () => {
    const db = freshDb();
    const rpcOverride = (name) => name === 'pilot_get_coach_client_state' ? { data: malformedRow, error: null } : null;
    const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
    await assert.rejects(
      api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
      e => e.code === 'PROVISIONING_RESULT_UNKNOWN' && e.status === 503,
    );
    // Nunca llega a intentar escribir la asignación coach-cliente con una
    // respuesta en la que no se puede confiar.
    assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0);
    assert.equal(db.coachClients.length, 0);
    // Nunca se crea una activación pendiente a partir de una respuesta
    // que ni siquiera se pudo interpretar con certeza.
    assert.equal(db.pendingActivations.length, 0);
  });
}

// ---------------------------------------------------------------------------
// P2 (auditoría sobre el commit 17a1ad1, defecto 3 — "cardinalidad de
// respuesta RPC"): `Array.isArray(state.data) ? state.data[0] : state.data`
// tomaba el PRIMER elemento sin comprobar nunca cuántos había — cero filas
// u más de una fila nunca se distinguían de "exactamente una". Las
// pruebas que siguen operan sobre `state.data` directamente (no sobre la
// forma de una fila ya extraída), para cubrir exactamente ese defecto.
// ---------------------------------------------------------------------------
for (const [label, rawData] of [
  ['cero filas (arreglo vacío)', []],
  ['dos filas válidas (nunca se elige la primera en silencio)', [
    { out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null },
    { out_profile_exists: true, out_client_exists: true, out_coach_client_id: uuid(5000), out_active: true, out_revision: 3 },
  ]],
  ['la respuesta es un string, no un objeto ni un arreglo', 'unexpected-string'],
  ['la respuesta es un number, no un objeto ni un arreglo', 42],
  ['la respuesta es un boolean, no un objeto ni un arreglo', true],
  ['un arreglo cuyo único elemento no es un objeto', [42]],
]) {
  test(`setCoachClient: cardinalidad/estructura inválida de pilot_get_coach_client_state (${label}) -> PROVISIONING_RESULT_UNKNOWN, nunca elige una fila en silencio`, async () => {
    const db = freshDb();
    const rpcOverride = (name) => name === 'pilot_get_coach_client_state' ? { data: rawData, error: null } : null;
    const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
    await assert.rejects(
      api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
      e => e.code === 'PROVISIONING_RESULT_UNKNOWN' && e.status === 503,
    );
    assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0);
    assert.equal(db.coachClients.length, 0);
    assert.equal(db.pendingActivations.length, 0);
  });
}

test('setCoachClient: exactamente UNA fila envuelta en un arreglo (la forma real de una RPC `returns table`) se acepta y se procesa normalmente', async () => {
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_get_coach_client_state'
    ? { data: [{ out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }], error: null }
    : null;
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 1);
});

test('addClient: un OWNER NO asignado previamente reasigna a un cliente YA EXISTENTE a un coach válido, sin leer NUNCA `clients` ni `coach_clients` (RLS clínica real lo bloquearía)', async () => {
  // P1 (auditoría sobre el commit a201ed1, "alta directa bloqueada por
  // RLS"): reproduce el caso exacto del hallazgo — el OWNER que llama
  // addClient() nunca fue el coach asignado de Ana, y RLS real sobre
  // `clients` casi con certeza solo permite leer al propio cliente o a su
  // coach YA asignado. Se envuelve from() para que CUALQUIER intento de
  // leer esas dos tablas directamente falle la prueba — no basta con que
  // el mock "lo permita"; se demuestra que el código nunca lo intenta.
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['CLIENT'], active: true, revision: 1 }]);
  db.clients.push({ id: uuid(8000), gym_id: GYM, membership_id: uuid(3) });
  // Ana ya estaba asignada a COACH, con revisión 2 — el caso donde
  // adivinar la revisión (en vez de leerla) realmente importa.
  db.coachClients.push({ id: uuid(5000), gym_id: GYM, coach_membership_id: uuid(2), client_id: uuid(8000), active: true, revision: 2 });

  const base = fakeClient({ actor: OWNER, db });
  const guarded = {
    ...base,
    from(table) {
      if (table === 'clients' || table === 'coach_clients') {
        return { select: () => assert.fail('nunca debe leer ' + table + ' directamente — RLS clínica real lo bloquearía para un OWNER no asignado') };
      }
      return base.from(table);
    },
  };
  const api = createProvisioningService({ createSession: async () => guarded, findUserByEmail: findAna });
  const result = await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED'); // nunca PENDING_PROFILE por un bloqueo de lectura que no debería hacer falta
  assert.equal(db.coachClients.length, 1); // reasignada, nunca duplicada
  assert.equal(db.coachClients[0].active, true);
  assert.equal(db.coachClients[0].revision, 3); // la RPC real sí incrementa, aunque esta capa nunca la haya leído
});

// ---------------------------------------------------------------------------
// P1 (auditoría sobre el commit e6554ff, "proteger contra concurrencia"):
// si la relación coach-cliente cambia ENTRE pilot_get_coach_client_state
// (lectura) y pilot_set_coach_client (escritura) — p. ej. una revocación
// concurrente — la escritura debe fallar con REVISION_CONFLICT, SIN
// reintentar automáticamente ni revertir esa revocación en silencio.
// ---------------------------------------------------------------------------
test('addClient: revocación CONCURRENTE entre la lectura del estado y la escritura -> REVISION_CONFLICT, SIN reintento automático, SIN revertir la revocación', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: ANA_ID, roles: ['CLIENT'], active: true, revision: 1 }]);
  db.clients.push({ id: uuid(8000), gym_id: GYM, membership_id: uuid(3) });
  db.coachClients.push({ id: uuid(5000), gym_id: GYM, coach_membership_id: uuid(2), client_id: uuid(8000), active: true, revision: 3 });
  const rpcOverride = (name) => {
    if (name === 'pilot_get_coach_client_state') {
      const row = db.coachClients[0];
      // La lectura devuelve el estado REAL en ese instante (revision=3,
      // activa) — pero, ENTRE esta lectura y la escritura que sigue, OTRA
      // transacción revoca la relación. La captura ANTES de mutar es,
      // deliberadamente, lo que esta función ya devolvió.
      const snapshot = { out_profile_exists: true, out_client_exists: true, out_coach_client_id: row.id, out_active: row.active, out_revision: row.revision };
      row.active = false;
      row.revision += 1;
      return { data: snapshot, error: null };
    }
    return null; // pilot_set_coach_client sigue el dispatcher normal (applySetCoachClient)
  };
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna, rpcOverride });
  await assert.rejects(
    api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }),
    e => e.code === 'REVISION_CONFLICT' && e.status === 409,
  );
  // Nunca reintenta automáticamente con otra revisión: exactamente UN
  // intento de escritura, nunca más.
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 1);
  // La revocación concurrente NUNCA se revirtió en silencio.
  assert.equal(db.coachClients[0].active, false);
  assert.equal(db.coachClients[0].revision, 4);
});

// ---------------------------------------------------------------------------
// Resolución/creación de la cuenta Auth — nunca con service_role para las
// RPC de dominio, solo para la Admin API pública de Supabase.
// ---------------------------------------------------------------------------

test('alta idempotente de un correo que YA tiene cuenta Auth (oziel.enriquez@complextraining.mx): nunca llama a la Admin API', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, findUserByEmail: findOziel, createAdminInvite: admin.invite });
  const command = { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM };
  const first = await api.addClient({ token: 'tok', command });
  const second = await api.addClient({ token: 'tok', command });
  assert.equal(first.status, 'PROVISIONED'); assert.equal(first.createdUser, false);
  assert.equal(second.status, 'PROVISIONED'); assert.equal(second.createdUser, false);
  assert.equal(admin.calls.length, 0);
  assert.equal(db.memberships.filter(m => m.user_id === OZIEL_ID).length, 1);
  assert.equal(db.coachClients.length, 1);
});

test('correo nuevo: busca por email (sin encontrarlo), crea la cuenta vía Admin API y la usa para la membresía', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, findUserByEmail: () => null, createAdminInvite: admin.invite });
  const result = await api.addClient({ token: 'tok', command: { name: 'Cliente Nuevo', email: 'nuevo@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  assert.equal(result.createdUser, true);
  assert.equal(result.invite, true);
  assert.deepEqual(admin.calls, [['nuevo@example.com', { name: 'Cliente Nuevo' }]]);
  const membershipCalls = rpcCalls.filter(c => c[0] === 'pilot_set_membership');
  assert.equal(membershipCalls.length, 1); // ya se sabe el user_id real antes de llamar; no hace falta reintentar por "no encontrado"
  assert.equal(membershipCalls[0][1].p_user_id, admin.createdIds[0]);
});

// ---------------------------------------------------------------------------
// Profiles: ni se asume un trigger ni se reintenta con esperas. Si
// `profiles.id` todavía no existe (invitación nunca aceptada, o cuenta
// recién creada), addClient() devuelve PENDING_PROFILE como resultado
// NORMAL (no como error), sin invitar dos veces, y una llamada posterior
// idéntica retoma y completa sin duplicar nada en cuanto el perfil exista.
// ---------------------------------------------------------------------------

test('usuario nuevo: si su perfil ya está disponible de inmediato, se provisiona en un solo intento (sin reintentos)', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, findUserByEmail: () => null, createAdminInvite: admin.invite });
  const result = await api.addClient({ token: 'tok', command: { name: 'Cliente Nuevo', email: 'nuevo@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED');
  assert.equal(result.createdUser, true);
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_membership').length, 1); // un solo intento, nada de reintentos artificiales
});

test('usuario existente con invitación pendiente (nunca inició sesión): PENDING_PROFILE, sin reenviar invitación', async () => {
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID); // existe en Auth, pero su perfil todavía no
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, findUserByEmail: findOziel, createAdminInvite: admin.invite });
  const result = await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PENDING_PROFILE');
  assert.equal(result.createdUser, false);
  assert.equal(admin.calls.length, 0); // encontrado vía listUsers: nunca se invita
  assert.equal(db.memberships.some(m => m.user_id === OZIEL_ID), false); // no quedó a medias
  assert.equal(rpcCalls.filter(c => c[0] === 'pilot_set_coach_client').length, 0); // nunca se intenta asignar sin membresía
});

test('reanudación idempotente: tras aceptar la invitación (perfil listo), repetir addClient completa sin duplicar ni reinvitar', async () => {
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, findUserByEmail: findOziel, createAdminInvite: admin.invite });
  const command = { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM };
  const pending = await api.addClient({ token: 'tok', command });
  assert.equal(pending.status, 'PENDING_PROFILE');
  // Simula que Oziel inició sesión por primera vez (lo que sea que cree su
  // perfil en la base real ya ocurrió) — nunca lo fuerza este módulo.
  db.missingProfiles.delete(OZIEL_ID);
  const resumed = await api.addClient({ token: 'tok', command });
  assert.equal(resumed.status, 'PROVISIONED');
  assert.equal(resumed.createdUser, false);
  assert.equal(admin.calls.length, 0); // en NINGÚN momento se reenvía la invitación
  assert.equal(db.memberships.filter(m => m.user_id === OZIEL_ID).length, 1); // sin duplicar
  assert.equal(db.coachClients.length, 1);
});

// Simula la sesión del propio cliente para pilot-auth.js (nunca el
// servicio de alta): solo auth.getUser / rpc('pilot_ensure_profile') /
// rpc('pilot_resume_pending_activation') / gym_memberships, exactamente lo
// que controller().verify() usa. La reanudación automática se simula con
// applyResumePendingActivation() — ver advertencia en
// PENDING-ACTIVATION-MIGRATION.sql: esto prueba la LÓGICA de este módulo
// contra el contrato SQL PROPUESTO, nunca contra Supabase real.
function fakeAuthClient(db, userId) {
  function tableOps(rows) {
    let filters = [];
    const q = { select: () => q, eq(k, v) { filters.push([k, v]); return q; }, then(resolve) { resolve({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)).map(r => ({ ...r })), error: null }); } };
    return q;
  }
  return {
    auth: { getUser: async () => ({ data: { user: { id: userId } } }) },
    rpc: async name => {
      // pilot_ensure_profile(): autoservicio, crea EXCLUSIVAMENTE el
      // propio perfil del llamador — simulado quitándolo de
      // missingProfiles, igual que hace applySetMembership para decidir
      // si una RPC administrativa debe fallar con "registro no encontrado".
      if (name === 'pilot_ensure_profile') { db.missingProfiles.delete(userId); return { data: { id: userId }, error: null }; }
      if (name === 'pilot_resume_pending_activation') return applyResumePendingActivation(db, userId);
      return { data: null, error: { code: '42883' } };
    },
    from: table => tableOps(table === 'gym_memberships' ? db.memberships : db.clients),
  };
}

test('activación automática: invitación → primer login → perfil → reanudación automática → autorizado, sin segunda acción del OWNER/ADMIN', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID); // invitación nunca aceptada todavía
  const admin = fakeAdminInvite();
  const { api } = service({ db, findUserByEmail: findOziel, createAdminInvite: admin.invite });
  const command = { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM };

  // 1) Alta inicial (una sola vez): el OWNER da de alta, pero el perfil de
  // Oziel no existe todavía — se guarda la solicitud pendiente persistente.
  const invited = await api.addClient({ token: 'tok', command });
  assert.equal(invited.status, 'PENDING_PROFILE');
  assert.equal(invited.autoResumable, true); // la solicitud SÍ quedó guardada
  assert.equal(db.pendingActivations.length, 1);
  assert.equal(db.pendingActivations[0].gym_id, GYM);
  assert.equal(db.pendingActivations[0].user_id, OZIEL_ID);
  assert.equal(db.pendingActivations[0].created_by, OWNER);

  // 2) Primer inicio de sesión de Oziel: SU PROPIA sesión (vista Cliente,
  // incluso en readOnly) ejecuta pilot_ensure_profile() y, en la MISMA
  // verificación, pilot_resume_pending_activation() — sin que ningún
  // OWNER/ADMIN haga nada más.
  const clientAuth = controller(fakeAuthClient(db, OZIEL_ID), 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  const afterFirstLogin = await clientAuth.verify();

  // 3) Activación automática: perfil creado, membresía y asignación
  // completadas en el mismo login — queda AUTORIZADO de inmediato.
  assert.equal(afterFirstLogin.status, 'AUTHORIZED');
  assert.equal(db.missingProfiles.has(OZIEL_ID), false);
  const membership = db.memberships.find(m => m.user_id === OZIEL_ID);
  assert.ok(membership); assert.deepEqual(membership.roles, ['CLIENT']); assert.equal(membership.active, true);
  assert.equal(db.coachClients.length, 1);
  assert.equal(db.pendingActivations[0].status, 'completed');
  assert.equal(admin.calls.length, 0); // nunca se reenvía la invitación; el OWNER no volvió a actuar
});

test('reanudación automática es idempotente: un segundo login no duplica nada ni reintenta la solicitud ya completada', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  const clientAuth = controller(fakeAuthClient(db, OZIEL_ID), 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  await clientAuth.verify();
  await clientAuth.verify(); // segundo login: nada pendiente ya (status 'completed')
  assert.equal(db.memberships.filter(m => m.user_id === OZIEL_ID).length, 1);
  assert.equal(db.coachClients.length, 1);
});

// ---------------------------------------------------------------------------
// Sesiones expiradas, solicitudes manipuladas y concurrencia.
// ---------------------------------------------------------------------------

test('sesión expirada/inválida: verify() nunca intenta reanudar nada (SIGNED_OUT antes de tocar ninguna RPC)', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  let rpcCalls = 0;
  const expiredClient = { auth: { getUser: async () => ({ error: new Error('token expirado (secreto interno)') }) }, rpc: async () => { rpcCalls++; return { data: null, error: null }; }, from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }) };
  const clientAuth = controller(expiredClient, 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  assert.equal((await clientAuth.verify()).status, 'SIGNED_OUT');
  assert.equal(rpcCalls, 0); // sin sesión válida, nunca se llega a pilot_ensure_profile ni a la reanudación
  assert.equal(db.pendingActivations[0].status, 'pending'); // la solicitud sigue intacta, sin tocar
});

test('solicitud manipulada: created_by ya NO es OWNER/ADMIN activo en el gimnasio → se cancela, nunca se aplica', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  // El OWNER que autorizó la solicitud fue removido/desactivado después.
  const owner = db.memberships.find(m => m.user_id === OWNER);
  owner.active = false;
  const clientAuth = controller(fakeAuthClient(db, OZIEL_ID), 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  const result = await clientAuth.verify();
  assert.equal(result.status, 'ROLE_REQUIRED'); // nunca se aplica una autorización que ya no es válida
  assert.equal(db.pendingActivations[0].status, 'cancelled');
  assert.equal(db.memberships.some(m => m.user_id === OZIEL_ID), false); // sin membresía otorgada
  assert.equal(db.coachClients.length, 0);
});

test('solicitud manipulada: el coach destino ya no es válido en ese gimnasio → se cancela, nunca se aplica', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  // El coach destino fue desactivado después de autorizar la solicitud.
  db.memberships.find(m => m.user_id === COACH).active = false;
  const clientAuth = controller(fakeAuthClient(db, OZIEL_ID), 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  const result = await clientAuth.verify();
  assert.equal(result.status, 'ROLE_REQUIRED');
  assert.equal(db.pendingActivations[0].status, 'cancelled');
  assert.equal(db.coachClients.length, 0);
});

test('solicitud manipulada: una fila apuntando a otro gimnasio nunca se aplica por error en el propio', async () => {
  const { controller } = require('../../nutrika/pilot-auth.js');
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  // Manipulación directa de la fila persistida: apunta a OTHER_GYM, donde
  // ni created_by ni el coach tienen ninguna membresía.
  db.pendingActivations[0].gym_id = OTHER_GYM;
  const clientAuth = controller(fakeAuthClient(db, OZIEL_ID), 'CLIENT', 'http://127.0.0.1:3000/auth/callback.html', { readOnly: true });
  const result = await clientAuth.verify();
  assert.equal(result.status, 'ROLE_REQUIRED');
  assert.equal(db.pendingActivations[0].status, 'cancelled');
  assert.equal(db.memberships.some(m => m.user_id === OZIEL_ID && m.gym_id === OTHER_GYM), false);
});

test('concurrencia: dos intentos de reanudación "simultáneos" nunca duplican la membresía ni la asignación', async () => {
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  db.missingProfiles.delete(OZIEL_ID); // "aceptó" la invitación
  // Simula FOR UPDATE SKIP LOCKED: la primera llamada toma el candado antes
  // de que la segunda intente leer la misma fila.
  const first = applyResumePendingActivation(db, OZIEL_ID);
  const second = applyResumePendingActivation(db, OZIEL_ID); // ya no encuentra nada 'pending': la primera la completó
  assert.equal(first.data.status, 'completed');
  assert.equal(second.data, null); // nada que hacer: ya no había solicitud pendiente
  assert.equal(db.memberships.filter(m => m.user_id === OZIEL_ID).length, 1);
  assert.equal(db.coachClients.length, 1);
});

test('concurrencia: una fila ya bloqueada (SKIP LOCKED) no se procesa dos veces en la misma ventana', async () => {
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  db.missingProfiles.delete(OZIEL_ID);
  db.lockedActivations.add(db.pendingActivations[0].id); // otra "transacción" ya la tiene tomada
  const result = applyResumePendingActivation(db, OZIEL_ID);
  assert.equal(result.data, null); // SKIP LOCKED: no espera, no aplica, no falla
  assert.equal(db.memberships.some(m => m.user_id === OZIEL_ID), false);
  assert.equal(db.pendingActivations[0].status, 'pending'); // intacta para el próximo intento
});

test('protección del último OWNER: si quien reanuda ya es OWNER, conserva ese rol además de CLIENT (nunca se reemplaza el arreglo de roles)', async () => {
  // Reproduce, a nivel de mock, el mismo fallo que Codex confirmó en la
  // migración SQL contra PG 17.11: la reanudación hacía
  // `set roles = array['CLIENT']`, reemplazando por completo el arreglo
  // en vez de agregar — pudiendo dejar un gimnasio sin ningún OWNER activo
  // si la persona invitada como cliente ya era su único OWNER.
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  // Oziel YA es OWNER de este gimnasio antes de aceptar la invitación de
  // cliente (caso límite real: mismo usuario con dos roles distintos).
  db.memberships.push({ id: uuid(300), gym_id: GYM, user_id: OZIEL_ID, roles: ['OWNER'], active: true, revision: 1 });
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  db.missingProfiles.delete(OZIEL_ID);
  const result = applyResumePendingActivation(db, OZIEL_ID);
  assert.equal(result.data.status, 'completed');
  const membership = db.memberships.find(m => m.user_id === OZIEL_ID);
  assert.deepEqual(new Set(membership.roles), new Set(['OWNER', 'CLIENT'])); // conserva OWNER, agrega CLIENT
  assert.equal(membership.roles.includes('OWNER'), true); // explícito: el gimnasio no se queda sin este OWNER
});

test('P0 restauración de privilegios: una membresía ADMIN INACTIVA con roles {ADMIN,CLIENT} nunca se reactiva sola al reanudar', async () => {
  // Reproduce, a nivel de mock, el hallazgo P0 de la auditoría de Codex
  // sobre el commit 9462850 (SQL:317-318 de PENDING-ACTIVATION-MIGRATION.sql):
  // si la membresía propia ya existe, está revocada (active=false) y
  // conserva el rol ADMIN en el arreglo, el camino normal de reanudación
  // la reactivaría (`active=true`) por el solo hecho de iniciar sesión —
  // restaurando privilegios administrativos sin ninguna acción
  // administrativa explícita. Distinto del caso "último OWNER" de arriba:
  // ahí la membresía ya estaba ACTIVA; aquí el problema es reactivar una
  // que no lo estaba.
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const { api } = service({ db, findUserByEmail: findOziel });
  await api.addClient({ token: 'tok', command: { name: 'Oziel Enríquez', email: OZIEL_EMAIL, coachId: COACH, gymId: GYM } });
  db.missingProfiles.delete(OZIEL_ID);
  // Entre la invitación original (arriba) y este primer login, una acción
  // administrativa COMPLETAMENTE DISTINTA (no addClient, no esta prueba) le
  // otorgó y luego le revocó el rol ADMIN en este mismo gimnasio — de ahí
  // que la membresía se agregue aquí directamente, nunca a través de
  // addClient (que ahora también bloquea reactivar privilegios, ver la
  // prueba "P1 sobrescritura de roles" más abajo).
  db.memberships.push({ id: uuid(300), gym_id: GYM, user_id: OZIEL_ID, roles: ['ADMIN', 'CLIENT'], active: false, revision: 3 });
  const result = applyResumePendingActivation(db, OZIEL_ID);
  assert.equal(result.data.status, 'blocked_privileged_role'); // nunca 'completed': no se decide solo
  const membership = db.memberships.find(m => m.user_id === OZIEL_ID);
  assert.equal(membership.active, false); // sigue inactiva
  assert.deepEqual(membership.roles, ['ADMIN', 'CLIENT']); // sus roles no se tocaron en absoluto
  assert.equal(db.pendingActivations[0].status, 'blocked_privileged_role'); // auditable, distinto de 'cancelled'
});

test('correo nuevo con perfil pendiente tras crear la cuenta: PENDING_PROFILE, la Admin API se llama una sola vez incluso tras varios intentos', async () => {
  const db = freshDb();
  // Cualquier id recién creado por la Admin API se trata como "perfil
  // todavía no listo" hasta que la prueba decida lo contrario.
  db.missingProfiles = { has: () => true };
  const admin = fakeAdminInvite();
  // findUserByEmail con estado: una vez que admin.invite "crea" la cuenta,
  // las siguientes búsquedas la encuentran (como listUsers real lo haría) —
  // así ningún intento posterior vuelve a invitar.
  const byEmail = new Map();
  const findUserByEmail = email => byEmail.get(email) ?? null;
  const createAdminInvite = async (...args) => { const created = await admin.invite(...args); byEmail.set(args[0], { id: created.id }); return created; };
  const { api } = service({ db, findUserByEmail, createAdminInvite });
  const command = { name: 'Cliente Nuevo', email: 'pendiente@example.com', coachId: COACH, gymId: GYM };

  const first = await api.addClient({ token: 'tok', command });
  assert.equal(first.status, 'PENDING_PROFILE');
  assert.equal(first.createdUser, true);
  assert.equal(admin.calls.length, 1); // la invitación SÍ se envió una vez

  const second = await api.addClient({ token: 'tok', command });
  assert.equal(second.status, 'PENDING_PROFILE'); // sigue pendiente

  db.missingProfiles = new Set(); // ahora "acepta la invitación": el perfil ya existe
  const third = await api.addClient({ token: 'tok', command });
  assert.equal(third.status, 'PROVISIONED'); // se completa en el 3er intento

  assert.equal(admin.calls.length, 1); // en NINGÚN momento se reenvía la invitación
  assert.equal(third.createdUser, false); // ya existía en Auth (encontrado vía listUsers, no se reinvita)
});

test('sin capacidad admin configurada, un correo nuevo reporta USER_NOT_FOUND sin llamar ninguna RPC', async () => {
  const db = freshDb();
  const { api, rpcCalls } = service({ db, findUserByEmail: () => null }); // createAdminInvite ausente
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'X', email: 'nuevo@example.com', coachId: COACH, gymId: GYM } }), e => e.code === 'USER_NOT_FOUND' && e.status === 404);
  assert.equal(rpcCalls.length, 0); // ni autorizado el coach llega a tocar una RPC sin saber el user_id real
});

test('si la Admin API falla al crear la cuenta, se reporta ADMIN_INVITE_FAILED sin mensaje crudo del proveedor', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite({ fail: true });
  const { api, rpcCalls } = service({ db, findUserByEmail: () => null, createAdminInvite: admin.invite });
  try {
    await api.addClient({ token: 'tok', command: { name: 'X', email: 'nuevo@example.com', coachId: COACH, gymId: GYM } });
    assert.fail('debía rechazar');
  } catch (e) {
    assert.equal(e.code, 'ADMIN_INVITE_FAILED');
    assert.ok(!JSON.stringify(e.message).includes('synthetic-admin-failure'));
  }
  assert.equal(rpcCalls.length, 0); // nunca se intenta una RPC sin un user_id real
});

// ---------------------------------------------------------------------------
// Validación de entrada, autenticación, rate limit y resto del API.
// ---------------------------------------------------------------------------

test('límite de solicitudes: bloquea al mismo actor tras el máximo configurado, permite a otro actor', async () => {
  let now = 0;
  const limiter = (() => {
    const hits = new Map();
    return actor => {
      const list = (hits.get(actor) ?? []).filter(t => now - t < 60000);
      if (list.length >= 2) throw new ProvisioningError('RATE_LIMIT_EXCEEDED', 429);
      list.push(now); hits.set(actor, list);
    };
  })();
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: OTHER_OWNER, roles: ['OWNER'], active: true, revision: 1 }]);
  const command = { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM };
  const { api } = service({ db, findUserByEmail: findAna, rateLimiter: limiter });
  await api.addClient({ token: 'tok', command });
  await api.addClient({ token: 'tok', command });
  await assert.rejects(api.addClient({ token: 'tok', command }), e => e.code === 'RATE_LIMIT_EXCEEDED' && e.status === 429);
  const { api: otherApi } = service({ db, actor: OTHER_OWNER, findUserByEmail: findAna, rateLimiter: limiter });
  const ok = await otherApi.addClient({ token: 'tok', command });
  assert.equal(ok.status, 'PROVISIONED');
});

test('valida la entrada antes de abrir sesión: correo, nombre, coachId y gymId mal formados se rechazan sin llamar a Supabase', async () => {
  let sessionCalls = 0;
  const api = createProvisioningService({ createSession: async () => { sessionCalls++; return fakeClient({ db: freshDb() }); } });
  for (const command of [
    { name: 'Ana', email: 'no-es-correo', coachId: COACH, gymId: GYM },
    { name: '   ', email: 'ana@example.com', coachId: COACH, gymId: GYM },
    { name: 'Ana', email: 'ana@example.com', coachId: 'no-es-uuid', gymId: GYM },
    { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: 'no-es-uuid' },
    { name: 'Ana', email: 'ana@example.com', coachId: COACH }, // falta gymId
    'no es un objeto',
  ]) {
    await assert.rejects(api.addClient({ token: 'tok', command }));
  }
  assert.equal(sessionCalls, 0);
});

test('token ausente o malformado se rechaza como AUTH_REQUIRED sin abrir sesión', async () => {
  let sessionCalls = 0;
  const api = createProvisioningService({ createSession: async () => { sessionCalls++; return fakeClient({ db: freshDb() }); } });
  for (const token of [undefined, '', 'con espacios no permitidos', 'a'.repeat(9000)]) {
    await assert.rejects(api.addClient({ token, command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === 'AUTH_REQUIRED' && e.status === 401);
  }
  assert.equal(sessionCalls, 0);
});

// ---------------------------------------------------------------------------
// P1 (auditoría sobre el commit 26fd7fc, "invitaciones sin autorización
// suficiente"): resendInvite exige una solicitud pendiente y vigente en ESE
// gimnasio para ESE correo — nunca solo que el llamador sea OWNER/ADMIN de
// algún gimnasio, lo que permitía invitar/reenviar cualquier correo arbitrario
// vía la Admin API.
// ---------------------------------------------------------------------------
test('resendInvite exige gymId, una solicitud pendiente vigente en ese gimnasio, y reusa la capacidad admin sin tocar las RPC de membresía', async () => {
  const db = freshDb();
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(2), created_by: OWNER, status: 'pending', revision: 0 });
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  const result = await api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } });
  assert.equal(result.status, 'INVITE_RESENT');
  assert.deepEqual(admin.calls, [['ana@example.com', {}]]);
  assert.equal(rpcCalls.length, 0); // pilot_set_membership no tiene concepto de "reenviar"
});

test('resendInvite RECHAZA un correo sin ninguna solicitud pendiente en ese gimnasio (nunca invita arbitrariamente vía la Admin API)', async () => {
  const db = freshDb(); // sin ninguna fila en pendingActivations
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []); // nunca se llegó a invocar la Admin API
});

test('resendInvite RECHAZA cuando la solicitud pendiente existe pero en OTRO gimnasio (gym_id no coincide)', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: OTHER_GYM, user_id: OTHER_OWNER, roles: ['OWNER'], active: true, revision: 1 }]);
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(2), created_by: OWNER, status: 'pending', revision: 0 });
  const admin = fakeAdminInvite();
  const { api } = service({ db, actor: OTHER_OWNER, createAdminInvite: admin.invite, findUserByEmail: findAna });
  // OTHER_OWNER SÍ es OWNER activo de OTHER_GYM (pasa authorizeCaller), pero
  // la única solicitud pendiente de ana@example.com es en GYM, no en
  // OTHER_GYM — nunca se reenvía cruzando el gimnasio del llamador.
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: OTHER_GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

test('resendInvite RECHAZA cuando la solicitud pendiente de ese correo ya está completada o cancelada (no "pending")', async () => {
  const db = freshDb();
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(2), created_by: OWNER, status: 'completed', revision: 1 });
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

test('resendInvite RECHAZA un correo que nunca tuvo cuenta Auth (findUserByEmail no lo encuentra), nunca lo invita como si fuera nuevo', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: () => null });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'nadie@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

// ---------------------------------------------------------------------------
// P1 (auditoría sobre el commit 60afc33, "reenvío de invitaciones
// inválidas"): status='pending' no basta — resendInvite debe revalidar en
// vivo que el autorizador original SIGUE siendo OWNER/ADMIN activo y que el
// coach destino SIGUE siendo COACH literal activo, EN ESE MISMO gimnasio.
// ---------------------------------------------------------------------------
test('resendInvite RECHAZA cuando el autorizador original (created_by) ya NO es OWNER/ADMIN activo en ese gimnasio', async () => {
  const db = freshDb();
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(2), created_by: ADMIN_ACTOR, status: 'pending', revision: 0 });
  // created_by (ADMIN_ACTOR) nunca tuvo membresía en GYM en freshDb(): es
  // exactamente "ya no autorizado", sin necesidad de revocarlo aparte.
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

test('resendInvite RECHAZA cuando el coach destino de la solicitud ya está INACTIVO en ese gimnasio', async () => {
  const db = freshDb();
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(2), created_by: OWNER, status: 'pending', revision: 0 });
  db.memberships.find(m => m.user_id === COACH).active = false; // el coach fue desactivado después de autorizar
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

test('resendInvite RECHAZA cuando el coach destino de la solicitud pertenece a OTRO gimnasio', async () => {
  const db = freshDb([{ id: uuid(6), gym_id: OTHER_GYM, user_id: OTHER_COACH, roles: ['COACH'], active: true, revision: 1 }]);
  // coach_membership_id apunta a una membresía real, pero de OTHER_GYM —
  // nunca válida como destino para una solicitud de GYM.
  db.pendingActivations.push({ id: uuid(7000), gym_id: GYM, user_id: ANA_ID, coach_membership_id: uuid(6), created_by: OWNER, status: 'pending', revision: 0 });
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite, findUserByEmail: findAna });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'NO_PENDING_ACTIVATION' && e.status === 422);
  assert.deepEqual(admin.calls, []);
});

test('resendInvite sin capacidad admin configurada reporta ADMIN_INVITE_UNAVAILABLE', async () => {
  const db = freshDb();
  const { api } = service({ db });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'ADMIN_INVITE_UNAVAILABLE' && e.status === 503);
});

test('resendInvite sin findUserByEmail configurado (solo createAdminInvite) también reporta ADMIN_INVITE_UNAVAILABLE, nunca invita a ciegas', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api } = service({ db, createAdminInvite: admin.invite });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'ADMIN_INVITE_UNAVAILABLE' && e.status === 503);
  assert.deepEqual(admin.calls, []);
});

test('clientStatus es de solo lectura, exige gymId y autorización del llamador en ese gimnasio', async () => {
  const db = freshDb([{ id: uuid(3), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api } = service({ db });
  const result = await api.clientStatus({ token: 'tok', email: 'ana@example.com', gymId: GYM });
  assert.equal(result.email, 'ana@example.com');
  assert.equal(result.gymId, GYM);
  const { api: unauthorized } = service({ db, actor: NON_COACH });
  await assert.rejects(unauthorized.clientStatus({ token: 'tok', email: 'ana@example.com', gymId: GYM }), e => e.code === '42501');
});

// ---------------------------------------------------------------------------
// Infraestructura real: service_role confinado al servidor, allowlist de
// fetch, y resolución de usuario existente vía paginación de listUsers
// (único mecanismo que expone la versión instalada de @supabase/auth-js).
// ---------------------------------------------------------------------------

test('createProvisioningInfrastructure: PILOT_SUPABASE_SERVICE_KEY con forma de clave publicable se rechaza en vez de usarse', () => {
  const { createProvisioningInfrastructure } = require('../server/pilot-admin-provisioning-service.cjs');
  assert.throws(() => createProvisioningInfrastructure({
    env: { PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_publishable_test' },
    createClient: () => ({}),
  }), /PILOT_SUPABASE_SERVICE_KEY_REJECTED/);
});

test('createProvisioningInfrastructure: el cliente admin real solo llega a invitar o listar usuarios, nunca a las RPC de dominio', async () => {
  const { createProvisioningInfrastructure } = require('../server/pilot-admin-provisioning-service.cjs');
  let capturedFetch;
  const infra = createProvisioningInfrastructure({
    env: { PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_' + 'x'.repeat(30) },
    fetchImpl: async () => ({ ok: true, status: 200 }), // nunca debe tocar la red real; solo valida el allowlist
    createClient: (_url, key, opts) => {
      if (key.startsWith('sb_secret_')) capturedFetch = opts.global.fetch;
      return { auth: { admin: { inviteUserByEmail: async () => ({ data: { user: { id: uuid(1) } }, error: null }), listUsers: async () => ({ data: { users: [] }, error: null }) } } };
    },
  });
  assert.equal(typeof infra.addClient, 'function');
  assert.equal(typeof capturedFetch, 'function'); // el cliente admin (service_role) se construyó al iniciar, no al usarlo
  const base = 'https://otswebncqidqthqplztj.supabase.co';
  for (const [path, method] of [
    ['/auth/v1/invite', 'GET'], ['/auth/v1/admin/users', 'POST'],
    ['/rest/v1/rpc/pilot_set_membership', 'POST'], ['/rest/v1/rpc/pilot_set_coach_client', 'POST'],
    ['/rest/v1/profiles', 'POST'], ['/auth/v1/token', 'POST'],
  ]) {
    await assert.rejects(capturedFetch(base + path, { method }));
  }
  await assert.doesNotReject(capturedFetch(base + '/auth/v1/invite', { method: 'POST' }));
  await assert.doesNotReject(capturedFetch(base + '/auth/v1/admin/users', { method: 'GET' }));
});

test('createProvisioningInfrastructure: resuelve un correo existente paginando listUsers, sin invitar ni duplicar', async () => {
  const { createProvisioningInfrastructure } = require('../server/pilot-admin-provisioning-service.cjs');
  const listUsersCalls = [];
  let inviteCalls = 0;
  const target = { id: uuid(777), email: 'encontrado@example.com' };
  const infra = createProvisioningInfrastructure({
    env: { PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_' + 'x'.repeat(30) },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    createClient: (_url, key) => {
      if (key === 'sb_publishable_test') {
        const memberships = [
          { id: uuid(1), gym_id: GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 },
          { id: uuid(2), gym_id: GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 },
        ];
        const clients = [];
        const coachClients = [];
        function tableOps(rows) {
          let filters = [];
          const q = {
            select: () => q,
            eq(k, v) { filters.push([k, v]); return q; },
            then(resolve) { resolve({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)), error: null }); },
          };
          return q;
        }
        return {
          auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
          from: table => table === 'gym_memberships' ? tableOps(memberships) : table === 'clients' ? tableOps(clients) : tableOps(coachClients),
          rpc: (name, args) => {
            if (name === 'pilot_set_membership') {
              let row = memberships.find(m => m.gym_id === args.p_gym_id && m.user_id === args.p_user_id);
              if (row) { row.roles = args.p_roles; row.active = args.p_active; }
              else { row = { id: uuid(9000), gym_id: args.p_gym_id, user_id: args.p_user_id, roles: args.p_roles, active: args.p_active, revision: 1 }; memberships.push(row); }
              if (args.p_roles.includes('CLIENT') && args.p_active && !clients.some(c => c.gym_id === args.p_gym_id && c.membership_id === row.id)) {
                clients.push({ id: uuid(9999), gym_id: args.p_gym_id, membership_id: row.id });
              }
            }
            // pilot_get_coach_client_state (ver COACH-CLIENT-STATE-MIGRATION.sql):
            // lectura administrativa que setCoachClient() consulta ANTES
            // de escribir — nunca lee `clients`/`coach_clients` con la
            // sesión propia.
            if (name === 'pilot_get_coach_client_state') {
              // Este mock nunca modela "perfil ausente" (el actor y los
              // correos usados aquí siempre tienen cuenta Auth resuelta ya
              // antes de llegar a esta RPC) — out_profile_exists es
              // siempre true, igual que en el flujo normal tras
              // setMembership().
              const clientRecord = clients.find(c => c.gym_id === args.p_gym_id && c.membership_id === args.p_client_membership_id);
              if (!clientRecord) return Promise.resolve({ data: { out_profile_exists: true, out_client_exists: false, out_coach_client_id: null, out_active: null, out_revision: null }, error: null });
              const row = coachClients.find(c => c.gym_id === args.p_gym_id && c.coach_membership_id === args.p_coach_membership_id && c.client_id === clientRecord.id);
              if (!row) return Promise.resolve({ data: { out_profile_exists: true, out_client_exists: true, out_coach_client_id: null, out_active: null, out_revision: null }, error: null });
              return Promise.resolve({ data: { out_profile_exists: true, out_client_exists: true, out_coach_client_id: row.id, out_active: row.active, out_revision: row.revision }, error: null });
            }
            if (name === 'pilot_set_coach_client') {
              const clientRecord = clients.find(c => c.gym_id === args.p_gym_id && c.membership_id === args.p_client_membership_id);
              const existing = coachClients.find(c => c.gym_id === args.p_gym_id && c.coach_membership_id === args.p_coach_membership_id && c.client_id === clientRecord?.id);
              if (!existing) coachClients.push({ id: uuid(9998), gym_id: args.p_gym_id, coach_membership_id: args.p_coach_membership_id, client_id: clientRecord?.id, active: args.p_active, revision: 1 });
              else { existing.active = args.p_active; existing.revision += 1; }
            }
            return Promise.resolve({ data: { ok: true }, error: null });
          },
        };
      }
      return { auth: { admin: {
        listUsers: async ({ page, perPage }) => {
          listUsersCalls.push(page);
          const users = page === 2 ? [target] : Array.from({ length: perPage }, (_, i) => ({ id: uuid(300 + page * 1000 + i), email: `relleno${page}-${i}@example.com` }));
          return { data: { users }, error: null };
        },
        inviteUserByEmail: async () => { inviteCalls++; return { data: { user: null }, error: { code: 'should-not-be-called' } }; },
      } } };
    },
  });
  const result = await infra.addClient({ token: 'tok', command: { name: 'X', email: target.email, coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PROVISIONED'); // la relación clients/gym_memberships también es correcta a través de la infraestructura real
  assert.equal(result.createdUser, false);
  assert.deepEqual(listUsersCalls, [1, 2]); // se detiene al encontrarlo; nunca pide la página 3
  assert.equal(inviteCalls, 0);
});

// ---------------------------------------------------------------------------
// P1 (auditoría sobre el commit 26fd7fc, "callback de invitación"):
// inviteUserByEmail debe recibir SIEMPRE un `redirectTo` explícito,
// construido del lado del servidor a partir de PILOT_PUBLIC_ORIGIN — nunca
// depender del callback global configurado en el dashboard de Supabase.
// ---------------------------------------------------------------------------
function infraForInviteRedirect(env, { onInvite } = {}) {
  const { createProvisioningInfrastructure } = require('../server/pilot-admin-provisioning-service.cjs');
  const memberships = [
    { id: uuid(1), gym_id: GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 },
    { id: uuid(2), gym_id: GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 },
  ];
  function tableOps(rows) {
    let filters = [];
    const q = {
      select: () => q,
      eq(k, v) { filters.push([k, v]); return q; },
      then(resolve) { resolve({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)), error: null }); },
    };
    return q;
  }
  return createProvisioningInfrastructure({
    env,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    createClient: (_url, key) => {
      if (key === env.PILOT_SUPABASE_PUBLIC_KEY) {
        return {
          auth: { getUser: async () => ({ data: { user: { id: OWNER } } }) },
          from: table => tableOps(table === 'gym_memberships' ? memberships : []),
          // PENDING_PROFILE directo: profiles.id todavía no existe para el
          // correo nuevo — no interesa llegar más lejos que resendInvite.
          rpc: () => Promise.resolve({ data: null, error: { code: '23503' } }),
        };
      }
      return { auth: { admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        inviteUserByEmail: async (email, options) => { onInvite?.(email, options); return { data: { user: { id: uuid(888) } }, error: null }; },
      } } };
    },
  });
}

test('createAdminInvite construye redirectTo del lado del servidor a partir de PILOT_PUBLIC_ORIGIN, nunca del callback global de Supabase', async () => {
  let captured = null;
  const infra = infraForInviteRedirect(
    { PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_' + 'x'.repeat(30), PILOT_PUBLIC_ORIGIN: 'https://twogramms-preprod.onrender.com' },
    { onInvite: (email, options) => { captured = { email, options }; } },
  );
  const result = await infra.addClient({ token: 'tok', command: { name: 'Nueva', email: 'nueva@example.com', coachId: COACH, gymId: GYM } });
  assert.equal(result.status, 'PENDING_PROFILE');
  assert.ok(captured, 'debía invitar: el correo no existía todavía');
  assert.equal(captured.email, 'nueva@example.com');
  assert.equal(captured.options.redirectTo, 'https://twogramms-preprod.onrender.com/auth/callback.html');
});

test('createAdminInvite RECHAZA invitar sin PILOT_PUBLIC_ORIGIN configurado (nunca cae al callback global de Supabase en silencio)', async () => {
  let invited = false;
  const infra = infraForInviteRedirect(
    { PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_' + 'x'.repeat(30) }, // sin PILOT_PUBLIC_ORIGIN
    { onInvite: () => { invited = true; } },
  );
  await assert.rejects(
    infra.addClient({ token: 'tok', command: { name: 'Nueva', email: 'nueva@example.com', coachId: COACH, gymId: GYM } }),
    e => e.code === 'PILOT_PUBLIC_ORIGIN_REQUIRED' && e.status === 503,
  );
  assert.equal(invited, false); // nunca se llegó a invocar la Admin API sin saber a dónde redirigir
});

// ---------------------------------------------------------------------------
// Capa HTTP: servidor real en loopback (sin red externa), mismo patrón que
// render-readonly.test.cjs. El "service" aquí es un doble de prueba con
// métodos instrumentados — ya se probó el servicio real arriba.
// ---------------------------------------------------------------------------
function stubService() {
  const calls = [];
  return {
    calls,
    async addClient(args) { calls.push(['addClient', args]); return { status: 'PROVISIONED', email: args.command.email, coachId: args.command.coachId, gymId: args.command.gymId }; },
    async resendInvite(args) { calls.push(['resendInvite', args]); return { status: 'INVITE_RESENT', email: args.command.email }; },
    async clientStatus(args) { calls.push(['clientStatus', args]); return { email: args.email, gymId: args.gymId, knownMemberships: 1 }; },
  };
}

test('HTTP: la ruta solo existe cuando se pasa adminProvisioningService (opt-in, no rompe despliegues existentes)', async () => {
  const origin = 'https://twogramms-test.onrender.com';
  const app = createPilotServer({ env: { PILOT_PUBLIC_ORIGIN: origin, PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' } });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const res = await httpRequest(app, origin, '/api/admin/clients', 'POST', { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM });
    assert.equal(res.status, 404);
  } finally { await new Promise(r => app.server.close(r)); }
});

test('HTTP: readOnly=true y adminProvisioningService pueden coexistir (funciones clínicas cerradas, alta habilitada)', async () => {
  const origin = 'https://twogramms-test.onrender.com';
  assert.doesNotThrow(() => createPilotServer({ env: { PILOT_PUBLIC_ORIGIN: origin, PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: stubService() }));
});

test('HTTP: alta exitosa reenvía el bearer del llamador y responde 200 con los datos del servicio', async () => {
  const origin = 'https://twogramms-test.onrender.com';
  const svc = stubService();
  const app = createPilotServer({ env: { PILOT_PUBLIC_ORIGIN: origin, PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: svc });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const res = await httpRequest(app, origin, '/api/admin/clients', 'POST', { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM }, 'Bearer caller-token');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).data, { status: 'PROVISIONED', email: 'ana@example.com', coachId: COACH, gymId: GYM });
    assert.equal(svc.calls[0][0], 'addClient');
    assert.equal(svc.calls[0][1].token, 'caller-token');

    const resend = await httpRequest(app, origin, '/api/admin/clients/resend-invite', 'POST', { email: 'ana@example.com', gymId: GYM }, 'Bearer caller-token');
    assert.equal(resend.status, 200);

    const status = await httpRequest(app, origin, '/api/admin/clients/status?email=ana%40example.com&gymId=' + GYM, 'GET', undefined, 'Bearer caller-token');
    assert.equal(status.status, 200);

    const config = JSON.parse((await httpRequest(app, origin, '/pilot-config.json', 'GET')).body);
    assert.equal(config.adminProvisioningAvailable, true);
    assert.equal(config.readOnly, true);

    const coachPage = (await httpRequest(app, origin, '/coach.html', 'GET')).body;
    assert.ok(coachPage.includes('pilot-admin-provisioning-ui.js'));
    assert.ok(coachPage.includes('admin-provisioning-root'));
    const clientPage = (await httpRequest(app, origin, '/index.html', 'GET')).body;
    assert.ok(!clientPage.includes('pilot-admin-provisioning-ui.js')); // nunca para la vista CLIENT
  } finally { await new Promise(r => app.server.close(r)); }
});

test('HTTP: rechaza sin bearer, método incorrecto u origen cruzado antes de llamar al servicio', async () => {
  const origin = 'https://twogramms-test.onrender.com';
  const svc = stubService();
  const app = createPilotServer({ env: { PILOT_PUBLIC_ORIGIN: origin, PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: svc });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    assert.equal((await httpRequest(app, origin, '/api/admin/clients', 'POST', { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM })).status, 401); // sin bearer
    assert.equal((await httpRequest(app, origin, '/api/admin/clients', 'GET', undefined, 'Bearer tok')).status, 405); // método incorrecto
    assert.equal((await httpRequest(app, origin, '/api/admin/clients/status', 'POST', {}, 'Bearer tok')).status, 405);
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/api/admin/clients', method: 'POST', headers: { host: new URL(origin).host, origin: 'https://evil.example', authorization: 'Bearer tok', 'content-type': 'application/json' } });
    const res = await new Promise((resolve, reject) => { req.on('response', resolve); req.on('error', reject); req.end('{}'); });
    assert.equal(res.statusCode, 403); // origen no coincide
    assert.equal(svc.calls.length, 0);
  } finally { await new Promise(r => app.server.close(r)); }
});

// ---------------------------------------------------------------------------
// Integración real (punto 5 de la auditoría): el script de UI de verdad
// (nutrika/pilot-admin-provisioning-ui.js, SIN copiar su lógica a mano),
// corriendo contra un servidor HTTP real en loopback y un
// createProvisioningService real (con un Supabase simulado en el límite,
// nunca red real). Esto prueba que la interfaz y el backend corregido
// realmente encajan, no solo que cada uno por separado pasa sus pruebas.
// ---------------------------------------------------------------------------
function fakeDom() {
  function el(tag) {
    const node = {
      tagName: tag, _children: [], _listeners: {}, _text: '', hidden: false, disabled: false, value: '', required: false, maxLength: 0, type: '',
      get textContent() { return this._text; }, set textContent(v) { this._text = v; },
      append(...nodes) { this._children.push(...nodes); },
      replaceChildren() { this._children = []; },
      setAttribute() {},
      addEventListener(type, fn) { this._listeners[type] = fn; },
      reset() { this.value = ''; },
    };
    return node;
  }
  const container = el('div');
  return { container, document: { createElement: el } };
}

test('Integración UI real + HTTP real + servicio real: Agregar cliente funciona de punta a punta', async () => {
  const db = freshDb();
  const api = createProvisioningService({ createSession: async () => fakeClient({ actor: OWNER, db }), findUserByEmail: findAna });
  // Sin PILOT_PUBLIC_ORIGIN: el host permitido pasa a ser exactamente
  // 127.0.0.1:<puerto>, que es lo que un fetch real a loopback envía de
  // todas formas (no se puede falsear el header Host vía fetch — node
  // reescribe a Host real; sí se puede fijar Origin, que es lo único que
  // necesita coincidir aquí).
  const app = createPilotServer({ env: { PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: api });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    // "client" del navegador: simula el SDK de Supabase que la UI consulta
    // para su propia sesión y su propia membresía — NUNCA el servicio real.
    const browserClient = fakeClient({ actor: OWNER, db });
    browserClient.auth.getSession = async () => ({ data: { session: { access_token: 'owner-session-token', user: { id: OWNER } } } });
    const { container, document: doc } = fakeDom();
    const context = {
      module: { exports: {} },
      fetch: (path, init) => globalThis.fetch(base + path, { ...init, headers: { ...init.headers, origin: base } }),
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../../nutrika/pilot-admin-provisioning-ui.js'), 'utf8'), context);
    const ui = context.module.exports.mount(container, { client: browserClient, document: doc });
    await ui.refresh();
    const form = container._children.find(c => c.tagName === 'form');
    assert.ok(form, 'el formulario debía montarse: OWNER con membresía activa está autorizado');
    const [nameField, emailField, coachField] = form._children;
    nameField._children[0].value = 'Ana Integración';
    emailField._children[0].value = 'ana@example.com';
    coachField._children[0].value = COACH;
    await form._listeners.submit({ preventDefault() {} });
    const status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.includes('Cliente agregado'), 'la UI real debía reportar éxito: ' + status.textContent);

    // Confirma que el backend real (no un doble) de verdad escribió el
    // estado esperado, usando las relaciones reales corregidas.
    const anaMembershipId = db.memberships.find(m => m.user_id === ANA_ID).id;
    const anaClient = db.clients.find(c => c.membership_id === anaMembershipId && c.gym_id === GYM);
    assert.ok(anaClient, 'pilot_set_membership debía crear la fila en clients');
    const coachMembershipId = db.memberships.find(m => m.user_id === COACH).id;
    assert.equal(db.coachClients.length, 1);
    assert.equal(db.coachClients[0].coach_membership_id, coachMembershipId);
    assert.equal(db.coachClients[0].client_id, anaClient.id); // la fila de coach_clients referencia clients.id, no gym_memberships.id
  } finally { await new Promise(r => app.server.close(r)); }
});

test('Integración UI real: invitación pendiente reporta PENDING_PROFILE con honestidad, no "Cliente agregado"', async () => {
  const db = freshDb();
  db.missingProfiles.add(OZIEL_ID);
  const api = createProvisioningService({ createSession: async () => fakeClient({ actor: OWNER, db }), findUserByEmail: findOziel });
  const app = createPilotServer({ env: { PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: api });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const browserClient = fakeClient({ actor: OWNER, db });
    browserClient.auth.getSession = async () => ({ data: { session: { access_token: 'owner-session-token', user: { id: OWNER } } } });
    const { container, document: doc } = fakeDom();
    const context = { module: { exports: {} }, fetch: (path, init) => globalThis.fetch(base + path, { ...init, headers: { ...init.headers, origin: base } }) };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../../nutrika/pilot-admin-provisioning-ui.js'), 'utf8'), context);
    const ui = context.module.exports.mount(container, { client: browserClient, document: doc });
    await ui.refresh();
    const form = container._children.find(c => c.tagName === 'form');
    const [nameField, emailField, coachField] = form._children;
    nameField._children[0].value = 'Oziel Enríquez';
    emailField._children[0].value = OZIEL_EMAIL;
    coachField._children[0].value = COACH;
    await form._listeners.submit({ preventDefault() {} });
    const status = container._children.find(c => c.tagName === 'p');
    assert.ok(!status.textContent.includes('Cliente agregado'), 'no debe afirmar éxito cuando sigue pendiente: ' + status.textContent);
    assert.ok(status.textContent.toLowerCase().includes('inicie sesión'), status.textContent);
    assert.equal(db.memberships.some(m => m.user_id === OZIEL_ID), false); // no quedó a medias en el backend real
  } finally { await new Promise(r => app.server.close(r)); }
});

test('Integración UI real: un COACH sin OWNER/ADMIN ve un mensaje claro, nunca un formulario que el servidor rechazaría', async () => {
  const db = freshDb();
  const api = createProvisioningService({ createSession: async () => fakeClient({ actor: COACH, db }) });
  const browserClient = fakeClient({ actor: COACH, db });
  browserClient.auth.getSession = async () => ({ data: { session: { access_token: 'coach-session-token', user: { id: COACH } } } });
  const { container, document: doc } = fakeDom();
  const context = { module: { exports: {} }, fetch: () => assert.fail('no debía llegar a llamar al backend') };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../../nutrika/pilot-admin-provisioning-ui.js'), 'utf8'), context);
  const ui = context.module.exports.mount(container, { client: browserClient, document: doc });
  await ui.refresh();
  assert.equal(container._children.some(c => c.tagName === 'form'), false);
  const status = container._children.find(c => c.tagName === 'p');
  assert.ok(status.textContent.toLowerCase().includes('owner/admin'), status.textContent);
  void api; // el servicio real existe para simetría con el otro caso, pero nunca se invoca
});

// ---------------------------------------------------------------------------
// P2 (auditoría sobre el commit 26fd7fc, "multigimnasio"): un OWNER/ADMIN con
// membresía activa en más de un gimnasio nunca debe ver el alta enviada en
// silencio al primero que devuelva la consulta — debe elegir explícitamente.
// ---------------------------------------------------------------------------
test('Integración UI real: OWNER con membresías activas en DOS gimnasios debe elegir uno explícitamente (nunca el primero en silencio)', async () => {
  const db = freshDb([{ id: uuid(300), gym_id: OTHER_GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 }]);
  const api = createProvisioningService({ createSession: async () => fakeClient({ actor: OWNER, db }), findUserByEmail: findAna });
  const app = createPilotServer({ env: { PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: api });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const browserClient = fakeClient({ actor: OWNER, db });
    browserClient.auth.getSession = async () => ({ data: { session: { access_token: 'owner-session-token', user: { id: OWNER } } } });
    const { container, document: doc } = fakeDom();
    const context = { module: { exports: {} }, fetch: (path, init) => globalThis.fetch(base + path, { ...init, headers: { ...init.headers, origin: base } }) };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../../nutrika/pilot-admin-provisioning-ui.js'), 'utf8'), context);
    const ui = context.module.exports.mount(container, { client: browserClient, document: doc });
    await ui.refresh();
    const form = container._children.find(c => c.tagName === 'form');
    assert.ok(form, 'el formulario debía montarse: OWNER con al menos una membresía activa está autorizado');
    const [nameField, emailField, coachField, gymField] = form._children;
    assert.ok(gymField, 'con dos gimnasios elegibles debe aparecer un campo adicional de selección');
    const select = gymField._children[0];
    assert.equal(select.tagName, 'select');
    assert.equal(select.value, '', 'nunca preseleccionado — ni el primero ni ningún otro, hasta que la persona elige');
    const optionGyms = select._children.map(o => o.value).filter(v => v !== '');
    assert.deepEqual(new Set(optionGyms), new Set([GYM, OTHER_GYM]));

    nameField._children[0].value = 'Ana Multi';
    emailField._children[0].value = 'ana@example.com';
    coachField._children[0].value = COACH;
    // Intento de envío SIN elegir gimnasio: debe rechazarse sin llamar al backend.
    await form._listeners.submit({ preventDefault() {} });
    let status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.toLowerCase().includes('selecciona'), status.textContent);
    assert.equal(db.memberships.some(m => m.user_id === ANA_ID), false);

    // Elige explícitamente GYM (donde está el coach real) y reintenta.
    select.value = GYM;
    select._listeners.change();
    await form._listeners.submit({ preventDefault() {} });
    status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.includes('Cliente agregado'), status.textContent);
    // Confirma que el backend REAL recibió exactamente el gimnasio elegido,
    // nunca OTHER_GYM (el que habría salido primero de un memberships[0]).
    const anaMembership = db.memberships.find(m => m.user_id === ANA_ID);
    assert.equal(anaMembership.gym_id, GYM);
  } finally { await new Promise(r => app.server.close(r)); }
});

test('Integración UI real: tras agregar un cliente y resetear el formulario, reenviar SIN volver a elegir gimnasio se rechaza (nunca reusa el gymId anterior en silencio)', async () => {
  // P2 (auditoría sobre el commit 60afc33, "selector multigimnasio"):
  // form.reset() no dispara 'change' en el <select> — sin el fix, la
  // variable gymId seguía apuntando al gimnasio de la operación anterior
  // aunque el selector ya se viera vacío otra vez.
  const otherCoachMembership = { id: uuid(301), gym_id: OTHER_GYM, user_id: OTHER_COACH, roles: ['COACH'], active: true, revision: 1 };
  const db = freshDb([
    { id: uuid(300), gym_id: OTHER_GYM, user_id: OWNER, roles: ['OWNER'], active: true, revision: 1 },
    otherCoachMembership,
  ]);
  // Solicitud pendiente y vigente para Oziel, YA en OTHER_GYM, por si el
  // reenvío explícito a OTHER_GYM (más abajo) llega a intentarse.
  db.pendingActivations.push({ id: uuid(7000), gym_id: OTHER_GYM, user_id: OZIEL_ID, coach_membership_id: otherCoachMembership.id, created_by: OWNER, status: 'pending', revision: 0 });
  const admin = fakeAdminInvite();
  const api = createProvisioningService({ createSession: async () => fakeClient({ actor: OWNER, db }), findUserByEmail: email => findAna(email) ?? findOziel(email), createAdminInvite: admin.invite });
  const app = createPilotServer({ env: { PORT: '10000', PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test' }, readOnly: true, adminProvisioningService: api });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const browserClient = fakeClient({ actor: OWNER, db });
    browserClient.auth.getSession = async () => ({ data: { session: { access_token: 'owner-session-token', user: { id: OWNER } } } });
    const { container, document: doc } = fakeDom();
    const context = { module: { exports: {} }, fetch: (path, init) => globalThis.fetch(base + path, { ...init, headers: { ...init.headers, origin: base } }) };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve('../../nutrika/pilot-admin-provisioning-ui.js'), 'utf8'), context);
    const ui = context.module.exports.mount(container, { client: browserClient, document: doc });
    await ui.refresh();
    const form = container._children.find(c => c.tagName === 'form');
    const resend = container._children.find(c => c.tagName === 'button' && c.textContent === 'Reenviar invitación');
    const [nameField, emailField, coachField, gymField] = form._children;
    const select = gymField._children[0];

    // 1) Selecciona GYM explícitamente y da de alta a Ana ahí.
    select.value = GYM; select._listeners.change();
    nameField._children[0].value = 'Ana Multi'; emailField._children[0].value = 'ana@example.com'; coachField._children[0].value = COACH;
    await form._listeners.submit({ preventDefault() {} });
    let status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.includes('Cliente agregado'), status.textContent);
    assert.equal(select.value, '', 'el <select> visible vuelve al placeholder tras reset');

    // 2) SIN volver a elegir gimnasio, intenta reenviar para otro correo:
    // debe rechazarse — nunca reutilizar GYM (el de la operación anterior)
    // en silencio, que es justo lo que el <select> ya no muestra elegido.
    emailField._children[0].value = OZIEL_EMAIL;
    await resend._listeners.click();
    status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.toLowerCase().includes('selecciona'), 'debía exigir elegir gimnasio de nuevo: ' + status.textContent);
    assert.deepEqual(admin.calls, []); // nunca llegó a reenviar nada

    // 3) Elige OTHER_GYM explícitamente (donde SÍ hay una solicitud
    // pendiente y vigente para Oziel) y reenvía: ahora sí debe funcionar,
    // y debe usar OTHER_GYM — nunca GYM.
    select.value = OTHER_GYM; select._listeners.change();
    await resend._listeners.click();
    status = container._children.find(c => c.tagName === 'p');
    assert.ok(status.textContent.includes('Invitación reenviada'), status.textContent);
    assert.deepEqual(admin.calls, [[OZIEL_EMAIL, {}]]);
  } finally { await new Promise(r => app.server.close(r)); }
});

function httpRequest(app, origin, path, method, jsonBody, authorization = undefined) {
  return new Promise((resolve, reject) => {
    const headers = { host: new URL(origin).host, origin, 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path, method, headers }, res => {
      let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(jsonBody !== undefined ? JSON.stringify(jsonBody) : (method === 'POST' ? '{}' : undefined));
  });
}
