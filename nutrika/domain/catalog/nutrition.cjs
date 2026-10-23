'use strict';
const {number, immutable} = require('../values.cjs');
const {KEYS, derivedKcal, validateEnergy} = require('../energy.cjs');
function foodNutrition(input = {}) {
  return immutable(Object.fromEntries(KEYS.map(key => [key, input[key] == null ? null : number(input[key], key)])));
}
function energyReview(input) {
  const values = foodNutrition(input);
  const derived = KEYS.slice(1).every(k => values[k] !== null) ? derivedKcal(values) : null;
  if (derived === null || values.kcal === null) return immutable({declaredKcal: values.kcal, derivedKcal: derived, difference: null,
    status: 'UNKNOWN', warning: 'INCOMPLETE_NUTRITION', materiality: 'UNKNOWN', policyVersion: 'FOOD_ENERGY_REVIEW_V2'});
  const result = validateEnergy(values);
  return immutable({declaredKcal: values.kcal, derivedKcal: derived, difference: result.difference,
    status: result.status === 'CONSISTENT' ? 'CONSISTENT' : 'WARNING',
    warning: result.status === 'CONSISTENT' ? null : 'ENERGY_DIFFERENCE_REVIEW_REQUIRED',
    message: result.status === 'CONSISTENT' ? null : 'REVISAR INFORMACIÓN NUTRICIONAL',
    materiality: result.status === 'CONSISTENT' ? 'NO_DIFFERENCE_BEYOND_NUMERIC_PRECISION' : 'HUMAN_REVIEW_NO_UNIVERSAL_THRESHOLD', policyVersion: 'FOOD_ENERGY_REVIEW_V2'});
}
function sumNutrition(rows) {
  return foodNutrition(Object.fromEntries(KEYS.map(key => [key, rows.some(row => row[key] === null) ? null : rows.reduce((sum, row) => sum + row[key], 0)])));
}
module.exports = {foodNutrition, energyReview, sumNutrition};
