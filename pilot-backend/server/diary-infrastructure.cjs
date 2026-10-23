'use strict';
const {loadPilotConfig}=require('./pilot-config.cjs');
const {loadPostgresConfig}=require('./postgres-config.cjs');
const {supabaseDiaryStore,pgDiaryTransaction}=require('./supabase-diary-store.cjs');
const {realFoodCatalog,loadCatalogApprovalPackage}=require('./real-food-catalog.cjs');
const {createPilotDiary}=require('../../nutrika/application/pilot-diary.cjs');
const {createPersonalFoodService}=require('./personal-food-service.cjs');
const {createTrackingService}=require('./pilot-tracking-service.cjs');
const {randomUUID}=require('node:crypto');
function createDiaryInfrastructure({activate=false,env=process.env,approvals=null,fetchImpl=globalThis.fetch,Pool=require('pg').Pool}={}){
  // No environment switch and no production launcher calls this active factory.
  if(!activate)return {read:async()=>{throw new Error('DIARY_DISABLED');},save:async()=>{throw new Error('DIARY_DISABLED');},foods:()=>[],close:async()=>{}};
  const config=loadPilotConfig(env),packageData=approvals===null?loadCatalogApprovalPackage():null;
  const catalog=packageData?realFoodCatalog(packageData.registry,undefined,packageData.profileManifest):realFoodCatalog(approvals);
  if(!catalog.list().length||!config.publicKey)throw new Error('APPROVED_CATALOG_AND_AUTH_REQUIRED');
  const pool=new Pool(loadPostgresConfig(env,undefined,'pilot_diary_server'));
  pool.on('error',()=>{}); // Never log driver errors/connection credentials.
  async function verifySession(token){
    if(typeof token!=='string'||!/^[A-Za-z0-9._-]{1,8192}$/.test(token))throw new Error('AUTH_REQUIRED');
    try{
      const response=await fetchImpl(config.supabaseUrl+'/auth/v1/user',{method:'GET',redirect:'error',
        headers:{apikey:config.publicKey,Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw new Error();return (await response.json()).id;
    }catch{throw new Error('AUTH_REQUIRED');}
  }
  const store=supabaseDiaryStore({transaction:pgDiaryTransaction(pool),verifySession});
  const transaction=pgDiaryTransaction(pool),personalFoods=createPersonalFoodService({transaction,verifySession,catalog,newId:randomUUID,now:()=>new Date().toISOString()});
  const diary=createPilotDiary({store,resolveFood:catalog.resolve,personalFoods,listSharedFoods:catalog.list,newId:randomUUID,now:()=>new Date().toISOString()});
  const trackingService=createTrackingService({transaction,verifySession,diary,newId:randomUUID,now:()=>new Date().toISOString()});
  return {...diary,trackingService,close:()=>pool.end()};
}
module.exports={createDiaryInfrastructure};
