'use strict';
const {id, instant, number, requireValue, immutable} = require('../values.cjs');
const {KEYS} = require('../energy.cjs');
const {unit, equivalence} = require('./units.cjs');
const {foodNutrition, energyReview} = require('./nutrition.cjs');
const CATEGORIES = ['COOKING_PROTEIN', 'DRY_STARCH', 'VEGETABLE', 'FAT', 'DAIRY', 'FRUIT', 'BREAD', 'SUPPLEMENT', 'OTHER', 'COMPOSITE'];
const STATES = ['COOKED', 'RAW', 'DRY', 'AS_SOLD', 'READY_TO_EAT', 'DRAINED', 'AS_PREPARED', 'UNKNOWN'];
const BASES = ['COOKED', 'RAW_DRY', 'RAW', 'AS_SOLD', 'EDIBLE_PORTION', 'DRAINED', 'AS_PREPARED', 'UNWEIGHED', 'UNKNOWN'];
function barcode(value) { id(value, 'BARCODE'); requireValue(value === value.trim(), 'BARCODE_WHITESPACE'); return value; }
// Structural constructor, NOT an authorization boundary. Server must authorize revisions.
function foodRevision(input) {
  id(input.foodId); id(input.canonicalName); id(input.displayName); id(input.createdBy); instant(input.createdAt);
  requireValue(Number.isSafeInteger(input.revision) && input.revision >= 1, 'INVALID_FOOD_REVISION');
  requireValue(input.revision === 1 ? input.previousRevision == null : input.previousRevision === input.revision - 1, 'INVALID_FOOD_LINEAGE');
  if (input.brand != null) id(input.brand);
  requireValue(CATEGORIES.includes(input.category), 'INVALID_FOOD_CATEGORY');
  requireValue(STATES.includes(input.preparationState) && BASES.includes(input.weighingBasis), 'EXPLICIT_PREPARATION_AND_BASIS_REQUIRED');
  requireValue(['SINGLE_INGREDIENT', 'COMPOSITE'].includes(input.composition), 'EXPLICIT_COMPOSITION_REQUIRED');
  requireValue(['USER_CONTRIBUTED', 'EXTERNAL_IMPORT', 'CURATED'].includes(input.contributionStatus), 'INVALID_CONTRIBUTION_STATUS');
  requireValue(['USER_CONTRIBUTED', 'PENDING_VALIDATION', 'VALIDATED'].includes(input.validationStatus), 'INVALID_FOOD_VALIDATION_STATUS');
  requireValue(typeof input.active === 'boolean', 'EXPLICIT_ACTIVE_REQUIRED');
  requireValue(input.nutritionBasis === 'PER_REFERENCE_QUANTITY', 'UNSUPPORTED_NUTRITION_BASIS');
  if (input.referenceQuantity != null) number(input.referenceQuantity, 'REFERENCE_QUANTITY', {positive: true});
  if (input.referenceUnit != null) unit(input.referenceUnit);
  const nutrients = foodNutrition(input);
  const policy = input.accountingPolicy;
  requireValue(policy && ['STANDARD', 'VEGETABLE_ZERO'].includes(policy.id) && policy.version === 1, 'UNKNOWN_ACCOUNTING_POLICY');
  if (policy.id === 'VEGETABLE_ZERO') requireValue(input.category === 'VEGETABLE' && input.composition === 'SINGLE_INGREDIENT' && input.weighingBasis === 'UNWEIGHED', 'VEGETABLE_ZERO_REQUIRES_SINGLE_VEGETABLE');
  if (input.category === 'VEGETABLE') requireValue(policy.id === 'VEGETABLE_ZERO', 'VEGETABLE_ACCOUNTING_POLICY_REQUIRED');
  if (input.weighingBasis === 'UNWEIGHED') requireValue(policy.id === 'VEGETABLE_ZERO', 'UNWEIGHED_ONLY_FOR_VEGETABLE_ZERO');
  requireValue(input.source && ['MANUAL', 'EXTERNAL', 'CURATED'].includes(input.source.type), 'FOOD_SOURCE_REQUIRED');
  if (input.source.type === 'EXTERNAL') { id(input.source.provider); instant(input.source.importedAt); if (input.source.externalId != null) id(input.source.externalId); }
  requireValue(Array.isArray(input.equivalences ?? []), 'INVALID_EQUIVALENCE_LIST');
  requireValue(Array.isArray(input.barcodes ?? []), 'INVALID_BARCODE_LIST');
  const equivalents = (input.equivalences ?? []).map(equivalence);
  requireValue(new Set(equivalents.map(e => e.equivalenceId)).size === equivalents.length, 'DUPLICATE_EQUIVALENCE_ID');
  for (const eq of equivalents) requireValue(eq.foodId === input.foodId && eq.preparationState === input.preparationState && eq.weighingBasis === input.weighingBasis, 'EQUIVALENCE_FOOD_OR_STATE_MISMATCH');
  const barcodes = (input.barcodes ?? []).map(barcode);
  requireValue(new Set(barcodes).size === barcodes.length, 'DUPLICATE_BARCODE');
  if (input.validationStatus === 'VALIDATED') {
    id(input.validatedBy); instant(input.validatedAt);
    requireValue(KEYS.every(k => nutrients[k] !== null) && input.referenceQuantity != null && input.referenceUnit != null, 'INCOMPLETE_FOOD_CANNOT_BE_VALIDATED');
  } else requireValue(input.validatedBy == null && input.validatedAt == null, 'UNVALIDATED_FOOD_WITH_APPROVAL');
  if (input.revision > 1) { id(input.revisedBy); instant(input.revisedAt); }
  return immutable({foodId: input.foodId, canonicalName: input.canonicalName, displayName: input.displayName, brand: input.brand ?? null,
    barcodes, category: input.category, composition: input.composition, source: input.source, contributionStatus: input.contributionStatus,
    validationStatus: input.validationStatus, active: input.active, nutritionBasis: input.nutritionBasis,
    referenceQuantity: input.referenceQuantity ?? null, referenceUnit: input.referenceUnit ?? null, ...nutrients,
    preparationState: input.preparationState, weighingBasis: input.weighingBasis, accountingPolicy: policy, equivalences: equivalents,
    createdBy: input.createdBy, createdAt: input.createdAt, revision: input.revision, previousRevision: input.previousRevision ?? null,
    revisedBy: input.revisedBy ?? null, revisedAt: input.revisedAt ?? null, validatedBy: input.validatedBy ?? null,
    validatedAt: input.validatedAt ?? null, energyReview: energyReview(nutrients)});
}
function createContributedFood(input, {actorId, at}) {
  requireValue(input.validationStatus !== 'VALIDATED' && !input.validatedBy && !input.validatedAt, 'SELF_VALIDATION_FORBIDDEN');
  requireValue(KEYS.every(k => input[k] != null) && input.referenceQuantity != null && input.referenceUnit != null, 'MANUAL_NUTRITION_REQUIRED');
  requireValue((input.equivalences ?? []).every(e => e.validationStatus !== 'VALIDATED'), 'SELF_EQUIVALENCE_VALIDATION_FORBIDDEN');
  return foodRevision({...input, source: {type: 'MANUAL', provenance: input.source?.provenance ?? null}, contributionStatus: 'USER_CONTRIBUTED',
    validationStatus: 'PENDING_VALIDATION', validatedBy: null, validatedAt: null, active: true, revision: 1, previousRevision: null,
    createdBy: actorId, createdAt: at, revisedBy: null, revisedAt: null});
}
function reviseFood(previous, patch, {actorId, at}) {
  requireValue(patch.foodId === undefined || patch.foodId === previous.foodId, 'FOOD_ID_IMMUTABLE');
  return foodRevision({...previous, ...patch, foodId: previous.foodId, createdBy: previous.createdBy, createdAt: previous.createdAt,
    revision: previous.revision + 1, previousRevision: previous.revision, revisedBy: actorId, revisedAt: at});
}
function preparationEligibility(food) {
  if (food.preparationState === 'UNKNOWN' || food.weighingBasis === 'UNKNOWN') return 'PREPARATION_UNKNOWN';
  if (food.category === 'COOKING_PROTEIN' && (food.preparationState !== 'COOKED' || food.weighingBasis !== 'COOKED')) return 'COOKED_PROTEIN_REQUIRED';
  if (food.category === 'DRY_STARCH' && (!['RAW', 'DRY'].includes(food.preparationState) || food.weighingBasis !== 'RAW_DRY')) return 'DRY_CARBOHYDRATE_REQUIRED';
  return 'ELIGIBLE';
}
function assessFoodUse(food, policy = null) {
  if (!food.active) return immutable({status: 'FOOD_INACTIVE', allowed: false});
  const preparation = preparationEligibility(food);
  if (preparation !== 'ELIGIBLE') return immutable({status: preparation, allowed: false});
  if (food.validationStatus === 'VALIDATED') return immutable({status: 'ALLOWED', allowed: true});
  if (policy === null) return immutable({status: 'USAGE_POLICY_REQUIRED', allowed: null});
  id(policy.policyId); requireValue(Number.isSafeInteger(policy.version) && policy.version > 0 && typeof policy.allowUnvalidated === 'boolean', 'INVALID_USAGE_POLICY');
  return immutable({status: policy.allowUnvalidated ? 'ALLOWED_UNVALIDATED' : 'UNVALIDATED_NOT_ALLOWED', allowed: policy.allowUnvalidated, policyId: policy.policyId, policyVersion: policy.version});
}
module.exports = {foodRevision, createContributedFood, reviseFood, preparationEligibility, assessFoodUse, barcode};
