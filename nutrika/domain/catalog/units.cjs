'use strict';
const {number, requireValue, immutable, id, instant} = require('../values.cjs');
const UNITS = Object.freeze({g: ['MASS', 1], kg: ['MASS', 1000], ml: ['VOLUME', 1], L: ['VOLUME', 1000],
  pieza: ['PRACTICAL', 1], cucharada: ['PRACTICAL', 1], cucharadita: ['PRACTICAL', 1], taza: ['PRACTICAL', 1], scoop: ['PRACTICAL', 1], porcion: ['PRACTICAL', 1]});
function unit(value) { requireValue(typeof value === 'string' && Object.hasOwn(UNITS, value), 'UNKNOWN_UNIT'); return value; }
function axis(value) { unit(value); return UNITS[value][0] === 'MASS' ? 'g' : UNITS[value][0] === 'VOLUME' ? 'ml' : value; }
function equivalence(input) {
  id(input.equivalenceId); id(input.foodId); id(input.preparationState); id(input.weighingBasis);
  requireValue(Number.isSafeInteger(input.revision) && input.revision > 0, 'INVALID_EQUIVALENCE_REVISION');
  for (const side of ['from', 'to']) { number(input[side]?.quantity, 'EQUIVALENCE_QUANTITY', {positive: true}); unit(input[side]?.unit); }
  requireValue(['PENDING_VALIDATION', 'VALIDATED'].includes(input.validationStatus), 'INVALID_EQUIVALENCE_STATUS');
  if (input.validationStatus === 'VALIDATED') { id(input.validatedBy); instant(input.validatedAt); }
  else requireValue(input.validatedBy == null && input.validatedAt == null, 'UNVALIDATED_EQUIVALENCE_WITH_APPROVAL');
  return immutable({equivalenceId: input.equivalenceId, revision: input.revision, foodId: input.foodId,
    preparationState: input.preparationState, weighingBasis: input.weighingBasis,
    from: {quantity: input.from.quantity, unit: input.from.unit}, to: {quantity: input.to.quantity, unit: input.to.unit},
    validationStatus: input.validationStatus, validatedBy: input.validatedBy ?? null, validatedAt: input.validatedAt ?? null});
}
function convertQuantity(food, quantity, fromUnit, toUnit) {
  number(quantity, 'QUANTITY'); unit(fromUnit); unit(toUnit);
  const graph = new Map();
  function edge(a, b, factor) {
    number(factor, 'CONVERSION_FACTOR', {positive: true});
    if (!graph.has(a)) graph.set(a, []); graph.get(a).push([b, factor]);
  }
  for (const raw of food.equivalences ?? []) {
    const eq = equivalence(raw);
    requireValue(eq.foodId === food.foodId && eq.preparationState === food.preparationState && eq.weighingBasis === food.weighingBasis, 'EQUIVALENCE_FOOD_OR_STATE_MISMATCH');
    if (eq.validationStatus !== 'VALIDATED') continue;
    const ratio = eq.to.quantity * UNITS[eq.to.unit][1] / (eq.from.quantity * UNITS[eq.from.unit][1]);
    edge(axis(eq.from.unit), axis(eq.to.unit), ratio); edge(axis(eq.to.unit), axis(eq.from.unit), 1 / ratio);
  }
  const from = axis(fromUnit), target = axis(toUnit), factors = new Map([[from, 1]]), queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    for (const [next, ratio] of graph.get(node) ?? []) {
      const candidate = number(factors.get(node) * ratio, 'CONVERSION_FACTOR', {positive: true});
      if (factors.has(next)) {
        const prior = factors.get(next);
        if (Math.abs(candidate - prior) > 32 * Number.EPSILON * Math.max(Math.abs(candidate), Math.abs(prior))) return immutable({status: 'CONVERSION_CONFLICT'});
      } else { factors.set(next, candidate); queue.push(next); }
    }
  }
  if (!factors.has(target)) return immutable({status: 'CONVERSION_UNAVAILABLE'});
  return immutable({status: 'CONVERTED', quantity: number(quantity * UNITS[fromUnit][1] * factors.get(target) / UNITS[toUnit][1], 'CONVERTED_QUANTITY'), unit: toUnit});
}
module.exports = {unit, equivalence, convertQuantity};
