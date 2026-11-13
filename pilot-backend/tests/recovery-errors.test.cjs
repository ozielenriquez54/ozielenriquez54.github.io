'use strict';
// Clasificación de errores de recuperación: límite de solicitudes (HTTP 429) y
// fallos PKCE. Nunca expone mensajes del servidor, tokens ni el enlace.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const auth=require('../../nutrika/pilot-auth.js');
const sdk=require('@supabase/supabase-js');
const origin='http://localhost:3000',token='synthetic_'.repeat(8),secret='synthetic-secret-detail';
const config={projectRef:'otswebncqidqthqplztj',supabaseUrl:'https://otswebncqidqthqplztj.supabase.co',publicKey:'sb_publishable_synthetic',readOnly:true};
const memoryState=()=>{let v=null;return {get:()=>v,set:x=>{v=x;},clear:()=>{v=null;}};};
const noLeak=result=>{const s=JSON.stringify(result);assert.ok(!s.includes(token)&&!s.includes(secret),s);};

test('HTTP 429 al solicitar el correo: estado RATE_LIMITED con el SDK real y transporte saneado',async()=>{
  let requests=0;
  const client=auth.createClient(config,sdk,async()=>{requests++;
    return new Response(JSON.stringify({code:'over_email_send_rate_limit',msg:secret}),{status:429});});
  const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:memoryState()});
  const recovery=await c.email('synthetic@example.invalid',true);
  assert.deepEqual(recovery,{status:'RATE_LIMITED'});noLeak(recovery);
  assert.deepEqual(await c.email('synthetic@example.invalid',false),{status:'RATE_LIMITED'}); // Magic Link comparte el límite
  assert.equal(requests,2); // sin reintentos automáticos
  client.auth.stopAutoRefresh();
});

test('otros errores al solicitar el correo siguen siendo AUTH_FAILED',async()=>{
  for(const status of [400,422,500]){
    const client=auth.createClient(config,sdk,async()=>new Response(JSON.stringify({code:'unexpected',msg:secret}),{status}));
    const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:memoryState()});
    assert.deepEqual(await c.email('synthetic@example.invalid',true),{status:'AUTH_FAILED'});
    client.auth.stopAutoRefresh();
  }
});

test('callback PKCE sin verificador en este navegador: LINK_OTHER_BROWSER, sin red ni sesión',async()=>{
  let requests=0;
  const client=auth.createClient(config,sdk,async()=>{requests++;return new Response('{}');});
  const state=memoryState();
  const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:state});
  const result=await c.callback('synthetic-code-'+token);
  assert.deepEqual(result,{status:'LINK_OTHER_BROWSER'});noLeak(result);
  assert.equal(requests,0);assert.equal(state.get(),null);
  assert.equal((await c.password('synthetic-password')).status,'AUTH_FAILED'); // no habilita el cambio de contraseña
  client.auth.stopAutoRefresh();
});

test('bad_code_verifier y flow_state_not_found atraviesan el transporte saneado y se clasifican como LINK_SUPERSEDED',async()=>{
  for(const code of ['bad_code_verifier','flow_state_not_found']){
    let options;
    auth.createClient(config,{createClient:(_u,_k,o)=>{options=o;return {};}},async()=>new Response(JSON.stringify({code,msg:secret+token}),{status:400}));
    const body=await (await options.global.fetch(config.supabaseUrl+'/auth/v1/token?grant_type=pkce',{method:'POST'})).json();
    assert.equal(body.error_code,code);assert.ok(!JSON.stringify(body).includes(secret));assert.ok(!JSON.stringify(body).includes(token));
  }
  for(const code of ['bad_code_verifier','flow_state_not_found']){
    const state=memoryState();state.set('previous-user');
    const client={auth:{exchangeCodeForSession:async()=>({error:{code,status:400,message:secret}}),updateUser:async()=>{throw new Error('no debe llamarse');}}};
    const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:state});
    const result=await c.callback('synthetic-code');
    assert.deepEqual(result,{status:'LINK_SUPERSEDED'});noLeak(result);assert.equal(state.get(),null);
  }
});

test('429 durante la verificación del enlace: RATE_LIMITED; la seguridad previa no cambia',async()=>{
  const state=memoryState();
  const client={auth:{verifyOtp:async()=>({error:{status:429,message:secret}}),getUser:async()=>({data:{user:{id:'u'}}}),updateUser:async()=>{throw new Error('no debe llamarse');}}};
  const c=auth.controller(client,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:state});
  assert.deepEqual(await c.recovery(token),{status:'RATE_LIMITED'});assert.equal(state.get(),null);
  assert.equal((await c.password('synthetic-password')).status,'AUTH_FAILED');
  // Clasificaciones existentes intactas.
  for(const [error,status] of [[{code:'otp_expired'},'LINK_EXPIRED_OR_USED'],[{code:'flow_state_expired'},'LINK_EXPIRED'],[{code:'bad_jwt'},'RECOVERY_SESSION_MISSING'],
    [{name:'AuthRetryableFetchError',status:503},'RECOVERY_NETWORK'],[{status:500},'RECOVERY_NETWORK'],[{code:'unknown',status:400},'AUTH_FAILED']]){
    const cl={auth:{verifyOtp:async()=>({error:{...error,message:secret}})}};
    assert.deepEqual(await auth.controller(cl,'CLIENT',origin+'/auth/callback.html',{readOnly:true,recoveryState:memoryState()}).recovery(token),{status});
  }
});

test('la interfaz tiene un mensaje propio para cada estado nuevo, sin el texto genérico',async()=>{
  const src=fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8');
  for(const key of ['RATE_LIMITED','LINK_OTHER_BROWSER','LINK_SUPERSEDED']){
    const m=new RegExp(key+":'([^']+)'").exec(src);assert.ok(m,key);
    assert.doesNotMatch(m[1],/No se pudo verificar la recuperación/);
  }
  // El archivo sigue ejecutándose en un contexto aislado (sin red ni datos).
  const context={document:{getElementById:()=>({hidden:true,textContent:''})},location:{pathname:'/index.html',search:'',hash:''},
    URLSearchParams,history:{replaceState(){}},fetch:async()=>({json:async()=>({publicKey:''})})};
  await vm.runInNewContext(src,context);
});
