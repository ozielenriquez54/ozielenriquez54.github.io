'use strict';
const {requireValue, number} = require('../values.cjs');
const {KEYS} = require('../energy.cjs');
const {sumNutrition} = require('../catalog/nutrition.cjs');
const {validateEntry} = require('./entry-validation.cjs');
// Validate projections loaded from a repository, not just newly constructed commands.
function validateRecordData(r) {
  if (r.kind === 'WEIGHT_DAY') number(r.weightKg, 'WEIGHT', {positive: true});
  else if (r.kind === 'HABITS_DAY') {
    requireValue(r.values && [null,'STRENGTH','NO_STRENGTH'].includes(r.values.training), 'INVALID_TRAINING');
    for (const k of ['steps','sleepHours','sleepQuality','waterLiters','stress']) {
      const v=r.values[k]; if(v===null) continue; number(v,k);
      if(k==='steps') requireValue(Number.isSafeInteger(v),'INVALID_STEPS');
      if(k==='sleepQuality'||k==='stress') requireValue(Number.isInteger(v)&&v>=1&&v<=5,'INVALID_SCALE');
    }
  } else if (r.kind === 'INTAKE_DAY') {
    requireValue(['PARTIAL','COMPLETE'].includes(r.status) && Array.isArray(r.entries), 'INVALID_DAY_STATE');
    requireValue(['ADD','REPLACE','REMOVE','QUICK_LOG','REOPEN','COMPLETE'].includes(r.action), 'INVALID_DAY_ACTION');
    requireValue((r.status==='COMPLETE') === (r.action==='COMPLETE'), 'EXPLICIT_COMPLETION_REQUIRED');
    const ids=new Set();
    for(const e of r.entries){validateEntry(e);requireValue(e.clientId===r.clientId&&e.nutritionDate===r.nutritionDate,'ENTRY_CONTEXT_MISMATCH');requireValue(!ids.has(e.entryId),'DUPLICATE_ENTRY');ids.add(e.entryId);}
    requireValue(typeof r.explicitZero==='boolean' && (!r.explicitZero || (r.status==='COMPLETE' && r.entries.length===0)), 'INVALID_EXPLICIT_ZERO');
    requireValue(r.status!=='COMPLETE'||r.entries.length>0||r.explicitZero,'EXPLICIT_ZERO_CONFIRMATION_REQUIRED');
    const expected=r.entries.length ? sumNutrition(r.entries.map(e=>e.nutritionSnapshot)) : r.explicitZero ? {kcal:0,proteinG:0,carbsG:0,fatG:0} : null;
    requireValue(expected===null ? r.totals===null : r.totals && KEYS.every(k=>r.totals[k]===expected[k]), 'DAILY_TOTAL_MISMATCH');
  } else requireValue(false, 'UNKNOWN_TRACKING_RECORD');
}
module.exports={validateRecordData};
