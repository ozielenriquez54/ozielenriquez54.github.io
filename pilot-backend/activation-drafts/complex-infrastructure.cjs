'use strict';
// Prepared composition ONLY. Not imported by the existing production launcher.
// No automatic start, migration, GRANT or scope population; explicit future activation.
const {loadPilotConfig}=require('../server/pilot-config.cjs');
const {createManualMacrosService}=require('../server/manual-macros-service.cjs');
const {createDiaryInfrastructure}=require('../server/diary-infrastructure.cjs');
const {createPilotServer}=require('../server/pilot-http.cjs');
function createScopedMacros({env,fetchImpl=globalThis.fetch,createClient=require('@supabase/supabase-js').createClient}){
  const config=loadPilotConfig(env);
  if(!config.publicOrigin||!config.publicKey||env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw new Error('SECURE_PILOT_CONFIGURATION_REQUIRED');
  return createManualMacrosService({writeEnabled:true,assignRpc:'pilot_save_complex_macros',createSession(token,signal){
    const client=createClient(config.supabaseUrl,config.publicKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
      db:{schema:'public',retry:false},global:{headers:{Authorization:'Bearer '+token},fetch:(input,init={})=>{
        const url=new URL(typeof input==='string'?input:input.url??input.href),method=(init.method??input.method??'GET').toUpperCase();
        const read=['/auth/v1/user','/rest/v1/gym_memberships','/rest/v1/clients','/rest/v1/coach_clients','/rest/v1/manual_macro_targets','/rest/v1/manual_macro_target_versions'];
        if(url.origin!==config.supabaseUrl||url.username||url.password||signal.aborted||
          !(read.includes(url.pathname)&&['GET','HEAD'].includes(method)||url.pathname==='/rest/v1/rpc/pilot_save_complex_macros'&&method==='POST'))throw new Error('TRANSPORT_REJECTED');
        return fetchImpl(input,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      }}});
    return {auth:{getUser:()=>client.auth.getUser(token)},from:t=>client.from(t),rpc:(n,args)=>client.rpc(n,args)};
  }});
}
function prepareComplexServer({activate=false,env=process.env,approvals=null}={}){
  if(!activate)return createPilotServer({env,readOnly:true});
  const config=loadPilotConfig(env);if(!config.publicOrigin)throw new Error('HTTPS_ORIGIN_REQUIRED');
  const macros=createScopedMacros({env});const diary=createDiaryInfrastructure({activate:true,env,approvals});
  const app=createPilotServer({env,manualMacrosService:macros,diaryService:diary,trackingService:diary.trackingService,manualMacrosWriteEnabled:true});
  return {...app,closeDatabase:()=>diary.close()};
}
module.exports={createScopedMacros,prepareComplexServer};
