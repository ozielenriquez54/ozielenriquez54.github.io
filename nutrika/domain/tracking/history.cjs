'use strict';
const {id, instant, requireValue, immutable} = require('../values.cjs');
const {calendarDate} = require('../dates.cjs');
const {validateRecordData} = require('./record-validation.cjs');
// Append-only snapshots. Entity revision is independent of server synchronization revision.
function revise(previous, {recordId, clientId, nutritionDate, at, actorId}, kind, data) {
  id(recordId); id(clientId); id(actorId); instant(at); calendarDate(nutritionDate);
  if (previous) {
    requireValue(previous.kind === kind && previous.clientId === clientId && previous.nutritionDate === nutritionDate, 'RECORD_CONTEXT_MISMATCH');
    requireValue(previous.recordId !== recordId, 'NEW_RECORD_ID_REQUIRED');
  }
  return immutable({kind, recordId, clientId, nutritionDate, revision: (previous?.revision ?? 0) + 1,
    previousRecordId: previous?.recordId ?? null, createdAt: previous?.createdAt ?? at, updatedAt: at, actorId, ...data});
}
function currentRecords(records, kind, clientId) {
  id(clientId);
  const ids = new Map();
  for (const r of records.filter(r => r.kind === kind && r.clientId === clientId)) {
    validateRecordData(r);
    id(r.recordId); calendarDate(r.nutritionDate); id(r.actorId); instant(r.createdAt); instant(r.updatedAt);
    requireValue(Number.isSafeInteger(r.revision) && r.revision > 0, 'INVALID_RECORD_REVISION');
    requireValue(r.previousRecordId === null || typeof r.previousRecordId === 'string', 'INVALID_PREDECESSOR');
    requireValue(!ids.has(r.recordId), 'DUPLICATE_RECORD_ID'); ids.set(r.recordId, r);
  }
  const children = new Map(), roots = new Map();
  for (const r of ids.values()) {
    if (r.previousRecordId === null) {
      requireValue(r.revision === 1 && !roots.has(r.nutritionDate), 'REVISION_CONFLICT'); roots.set(r.nutritionDate, r);
    } else {
      const p = ids.get(r.previousRecordId);
      requireValue(p && p.nutritionDate === r.nutritionDate && r.revision === p.revision + 1, 'INCOMPLETE_REVISION_HISTORY');
      requireValue(!children.has(p.recordId), 'REVISION_CONFLICT'); children.set(p.recordId, r);
    }
  }
  return immutable([...roots.values()].map(root => { let r = root; while (children.has(r.recordId)) r = children.get(r.recordId); return r; }).sort((a, b) => a.nutritionDate.localeCompare(b.nutritionDate)));
}
module.exports = {revise, currentRecords};
