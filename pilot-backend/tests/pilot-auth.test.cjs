'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createClient,controller,storageKeyFor}=require('../../nutrika/pilot-auth.js');
const config={projectRef:'otswebncqidqthqplztj',supabaseUrl:'https://otswebncqidqthqplztj.supabase.co',publicKey:'sb_publishable_synthetic'};
function fixture({roles=['COACH'],active=true,error=false,recovery=false}={}){
  const calls=[];let signedIn=true;
  const result=()=>error?{error:new Error('synthetic-secret-token')}:{data:{}};
  const client={auth:{
    getUser:async()=>signedIn?{data:{user:{id:'synthetic-user',user_metadata:{roles:['COACH']}}}}:{error:new Error('synthetic-secret')},
    signInWithPassword:async args=>{calls.push(['login',args]);return result();},
    signOut:async args=>{calls.push(['logout',args]);signedIn=false;return result();},
    resetPasswordForEmail:async(...args)=>{calls.push(['recover',...args]);return result();},
    signInWithOtp:async args=>{calls.push(['magic',args]);return result();},
    exchangeCodeForSession:async()=>error?result():{data:{redirectType:recovery?'recovery':null,session:{user:{id:'synthetic-user'}}}},
    updateUser:async args=>{calls.push(['password',args]);return result();}
  },rpc:async name=>{calls.push(['rpc',name]);return error?result():{data:{id:'synthetic-user'}};},
  from:name=>{calls.push(['table',name]);const q={select:()=>q,eq:(key,value)=>{calls.push(['filter',key,value]);return key==='active'?Promise.resolve(error?result():{data:[{user_id:'synthetic-user',roles,active}]}):q;}};return q;}};
  return {client,calls,auth:controller(client,'COACH','http://127.0.0.1:3000/auth/callback.html')};
}
test('only pilot config and publishable key accepted; PKCE storage isolated from legacy',async()=>{
  let options,requests=0;
  const sdk={createClient:(url,key,o)=>{assert.equal(url,config.supabaseUrl);options=o;return {};}};
  createClient(config,sdk,async()=>{requests++;return new Response('{}');});
  assert.equal(options.auth.flowType,'pkce');assert.equal(options.auth.storageKey,storageKeyFor(config.projectRef));assert.equal(options.auth.detectSessionInUrl,false);
  for(const change of [{projectRef:'skwjntfknzakhcjlxlnh'},{supabaseUrl:'https://skwjntfknzakhcjlxlnh.supabase.co'},{publicKey:'sb_secret_synthetic'},{publicKey:''}])assert.throws(()=>createClient({...config,...change},sdk,()=>{}),/PILOT_AUTH_FAILED/);
  for(const target of ['https://skwjntfknzakhcjlxlnh.supabase.co/auth/v1/token',config.supabaseUrl+'/rest/v1/rpc/pilot_create_gym',config.supabaseUrl+'/rest/v1/rpc/pilot_set_membership'])await assert.rejects(options.global.fetch(target),/PILOT_AUTH_FAILED/);
  assert.equal(requests,0);
  await options.global.fetch(config.supabaseUrl+'/auth/v1/token');assert.equal(requests,1);
});
test('login creates own profile then checks actual active role; metadata is not authority',async()=>{
  // La vista Coach acepta COACH/OWNER/ADMIN (permiso administrativo separado
  // del clínico); nunca CLIENT. Esto NO otorga el rol COACH en los datos —
  // solo decide qué roles reales dan acceso a esta página en particular.
  for(const [roles,active,expected] of [[['COACH'],true,'AUTHORIZED'],[['OWNER'],true,'AUTHORIZED'],[['ADMIN'],true,'AUTHORIZED'],[['CLIENT'],true,'ROLE_REQUIRED'],[['COACH'],false,'ROLE_REQUIRED'],[[],true,'ROLE_REQUIRED']]){
    const f=fixture({roles,active});assert.equal((await f.auth.login('synthetic@example.test','synthetic-password')).status,expected);
    // pilot_ensure_profile (autoservicio, siempre) y luego
    // pilot_resume_pending_activation (autoservicio, tolerante a que no
    // exista nada pendiente o que la función todavía no exista).
    assert.deepEqual(f.calls.filter(c=>c[0]==='rpc'),[['rpc','pilot_ensure_profile'],['rpc','pilot_resume_pending_activation']]);
    assert.deepEqual(f.calls.find(c=>c[0]==='table'),['table','gym_memberships']);
  }
  const f=fixture({roles:['CLIENT']});const auth=controller(f.client,'CLIENT','http://127.0.0.1:3000/auth/callback.html');
  assert.equal((await auth.verify()).status,'AUTHORIZED');
  // La vista Cliente NO se amplía: ni OWNER ni ADMIN la satisfacen por sí
  // solos — evita que el permiso administrativo cuele acceso clínico.
  for(const roles of [['OWNER'],['ADMIN'],['COACH']]){
    const g=fixture({roles});const clientAuth=controller(g.client,'CLIENT','http://127.0.0.1:3000/auth/callback.html');
    assert.equal((await clientAuth.verify()).status,'ROLE_REQUIRED');
  }
});
// P2 (auditoría sobre el commit 26fd7fc, "errores ocultos"): verify() debía
// distinguir completada/pendiente/bloqueada/fallida en la reanudación
// automática de activación, nunca ocultar un resultado real tras un
// AUTHORIZED/ROLE_REQUIRED genérico. fixture() de arriba usa un rpc() que no
// distingue por nombre (siempre {data:{id:...}}), así que esto necesita su
// propio doble con out_status real, igual al contrato de la función SQL.
function fixtureResume({resume,roles=['CLIENT'],active=true}={}){
  const calls=[];
  const client={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},
    rpc:async name=>{calls.push(['rpc',name]);if(name==='pilot_ensure_profile')return {data:{id:'synthetic-user'}};if(name==='pilot_resume_pending_activation')return resume();return {data:null,error:null};},
    from:name=>{calls.push(['table',name]);const q={select:()=>q,eq:(key,value)=>{calls.push(['filter',key,value]);return key==='active'?Promise.resolve({data:[{user_id:'synthetic-user',roles,active}]}):q;}};return q;}};
  return {client,calls,auth:controller(client,'CLIENT','http://127.0.0.1:3000/auth/callback.html')};
}
test('resume de activación: distingue completada, pendiente, bloqueada y fallida — nunca las oculta tras AUTHORIZED/ROLE_REQUIRED genérico',async()=>{
  // bloqueada (P0: reactivación de privilegios negada)
  let f=fixtureResume({resume:()=>({data:{out_status:'blocked_privileged_role',out_gym_id:'g',out_coach_membership_id:'c'},error:null})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_BLOCKED_PRIVILEGED_ROLE');
  // cancelada (la autorización original ya no es válida)
  f=fixtureResume({resume:()=>({data:{out_status:'cancelled',out_gym_id:'g',out_coach_membership_id:'c'},error:null})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_CANCELLED');
  // completada: nunca interrumpe el flujo normal de verify()
  f=fixtureResume({resume:()=>({data:{out_status:'completed',out_gym_id:'g',out_coach_membership_id:'c'},error:null})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // nada pendiente (sin fila): tampoco interrumpe el flujo normal
  f=fixtureResume({resume:()=>({data:null,error:null})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // la función todavía no existe (infraestructura propuesta no aplicada,
  // 404 -> PILOT_NOT_FOUND): se tolera, nunca rompe la verificación.
  f=fixtureResume({resume:()=>({data:null,error:{code:'PILOT_NOT_FOUND'}})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // un error REAL (permiso denegado, nunca "no existe todavía"): fallo
  // explícito, jamás absorbido en silencio.
  f=fixtureResume({resume:()=>({data:null,error:{code:'42501'}})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_FAILED');
  // P2 (auditoría sobre el commit 60afc33, "error de red"): el COMPORTAMIENTO
  // REAL del SDK de Supabase instalado — confirmado leyendo su código
  // fuente (@supabase/postgrest-js, PostgrestBuilder.ts) — es resolver
  // `{error}` con `code` VACÍO ante un fallo de fetch real, nunca lanzar
  // una excepción (eso solo pasaría con `.throwOnError()`, que este
  // archivo no usa). La prueba ANTERIOR de esta sesión simulaba una
  // excepción lanzada — un caso que la SDK real nunca produce aquí; esta
  // es la forma correcta de reproducirlo.
  f=fixtureResume({resume:()=>({data:null,error:{code:'',message:'TypeError: fetch failed'}})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_NETWORK_ERROR');
  // Defensa en profundidad (no el camino real del SDK actual, pero se
  // conserva por si una versión futura SÍ llegara a lanzar): una excepción
  // con code='PILOT_NETWORK_ERROR' también se distingue de AUTH_FAILED.
  f=fixtureResume({resume:()=>{const e=new Error('PILOT_NETWORK_ERROR');e.code='PILOT_NETWORK_ERROR';throw e;}});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_NETWORK_ERROR');
});
test('magic link never creates users; recovery uses fixed local PKCE callback',async()=>{
  const f=fixture({recovery:true});
  assert.equal((await f.auth.email('synthetic@example.test',false)).status,'EMAIL_SENT');
  assert.equal(f.calls[0][1].options.shouldCreateUser,false);
  assert.equal(f.calls[0][1].options.emailRedirectTo,'http://127.0.0.1:3000/auth/callback.html');
  await f.auth.email('synthetic@example.test',true);
  assert.equal((await f.auth.callback('synthetic-code')).status,'RECOVERY');
  assert.equal((await f.auth.password('synthetic-password')).status,'PASSWORD_UPDATED');
  assert.equal(f.calls.filter(c=>['rpc','table'].includes(c[0])).length,0);
  assert.throws(()=>controller(f.client,'COACH','https://other.example/auth/callback.html'));
});
test('profile RPC accepts a single composite row and rejects missing, foreign or ambiguous rows',async()=>{
  for(const [data,expected] of [[[{id:'synthetic-user'}],'AUTHORIZED'],[[],'AUTH_FAILED'],[[{id:'other'}],'AUTH_FAILED'],[[{id:'synthetic-user'},{id:'other'}],'AUTH_FAILED']]){
    const f=fixture();f.client.rpc=async()=>({data});assert.equal((await f.auth.verify()).status,expected);
  }
});
test('logout invalidates pending role checks and another browser client remains independent',async()=>{
  const a=fixture(),b=fixture();let complete;
  a.client.rpc=()=>new Promise(resolve=>{complete=resolve;});
  const pending=a.auth.verify();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await a.auth.logout()).status,'SIGNED_OUT');complete({data:{id:'synthetic-user'}});
  assert.equal((await pending).status,'SIGNED_OUT');assert.equal((await b.auth.verify()).status,'AUTHORIZED');
  assert.equal((await a.auth.verify()).status,'SIGNED_OUT');
});
test('unexpected errors do not expose tokens, passwords, details or causes',async()=>{
  const f=fixture({error:true});
  for(const result of [await f.auth.login('synthetic','synthetic'),await f.auth.verify(),await f.auth.email('synthetic',false),await f.auth.callback('synthetic'),await f.auth.password('synthetic')]){
    assert.deepEqual(result,{status:'AUTH_FAILED'});assert.ok(!JSON.stringify(result).includes('secret'));
  }
  let options;createClient(config,{createClient:(_u,_k,o)=>{options=o;}},async()=>new Response('synthetic-secret-token',{status:400}));
  const response=await options.global.fetch(config.supabaseUrl+'/auth/v1/token');assert.ok(!(await response.text()).includes('synthetic'));
});
test('callback UI erases code/fragment before loading configuration; missing config stays closed',async()=>{
  const events=[],elements={};const element=id=>elements[id]??=( {hidden:true,textContent:''} );
  const context={document:{getElementById:element},location:{pathname:'/auth/callback.html',search:'?code=synthetic-secret',hash:'#synthetic-token'},
    URLSearchParams,history:{replaceState:(_a,_b,url)=>events.push(['clean',url])},fetch:async()=>{events.push(['fetch']);return {json:async()=>({publicKey:''})};}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  assert.deepEqual(events,[['clean','/auth/callback.html'],['fetch']]);
  assert.equal(elements['pilot-access'].hidden,true);assert.ok(!JSON.stringify(elements).includes('synthetic-secret'));
});
test('administrative transport allows only explicit RPCs and read-only roster; preserves safe SQLSTATE',async()=>{
  let options,calls=0;
  createClient(config,{createClient:(_url,_key,o)=>{options=o;}},async()=>{calls++;return new Response(JSON.stringify({code:'40001',message:'synthetic secret',details:'synthetic token'}),{status:409});},{admin:true});
  const response=await options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_set_membership',{method:'POST'});
  const body=await response.json();assert.equal(body.code,'40001');assert.ok(!JSON.stringify(body).includes('synthetic'));
  await options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_set_coach_client',{method:'POST'});
  await options.global.fetch(config.supabaseUrl+'/rest/v1/coach_clients');
  assert.equal(calls,3);
  for(const [path,method] of [['/rest/v1/gym_memberships','POST'],['/rest/v1/coach_clients','DELETE'],['/rest/v1/rpc/pilot_create_gym','POST'],['/rest/v1/rpc/pilot_set_membership','GET']])await assert.rejects(options.global.fetch(config.supabaseUrl+path,{method}));
  assert.equal(calls,3);
});
