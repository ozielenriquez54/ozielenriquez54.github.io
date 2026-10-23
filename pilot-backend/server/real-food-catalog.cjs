'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {foodRevision,preparationEligibility}=require('../../nutrika/domain/catalog/food.cjs');
const {currentFoods}=require('../../nutrika/domain/catalog/catalog.cjs');
const BASE=path.join(__dirname,'../catalog-review');
const PROFILE_FILE=path.join(BASE,'usda-pilot-profiles-v1.json');
const APPROVAL_FILE=path.join(__dirname,'../catalog-approvals.json');
const nutrientKeys=['kcal','proteinG','carbsG','fatG'];
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function profileSha256(profile){return createHash('sha256').update(canonical(profile),'utf8').digest('hex');}
function datasetSha256(manifest){const {profiles,...metadata}=manifest;return profileSha256(metadata);}
function loadCatalogApprovalPackage(){
  const registry=JSON.parse(fs.readFileSync(APPROVAL_FILE,'utf8'));
  const profileManifest=JSON.parse(fs.readFileSync(PROFILE_FILE,'utf8'));
  return {registry,profileManifest};
}
function extractRealCatalog(source=fs.readFileSync(path.join(__dirname,'../../nutrika/index.html'),'utf8')){
  const block=/var FOODS = \[([\s\S]*?)\n\s*\];/.exec(source)?.[1];
  if(!block)throw new Error('REAL_CATALOG_NOT_FOUND');
  const rows=[],clean=block.replace(/^\s*\/\/.*$/gm,'');
  if(clean.replace(/\{[^{}]*\}/g,'').replace(/[\s,]/g,''))throw new Error('REAL_CATALOG_FORMAT_CHANGED');
  for(const raw of clean.match(/\{[^{}]*\}/g)??[]){
    const line=raw.replace(/\s+/g,' ').trim();
    const m=/^\{key:'([^']+)', name:'([^']+)', kcal:([\d.]+), p:([\d.]+), c:([\d.]+), f:([\d.]+), tags:\[.*\], aliases:\[.*\]\},?$/.exec(line);
    if(!m)throw new Error('REAL_CATALOG_FORMAT_CHANGED');
    const [,key,name,kcal,p,c,f]=m;
    const row={foodId:'legacy:'+key,displayName:name,referenceQuantity:100,referenceUnit:'g',
      kcal:Number(kcal),proteinG:Number(p),carbsG:Number(c),fatG:Number(f)};
    if(![row.kcal,row.proteinG,row.carbsG,row.fatG].every(Number.isFinite))throw new Error('REAL_CATALOG_VALUES_INVALID');
    row.sourceSha256=createHash('sha256').update(line).digest('hex');rows.push(row);
  }
  if(new Set(rows.map(r=>r.foodId)).size!==rows.length)throw new Error('DUPLICATE_REAL_FOOD_ID');
  return rows;
}
function realFoodCatalog(approvals=[],rows=extractRealCatalog(),profileManifest=null){
  let legacyApprovals=approvals,usdaApprovals=[];
  if(!Array.isArray(approvals)){
    if(approvals?.schemaVersion!==2||!Array.isArray(approvals.legacy)||!Array.isArray(approvals.usda))throw new Error('CATALOG_APPROVAL_REGISTRY_INVALID');
    legacyApprovals=approvals.legacy;usdaApprovals=approvals.usda;
  }
  const foods=[];
  for(const approval of legacyApprovals){
    const row=rows.find(r=>r.foodId===approval.foodId);
    if(!row||approval.sourceSha256!==row.sourceSha256)throw new Error('CATALOG_APPROVAL_SOURCE_CHANGED');
    // Approval supplies classification/state only; values always come from source.
    const food=foodRevision({...row,canonicalName:row.displayName,brand:null,barcodes:[],
      category:approval.category,composition:approval.composition,preparationState:approval.preparationState,
      weighingBasis:approval.weighingBasis,accountingPolicy:approval.accountingPolicy,equivalences:[],
      source:{type:'CURATED',provenance:{path:'nutrika/index.html#FOODS',sha256:row.sourceSha256}},
      contributionStatus:'CURATED',validationStatus:'VALIDATED',active:true,nutritionBasis:'PER_REFERENCE_QUANTITY',
      createdBy:approval.validatedBy,createdAt:approval.validatedAt,validatedBy:approval.validatedBy,validatedAt:approval.validatedAt,revision:1});
    if(preparationEligibility(food)!=='ELIGIBLE')throw new Error('APPROVED_FOOD_PREPARATION_INVALID');
    foods.push(food);
  }
  if(usdaApprovals.length){
    if(!profileManifest||profileManifest.schemaVersion!==1||!Array.isArray(profileManifest.profiles)||
      profileManifest.dataset?.provider!=='USDA FoodData Central'||profileManifest.dataset?.dataset!=='SR Legacy')throw new Error('USDA_PROFILE_MANIFEST_REQUIRED');
    if(approvals.datasetSha256!==datasetSha256(profileManifest))throw new Error('USDA_APPROVAL_DATASET_CHANGED');
    const profiles=profileManifest.profiles;
    if(new Set(profiles.map(p=>p.foodId)).size!==profiles.length||new Set(profiles.map(p=>p.fdcId)).size!==profiles.length)throw new Error('USDA_PROFILE_DUPLICATE_ID');
    if(new Set(usdaApprovals.map(a=>a.foodId)).size!==usdaApprovals.length)throw new Error('USDA_APPROVAL_DUPLICATE_ID');
    const profileById=new Map(profiles.map(p=>[p.foodId,p]));
    for(const approval of usdaApprovals){
      const allowedKeys=['foodId','fdcId','profileVersion','profileSha256','validatedBy','validatedAt','approvalBasis'];
      if(Object.keys(approval).some(k=>!allowedKeys.includes(k))||Object.keys(approval).length!==allowedKeys.length)throw new Error('USDA_APPROVAL_SCHEMA_INVALID');
      const profile=profileById.get(approval.foodId);
      if(!profile||profile.fdcId!==approval.fdcId||profile.profileVersion!==approval.profileVersion||
        approval.foodId!==`usda:fdc:${profile.fdcId}`||approval.profileSha256!==profileSha256(profile))throw new Error('USDA_APPROVAL_PROFILE_CHANGED');
      if(!approval.validatedBy||!approval.validatedAt||!approval.approvalBasis)throw new Error('USDA_APPROVAL_PROVENANCE_REQUIRED');
      const food=foodRevision({foodId:profile.foodId,canonicalName:profile.name,displayName:profile.displayName,brand:null,barcodes:[],
        category:profile.category,composition:profile.composition,referenceQuantity:profile.referenceQuantity,referenceUnit:profile.referenceUnit,
        kcal:profile.kcal,proteinG:profile.proteinG,carbsG:profile.carbsG,fatG:profile.fatG,
        preparationState:profile.preparationState,weighingBasis:profile.weighingBasis,accountingPolicy:profile.accountingPolicy,
        nutritionBasis:profile.nutritionBasis,equivalences:[],
        source:{type:'CURATED',provenance:{provider:'USDA FoodData Central',dataset:profileManifest.dataset.dataset,
          release:profileManifest.dataset.release,fdcId:profile.fdcId,url:profile.sourceUrl,sourceDescription:profile.sourceDescription,
          profileVersion:profile.profileVersion,profileSha256:approval.profileSha256,datasetSha256:approvals.datasetSha256}},
        contributionStatus:'CURATED',validationStatus:'VALIDATED',active:true,
        createdBy:approval.validatedBy,createdAt:approval.validatedAt,validatedBy:approval.validatedBy,validatedAt:approval.validatedAt,
        revision:profile.profileVersion,previousRevision:profile.profileVersion===1?null:profile.profileVersion-1});
      if(preparationEligibility(food)!=='ELIGIBLE')throw new Error('APPROVED_FOOD_PREPARATION_INVALID');
      foods.push(food);
    }
  }
  const current=currentFoods(foods);
  const indexed=new Map(current.map(f=>[f.foodId,f]));
  return {list:()=>structuredClone(current),candidates:()=>structuredClone(rows),
    search(query=''){
      const q=String(query).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
      return structuredClone(current.filter(f=>!q||f.displayName.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(q)));
    },
    resolve:async id=>{const found=indexed.get(id);if(!found)throw new Error('FOOD_NOT_APPROVED');return structuredClone(found);}};
}
module.exports={extractRealCatalog,realFoodCatalog,canonical,profileSha256,datasetSha256,loadCatalogApprovalPackage};
