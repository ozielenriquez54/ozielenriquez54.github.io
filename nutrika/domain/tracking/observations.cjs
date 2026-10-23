'use strict';
const {number, requireValue, immutable} = require('../values.cjs');
const {revise} = require('./history.cjs');
const {WEIGHT_PROTOCOL} = require('../weight.cjs');
const HABITS = ['steps', 'sleepHours', 'sleepQuality', 'waterLiters', 'stress'];
const GUIDANCE = immutable({steps: {from: 10000, to: 12000}, waterLiters: {from: 2, to: 3},
  sleepQuality: ['muy mala', 'mala', 'regular', 'buena', 'excelente'], stress: ['muy bajo', 'bajo', 'moderado', 'alto', 'muy alto'], weightProtocol: WEIGHT_PROTOCOL});
function recordHabits(previous, meta, patch) {
  requireValue(Object.keys(patch).every(k => [...HABITS, 'training'].includes(k)), 'INVALID_HABIT_FIELD');
  const values = {...Object.fromEntries(HABITS.map(k => [k, null])), training: null, ...previous?.values, ...patch};
  for (const k of HABITS) {
    if (values[k] === null) continue;
    number(values[k], k);
    if (k === 'steps') requireValue(Number.isSafeInteger(values[k]), 'INVALID_STEPS');
    if (['sleepQuality', 'stress'].includes(k)) requireValue(Number.isInteger(values[k]) && values[k] >= 1 && values[k] <= 5, 'INVALID_SCALE');
  }
  requireValue([null, 'STRENGTH', 'NO_STRENGTH'].includes(values.training), 'INVALID_TRAINING');
  return revise(previous, meta, 'HABITS_DAY', {values});
}
function recordOfficialWeight(previous, meta, weightKg) {
  number(weightKg, 'WEIGHT', {positive: true});
  return revise(previous, meta, 'WEIGHT_DAY', {weightKg});
}
module.exports = {HABITS, GUIDANCE, recordHabits, recordOfficialWeight};
