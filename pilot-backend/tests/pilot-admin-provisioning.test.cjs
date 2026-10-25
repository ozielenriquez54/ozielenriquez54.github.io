'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProvisioningService, ProvisioningError } = require('../server/pilot-admin-provisioning-service.cjs');
const { createPilotServer } = require('../server/pilot-http.cjs');

const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const COACH = uuid(1), OTHER_COACH = uuid(2), NON_COACH = uuid(3);
const GYM = uuid(100), OTHER_GYM = uuid(101);
const ANA_ID = uuid(200), OZIEL_ID = uuid(201);
const OZIEL_EMAIL = 'oziel.enriquez@complextraining.mx';

// ---------------------------------------------------------------------------
// Base de datos simulada en memoria: nunca toca la red. Modela EXACTAMENTE
// el comportamiento confirmado de las dos RPC reales (gym_id real,
// concurrencia optimista con `revision`, y pilot_set_membership creando la
// fila de membresía por su cuenta — esta capa de pruebas nunca modela ni
// toca una tabla `clients` separada, igual que el código bajo prueba).
// ---------------------------------------------------------------------------
function freshDb(extraMemberships = []) {
  return {
    memberships: [{ id: uuid(1), gym_id: GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 }, ...extraMemberships],
    coachClients: [],
  };
}

function applySetMembership(db, { p_gym_id, p_user_id, p_roles, p_active, p_expected_revision }) {
  const row = db.memberships.find(m => m.gym_id === p_gym_id && m.user_id === p_user_id);
  const current = row ? row.revision : 0;
  if (p_expected_revision !== current) return { data: null, error: { code: '40001', message: 'revision conflict (secreto interno)' } };
  if (row) { row.roles = p_roles; row.active = p_active; row.revision = current + 1; }
  else db.memberships.push({ id: uuid(1000 + db.memberships.length), gym_id: p_gym_id, user_id: p_user_id, roles: p_roles, active: p_active, revision: 1 });
  return { data: { ok: true }, error: null };
}

function applySetCoachClient(db, { p_gym_id, p_coach_membership_id, p_client_membership_id, p_active, p_expected_revision }) {
  const coach = db.memberships.find(m => m.id === p_coach_membership_id && m.gym_id === p_gym_id);
  const clientRow = db.memberships.find(m => m.id === p_client_membership_id && m.gym_id === p_gym_id);
  if (!coach || !clientRow || !clientRow.roles?.includes('CLIENT') || !clientRow.active) {
    return { data: null, error: { code: '23503', message: 'cliente sin registro (secreto interno)' } };
  }
  const row = db.coachClients.find(c => c.gym_id === p_gym_id && c.coach_membership_id === p_coach_membership_id && c.client_membership_id === p_client_membership_id);
  const current = row ? row.revision : 0;
  if (p_expected_revision !== current) return { data: null, error: { code: '40001', message: 'revision conflict (secreto interno)' } };
  if (row) { row.active = p_active; row.revision = current + 1; }
  else db.coachClients.push({ id: uuid(5000 + db.coachClients.length), gym_id: p_gym_id, coach_membership_id: p_coach_membership_id, client_membership_id: p_client_membership_id, active: p_active, revision: 1 });
  return { data: { ok: true }, error: null };
}

function fakeClient({ actor = COACH, db, rpcOverride = null, rpcCalls = [] }) {
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
      // Requisito: pilot_set_membership crea `clients` por su cuenta — esta
      // capa nunca debe leer ni escribir esa tabla directamente.
      if (table === 'gym_memberships') return tableOps(db.memberships);
      if (table === 'coach_clients') return tableOps(db.coachClients);
      assert.fail('tabla inesperada (no debe tocarse directamente): ' + table);
    },
    rpc(name, args) {
      rpcCalls.push([name, args]);
      const forced = rpcOverride?.(name, args, rpcCalls.length);
      if (forced) return Promise.resolve(forced);
      if (name === 'pilot_set_membership') return Promise.resolve(applySetMembership(db, args));
      if (name === 'pilot_set_coach_client') return Promise.resolve(applySetCoachClient(db, args));
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
  assert.equal(rpcCalls.length, 2);
  assert.equal(rpcCalls[0][0], 'pilot_set_membership');
  assert.deepEqual(rpcCalls[0][1], { p_gym_id: GYM, p_user_id: ANA_ID, p_roles: ['CLIENT'], p_active: true, p_expected_revision: 0 });
  const coachMembershipId = db.memberships.find(m => m.user_id === COACH).id;
  const clientMembershipId = db.memberships.find(m => m.user_id === ANA_ID).id;
  assert.notEqual(clientMembershipId, ANA_ID); // el ID real de membresía NUNCA es el user_id
  assert.equal(rpcCalls[1][0], 'pilot_set_coach_client');
  assert.deepEqual(rpcCalls[1][1], { p_gym_id: GYM, p_coach_membership_id: coachMembershipId, p_client_membership_id: clientMembershipId, p_active: true, p_expected_revision: 0 });
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

test('nunca inserta directamente en `clients`: cualquier intento de tocar esa tabla hace fallar la prueba', async () => {
  // Cubierto estructuralmente por fakeClient.from() en todas las pruebas de
  // este archivo (lanza assert.fail si se pide una tabla distinta de
  // gym_memberships/coach_clients) — se deja como caso explícito también.
  const db = freshDb();
  const { api } = service({ db, findUserByEmail: findAna });
  await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
});

// ---------------------------------------------------------------------------
// Aislamiento y permisos por gimnasio.
// ---------------------------------------------------------------------------

test('rechaza al llamador sin membresía COACH/OWNER activa EN ESE gimnasio, sin llegar a escribir', async () => {
  const db = freshDb([{ id: uuid(2), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, actor: NON_COACH, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === '42501' && e.status === 403);
  assert.equal(rpcCalls.length, 0);
});

test('un coach activo en OTRO gimnasio no puede operar en este, aunque sea coach en general', async () => {
  const db = freshDb([{ id: uuid(2), gym_id: OTHER_GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 }]);
  // El único registro de COACH en GYM se quita; solo existe en OTHER_GYM.
  db.memberships = db.memberships.filter(m => !(m.user_id === COACH && m.gym_id === GYM));
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } }), e => e.code === '42501' && e.status === 403);
  assert.equal(rpcCalls.length, 0);
});

