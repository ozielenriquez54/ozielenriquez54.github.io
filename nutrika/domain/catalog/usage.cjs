'use strict';
const {immutable, requireValue, id} = require('../values.cjs');
const {preparationEligibility} = require('./food.cjs');
// actorUserId/ownerUserId must be supplied by the trusted application/session boundary.
function foodUseFor(food, {actorUserId, ownerUserId, purpose}) {
  id(actorUserId); id(ownerUserId);
  requireValue(['ACTUAL_INTAKE', 'PERSONAL_PANTRY', 'AUTO_GENERATION'].includes(purpose), 'INVALID_FOOD_PURPOSE');
  if (!food.active) return immutable({allowed: false, status: 'FOOD_INACTIVE'});
  const state = preparationEligibility(food);
  if (state !== 'ELIGIBLE') return immutable({allowed: false, status: state});
  if (food.validationStatus === 'VALIDATED') return immutable({allowed: true, status: 'ALLOWED', label: null});
  const own = purpose === 'AUTO_GENERATION' ? food.createdBy === ownerUserId : food.createdBy === actorUserId && ownerUserId === actorUserId;
  const allowed = own && food.contributionStatus === 'USER_CONTRIBUTED' && food.validationStatus === 'PENDING_VALIDATION' && ['ACTUAL_INTAKE', 'PERSONAL_PANTRY', 'AUTO_GENERATION'].includes(purpose);
  return immutable({allowed, status: allowed ? 'ALLOWED_OWN_PENDING' : purpose === 'AUTO_GENERATION' && food.createdBy !== ownerUserId ? 'VALIDATED_REQUIRED' : 'USAGE_POLICY_REQUIRED', label: 'PENDIENTE DE VALIDAR'});
}
module.exports = {foodUseFor};
