'use strict';
const {requireValue}=require('../values.cjs');
const ACTIVITIES=['STRENGTH','CARDIO','HIIT_FUNCTIONAL','SPORTS','MOBILITY_RECOVERY','OTHER','NONE'];
function validateActivities(value){
  requireValue(Array.isArray(value)&&value.length<=ACTIVITIES.length&&value.every(v=>ACTIVITIES.includes(v))&&new Set(value).size===value.length,'INVALID_TRAINING_ACTIVITIES');
  requireValue(!value.includes('NONE')||value.length===1,'EXCLUSIVE_NO_TRAINING');
}
function legacyTraining(activities){return activities.length?(activities.includes('STRENGTH')?'STRENGTH':'NO_STRENGTH'):null;}
function validateTraining(values){
  requireValue(values&&[null,'STRENGTH','NO_STRENGTH'].includes(values.training),'INVALID_TRAINING');
  if(Object.hasOwn(values,'trainingActivities')){
    validateActivities(values.trainingActivities);
    requireValue(values.training===legacyTraining(values.trainingActivities),'TRAINING_MISMATCH');
  }
}
module.exports={ACTIVITIES,validateActivities,legacyTraining,validateTraining};
