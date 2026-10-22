'use strict';
const {snapshotCommand}=require('./gateway-safety.cjs');
const {validateManualMacros}=require('../../nutrika/domain/manual-macros.cjs');
const {createModel}=require('../../nutrika/pilot-macros.js');
const {loadPilotConfig}=require('./pilot-config.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ManualMacrosError extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
const error=(code,status=400)=>new ManualMacrosError(code,status);
function object(value,keys){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k)))throw error('INVALID_MANUAL_COMMAND');}
function target(value){object(value,['gymId','clientId']);if(!UUID.test(value.gymId)||!UUID.test(value.clientId))throw error('INVALID_MANUAL_COMMAND');return value;}
function validate(command){
  object(command,['gymId','clientId','operationId','baseRevision','macros','confirmations']);target({gymId:command.gymId,clientId:command.clientId});
  if(typeof command.operationId!=='string'||!command.operationId.trim()||command.operationId.length>200||!Number.isSafeInteger(command.baseRevision)||command.baseRevision<0||command.baseRevision>=Number.MAX_SAFE_INTEGER)throw error('INVALID_MANUAL_COMMAND');
  try{return validateManualMacros(command.macros,command.confirmations);}
  catch{throw error('INVALID_MANUAL_MACROS_OR_CONFIRMATIONS',422);}
}
function commandSnapshot(value){try{return snapshotCommand(value);}catch{throw error('INVALID_MANUAL_COMMAND');}}
function resultSnapshot(value,command,actor){
  // Never forward arbitrary provider properties, messages or nested metadata.
  const macros=validate(command).macros;
  if(!value||!UUID.test(value.targetId)||value.gymId!==command.gymId||value.clientId!==command.clientId||value.assignedBy!==actor||value.revision!==command.baseRevision+1||
    (command.baseRevision===0?value.previousTargetId!==null:!UUID.test(value.previousTargetId))||!value.macros||Object.keys(macros).some(k=>value.macros[k]!==macros[k])||
    !Number.isFinite(Date.parse(value.effectiveFrom))||!Number.isFinite(Date.parse(value.recordedAt)))throw error('MANUAL_RESULT_UNKNOWN',503);
  return {targetId:value.targetId,gymId:command.gymId,clientId:command.clientId,assignedBy:actor,revision:value.revision,previousTargetId:value.previousTargetId,
    macros,confirmations:validate(command).confirmations,effectiveFrom:value.effectiveFrom,recordedAt:value.recordedAt};
}
function createManualMacrosService({createSession,writeEnabled=false,timeoutMs=15000,assignRpc='pilot_assign_manual_macros'}){
  if(!['pilot_assign_manual_macros','pilot_save_complex_macros'].includes(assignRpc))throw error('INVALID_ASSIGNMENT_RPC');
  function run(token,signal,fn){
    if(typeof token!=='string'||!token||token.length>8192||!/^[A-Za-z0-9._-]+$/.test(token))return Promise.reject(error('AUTH_REQUIRED',401));
    const controller=new AbortController();let writing=false,timer,abort;
    const check=()=>{if(controller.signal.aborted)throw error(writing?'MANUAL_RESULT_UNKNOWN':'MANUAL_REQUEST_ABORTED',503);};
    return new Promise((resolve,reject)=>{
      let active=true;
      const finish=(err,value)=>{if(!active)return;active=false;clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();err?reject(err):resolve(value);};
      abort=()=>finish(error(writing?'MANUAL_RESULT_UNKNOWN':'MANUAL_REQUEST_ABORTED',503));
      if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs);
      Promise.resolve().then(async()=>{
        check();const client=await createSession(token,controller.signal);check();
        const verified=await client.auth.getUser();check();
        if(verified.error||!UUID.test(verified.data?.user?.id??''))throw error('AUTH_REQUIRED',401);
        return fn({client,actor:verified.data.user.id,check,beginWrite(){check();writing=true;}});
      }).then(v=>finish(null,v),e=>finish(e instanceof ManualMacrosError?e:error(writing?'MANUAL_RESULT_UNKNOWN':'MANUAL_SERVICE_UNAVAILABLE',503)));
    });
  }
  function role(value){if(!['COACH','CLIENT'].includes(value))throw error('INVALID_MANUAL_COMMAND');return value;}
  return {
    list({token,role:requestedRole,signal}){return run(token,signal,async({client,check})=>{const list=await createModel(client,role(requestedRole)).list();check();return list;});},
    read({token,role:requestedRole,target:requestedTarget,signal}){
      const dest=target(commandSnapshot(requestedTarget));
      return run(token,signal,async({client,check})=>{const value=await createModel(client,role(requestedRole)).read(dest);check();return value;});
    },
    assign({token,command,signal}){
      if(!writeEnabled)return Promise.reject(error('MANUAL_WRITES_DISABLED',503));
      const snapshot=commandSnapshot(command);validate(snapshot);
      return run(token,signal,async({client,actor,check,beginWrite})=>{
        const allowed=await createModel(client,'COACH').list();check();
        if(!allowed.some(t=>t.gymId===snapshot.gymId&&t.clientId===snapshot.clientId))throw error('42501',403);
        // The unchanged SQL RPC rechecks authorization under its locks, validates
        // energy change against the locked predecessor, and resolves receipt/CAS.
        // No comparison against the latest revision here: old exact replays remain valid.
        beginWrite();const r=await client.rpc(assignRpc,{p_command:snapshot});check();
        if(r.error){
          const statuses={'42501':403,'40001':409,'23514':422,'22023':400,'23503':422};
          const status=typeof r.error.code==='string'&&Object.hasOwn(statuses,r.error.code)?statuses[r.error.code]:undefined;
          throw status?error(r.error.code,status):error('MANUAL_RESULT_UNKNOWN',503);
        }
        return resultSnapshot(r.data,snapshot,actor);
      });
    }
  };
}
function createManualMacrosInfrastructure({env=process.env,fetchImpl=globalThis.fetch,createClient=require('@supabase/supabase-js').createClient}={}){
  const config=loadPilotConfig(env);
  // No environment variable enables remote writes. Deployment needs separate review.
  return createManualMacrosService({writeEnabled:false,createSession(token,signal){
    if(!config.publicKey||env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw error('MANUAL_SERVICE_UNAVAILABLE',503);
    const client=createClient(config.supabaseUrl,config.publicKey,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,debug:false},db:{schema:'public',retry:false},
      global:{headers:{Authorization:'Bearer '+token},fetch:async(input,init={})=>{
        const url=new URL(typeof input==='string'?input:input.url??input.href);
        const method=(init.method??(typeof input==='object'?input.method:undefined)??'GET').toUpperCase();
        const paths=['/auth/v1/user','/rest/v1/gym_memberships','/rest/v1/clients','/rest/v1/coach_clients','/rest/v1/manual_macro_targets','/rest/v1/manual_macro_target_versions'];
        if(signal.aborted||url.origin!==config.supabaseUrl||url.username||url.password||!paths.includes(url.pathname)||!['GET','HEAD'].includes(method))throw error('MANUAL_SERVICE_UNAVAILABLE',503);
        return fetchImpl(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([signal,init.signal,AbortSignal.timeout(10000)]):AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      }}
    });
    return {auth:{getUser:()=>client.auth.getUser(token)},from:table=>client.from(table),rpc:(name,args)=>client.rpc(name,args)};
  }});
}
module.exports={createManualMacrosService,createManualMacrosInfrastructure,ManualMacrosError};
