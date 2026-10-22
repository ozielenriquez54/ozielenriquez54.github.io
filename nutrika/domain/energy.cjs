'use strict';
const {number, requireValue, immutable} = require('./values.cjs');
const KEYS = ['kcal', 'proteinG', 'carbsG', 'fatG'];
function nutrition(input) {
  const result = {};
  for (const key of KEYS) result[key] = number(input?.[key], key);
  return result;
}
function derivedKcal(input) {
  for (const key of KEYS.slice(1)) number(input?.[key], key);
  return number(4 * input.proteinG + 4 * input.carbsG + 9 * input.fatG, 'DERIVED_KCAL');
}
// Numerical representation allowance, not a nutritional or display tolerance.
function numericalAllowance(a, b) { return 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)); }
function validateEnergy(input) {
  try {
    const values = nutrition(input);
    const derived = derivedKcal(values);
    const difference = values.kcal - derived;
    const allowance = numericalAllowance(values.kcal, derived);
    return immutable({status: Math.abs(difference) <= allowance ? 'CONSISTENT' : 'INCONSISTENT', declaredKcal: values.kcal, derivedKcal: derived, difference, allowance});
  } catch (error) {
    if (error.name !== 'DomainError') throw error;
    return immutable({status: 'INVALID', reason: error.code});
  }
}
function presentNutrition(input, digits = 0) {
  const values = nutrition(input);
  requireValue(Number.isInteger(digits) && digits >= 0 && digits <= 6, 'INVALID_DISPLAY_PRECISION');
  return immutable(Object.fromEntries(KEYS.map(key => [key, Number(values[key].toFixed(digits))])));
}
// Display values are never prescription inputs. Require exact provenance, not a guessed allowance.
function validatePresentation(display, canonical, digits = 0) {
  if (validateEnergy(canonical).status !== 'CONSISTENT') return immutable({status: 'INVALID_CANONICAL'});
  const expected = presentNutrition(canonical, digits);
  const matches = KEYS.every(key => display?.[key] === expected[key]);
  return immutable({status: matches ? 'VALID_PRESENTATION' : 'INCONSISTENT_PRESENTATION'});
}
module.exports = {KEYS, nutrition, derivedKcal, validateEnergy, presentNutrition, validatePresentation};
