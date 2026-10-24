'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const auth=require('../../nutrika/pilot-auth.js');
const origin='http://localhost:3000',token='synthetic_'.repeat(8),id='expected-user';
function fixture(){
 let marker=null,user=id,error=null,otp=0,updates=0;
 const client={auth:{verifyOtp:async()=>{otp++;return {data:{session:{user:{id}}}};},getUser:async()=>error?{error}:{data:{user:user?{id:user}:null}},updateUser:async()=>{updates++;return {};}}};
 const state={get:()=>marker,set:v=>{marker=v;},clear:()=>{marker=null;}};
 const controller=()=>auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:state});
 return {controller,client,state,setUser:v=>{user=v;},setError:v=>{error=v;},counts:()=>({otp,updates})};
}
test('temporary verification failure retains identity; reload verifies without consuming OTP again',async()=>{
 const f=fixture();f.setError({name:'AuthRetryableFetchError',message:token,status:503});
 let c=f.controller();assert.deepEqual(await c.recovery(token),{status:'RECOVERY_NETWORK'});
 assert.equal(f.state.get(),id);assert.equal((await c.password('synthetic-password')).status,'AUTH_FAILED');
 f.setError(null);c=f.controller();assert.equal((await c.resumeRecovery()).status,'RECOVERY');
 assert.equal((await c.password('synthetic-password')).status,'PASSWORD_UPDATED');assert.deepEqual(f.counts(),{otp:1,updates:1});
});
test('network retry rejects a foreign session and clears expected identity',async()=>{
 const f=fixture();f.setError({name:'AuthRetryableFetchError'});await f.controller().recovery(token);
 f.setError(null);f.setUser('other-user');const c=f.controller();
 assert.equal((await c.resumeRecovery()).status,'RECOVERY_SESSION_MISMATCH');assert.equal(f.state.get(),null);
 await c.password('synthetic-password');assert.equal(f.counts().updates,0);
});
test('safe errors distinguish expiry, ambiguous reused OTP, network and unknown without echoing details',async()=>{
 for(const [error,status] of [[{code:'flow_state_expired'},'LINK_EXPIRED'],[{code:'otp_expired'},'LINK_EXPIRED_OR_USED'],[{name:'AuthRetryableFetchError'},'RECOVERY_NETWORK'],[{code:'unknown'},'AUTH_FAILED']]){
  const f=fixture();f.client.auth.verifyOtp=async()=>({error:{...error,message:token}});
  assert.deepEqual(await f.controller().recovery(token),{status});assert.equal(f.state.get(),null);
 }
});
test('parser works without URLSearchParams.size and rejects altered or duplicate credentials',()=>{
 class LegacyParams extends URLSearchParams{get size(){return undefined;}}
 const context={module:{exports:{}},URLSearchParams:LegacyParams};
 vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth.js'),'utf8'),context);
 const parse=context.module.exports.parseCallback;
 assert.equal(parse('','#token_hash='+token+'&type=recovery').kind,'recovery');
 assert.equal(parse('?code=synthetic','').kind,'pkce');
 for(const suffix of ['&type=recovery','&next=outside','&token_hash='+token])assert.equal(parse('','#token_hash='+token+'&type=recovery'+suffix),null);
});
test('transport needs no AbortSignal static methods, sanitizes Auth codes and honors cancellation',async()=>{
 const context={module:{exports:{}},URL,URLSearchParams,AbortController,AbortSignal:{},Response,setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth.js'),'utf8'),context);
 let transport,signal;
 const config={projectRef:'otswebncqidqthqplztj',supabaseUrl:'https://otswebncqidqthqplztj.supabase.co',publicKey:'sb_publishable_synthetic',readOnly:true};
 context.module.exports.createClient(config,{createClient:(_u,_k,o)=>{transport=o.global.fetch;}},async(_i,init)=>{signal=init.signal;return new Response(JSON.stringify({code:'otp_expired',message:token}),{status:403});});
 const caller=new AbortController();caller.abort();
 const response=await transport(config.supabaseUrl+'/auth/v1/verify',{method:'POST',signal:caller.signal});
 assert.equal(signal.aborted,true);const body=await response.json();assert.equal(body.error_code,'otp_expired');assert.ok(!JSON.stringify(body).includes(token));
});
test('installed Supabase SDK retains safe OTP classification through the sanitized transport',async()=>{
 const sdk=require('@supabase/supabase-js');
 const config={projectRef:'otswebncqidqthqplztj',supabaseUrl:'https://otswebncqidqthqplztj.supabase.co',publicKey:'sb_publishable_synthetic',readOnly:true};
 let requests=0;
 const client=auth.createClient(config,sdk,async()=>{requests++;return new Response(JSON.stringify({code:'otp_expired',message:token}),{status:403});});
 const result=await client.auth.verifyOtp({type:'recovery',token_hash:token});
 assert.equal(result.error.code,'otp_expired');assert.ok(!result.error.message.includes(token));assert.equal(requests,1);
 client.auth.stopAutoRefresh();
});
