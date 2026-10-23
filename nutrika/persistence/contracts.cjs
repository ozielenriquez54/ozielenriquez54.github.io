'use strict';
const {id, requireValue, immutable, instant} = require('../domain/values.cjs');
const ENTITY_TYPES = ['references', 'prescriptions', 'intakes', 'weights', 'supersessions', 'intakeRevisions', 'weightRevisions', 'habitRevisions'];
const OP_TYPES = ['PUT', 'DELETE', 'PROPOSE', 'APPROVE', 'SUPERSEDE'];
function keyOf(clientId, entityType, entityId) {
  id(clientId); id(entityId); requireValue(ENTITY_TYPES.includes(entityType), 'INVALID_ENTITY_TYPE');
  return JSON.stringify([clientId, entityType, entityId]);
}
function revision(value) { requireValue(Number.isSafeInteger(value) && value >= 0, 'INVALID_SERVER_REVISION'); return value; }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { requireValue(Number.isFinite(value), 'NON_JSON_NUMBER'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype, 'NON_JSON_PAYLOAD');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function operation(input) {
  id(input.operationId); id(input.accountId); keyOf(input.clientId, input.entityType, input.entityId);
  requireValue(OP_TYPES.includes(input.type), 'INVALID_OPERATION_TYPE'); revision(input.baseRevision); instant(input.createdAt);
  const payload = input.payload ?? null;
  canonical(payload);
  return immutable({operationId: input.operationId, accountId: input.accountId, clientId: input.clientId,
    entityType: input.entityType, entityId: input.entityId, type: input.type, baseRevision: input.baseRevision,
    payload, createdAt: input.createdAt});
}
function emptyAccount(accountId) {
  id(accountId);
  return {schemaVersion: 1, accountId, entities: {}, operations: {}, tombstones: {}, history: [], syncMetadata: {}};
}
function remoteRecord(value, accountId) {
  requireValue(value && value.accountId === accountId, 'REMOTE_ACCOUNT_MISMATCH');
  keyOf(value.clientId, value.entityType, value.entityId); revision(value.serverRevision);
  requireValue(value.serverRevision > 0 && typeof value.tombstone === 'boolean', 'INVALID_REMOTE_RECORD');
  instant(value.serverTimestamp); canonical(value.payload);
  requireValue(!value.tombstone || value.payload === null, 'INVALID_REMOTE_TOMBSTONE');
  return value;
}
module.exports = {ENTITY_TYPES, keyOf, revision, canonical, operation, emptyAccount, remoteRecord};
