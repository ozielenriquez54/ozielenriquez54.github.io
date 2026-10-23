'use strict';
const {immutable, requireValue, id} = require('../values.cjs');
const {KEYS} = require('../energy.cjs');
const {barcode} = require('./food.cjs');
function normalizeName(value) { id(value); return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function currentFoods(revisions) {
  const current = new Map(), seen = new Set();
  for (const food of revisions) {
    const versionKey = JSON.stringify([food.foodId, food.revision]);
    requireValue(!seen.has(versionKey), 'DUPLICATE_FOOD_REVISION'); seen.add(versionKey);
    if (!current.has(food.foodId) || current.get(food.foodId).revision < food.revision) current.set(food.foodId, food);
  }
  return [...current.values()];
}
function lookupBarcode(revisions, code) {
  barcode(code);
  const candidates = currentFoods(revisions).filter(food => food.active && food.barcodes.includes(code));
  if (!candidates.length) return immutable({status: 'BARCODE_NOT_FOUND', barcode: code});
  if (candidates.length > 1) return immutable({status: 'BARCODE_CONFLICT', barcode: code, foodIds: candidates.map(f => f.foodId).sort()});
  return immutable({status: 'FOUND', barcode: code, food: candidates[0]});
}
function lookupExactName(revisions, query) {
  const name = normalizeName(query.canonicalName);
  const matches = currentFoods(revisions).filter(food => food.active && normalizeName(food.canonicalName) === name &&
    (!Object.hasOwn(query, 'brand') || food.brand === query.brand) &&
    (!Object.hasOwn(query, 'preparationState') || food.preparationState === query.preparationState) &&
    (!Object.hasOwn(query, 'weighingBasis') || food.weighingBasis === query.weighingBasis));
  if (!matches.length) return immutable({status: 'UNKNOWN'});
  if (matches.length > 1) return immutable({status: 'AMBIGUOUS', foodIds: matches.map(f => f.foodId).sort()});
  return immutable({status: 'FOUND', food: matches[0]});
}
function duplicateCandidates(revisions, candidate) {
  return immutable(currentFoods(revisions).filter(food => food.active && food.foodId !== candidate.foodId).map(food => {
    const signals = [];
    if (normalizeName(food.canonicalName) === normalizeName(candidate.canonicalName)) signals.push('EXACT_NORMALIZED_NAME');
    if (food.brand !== null && candidate.brand !== null && normalizeName(food.brand) === normalizeName(candidate.brand)) signals.push('BRAND');
    if (food.barcodes.some(code => candidate.barcodes.includes(code))) signals.push('BARCODE');
    if (food.preparationState === candidate.preparationState && food.weighingBasis === candidate.weighingBasis) signals.push('PREPARATION_AND_BASIS');
    if (food.referenceQuantity === candidate.referenceQuantity && food.referenceUnit === candidate.referenceUnit && KEYS.every(k => food[k] !== null && food[k] === candidate[k])) signals.push('NUTRITION_REFERENCE');
    return {foodId: food.foodId, foodRevision: food.revision, signals, mergeAuthorized: false};
  }).filter(row => row.signals.includes('EXACT_NORMALIZED_NAME') || row.signals.includes('BARCODE')));
}
function foodAtRevision(revisions, foodId, revision) {
  const matches = revisions.filter(food => food.foodId === foodId && food.revision === revision);
  requireValue(matches.length <= 1, 'DUPLICATE_FOOD_REVISION');
  return immutable(matches[0] ?? null); // no alias lookup; never reinterpret historical identity
}
function resolveFoodIdentity(revisions, foodId, redirects = []) {
  const latest = new Map(currentFoods(revisions).map(food => [food.foodId, food]));
  const visited = new Set(), path = [];
  let current = foodId;
  while (true) {
    if (visited.has(current)) return immutable({status: 'ALIAS_CONFLICT'});
    visited.add(current);
    const aliases = redirects.filter(event => event.sourceFoodId === current);
    if (aliases.length > 1) return immutable({status: 'ALIAS_CONFLICT'});
    if (!aliases.length) break;
    path.push(current); current = aliases[0].targetFoodId;
  }
  const food = latest.get(current);
  if (!food) return immutable({status: 'UNKNOWN'});
  if (!food.active) return immutable({status: 'FOOD_INACTIVE', foodId: current});
  return immutable({status: path.length ? 'REDIRECT' : 'FOUND', requestedFoodId: foodId, food, redirectPath: path});
}
module.exports = {currentFoods, normalizeName, lookupBarcode, lookupExactName, duplicateCandidates, foodAtRevision, resolveFoodIdentity};
