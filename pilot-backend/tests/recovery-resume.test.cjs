'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const auth=require('../../nutrika/pilot-auth.js');
const source=fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8');
const origin='https://twogramms-preprod-test.onrender.com';
const key='twogramms-pilot-recovery',id='00000000-0000-4000-8000-000000000001';
const token='synthetic_'.repeat(8),password='synthetic-new-password';
function fixture(){
 const storage=new Map(),calls={otp:0,user:0,password:0};
 const state={user:id,expired:false};
 const client={auth:{onAuthStateChange(){},
  async setSession(){return {data:{session:{user:{id}}}};},
  async exchangeCodeForSession(){return {data:{session:{user:{id}},redirectType:'recovery'}};},
  async verifyOtp(){calls.otp++;return state.expired?{error:{message:token,code:'otp_expired'}}:{data:{session:{user:{id}}}};},
  async getUser(){calls.user++;if(state.network)return {error:{name:'AuthRetryableFetchError',status:503}};return {data:{user:state.user?{id:state.user}:null},error:state.user?null:{message:'Session missing'}};},
  async updateUser(input){calls.password++;assert.deepEqual(input,{password});return {data:{user:{id}}};}
 },from(){assert.fail('No membership/profile dependency');},rpc(){assert.fail('No business RPC');}};
 async function page(hash='',search=''){
  const els={},element=k=>els[k]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  let cleaned=false;
  const context={document:{body:{dataset:{role:'CLIENT'}},hidden:false,getElementById:element,querySelectorAll:()=>[element('new-password')],addEventListener(){}},
   window:{addEventListener(){}},location:{pathname:'/auth/callback.html',origin,hash,search},
   history:{replaceState(_a,_b,path){assert.equal(path,'/auth/callback.html');cleaned=true;}},
   sessionStorage:{getItem:k=>storage.get(k)??null,setItem(k,v){assert.ok(![token,password].some(s=>String(v).includes(s)));storage.set(k,v);},removeItem:k=>storage.delete(k)},
   fetch:async path=>{assert.ok(cleaned);assert.equal(path,'/pilot-config.json');return {json:async()=>({publicKey:'sb_publishable_test',publicOrigin:origin,readOnly:true,macrosWritable:false,diaryAvailable:false,trackingAvailable:false})};},
   supabase:{},PilotAuth:{...auth,createClient:()=>client},PilotMacrosService:{createModel:()=>({})},
   PilotMacrosUI:{mount:(_root,opts)=>{assert.equal(opts.writer,null);return {clear(){},refresh(){assert.fail('No business access');}};}},
   console:{log(){assert.fail('No logs');},warn(){assert.fail('No logs');},error(){assert.fail('No logs');}},setInterval(){},setTimeout(){}};
  await vm.runInNewContext(source,context);
  return {els,async submit(){element('new-password').value=password;els['password-form'].submit({preventDefault(){}});await new Promise(r=>setImmediate(r));assert.equal(els['new-password'].value,'');}};
 }
 return {storage,state,calls,page};
}
for(const type of ['invite','recovery'])test('implicit '+type+': UI cleans URL, verifies session and shows password form',async()=>{
 const f=fixture(),page=await f.page('#access_token=synthetic.payload.signature&refresh_token='+token+'&token_type=bearer&type='+type);
 assert.equal(page.els['password-form'].hidden,false);assert.equal(page.els['login-form'].hidden,true);
 await page.submit();assert.equal(f.calls.password,1);assert.equal(f.calls.otp,0);assert.equal(f.storage.has(key),false);
});
test('PKCE recovery shows password UI after authenticated exchange',async()=>{
 const f=fixture(),page=await f.page('','?code=synthetic-code');assert.equal(page.els['password-form'].hidden,false);
 await page.submit();assert.equal(f.calls.password,1);assert.equal(f.calls.otp,0);
});
test('Auth error redirect shows safe expiry message and cannot resume an old session',async()=>{
 const f=fixture();f.storage.set(key,id);const page=await f.page('#error=access_denied&error_code=otp_expired&error_description=private-detail');
 assert.equal(page.els['password-form'].hidden,true);assert.equal(f.storage.has(key),false);assert.match(page.els['auth-status'].textContent,/utilizado/);
 assert.ok(!page.els['auth-status'].textContent.includes('private-detail'));assert.equal(f.calls.user,0);
});
for(const type of ['invite','recovery'])test(type+': reload resumes validated identity without reusing OTP or requiring membership',async()=>{
 const f=fixture();let page=await f.page('#token_hash='+token+'&type='+type);
 assert.equal(page.els['password-form'].hidden,false);assert.equal(f.storage.get(key),id);
 assert.equal(f.calls.otp,1);assert.equal(f.calls.user,1);
 page=await f.page();assert.equal(page.els['password-form'].hidden,false);
 assert.equal(f.calls.otp,1);assert.equal(f.calls.user,2);assert.equal(page.els['pilot-access'].hidden,true);
 await page.submit();assert.equal(f.calls.password,1);assert.equal(f.calls.user,3);
 assert.equal(f.storage.has(key),false);assert.equal(page.els['pilot-access'].hidden,true);
 assert.equal(page.els['password-form'].hidden,true);assert.match(page.els['auth-status'].textContent,/Contraseña actualizada/);
});
for(const [scenario,user] of [['absent',null],['wrong','00000000-0000-4000-8000-000000000002']]){
 test('reload rejects '+scenario+' session',async()=>{
  const f=fixture();await f.page('#token_hash='+token+'&type=recovery');f.state.user=user;
  const page=await f.page();assert.equal(page.els['password-form'].hidden,true);assert.equal(f.storage.has(key),false);
  await page.submit();assert.equal(f.calls.password,0);assert.equal(f.calls.otp,1);
 });
 test('password submit rechecks '+scenario+' session after form was shown',async()=>{
  const f=fixture();const page=await f.page('#token_hash='+token+'&type=recovery');f.state.user=user;
  await page.submit();assert.equal(f.calls.password,0);assert.equal(page.els['password-form'].hidden,true);
 });
}
test('expired explicit link cannot fall back to a pending valid session',async()=>{
 const f=fixture();f.storage.set(key,id);f.state.expired=true;
 const page=await f.page('#token_hash='+token+'&type=recovery');
 assert.equal(page.els['password-form'].hidden,true);assert.equal(f.storage.has(key),false);
 await page.submit();assert.equal(f.calls.password,0);assert.equal(f.calls.otp,1);assert.equal(f.calls.user,0);
 assert.ok(!page.els['auth-status'].textContent.includes(token));
});
for(const marker of [null,'1'])test('clean callback rejects '+(marker?'legacy unbound':'missing')+' marker',async()=>{
 const f=fixture();if(marker)f.storage.set(key,marker);const page=await f.page();
 assert.equal(page.els['password-form'].hidden,true);assert.equal(f.calls.user,0);
 await page.submit();assert.equal(f.calls.password,0);assert.equal(f.calls.otp,0);
});
test('malformed callback never resumes an older session',async()=>{
 const f=fixture();f.storage.set(key,id);const page=await f.page('#type=recovery');
 assert.equal(page.els['password-form'].hidden,true);assert.equal(f.calls.user,0);
 assert.equal(f.storage.has(key),false);assert.equal(f.calls.otp,0);
});
test('logout invalidates an in-flight recovery check',async()=>{
 let finish,pending=id,updates=0;
 const client={auth:{getUser:()=>new Promise(r=>{finish=r;}),signOut:async()=>({}),updateUser(){updates++;}}};
 const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true,
  recoveryState:{get:()=>pending,set:v=>{pending=v;},clear:()=>{pending=null;}}});
 const check=c.resumeRecovery();assert.equal((await c.logout()).status,'SIGNED_OUT');
 finish({data:{user:{id}}});assert.equal((await check).status,'AUTH_FAILED');
 assert.equal((await c.password(password)).status,'AUTH_FAILED');assert.equal(updates,0);assert.equal(pending,null);
});
test('Auth password failure exposes no server details and permits a validated retry',async()=>{
 let updates=0;
 const client={auth:{verifyOtp:async()=>({data:{session:{user:{id}}}}),getUser:async()=>({data:{user:{id}}}),
  updateUser:async()=>{updates++;return updates===1?{error:{message:token+password}}:{data:{user:{id}}};}}};
 const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true});
 assert.equal((await c.recovery(token)).status,'RECOVERY');
 assert.deepEqual(await c.password(password),{status:'AUTH_FAILED'});
 assert.equal((await c.password(password)).status,'PASSWORD_UPDATED');assert.equal(updates,2);
 assert.equal((await c.resumeRecovery()).status,'AUTH_FAILED');
});

test('network failure keeps recovery screen separate; retry validates session without another OTP',async()=>{
 const f=fixture();f.state.network=true;
 const page=await f.page('#token_hash='+token+'&type=recovery');
 assert.equal(f.storage.get(key),id);assert.equal(page.els['login-form'].hidden,true);
 assert.equal(page.els['password-form'].hidden,true);assert.equal(page.els['recovery-retry'].hidden,false);
 assert.equal(page.els['recovery-title'].hidden,false);assert.match(page.els['auth-status'].textContent,/conexi/);
 f.state.network=false;page.els['recovery-retry'].click();await new Promise(r=>setImmediate(r));
 assert.equal(page.els['password-form'].hidden,false);assert.equal(page.els['login-form'].hidden,true);
 assert.equal(f.calls.otp,1);assert.equal(f.calls.user,2);assert.equal(f.calls.password,0);
});
