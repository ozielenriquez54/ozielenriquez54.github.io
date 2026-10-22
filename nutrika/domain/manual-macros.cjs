'use strict';
const {derivedKcal}=require('./energy.cjs');
const {requireValue,immutable}=require('./values.cjs');

const MACROS=Object.freeze(['proteinG','carbsG','fatG']);
const LIMITS=immutable({proteinG:{min:0,max:400},carbsG:{min:0,max:1000},fatG:{min:0,max:300},kcal:{min:500,max:6000}});

function exactObject(value,fields,code){
  requireValue(value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,code);
  const keys=Reflect.ownKeys(value);
  requireValue(keys.length===fields.length&&keys.every(k=>fields.includes(k)),code);
  for(const field of fields){
    const descriptor=Object.getOwnPropertyDescriptor(value,field);
    requireValue(descriptor?.enumerable===true&&Object.hasOwn(descriptor,'value'),code);
  }
}

// Pure preview, NOT permission to persist. previousKcal must come from the
// authoritative previous assignment, or null for the first assignment.
// Transactional revision checks and authorization belong to a future service.
function reviewManualMacros(macros,previousKcal=null){
  exactObject(macros,MACROS,'INVALID_MANUAL_MACROS');
  const values={};
  for(const key of MACROS){
    const value=macros[key];
    requireValue(Number.isSafeInteger(value),'MANUAL_MACROS_INTEGER_REQUIRED');
    requireValue(value>=LIMITS[key].min&&value<=LIMITS[key].max,'MANUAL_MACROS_OUT_OF_RANGE');
    values[key]=value===0?0:value;
  }
  const kcal=derivedKcal(values);
  requireValue(Number.isSafeInteger(kcal)&&kcal>=LIMITS.kcal.min&&kcal<=LIMITS.kcal.max,'MANUAL_KCAL_OUT_OF_RANGE');
  requireValue(previousKcal===null||(Number.isSafeInteger(previousKcal)&&previousKcal>=LIMITS.kcal.min&&previousKcal<=LIMITS.kcal.max),'INVALID_PREVIOUS_MANUAL_KCAL');
  return immutable({macros:{...values,kcal},requiredConfirmations:{
    zeroMacros:MACROS.filter(key=>values[key]===0),
    energyChange:previousKcal!==null&&4*Math.abs(kcal-previousKcal)>previousKcal
  }});
}

// Validates explicit acknowledgements only AFTER all strict limits pass.
// Returns a detached immutable snapshot; no writes, clocks, Auth or phase logic.
function validateManualMacros(macros,confirmations,previousKcal=null){
  const review=reviewManualMacros(macros,previousKcal);
  exactObject(confirmations,['zeroMacros','energyChange'],'INVALID_MANUAL_CONFIRMATIONS');
  const zeros=confirmations.zeroMacros;
  requireValue(Array.isArray(zeros)&&zeros.length<=MACROS.length&&typeof confirmations.energyChange==='boolean','INVALID_MANUAL_CONFIRMATIONS');
  for(const key of zeros)requireValue(MACROS.includes(key),'INVALID_MANUAL_CONFIRMATIONS');
  requireValue(new Set(zeros).size===zeros.length,'INVALID_MANUAL_CONFIRMATIONS');
  requireValue(zeros.length===review.requiredConfirmations.zeroMacros.length&&review.requiredConfirmations.zeroMacros.every(key=>zeros.includes(key)),'MANUAL_ZERO_CONFIRMATION_REQUIRED');
  requireValue(!review.requiredConfirmations.energyChange||confirmations.energyChange===true,'MANUAL_ENERGY_CONFIRMATION_REQUIRED');
  return immutable({macros:review.macros,confirmations:{zeroMacros:review.requiredConfirmations.zeroMacros,energyChange:confirmations.energyChange}});
}

module.exports={LIMITS,reviewManualMacros,validateManualMacros};
