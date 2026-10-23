'use strict';
const {immutable} = require('../values.cjs');
const {KEYS} = require('../energy.cjs');
const {foodNutrition} = require('./nutrition.cjs');
const {convertQuantity} = require('./units.cjs');
const {assessFoodUse, preparationEligibility} = require('./food.cjs');
function calculatePortion(food, amount) {
  if (!food.active) return immutable({status: 'FOOD_INACTIVE'});
  const eligibility = preparationEligibility(food);
  if (eligibility !== 'ELIGIBLE') return immutable({status: eligibility});
  if (amount.preparationState !== food.preparationState || amount.weighingBasis !== food.weighingBasis) return immutable({status: 'PREPARATION_MISMATCH'});
  const metadata = foodNutrition(food);
  let actual, accounted, conversion = null;
  if (food.accountingPolicy.id === 'VEGETABLE_ZERO') {
    if (amount.kind !== 'UNWEIGHED' || amount.quantity !== null || amount.unit !== null) return immutable({status: 'UNWEIGHED_VEGETABLE_REQUIRED'});
    actual = null; // Actual portion energy is unknown: vegetables were not weighed.
    accounted = foodNutrition({kcal: 0, proteinG: 0, carbsG: 0, fatG: 0});
  } else {
    if (amount.kind !== 'MEASURED') return immutable({status: 'MEASURED_AMOUNT_REQUIRED'});
    if (food.referenceQuantity === null || food.referenceUnit === null) return immutable({status: 'REFERENCE_BASIS_UNKNOWN'});
    conversion = convertQuantity(food, amount.quantity, amount.unit, food.referenceUnit);
    if (conversion.status !== 'CONVERTED') return conversion;
    // Multiply before division to avoid avoidable error from a rounded intermediate ratio.
    actual = foodNutrition(Object.fromEntries(KEYS.map(key => [key, metadata[key] === null ? null : metadata[key] * conversion.quantity / food.referenceQuantity])));
    accounted = actual;
  }
  return immutable({status: KEYS.some(key => accounted[key] === null) ? 'PARTIAL_NUTRITION' : 'CALCULATED',
    foodId: food.foodId, foodRevision: food.revision, quantity: amount.quantity, unit: amount.unit, amountKind: amount.kind,
    preparationState: food.preparationState, weighingBasis: food.weighingBasis, conversion,
    nutritionalMetadataPerReference: metadata, nutritionBeforeAccounting: actual, nutritionSnapshot: accounted,
    accountingPolicyId: food.accountingPolicy.id, accountingPolicyVersion: food.accountingPolicy.version,
    validationStatus: food.validationStatus, definitionSnapshot: food});
}
function snapshotFood(food, amount, {usagePolicy = null} = {}) {
  const use = assessFoodUse(food, usagePolicy);
  if (use.allowed !== true) return immutable({status: use.status});
  const result = calculatePortion(food, amount);
  return immutable({...result, usageAssessment: use});
}
module.exports = {calculatePortion, snapshotFood};
