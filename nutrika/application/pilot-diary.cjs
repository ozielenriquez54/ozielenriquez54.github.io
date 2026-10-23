'use strict';
// Trusted application boundary. No network, environment keys or implicit adapter.
const {entryFromFood,changeDay,unrecordedDay}=require('../domain/tracking/diary.cjs');
const {calendarDate}=require('../domain/dates.cjs');
const {requireValue}=require('../domain/values.cjs');
function createPilotDiary({store,resolveFood,newId,now,personalFoods=null,listSharedFoods=()=>[]}){
  function input(command){
    requireValue(command&&typeof command==='object','INVALID_DIARY_COMMAND');
    const copy=structuredClone(command);calendarDate(copy.nutritionDate);
    requireValue(typeof copy.operationId==='string'&&copy.operationId.length>0&&copy.operationId.length<=200,'INVALID_OPERATION');
    requireValue(Number.isSafeInteger(copy.baseRevision)&&copy.baseRevision>=0&&copy.baseRevision<Number.MAX_SAFE_INTEGER,'INVALID_REVISION');
    return copy;
  }
  return {
    async foods(session,target){
      const shared=await listSharedFoods();
      return [...shared,...(personalFoods?await personalFoods.list(session,target):[])];
    },
    createFood(session,command){
      requireValue(personalFoods,'PERSONAL_FOODS_DISABLED');
      requireValue(command&&typeof command==='object'&&Object.keys(command).every(k=>['gymId','clientId','food'].includes(k)),'INVALID_PERSONAL_FOOD_COMMAND');
      return personalFoods.create(session,{gymId:command.gymId,clientId:command.clientId},command.food);
    },
    read(session,target,date){calendarDate(date);return store.readOwn(session,structuredClone(target),date)
      .then(r=>r??unrecordedDay(target.clientId,date));},
    async save(session,command){
      const c=input(command);
      let addedFood=null;
      if(c.type==='ADD'){
        try{addedFood=await resolveFood(c.foodId);}catch(e){if(e?.message!=='FOOD_NOT_APPROVED')throw e;}
        if(!addedFood&&personalFoods)addedFood=await personalFoods.resolve(session,{gymId:c.gymId,clientId:c.clientId},c.foodId);
        requireValue(addedFood&&addedFood.foodId===c.foodId,'FOOD_NOT_FOUND');
      }
      return store.updateOwn(session,{gymId:c.gymId,clientId:c.clientId},c,async(previous,actor)=>{
        requireValue(c.baseRevision===(previous?.revision??0),'REVISION_CONFLICT');
        const at=now(),meta={recordId:newId(),clientId:c.clientId,nutritionDate:c.nutritionDate,actorId:actor,at};
        let action;
        if(c.type==='ADD'){
          action={type:'ADD',entry:entryFromFood({entryId:newId(),clientId:c.clientId,
            nutritionDate:c.nutritionDate,mealId:c.mealId,mealType:c.mealType,createdAt:at},addedFood,c.amount,
            {actorUserId:actor,ownerUserId:actor})};
        }else if(c.type==='REPLACE'){
          const previousEntry=previous?.entries?.find(e=>e.entryId===c.entryId);
          requireValue(previousEntry&&c.foodId===previousEntry.foodSnapshot.definitionSnapshot.foodId,'ENTRY_NOT_FOUND');
          const definition=previousEntry.foodSnapshot.definitionSnapshot;
          action={type:'REPLACE',entryId:c.entryId,entry:entryFromFood({entryId:c.entryId,clientId:c.clientId,
            nutritionDate:c.nutritionDate,mealId:previousEntry.mealId,mealType:previousEntry.mealType,createdAt:previousEntry.createdAt},definition,c.amount,
            {actorUserId:actor,ownerUserId:actor})};
        }else{
          requireValue(['COMPLETE','REOPEN','REMOVE'].includes(c.type),'INVALID_DIARY_ACTION');
          action={type:c.type,entryId:c.entryId,confirmZero:c.confirmZero===true};
        }
        return changeDay(previous,meta,action);
      });
    }
  };
}
module.exports={createPilotDiary};
