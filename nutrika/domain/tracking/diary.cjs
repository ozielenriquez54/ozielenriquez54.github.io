'use strict';
const {id, instant, immutable, requireValue} = require('../values.cjs');
const {calendarDate} = require('../dates.cjs');
const {KEYS} = require('../energy.cjs');
const {sumNutrition} = require('../catalog/nutrition.cjs');
const {calculatePortion} = require('../catalog/portions.cjs');
const {foodUseFor} = require('../catalog/usage.cjs');
const {revise} = require('./history.cjs');
const {validateEntry} = require('./entry-validation.cjs');
function entryFromFood(input, food, amount, context) {
  const use = foodUseFor(food, {...context, purpose: 'ACTUAL_INTAKE'});
  requireValue(use.allowed, use.status);
  const portion = calculatePortion(food, amount);
  requireValue(['CALCULATED', 'PARTIAL_NUTRITION'].includes(portion.status), portion.status);
  id(input.entryId); id(input.clientId); id(input.mealId); id(input.mealType); calendarDate(input.nutritionDate); instant(input.createdAt);
  return immutable({entryId: input.entryId, clientId: input.clientId, nutritionDate: input.nutritionDate,
    mealId: input.mealId, mealType: input.mealType, foodId: portion.foodId, foodRevision: portion.foodRevision,
    quantity: portion.quantity, unit: portion.unit, nutritionSnapshot: portion.nutritionSnapshot,
    accountingPolicyVersion: portion.accountingPolicyVersion, accountingPolicyId: portion.accountingPolicyId,
    ...portion.nutritionSnapshot, foodSnapshot: portion, validationLabel: use.label,
    createdAt: input.createdAt, updatedAt: null, plannedSource: null});
}
function totals(entries) { return entries.length ? sumNutrition(entries.map(e => e.nutritionSnapshot)) : null; }
function changeDay(previous, meta, command) {
  const entries = structuredClone(previous?.entries ?? []);
  entries.forEach(validateEntry);
  let status = previous?.status ?? 'UNRECORDED', explicitZero = false;
  if (command.type === 'REOPEN') {
    requireValue(status === 'COMPLETE', 'DAY_NOT_COMPLETE'); status = 'PARTIAL';
  } else if (command.type === 'COMPLETE') {
    requireValue(status !== 'COMPLETE', 'DAY_ALREADY_COMPLETE');
    requireValue(entries.length > 0 || command.confirmZero === true, 'EXPLICIT_ZERO_CONFIRMATION_REQUIRED');
    explicitZero = entries.length === 0; status = 'COMPLETE';
  } else {
    requireValue(status !== 'COMPLETE', 'REOPEN_DAY_FIRST');
    requireValue(['ADD', 'REPLACE', 'REMOVE', 'QUICK_LOG'].includes(command.type), 'INVALID_DAY_COMMAND');
    const incoming = command.type === 'QUICK_LOG' ? command.entries : command.entry ? [command.entry] : [];
    for (const e of incoming) {
      requireValue(e.clientId === meta.clientId && e.nutritionDate === meta.nutritionDate, 'ENTRY_CONTEXT_MISMATCH');
      validateEntry(e);
    }
    if (command.type === 'ADD' || command.type === 'QUICK_LOG') {
      requireValue(incoming.length > 0, 'ENTRIES_REQUIRED'); entries.push(...incoming);
    } else {
      const index = entries.findIndex(e => e.entryId === command.entryId);
      requireValue(index >= 0, 'ENTRY_NOT_FOUND');
      if (command.type === 'REMOVE') entries.splice(index, 1);
      else { requireValue(command.entry?.entryId === command.entryId, 'ENTRY_ID_MISMATCH'); entries[index] = {...command.entry, createdAt: entries[index].createdAt, updatedAt: meta.at}; }
    }
    requireValue(new Set(entries.map(e => e.entryId)).size === entries.length, 'DUPLICATE_ENTRY');
    status = 'PARTIAL';
  }
  return revise(previous, meta, 'INTAKE_DAY', {status, entries, explicitZero,
    totals: explicitZero ? {kcal: 0, proteinG: 0, carbsG: 0, fatG: 0} : totals(entries), action: command.type});
}
function unrecordedDay(clientId, nutritionDate) {
  id(clientId); calendarDate(nutritionDate);
  return immutable({clientId, nutritionDate, status: 'UNRECORDED', entries: [], totals: null});
}
function copyPlannedMeal(planned, {clientId, nutritionDate, mealId, mealType, createdAt, entryIds}, context) {
  id(planned.planId); requireValue(Array.isArray(planned.entries) && planned.entries.length > 0 && entryIds.length === planned.entries.length, 'INVALID_PLANNED_MEAL');
  return immutable(planned.entries.map((item, i) => {
    const snapshot = item.foodSnapshot;
    requireValue(snapshot?.definitionSnapshot, 'PLANNED_SNAPSHOT_REQUIRED');
    // Recompute only to validate the stored definition/amount, never look up a newer catalog revision.
    const entry = entryFromFood({clientId, nutritionDate, mealId, mealType, createdAt, entryId: entryIds[i]}, snapshot.definitionSnapshot,
      {kind: snapshot.amountKind, quantity: snapshot.quantity, unit: snapshot.unit, preparationState: snapshot.preparationState, weighingBasis: snapshot.weighingBasis}, context);
    requireValue(KEYS.every(k => entry.nutritionSnapshot[k] === snapshot.nutritionSnapshot[k]), 'PLANNED_SNAPSHOT_MISMATCH');
    return {...entry, foodSnapshot: snapshot, nutritionSnapshot: snapshot.nutritionSnapshot, plannedSource: {planId: planned.planId, revision: planned.revision ?? null}};
  }));
}
module.exports = {entryFromFood, changeDay, unrecordedDay, copyPlannedMeal};
