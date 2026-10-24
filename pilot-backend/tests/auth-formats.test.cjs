'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {controller,parseCallback}=require('../../nutrika/pilot-auth.js');
const token='synthetic_'.repeat(8),tokens={access_token:'synthetic.payload.signature',refresh_token:token};
const fragment=()=> '#'+new URLSearchParams({...tokens,token_type:'bearer',type:'invite',expires_in:'3600'});
function fixture(){
 let marker=null,saved=null;const calls={otp:0,pkce:0,set:0,updates:0};
 const state={id:'client-one',error:null,sessionId:'client-one'};
 const session=()=>({user:{id:state.sessionId}});
 const client={auth:{
  verifyOtp:async()=>{calls.otp++;return state.error?{error:state.error}:{data:{session:session()}};},
  exchangeCodeForSession:async()=>{calls.pkce++;return state.error?{error:state.error}:{data:{session:session(),redirectType:'recovery'}};},
  getUser:async jwt=>{if(jwt)assert.equal(jwt,tokens.access_token);return state.error?{error:state.error}:{data:{user:{id:state.id}}};},
  setSession:async input=>{calls.set++;assert.deepEqual(input,tokens);return {data:{session:session()}};},
  updateUser:async({password})=>{calls.updates++;saved=password;return {data:{user:{id:state.id}}};},
  signInWithPassword:async({password})=>password===saved?{data:{session:session()}}:{error:{}}
 },from(table){const q={select:()=>q,eq:()=>table==='profiles'?Promise.resolve({data:[{id:state.id}]}):q,then(resolve){resolve({data:[{user_id:state.id,roles:['CLIENT'],active:true}]});}};return q;}};
 const make=()=>controller(client,'CLIENT','http://localhost:3000/auth/callback.html',{readOnly:true,recoveryState:{get:()=>marker,set:v=>{marker=v;},clear:()=>{marker=null;}}});
 return {make,state,calls,client,marker:()=>marker};
}
for(const format of ['invite','recovery','implicit-invite','implicit-recovery','pkce'])test(format+': verified password setup and subsequent login',async()=>{
 const f=fixture(),c=f.make();
 const result=format.startsWith('implicit')?await c.implicit(tokens,format.endsWith('invite')?'invite':'recovery'):format==='pkce'?await c.callback('synthetic-code'):await c[format==='invite'?'invitation':format](token);
 assert.equal(result.status,'RECOVERY');assert.equal((await f.make().resumeRecovery()).status,'RECOVERY');
 assert.equal((await c.password('synthetic-password')).status,'PASSWORD_UPDATED');
 assert.equal((await c.login('synthetic@example.test','synthetic-password')).status,'AUTHORIZED');assert.equal(f.calls.updates,1);
});
test('implicit parser accepts only complete unambiguous supported fields',()=>{
 assert.equal(parseCallback('',fragment()).kind,'implicit');
 for(const hash of [fragment()+'&type=recovery',fragment()+'&next=outside',fragment().replace('bearer','other'),fragment().replace('synthetic.payload.signature','altered'),fragment().replace('refresh_token=','missing='),fragment()+'&token_hash='+token])assert.equal(parseCallback('',hash),null);
 assert.equal(parseCallback('?code=test',fragment()),null);
 assert.deepEqual(parseCallback('','#error=access_denied&error_code=otp_expired&error_description=secret'),{kind:'error',status:'LINK_EXPIRED_OR_USED'});
});
test('implicit token rejected by Auth never establishes session or allows password update',async()=>{
 const f=fixture();f.state.error={code:'bad_jwt',message:'private'};const c=f.make();
 assert.equal((await c.implicit(tokens,'invite')).status,'RECOVERY_SESSION_MISSING');await c.password('synthetic-password');
 assert.equal(f.calls.set,0);assert.equal(f.calls.updates,0);
});
test('implicit identity mismatch and prior bound recovery cannot change another password',async()=>{
 const f=fixture(),c=f.make();await c.invitation(token);f.state.id='other';
 assert.equal((await c.implicit(tokens,'invite')).status,'RECOVERY_SESSION_MISMATCH');assert.equal(f.calls.set,0);
 f.state.id='client-one';f.state.sessionId='other';assert.equal((await c.implicit(tokens,'invite')).status,'RECOVERY_SESSION_MISMATCH');
 await c.password('synthetic-password');assert.equal(f.calls.updates,0);
});
test('expired PKCE and consumed OTP produce safe explicit errors',async()=>{
 const f=fixture(),c=f.make();f.state.error={code:'flow_state_expired'};assert.equal((await c.callback('code')).status,'LINK_EXPIRED');
 f.state.error={code:'otp_expired'};assert.equal((await c.invitation(token)).status,'LINK_EXPIRED_OR_USED');assert.equal(f.calls.updates,0);
});
test('ordinary PKCE login never grants password setup capability',async()=>{
 const f=fixture();f.client.auth.exchangeCodeForSession=async()=>({data:{session:{user:{id:'client-one'}},redirectType:null}});
 const c=f.make();assert.equal((await c.callback('code')).status,'AUTHORIZED');
 assert.equal((await c.password('synthetic-password')).status,'AUTH_FAILED');assert.equal(f.calls.updates,0);
});
test('network failure after verified implicit token keeps identity for verified reload',async()=>{
 const f=fixture(),c=f.make();f.client.auth.setSession=async()=>({error:{name:'AuthRetryableFetchError'}});
 assert.equal((await c.implicit(tokens,'recovery')).status,'RECOVERY_NETWORK');assert.equal(f.marker(),'client-one');
 assert.equal((await f.make().resumeRecovery()).status,'RECOVERY');assert.equal(f.calls.otp,0);
});
