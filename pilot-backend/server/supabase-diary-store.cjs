'use strict';
const {canonical}=require('../../nutrika/persistence/contracts.cjs');
const {validateRecordData}=require('../../nutrika/domain/tracking/record-validation.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Explicit transaction port shared by pg and disposable test DB; no default
// connection or environment activation. JWT verification is mandatory per call.
function supabaseDiaryStore({transaction,verifySession}){
  async function run(token,target,fn){
    const actor=await verifySession(token);
    if(!UUID.test(actor??'')||!UUID.test(target.gymId??'')||!UUID.test(target.clientId??''))throw new Error('AUTH_OR_TARGET_REJECTED');
    return transaction(tx=>fn(tx,actor));
  }
  const state=async(tx,a,t,date,op)=>(await tx.query('select pilot_private.diary_state($1,$2,$3,$4,$5) value',
    [a,t.gymId,t.clientId,date,op])).rows[0].value;
  return {
    readOwn(token,target,date){return run(token,target,async(tx,a)=>(await state(tx,a,target,date,null)).head);},
    updateOwn(token,target,command,change){return run(token,target,async(tx,a)=>{
      const s=await state(tx,a,target,command.nutritionDate,command.operationId);
      if(s.receipt){if(canonical(s.receipt.command)!==canonical(command))throw new Error('OPERATION_REUSED');return s.receipt.result;}
      const next=await change(s.head,a);validateRecordData(next);
      return (await tx.query('select pilot_private.diary_commit($1,$2,$3,$4,$5::jsonb,$6::jsonb) value',
        [a,target.gymId,target.clientId,command.nutritionDate,JSON.stringify(command),JSON.stringify(next)])).rows[0].value;
    });}
  };
}
function pgDiaryTransaction(pool){return async fn=>{
  let client;try{client=await pool.connect();}catch{throw new Error('DIARY_DATABASE_UNAVAILABLE');}
  let begun=false,broken=false;
  const failed=()=>{broken=true;};client.on?.('error',failed);
  try{
    const identity=(await client.query('select current_user role')).rows[0];
    if(identity?.role!=='pilot_diary_server'){broken=true;throw new Error('DIARY_DATABASE_ROLE_REJECTED');}
    await client.query('begin');begun=true;
    await client.query("set local statement_timeout='15s'; set local lock_timeout='3s'; set local idle_in_transaction_session_timeout='10s'");
    const value=await fn(client);if(broken)throw new Error('CONNECTION_LOST');await client.query('commit');begun=false;return value;
  }catch(e){if(begun)try{await client.query('rollback');}catch{broken=true;}throw new Error(
    ['42501','40001','23514','22023'].includes(e.code)?e.code:'DIARY_RESULT_UNKNOWN');
  }finally{client.removeListener?.('error',failed);client.release(broken);}
};}
module.exports={supabaseDiaryStore,pgDiaryTransaction};
