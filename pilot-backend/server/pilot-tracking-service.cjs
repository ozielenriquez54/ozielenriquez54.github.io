'use strict';
// Local candidate. Requires explicit trusted transaction + Auth verifier; no env/network defaults.
const {canonical}=require('../../nutrika/persistence/contracts.cjs');
const {recordHabits,recordOfficialWeight,HABITS}=require('../../nutrika/domain/tracking/observations.cjs');
const {validateRecordData}=require('../../nutrika/domain/tracking/record-validation.cjs');
const {currentRecords}=require('../../nutrika/domain/tracking/history.cjs');
const {calendarDate,addDays}=require('../../nutrika/domain/dates.cjs');
const {requireValue}=require('../../nutrika/domain/values.cjs');
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function createTrackingService({transaction,verifySession,newId,now,diary}){
  const kinds=['WEIGHT_DAY','HABITS_DAY'];
  async function actor(token,target){
    const a=await verifySession(token);
    requireValue(UUID.test(a??'')&&UUID.test(target?.gymId??'')&&UUID.test(target?.clientId??''),'AUTH_OR_TARGET_REJECTED');return a;
  }
  function command(input){
    requireValue(input&&typeof input==='object'&&!Array.isArray(input),'INVALID_COMMAND');
    const c=structuredClone(input);calendarDate(c.nutritionDate);
    requireValue(kinds.includes(c.kind),'INVALID_KIND');
    const fields=['gymId','clientId','nutritionDate','kind','baseRevision','operationId',...(c.kind==='WEIGHT_DAY'?['weightKg']:['values','completion'])];
    requireValue(Object.keys(c).every(k=>fields.includes(k)),'UNEXPECTED_FIELD');
    requireValue(Number.isSafeInteger(c.baseRevision)&&c.baseRevision>=0&&c.baseRevision<Number.MAX_SAFE_INTEGER,'INVALID_REVISION');
    requireValue(typeof c.operationId==='string'&&c.operationId.length>0&&c.operationId.length<=200,'INVALID_OPERATION');
    return c;
  }
  return {
    async save(token,input){
      const c=command(input),a=await actor(token,c);
      return transaction(async tx=>{
        const s=(await tx.query('select pilot_private.tracking_state($1,$2,$3,$4,$5,$6) value',[a,c.gymId,c.clientId,c.nutritionDate,c.kind,c.operationId])).rows[0].value;
        if(s.receipt){requireValue(canonical(s.receipt.command)===canonical(c),'OPERATION_REUSED');return s.receipt.result;}
        requireValue(c.baseRevision===(s.head?.revision??0),'REVISION_CONFLICT');
        const meta={recordId:newId(),clientId:c.clientId,nutritionDate:c.nutritionDate,actorId:a,at:now()};let record;
        if(c.kind==='WEIGHT_DAY')record=recordOfficialWeight(s.head,meta,c.weightKg);
        else{
          requireValue(c.values&&typeof c.values==='object'&&!Array.isArray(c.values),'INVALID_HABITS');
          const patch=c.completion??{};
          requireValue(patch&&typeof patch==='object'&&!Array.isArray(patch)&&Object.entries(patch).every(([k,v])=>[...HABITS,'training'].includes(k)&&[true,false,null].includes(v)),'INVALID_COMPLETION');
          record={...recordHabits(s.head,meta,c.values),completion:{...Object.fromEntries([...HABITS,'training'].map(k=>[k,null])),...s.head?.completion,...patch}};
        }
        validateRecordData(record);
        return (await tx.query('select pilot_private.tracking_commit($1,$2,$3,$4,$5::jsonb,$6::jsonb) value',[a,c.gymId,c.clientId,c.nutritionDate,JSON.stringify(c),JSON.stringify(record)])).rows[0].value;
      });
    },
    async history(token,target,from,to){
      calendarDate(from);calendarDate(to);
      requireValue(to>=from&&(Date.parse(to)-Date.parse(from))/86400000<=30,'INVALID_DATE_RANGE');
      const a=await actor(token,target);
      const revisions=await transaction(async tx=>(await tx.query('select pilot_private.tracking_history_read($1,$2,$3,$4,$5) value',[a,target.gymId,target.clientId,from,to])).rows[0].value);
      const current=Object.fromEntries(['INTAKE_DAY',...kinds].map(k=>[k,currentRecords(revisions,k,target.clientId)]));
      const publicRevisions=revisions.map(({actorId,...record})=>record);
      const publicRecord=record=>{if(!record)return null;const {actorId,...safe}=record;return safe;};
      const days=[];for(let date=from;;date=addDays(date,1)){
        days.push({date,intake:publicRecord(current.INTAKE_DAY.find(r=>r.nutritionDate===date)),weight:publicRecord(current.WEIGHT_DAY.find(r=>r.nutritionDate===date)),habits:publicRecord(current.HABITS_DAY.find(r=>r.nutritionDate===date))});
        if(date===to)break;
      }
      return {days,revisions:publicRevisions};
    },
    // Reuse the existing own-client food validation/receipts without broadening writes.
    saveFood(token,c){requireValue(diary,'DIARY_DISABLED');return diary.save(token,c);}
  };
}
module.exports={createTrackingService};
