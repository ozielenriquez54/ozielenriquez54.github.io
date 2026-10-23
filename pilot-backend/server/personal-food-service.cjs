'use strict';
const {randomUUID}=require('node:crypto');
const {buildPersonalFood,duplicateKey}=require('../../nutrika/application/personal-foods.cjs');
const {requireValue}=require('../../nutrika/domain/values.cjs');
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

// Explicit application port. Every read/write is scoped by the authenticated
// CLIENT membership, gym and client; no default database or remote activation.
function createPersonalFoodService({transaction,verifySession,catalog,newId=randomUUID,now=()=>new Date().toISOString()}){
  requireValue(typeof transaction==='function'&&typeof verifySession==='function'&&catalog,'PERSONAL_FOOD_INFRASTRUCTURE_REQUIRED');
  async function actor(token,target){
    const id=await verifySession(token);
    requireValue(UUID.test(id??'')&&UUID.test(target?.gymId??'')&&UUID.test(target?.clientId??''),'AUTH_OR_TARGET_REJECTED');
    return id;
  }
  const sharedFoods=()=>catalog.list();
  async function list(token,target){
    const a=await actor(token,target);
    const own=await transaction(async tx=>(await tx.query('select pilot_private.personal_food_list($1,$2,$3) value',[a,target.gymId,target.clientId])).rows[0].value);
    return own??[];
  }
  async function create(token,target,input){
    const a=await actor(token,target),name=input?.displayName;
    requireValue(typeof name==='string','INVALID_FOOD_NAME');
    requireValue(!sharedFoods().some(f=>duplicateKey(f.canonicalName)===duplicateKey(name)),'SHARED_FOOD_ALREADY_EXISTS');
    const food=buildPersonalFood(input,{actorId:a,foodId:newId(),at:now()});
    return transaction(async tx=>(await tx.query('select pilot_private.personal_food_create($1,$2,$3,$4,$5,$6::jsonb) value',
      [a,target.gymId,target.clientId,food.foodId,duplicateKey(food.canonicalName),JSON.stringify(food)])).rows[0].value);
  }
  async function resolveActor(a,target,foodId){
    requireValue(UUID.test(a??'')&&UUID.test(target?.gymId??'')&&UUID.test(target?.clientId??'')&&UUID.test(foodId??''),'AUTH_OR_TARGET_REJECTED');
    const shared=sharedFoods().find(f=>f.foodId===foodId);if(shared)return shared;
    return transaction(async tx=>(await tx.query('select pilot_private.personal_food_resolve($1,$2,$3,$4) value',
      [a,target.gymId,target.clientId,foodId])).rows[0].value);
  }
  async function resolve(token,target,foodId){return resolveActor(await actor(token,target),target,foodId);}
  return {list,create,resolve,resolveActor};
}
module.exports={createPersonalFoodService};
