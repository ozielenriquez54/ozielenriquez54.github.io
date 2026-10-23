'use strict';
const {foodRevision,preparationEligibility}=require('../domain/catalog/food.cjs');
const {normalizeName}=require('../domain/catalog/catalog.cjs');
const {requireValue,number}=require('../domain/values.cjs');

const FIELDS=['displayName','referenceQuantity','referenceUnit','kcal','proteinG','carbsG','fatG','sourceKind','sourceReference','profile'];
function duplicateKey(name){return normalizeName(name).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
// Decimal form controls may submit strings. Never coerce containers, booleans or blanks.
function decimal(value,label,max,{positive=false}={}){
  requireValue(typeof value==='number'||typeof value==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value),'INVALID_'+label);
  const result=number(Number(value),label,{positive});
  requireValue(result<=max,'INVALID_'+label);return result;
}
function buildPersonalFood(input,{actorId,foodId,at}){
  requireValue(input&&typeof input==='object'&&!Array.isArray(input),'INVALID_PERSONAL_FOOD');
  requireValue(Object.keys(input).every(k=>FIELDS.includes(k)),'UNEXPECTED_PERSONAL_FOOD_FIELD');
  requireValue(typeof input.displayName==='string'&&input.displayName.trim().length>=2&&input.displayName.trim().length<=100,'INVALID_FOOD_NAME');
  requireValue(['LABEL','MANUAL'].includes(input.sourceKind),'INVALID_FOOD_SOURCE_KIND');
  requireValue(input.sourceReference===undefined||typeof input.sourceReference==='string'&&input.sourceReference.length<=300,'INVALID_FOOD_SOURCE_REFERENCE');
  requireValue(duplicateKey(input.displayName).length>=2,'INVALID_FOOD_NAME');
  if(input.sourceKind==='MANUAL')requireValue(typeof input.sourceReference==='string'&&input.sourceReference.trim().length>=2&&input.sourceReference.trim().length<=300,'FOOD_SOURCE_NOTE_REQUIRED');
  const vegetable=input.profile==='VEGETABLE_ZERO';
  requireValue(vegetable||['COOKED_PROTEIN','DRY','AS_SOLD'].includes(input.profile),'INVALID_FOOD_PROFILE');
  let category='OTHER',preparationState='AS_SOLD',weighingBasis='AS_SOLD',accountingPolicy={id:'STANDARD',version:1};
  if(input.profile==='COOKED_PROTEIN'){category='COOKING_PROTEIN';preparationState='COOKED';weighingBasis='COOKED';}
  if(input.profile==='DRY'){category='DRY_STARCH';preparationState='DRY';weighingBasis='RAW_DRY';}
  if(vegetable){category='VEGETABLE';preparationState='RAW';weighingBasis='UNWEIGHED';accountingPolicy={id:'VEGETABLE_ZERO',version:1};}
  const keys=['kcal','proteinG','carbsG','fatG'];let nutrients;
  if(vegetable&&keys.every(k=>input[k]===undefined||input[k]===null||input[k]===''))nutrients=Object.fromEntries(keys.map(k=>[k,null]));
  else{
    requireValue(keys.every(k=>input[k]!==undefined&&input[k]!==null&&input[k]!==''),'ALL_MACROS_REQUIRED');
    nutrients=Object.fromEntries(keys.map(k=>[k,decimal(input[k],k,k==='kcal'?10000:1000)]));
  }
  const units=['g','ml','pieza','porcion','taza','cucharada','cucharadita','scoop'];
  const hasReference=input.referenceQuantity!==undefined&&input.referenceQuantity!==null&&input.referenceQuantity!=='';
  const checkedQty=(!vegetable||hasReference)?decimal(input.referenceQuantity,'REFERENCE_QUANTITY',1000,{positive:true}):null;
  if(checkedQty!==null)requireValue(checkedQty>=0.01&&(input.referenceUnit==='g'||input.referenceUnit==='ml'||checkedQty<=100),'INVALID_REFERENCE_QUANTITY');
  requireValue(vegetable&&(input.referenceUnit===undefined||input.referenceUnit===null||input.referenceUnit==='')||units.includes(input.referenceUnit),'REFERENCE_UNIT_REQUIRED');
  const refQty=vegetable?null:checkedQty;
  const referenceUnit=vegetable?null:input.referenceUnit;
  if(!vegetable){
    requireValue(refQty>=0.01&&(referenceUnit==='g'||referenceUnit==='ml'||refQty<=100),'INVALID_REFERENCE_QUANTITY');
    if(referenceUnit==='g')requireValue(['proteinG','carbsG','fatG'].every(k=>nutrients[k]<=refQty*1.01)&&nutrients.kcal<=refQty*10,'INVALID_NUTRIENT_DENSITY');
  }
  const displayName=input.displayName.trim().replace(/\s+/g,' '),canonicalName=displayName;
  const sourceKind=input.sourceKind,sourceReference=(input.sourceReference??'').trim().slice(0,300);
  const food=foodRevision({foodId,canonicalName,displayName,brand:null,barcodes:[],category,composition:'SINGLE_INGREDIENT',
    source:{type:'MANUAL',provenance:{kind:sourceKind,reference:sourceReference||null}},contributionStatus:'USER_CONTRIBUTED',
    validationStatus:'PENDING_VALIDATION',active:true,nutritionBasis:'PER_REFERENCE_QUANTITY',referenceQuantity:refQty,referenceUnit,
    ...nutrients,preparationState,weighingBasis,accountingPolicy,equivalences:[],createdBy:actorId,createdAt:at,
    revision:1,previousRevision:null,validatedBy:null,validatedAt:null});
  requireValue(preparationEligibility(food)==='ELIGIBLE','INVALID_FOOD_PREPARATION');
  return food;
}
module.exports={buildPersonalFood,duplicateKey};
