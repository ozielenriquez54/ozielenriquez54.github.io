'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const auth=require('../../nutrika/pilot-auth.js');
const origin='https://twogramms-preprod-test.onrender.com',token='synthetic_'.repeat(8);

for(const type of ['invite','recovery']){
 test(type+': strict fragment parsing rejects ambiguous credentials',()=>{
  assert.deepEqual(auth.parseCallback('','#token_hash='+token+'&type='+type),{kind:type,value:token});
  for(const value of ['', 'short', 'x'.repeat(2049), 'white space', '%0Atoken'])
   assert.equal(auth.parseCallback('','#token_hash='+value+'&type='+type),null);
  for(const suffix of ['&type='+type,'&token_hash='+token,'&next=https://outside.invalid','&access_token=secret'])
   assert.equal(auth.parseCallback('','#token_hash='+token+'&type='+type+suffix),null);
  assert.equal(auth.parseCallback('?code=synthetic','#token_hash='+token+'&type='+type),null);
  assert.equal(auth.parseCallback('?token_hash='+token+'&type='+type,''),null);
 });

 for(const scenario of ['valid','expired','used','mismatch','missing-session','network']){
  test(type+': UI '+scenario+' keeps credentials private and business writes closed',async()=>{
   let clean=false,verified=0,updates=0,profileReads=0;const els={},storage=new Map();
   const element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
   const client={auth:{
    onAuthStateChange(){},
    async verifyOtp(input){assert.ok(clean);verified++;assert.deepEqual(input,{token_hash:token,type});
     if(scenario==='network')throw new Error(token);
     if(['expired','used'].includes(scenario))return {error:{message:token,code:'otp_expired'}};
     return {data:{session:scenario==='missing-session'?null:{user:{id:'pilot-client'}}}};
    },
    async getUser(){return {data:{user:{id:scenario==='mismatch'?'different-client':'pilot-client'}}};},
    async updateUser(input){updates++;assert.ok(clean);assert.deepEqual(input,{password:'synthetic-new-password'});return {data:{user:{id:'pilot-client'}}};}
   },from(table){profileReads++;assert.equal(table,'profiles');return {select:()=>({eq:async()=>({data:[]})})};},
   rpc(){assert.fail('No provisioning or business RPC permitted');}};
   const context={document:{hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,
     querySelectorAll:()=>[element('new-password')],addEventListener(){}},window:{addEventListener(){}},
    location:{pathname:'/auth/callback.html',origin,search:'',hash:'#token_hash='+token+'&type='+type},
    history:{replaceState(_state,_title,url){assert.equal(url,'/auth/callback.html');clean=true;}},
    sessionStorage:{getItem:k=>storage.get(k)??null,setItem(k,v){assert.ok(!String(v).includes(token));storage.set(k,v);},removeItem:k=>storage.delete(k)},
    fetch:async url=>{assert.ok(clean);assert.equal(url,'/pilot-config.json');return {json:async()=>({publicKey:'sb_publishable_test',publicOrigin:origin,readOnly:true,macrosWritable:false,diaryAvailable:false,trackingAvailable:false})};},
    supabase:{},PilotAuth:{...auth,createClient:()=>client},
    PilotMacrosService:{createModel:()=>({})},PilotMacrosUI:{mount:(_el,options)=>{assert.equal(options.writer,null);return {clear(){},refresh(){},revalidate(){}};}},
    console:{log(){assert.fail('No logs');},error(){assert.fail('No error logs');},warn(){assert.fail('No warning logs');}},setInterval(){},setTimeout(){}};
   await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
   assert.equal(verified,1);assert.equal(profileReads,0);assert.equal(els['pilot-access'].hidden,true);
   assert.equal(els['password-form'].hidden,scenario!=='valid');
   element('new-password').value='synthetic-new-password';
   els['password-form'].submit({preventDefault(){}});await new Promise(r=>setImmediate(r));
   assert.equal(updates,scenario==='valid'?1:0);assert.equal(els['new-password'].value,'');
   assert.equal(els['pilot-access'].hidden,true);assert.equal(profileReads,0);
   assert.ok(!els['auth-status'].textContent.includes(token));
  });
 }
}

test('recovery rejects invalid token before contacting Auth and sanitizes password errors',async()=>{
 let called=0;
 const client={auth:{verifyOtp(){called++;},updateUser:async()=>({error:{message:token}})}};
 const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true});
 for(const t of [null,true,[],{},' ',token+'!'])assert.deepEqual(await c.recovery(t),{status:'AUTH_FAILED'});
 assert.equal(called,0);
 assert.deepEqual(await c.password('synthetic-new-password'),{status:'AUTH_FAILED'});
});
