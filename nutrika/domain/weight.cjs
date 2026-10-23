'use strict';
const {id, number, requireValue, immutable, instant} = require('./values.cjs');
const {calendarDate} = require('./dates.cjs');
const WEIGHT_PROTOCOL = 'Por la mañana/al despertar, después de ir al baño, sin ropa.';
function currentWeights(records) {
  requireValue(Array.isArray(records), 'INVALID_WEIGHT_HISTORY');
  const result = new Map(), ids = new Set();
  for (const record of records) {
    id(record.weightId); id(record.clientId); calendarDate(record.date); instant(record.recordedAt);
    number(record.weightKg, 'WEIGHT', {positive: true});
    requireValue(!ids.has(record.weightId), 'DUPLICATE_WEIGHT_ID'); ids.add(record.weightId);
    const key = JSON.stringify([record.clientId, record.date]);
    const previous = result.get(key);
    requireValue(record.revision === (previous ? previous.revision + 1 : 1) && record.previousWeightId === (previous?.weightId ?? null), 'INVALID_WEIGHT_REVISION');
    requireValue(!previous || Date.parse(record.recordedAt) >= Date.parse(previous.recordedAt), 'WEIGHT_CORRECTION_ORDER');
    result.set(key, record);
  }
  return result;
}
function recordWeight(records, input) {
  const current = currentWeights(records);
  const previous = current.get(JSON.stringify([input.clientId, input.date]));
  const event = {weightId: input.weightId, clientId: input.clientId, date: input.date, weightKg: input.weightKg,
    recordedAt: input.recordedAt, revision: previous ? previous.revision + 1 : 1, previousWeightId: previous?.weightId ?? null};
  const next = [...records, event];
  currentWeights(next);
  return immutable(next);
}
function officialWeightsForClient(clientId, records) {
  id(clientId);
  return immutable([...currentWeights(records).values()].filter(r => r.clientId === clientId).sort((a, b) => a.date.localeCompare(b.date)));
}
module.exports = {WEIGHT_PROTOCOL, recordWeight, officialWeightsForClient};
