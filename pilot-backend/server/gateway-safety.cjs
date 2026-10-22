'use strict';
const {types}=require('node:util');
const {DomainError}=require('../../nutrika/domain/values.cjs');
const INPUT_LIMITS=Object.freeze({bytes:65536,depth:16,nodes:2048});
function failure(code){return Object.assign(new Error(code),{code});}

// Accept bounded JSON data only; never invoke getters/toJSON or proxy traps.
// This traversal is synchronous and depth-bounded before structuredClone runs.
function snapshotCommand(command){
  let bytes=0,nodes=0;
  const seen=new WeakSet();
  const add=n=>{bytes+=n;if(bytes>INPUT_LIMITS.bytes)throw failure('COMMAND_LIMIT_EXCEEDED');};
  function visit(value,depth){
    if(depth>INPUT_LIMITS.depth||++nodes>INPUT_LIMITS.nodes)throw failure('COMMAND_LIMIT_EXCEEDED');
    if(typeof value==='string'){
      if(value.length>INPUT_LIMITS.bytes)throw failure('COMMAND_LIMIT_EXCEEDED');
      add(Buffer.byteLength(JSON.stringify(value)));return;
    }
    if(value===null||typeof value==='boolean'){add(5);return;}
    if(typeof value==='number'&&Number.isFinite(value)){add(24);return;}
    if(!value||typeof value!=='object'||types.isProxy(value))throw failure('INVALID_COMMAND');
    const array=Array.isArray(value);
    if(array&&value.length>INPUT_LIMITS.nodes)throw failure('COMMAND_LIMIT_EXCEEDED');
    if(!array&&Object.getPrototypeOf(value)!==Object.prototype)throw failure('INVALID_COMMAND');
    if(seen.has(value))throw failure('INVALID_COMMAND');
    seen.add(value);
    const keys=Reflect.ownKeys(value);
    if(keys.length>INPUT_LIMITS.nodes)throw failure('COMMAND_LIMIT_EXCEEDED');
    add(2);
    for(const key of keys){
      if(array&&key==='length')continue;
      if(typeof key!=='string')throw failure('INVALID_COMMAND');
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw failure('INVALID_COMMAND');
      visit(key,depth+1);add(2);visit(descriptor.value,depth+1);
    }
    seen.delete(value);
  }
  visit(command,0);
  try{return structuredClone(command);}catch{throw failure('INVALID_COMMAND');}
}

const PROVIDER_CODES=new Set(['EVIDENCE_CLIENT_MISMATCH','EVIDENCE_DATE_NOT_CLOSED','EVIDENCE_UNAVAILABLE']);
class EvidenceError extends Error{
  constructor(code,discard=false){super(code);this.code=code;this.discard=discard;}
}
function providerError(error){
  // Never copy arbitrary provider properties, including message/detail/cause.
  let code='EVIDENCE_PROVIDER_FAILED';
  try{if(error instanceof DomainError&&PROVIDER_CODES.has(error.code))code=error.code;}catch{}
  return new EvidenceError(code);
}

function readBoundedEvidence(provider,args,{signal,timeoutMs=5000}={}){
  const controller=new AbortController();
  const deadline=performance.now()+timeoutMs;
  let active=true,pending=0,timer,onAbort;
  return new Promise((resolve,reject)=>{
    const finish=(error,value)=>{
      if(!active)return;
      if(performance.now()>=deadline&&error?.code!=='EVIDENCE_CANCELLED')error=new EvidenceError('EVIDENCE_TIMEOUT',true);
      active=false;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      // Revoke the provider's SQL capability before notifying abort listeners.
      if(pending)error=new EvidenceError(error?.code??'EVIDENCE_QUERY_PENDING',true);
      if(error)reject(error);else resolve(value);
      controller.abort();
    };
    onAbort=()=>finish(new EvidenceError('EVIDENCE_CANCELLED',true));
    const tx={query:async(sql,params)=>{
      if(!active)throw new EvidenceError('EVIDENCE_SCOPE_CLOSED');
      pending++;
      try{return await args.tx.query(sql,params);}finally{pending--;}
    }};
    if(signal?.aborted){onAbort();return;}
    signal?.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>finish(new EvidenceError('EVIDENCE_TIMEOUT',true)),timeoutMs);
    Promise.resolve().then(()=>{
      if(!active)throw new EvidenceError('EVIDENCE_SCOPE_CLOSED');
      return provider({...args,tx,signal:controller.signal});
    }).then(value=>finish(null,value),error=>finish(providerError(error)));
  });
}
module.exports={snapshotCommand,readBoundedEvidence,EvidenceError,INPUT_LIMITS};
