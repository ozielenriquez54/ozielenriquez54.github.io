'use strict';
const {requireValue, id, instant} = require('../values.cjs');
const {calendarDate} = require('../dates.cjs');
const {KEYS} = require('../energy.cjs');
const {calculatePortion} = require('../catalog/portions.cjs');
function validateEntry(e) {
  id(e.entryId); id(e.clientId); id(e.mealId); id(e.mealType); calendarDate(e.nutritionDate); instant(e.createdAt);
  if (e.updatedAt !== null) instant(e.updatedAt);
  const s = e.foodSnapshot;
  requireValue(s?.definitionSnapshot && e.nutritionSnapshot, 'SNAPSHOT_REQUIRED');
  const portion = calculatePortion(s.definitionSnapshot, {kind: s.amountKind, quantity: s.quantity, unit: s.unit, preparationState: s.preparationState, weighingBasis: s.weighingBasis});
  requireValue(['CALCULATED', 'PARTIAL_NUTRITION'].includes(portion.status), 'INVALID_SNAPSHOT');
  for (const key of ['foodId','foodRevision','quantity','unit','accountingPolicyId','accountingPolicyVersion']) requireValue(e[key] === s[key] && s[key] === portion[key], 'SNAPSHOT_IDENTITY_MISMATCH');
  requireValue(KEYS.every(k => e[k] === e.nutritionSnapshot[k] && e[k] === s.nutritionSnapshot[k] && e[k] === portion.nutritionSnapshot[k]), 'SNAPSHOT_MISMATCH');
  return e;
}
module.exports = {validateEntry};