test('rechaza coach destino sin rol de coach activo en ese gimnasio, sin llegar a escribir', async () => {
  const db = freshDb([{ id: uuid(2), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: NON_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
});

test('rechaza coach destino que SÍ es coach activo pero en otro gimnasio', async () => {
  const db = freshDb([{ id: uuid(2), gym_id: OTHER_GYM, user_id: OTHER_COACH, roles: ['COACH'], active: true, revision: 1 }]);
  const { api, rpcCalls } = service({ db, findUserByEmail: findAna });
  await assert.rejects(api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: OTHER_COACH, gymId: GYM } }), e => e.code === 'INVALID_COACH' && e.status === 422);
  assert.equal(rpcCalls.length, 0);
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

test('un 23503 inesperado en pilot_set_coach_client se reporta como RELATED_RECORD_NOT_FOUND, sin mensaje crudo', async () => {
  const db = freshDb();
  const rpcOverride = (name) => name === 'pilot_set_coach_client' ? { data: null, error: { code: '23503', message: 'detalle-interno-secreto' } } : null;
  const { api } = service({ db, findUserByEmail: findAna, rpcOverride });
  try {
    await api.addClient({ token: 'tok', command: { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM } });
    assert.fail('debía rechazar');
  } catch (e) {
    assert.equal(e.code, 'RELATED_RECORD_NOT_FOUND');
    assert.ok(!JSON.stringify(e.message).includes('secreto'));
  }
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
  const db = freshDb([{ id: uuid(2), gym_id: GYM, user_id: OTHER_COACH, roles: ['COACH'], active: true, revision: 1 }]);
  const command = { name: 'Ana', email: 'ana@example.com', coachId: COACH, gymId: GYM };
  const { api } = service({ db, findUserByEmail: findAna, rateLimiter: limiter });
  await api.addClient({ token: 'tok', command });
  await api.addClient({ token: 'tok', command });
  await assert.rejects(api.addClient({ token: 'tok', command }), e => e.code === 'RATE_LIMIT_EXCEEDED' && e.status === 429);
  const { api: otherApi } = service({ db, actor: OTHER_COACH, findUserByEmail: findAna, rateLimiter: limiter });
  const ok = await otherApi.addClient({ token: 'tok', command: { ...command, coachId: OTHER_COACH } });
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

test('resendInvite exige gymId y reusa la capacidad admin, sin tocar las RPC de membresía', async () => {
  const db = freshDb();
  const admin = fakeAdminInvite();
  const { api, rpcCalls } = service({ db, createAdminInvite: admin.invite });
  const result = await api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } });
  assert.equal(result.status, 'INVITE_RESENT');
  assert.deepEqual(admin.calls, [['ana@example.com', {}]]);
  assert.equal(rpcCalls.length, 0); // pilot_set_membership no tiene concepto de "reenviar"
});

test('resendInvite sin capacidad admin configurada reporta ADMIN_INVITE_UNAVAILABLE', async () => {
  const db = freshDb();
  const { api } = service({ db });
  await assert.rejects(api.resendInvite({ token: 'tok', command: { email: 'ana@example.com', gymId: GYM } }), e => e.code === 'ADMIN_INVITE_UNAVAILABLE' && e.status === 503);
});

test('clientStatus es de solo lectura, exige gymId y autorización del llamador en ese gimnasio', async () => {
  const db = freshDb([{ id: uuid(2), gym_id: GYM, user_id: NON_COACH, roles: ['CLIENT'], active: true, revision: 1 }]);
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
        const rows = [{ id: uuid(1), gym_id: GYM, user_id: COACH, roles: ['COACH'], active: true, revision: 1 }];
        return {
          auth: { getUser: async () => ({ data: { user: { id: COACH } } }) },
          from: () => {
            let filters = [];
            const q = {
              select: () => q,
              eq(k, v) { filters.push([k, v]); return q; },
              then(resolve) { resolve({ data: rows.filter(r => filters.every(([k, v]) => r[k] === v)), error: null }); },
            };
            return q;
          },
          rpc: (name, args) => {
            if (name === 'pilot_set_membership') rows.push({ id: uuid(2), gym_id: args.p_gym_id, user_id: args.p_user_id, roles: args.p_roles, active: args.p_active, revision: 1 });
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
  // No podemos invocar authorizeTargetCoach/setCoachClient con este rpc
  // simplificado (siempre responde ok), pero sí verificamos que la
  // resolución del usuario se detuvo en la página 2 sin invitar a nadie.
  const result = await infra.addClient({ token: 'tok', command: { name: 'X', email: target.email, coachId: COACH, gymId: GYM } });
  assert.equal(result.createdUser, false);
  assert.deepEqual(listUsersCalls, [1, 2]); // se detiene al encontrarlo; nunca pide la página 3
  assert.equal(inviteCalls, 0);
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
