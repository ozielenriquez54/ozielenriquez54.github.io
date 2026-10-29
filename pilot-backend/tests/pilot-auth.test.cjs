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
  let f=fixtureResume({resume:()=>({data:{out_status:'blocked_privileged_role',out_gym_id:'g',out_coach_membership_id:'c'},error:null,status:200})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_BLOCKED_PRIVILEGED_ROLE');
  // cancelada (la autorización original ya no es válida)
  f=fixtureResume({resume:()=>({data:{out_status:'cancelled',out_gym_id:'g',out_coach_membership_id:'c'},error:null,status:200})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_CANCELLED');
  // completada: nunca interrumpe el flujo normal de verify()
  f=fixtureResume({resume:()=>({data:{out_status:'completed',out_gym_id:'g',out_coach_membership_id:'c'},error:null,status:200})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // nada pendiente (sin fila): tampoco interrumpe el flujo normal
  f=fixtureResume({resume:()=>({data:null,error:null,status:200})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // P2 (auditoría sobre el commit a201ed1, "clasificación incorrecta de
  // errores"): la señal correcta para cada caso es `resume.status` (el
  // código HTTP REAL que el SDK conserva, confirmado leyendo
  // PostgrestBuilder.ts), nunca la mera ausencia de `error.code` — un
  // código vacío/ausente NO implica por sí mismo "sin red".
  //
  // la función todavía no existe (infraestructura propuesta no aplicada,
  // HTTP 404 real de PostgREST): se tolera, nunca rompe la verificación.
  f=fixtureResume({resume:()=>({data:null,error:{code:'PGRST202',message:'Could not find the function'},status:404})});
  assert.equal((await f.auth.verify()).status,'AUTHORIZED');
  // un error REAL con código SQL reconocido (permiso denegado, 42501):
  // fallo explícito, jamás absorbido en silencio ni confundido con "no
  // existe todavía" aunque ambos puedan compartir una respuesta sin 2xx.
  f=fixtureResume({resume:()=>({data:null,error:{code:'42501'},status:403})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_FAILED');
  // un conflicto SQL real (23505, unique_violation) — se conserva y se
  // reporta como fallo real, nunca como "nada pendiente" ni como red.
  f=fixtureResume({resume:()=>({data:null,error:{code:'23505'},status:409})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_FAILED');
  // un HTTP 500 SIN código SQL reconocido (error.code queda undefined,
  // exactamente como con un fallo de red) — antes esto se clasificaba
  // como ACTIVATION_NETWORK_ERROR por error; con `status` como señal,
  // 500 es un fallo de SERVIDOR real, no de transporte.
  f=fixtureResume({resume:()=>({data:null,error:{message:'Internal Server Error'},status:500})});
  assert.equal((await f.auth.verify()).status,'ACTIVATION_FAILED');
  // P2 (auditoría sobre el commit 60afc33, "error de red"): el COMPORTAMIENTO
  // REAL del SDK de Supabase instalado — confirmado leyendo su código
  // fuente (@supabase/postgrest-js, PostgrestBuilder.ts) — es resolver
  // `{error, status:0}` ante un fallo de fetch real (nunca hubo respuesta
  // HTTP), nunca lanzar una excepción (eso solo pasaría con
  // `.throwOnError()`, que este archivo no usa). status:0 es la señal —
  // no el código, que también queda vacío en un 500 real (caso de arriba).
  f=fixtureResume({resume:()=>({data:null,error:{code:'',message:'TypeError: fetch failed'},status:0})});
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
  // pilot_create_gym ya NO está en esta lista: es una excepción de
  // autoservicio (como pilot_ensure_profile/pilot_resume_pending_activation),
  // permitida siempre — con o sin `admin` — así que una llamada POST
  // correcta sí debe llegar a fetchImpl; se cubre aparte más abajo.
  for(const [path,method] of [['/rest/v1/gym_memberships','POST'],['/rest/v1/coach_clients','DELETE'],['/rest/v1/rpc/pilot_set_membership','GET']])await assert.rejects(options.global.fetch(config.supabaseUrl+path,{method}));
  assert.equal(calls,3);
});
test('fetch real: conserva 23505 (unique_violation) sin exponer el mensaje crudo, y nunca sustituye el código HTTP real',async()=>{
  // P2 (auditoría sobre el commit a201ed1, "clasificación incorrecta de
  // errores"): 23505 es un conflicto SQL real (p. ej. una fila duplicada
  // por una condición de carrera) que antes se descartaba en silencio
  // junto con cualquier código no reconocido.
  let options;
  createClient(config,{createClient:(_url,_key,o)=>{options=o;}},async()=>new Response(JSON.stringify({code:'23505',message:'duplicate key value (secreto interno)',details:'secreto interno'}),{status:409}),{admin:true});
  const response=await options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_set_membership',{method:'POST'});
  assert.equal(response.status,409); // el código HTTP real nunca se sustituye
  const body=await response.json();
  assert.equal(body.code,'23505');assert.ok(!JSON.stringify(body).includes('secreto'));
});
// pilot_create_gym(p_name text): bootstrap de autoservicio (igual categoría
// que pilot_ensure_profile/pilot_resume_pending_activation) para una cuenta
// SIN ninguna membresía activa todavía — la única vía para crear el primer
// gimnasio+OWNER (ver pilot_create_gym en BASE-LAYER-INSTALL-CLIENT-COACH.sql,
// sección 14). `membership` es mutable para simular que, tras llamar a la
// RPC, la MISMA sesión ya refleja la nueva fila sin pedir un nuevo login.
function fixtureCreateGym({initialRoles=[],failCreateGym=false}={}){
  const calls=[];
  let membership=initialRoles.length?{user_id:'synthetic-user',roles:initialRoles,active:true}:null;
  const client={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},
    rpc:async(name,args)=>{
      calls.push(['rpc',name,args]);
      if(name==='pilot_ensure_profile')return {data:{id:'synthetic-user'}};
      if(name==='pilot_resume_pending_activation')return {data:null,error:null,status:200};
      if(name==='pilot_create_gym'){
        if(failCreateGym)return {data:null,error:{code:'42501'},status:403};
        membership={user_id:'synthetic-user',roles:['OWNER'],active:true};
        return {data:{id:'synthetic-gym',name:args?.p_name},error:null};
      }
      return {data:null,error:null};
    },
    from:name=>{calls.push(['table',name]);const q={select:()=>q,eq:key=>key==='active'?Promise.resolve({data:membership?[membership]:[]}):q};return q;}};
  return {client,calls,auth:controller(client,'COACH','http://127.0.0.1:3000/auth/callback.html')};
}
test('verify(): NO_MEMBERSHIP (cero membresías activas) es distinto de ROLE_REQUIRED (ya pertenece a un gimnasio, solo con otro rol) — solo el primero habilita crear un gimnasio propio',async()=>{
  assert.equal((await fixtureCreateGym().auth.verify()).status,'NO_MEMBERSHIP');
  assert.equal((await fixtureCreateGym({initialRoles:['CLIENT']}).auth.verify()).status,'ROLE_REQUIRED');
  assert.equal((await fixtureCreateGym({initialRoles:['OWNER']}).auth.verify()).status,'AUTHORIZED');
});
test('createGym(): crea el gimnasio sobre auth.uid(), refleja OWNER sin nuevo login, valida el nombre como gyms_name_check (1 a 160) y nunca refleja un gimnasio que la RPC rechazó',async()=>{
  const f=fixtureCreateGym();
  assert.equal((await f.auth.verify()).status,'NO_MEMBERSHIP');
  const result=await f.auth.createGym('  Complex Training  ');
  assert.equal(result.status,'AUTHORIZED');
  assert.deepEqual(f.calls.find(c=>c[1]==='pilot_create_gym'),['rpc','pilot_create_gym',{p_name:'Complex Training'}]);
  assert.equal((await f.auth.verify()).status,'AUTHORIZED'); // misma sesión, sin nuevo login
  for(const bad of ['','   ','x'.repeat(161)]){
    const g=fixtureCreateGym();
    assert.equal((await g.auth.createGym(bad)).status,'AUTH_FAILED');
    assert.ok(!g.calls.some(c=>c[1]==='pilot_create_gym')); // rechazado antes de llamar a la RPC
  }
  const h=fixtureCreateGym();
  assert.equal((await h.auth.createGym('x'.repeat(160))).status,'AUTHORIZED'); // límite exacto permitido
  const failing=fixtureCreateGym({failCreateGym:true});
  assert.deepEqual(await failing.auth.createGym('Complex Training'),{status:'AUTH_FAILED'});
  assert.equal((await failing.auth.verify()).status,'NO_MEMBERSHIP'); // nunca se refleja parcialmente
});
test('pilot_create_gym es alcanzable con la MISMA combinación que usa el runner real (readOnly:true, sin admin ni macros) — nunca por otro método ni otro origin',async()=>{
  let options,calls=0;
  createClient({...config,readOnly:true},{createClient:(_u,_k,o)=>{options=o;}},async()=>{calls++;return new Response(JSON.stringify({id:'synthetic-gym'}));});
  await options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_create_gym',{method:'POST'});
  assert.equal(calls,1);
  await assert.rejects(options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_create_gym')); // sin method -> GET por defecto, rechazado
  await assert.rejects(options.global.fetch('https://skwjntfknzakhcjlxlnh.supabase.co/rest/v1/rpc/pilot_create_gym',{method:'POST'})); // otro origin
  assert.equal(calls,1);
});
// addOwnCoachRole(): un OWNER/ADMIN se agrega a sí mismo el rol COACH
// (pilot_set_membership) para poder asignarse como coach de un cliente.
// `memberships` es mutable para reflejar, tras la RPC, la fila real sin
// pedir un nuevo login; `revisionSeenByRpc` registra con qué
// p_expected_revision se llamó realmente, para probar que viene SIEMPRE
// de una lectura fresca, nunca de un valor fijo en el código.
function fixtureOwnCoachRole({memberships=[{gym_id:'g1',user_id:'synthetic-user',roles:['OWNER'],active:true,revision:1}],failWithCode=null}={}){
  const calls=[];let revisionSeenByRpc=null;
  const state={memberships:memberships.map(m=>({...m}))};
  const client={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},
    rpc:async(name,args)=>{
      calls.push(['rpc',name,args]);
      if(name==='pilot_ensure_profile')return {data:{id:'synthetic-user'}};
      if(name==='pilot_resume_pending_activation')return {data:null,error:null,status:200};
      if(name==='pilot_set_membership'){
        revisionSeenByRpc=args.p_expected_revision;
        if(failWithCode)return {data:null,error:{code:failWithCode},status:409};
        const row=state.memberships.find(m=>m.gym_id===args.p_gym_id&&m.user_id===args.p_user_id);
        if(!row||row.revision!==args.p_expected_revision)return {data:null,error:{code:'40001'},status:409};
        row.roles=args.p_roles;row.active=args.p_active;row.revision+=1;
        return {data:{...row},error:null};
      }
      return {data:null,error:null};
    },
    from:name=>{calls.push(['table',name]);const q={select:()=>q,eq:key=>key==='active'?Promise.resolve({data:state.memberships.filter(m=>m.active)}):q};return q;}};
  return {client,calls,state,get revisionSeenByRpc(){return revisionSeenByRpc;},auth:controller(client,'COACH','http://127.0.0.1:3000/auth/callback.html')};
}
test('verify(): canAddOwnCoachRole solo con exactamente una membresía activa OWNER/ADMIN sin COACH, y solo en la vista Coach — nunca se adivina',async()=>{
  assert.equal((await fixtureOwnCoachRole().auth.verify()).canAddOwnCoachRole,true);
  // ya tiene COACH: nada que ofrecer
  assert.equal((await fixtureOwnCoachRole({memberships:[{gym_id:'g1',user_id:'synthetic-user',roles:['OWNER','COACH'],active:true,revision:1}]}).auth.verify()).canAddOwnCoachRole,false);
  // ni OWNER ni ADMIN: nada que ofrecer (vista Coach accesible solo por COACH puro)
  assert.equal((await fixtureOwnCoachRole({memberships:[{gym_id:'g1',user_id:'synthetic-user',roles:['COACH'],active:true,revision:1}]}).auth.verify()).canAddOwnCoachRole,false);
  // dos gimnasios elegibles a la vez: ambiguo, nunca se adivina cuál
  const two=await fixtureOwnCoachRole({memberships:[
    {gym_id:'g1',user_id:'synthetic-user',roles:['OWNER'],active:true,revision:1},
    {gym_id:'g2',user_id:'synthetic-user',roles:['ADMIN'],active:true,revision:1},
  ]}).auth.verify();
  assert.equal(two.canAddOwnCoachRole,false);
  // la misma condición en la vista Cliente nunca ofrece el botón (es exclusivo de Coach)
  const clientFixture=fixtureOwnCoachRole();
  const clientAuth=controller(clientFixture.client,'CLIENT','http://127.0.0.1:3000/auth/callback.html');
  const clientResult=await clientAuth.verify();
  assert.equal(clientResult.status,'ROLE_REQUIRED'); // la vista Cliente exige CLIENT, no OWNER
  assert.notEqual(clientResult.canAddOwnCoachRole,true);
});
test('addOwnCoachRole(): agrega COACH conservando OWNER, usa auth.uid() y la revisión REAL recién leída, y nunca actúa si es ambiguo o falla la RPC',async()=>{
  const f=fixtureOwnCoachRole();
  const result=await f.auth.addOwnCoachRole();
  assert.equal(result.status,'AUTHORIZED');
  assert.equal(result.canAddOwnCoachRole,false); // ya no es elegible: acaba de obtener COACH
  assert.deepEqual(f.calls.find(c=>c[1]==='pilot_set_membership'),['rpc','pilot_set_membership',{p_gym_id:'g1',p_user_id:'synthetic-user',p_roles:['OWNER','COACH'],p_active:true,p_expected_revision:1}]);
  assert.deepEqual(f.state.memberships[0].roles,['OWNER','COACH']); // conserva OWNER
  assert.equal(f.revisionSeenByRpc,1); // la revisión real leída, nunca un valor fijo
  // sin membresía elegible (ya tiene COACH): nunca llama a la RPC, nunca adivina
  const already=fixtureOwnCoachRole({memberships:[{gym_id:'g1',user_id:'synthetic-user',roles:['OWNER','COACH'],active:true,revision:1}]});
  assert.deepEqual(await already.auth.addOwnCoachRole(),{status:'AUTH_FAILED'});
  assert.ok(!already.calls.some(c=>c[1]==='pilot_set_membership'));
  // ambiguo (dos gimnasios elegibles): nunca llama a la RPC, nunca elige el primero en silencio
  const ambiguous=fixtureOwnCoachRole({memberships:[
    {gym_id:'g1',user_id:'synthetic-user',roles:['OWNER'],active:true,revision:1},
    {gym_id:'g2',user_id:'synthetic-user',roles:['ADMIN'],active:true,revision:1},
  ]});
  assert.deepEqual(await ambiguous.auth.addOwnCoachRole(),{status:'AUTH_FAILED'});
  assert.ok(!ambiguous.calls.some(c=>c[1]==='pilot_set_membership'));
  assert.deepEqual(ambiguous.state.memberships.map(m=>m.roles),[['OWNER'],['ADMIN']]); // ninguna fila se tocó
  // conflicto de revisión real (40001): otra escritura cambió la fila
  // justo ENTRE el select propio y la RPC (la revisión que ve el select
  // ya está vieja frente a lo que la base realmente tiene) — AUTH_FAILED,
  // y la fila nunca se toca por esta llamada.
  const serverRoles=['OWNER'];
  const conflictCalls=[];
  const conflictClient={auth:{getUser:async()=>({data:{user:{id:'synthetic-user'}}})},
    rpc:async(name,args)=>{conflictCalls.push(['rpc',name,args]);
      if(name==='pilot_ensure_profile')return {data:{id:'synthetic-user'}};
      if(name==='pilot_resume_pending_activation')return {data:null,error:null,status:200};
      if(name==='pilot_set_membership'){
        if(args.p_expected_revision!==2)return {data:null,error:{code:'40001'},status:409}; // la base real ya está en revision=2
        serverRoles.length=0;serverRoles.push(...args.p_roles);return {data:{},error:null};
      }
      return {data:null,error:null};},
    from:()=>{const q={select:()=>q,eq:key=>key==='active'?Promise.resolve({data:[{gym_id:'g1',user_id:'synthetic-user',roles:[...serverRoles],active:true,revision:1}]}):q};return q;}}; // el select SIGUE devolviendo revision=1 (desactualizado)
  const conflictAuth=controller(conflictClient,'COACH','http://127.0.0.1:3000/auth/callback.html');
  assert.deepEqual(await conflictAuth.addOwnCoachRole(),{status:'AUTH_FAILED'});
  assert.deepEqual(conflictCalls.find(c=>c[1]==='pilot_set_membership'),['rpc','pilot_set_membership',{p_gym_id:'g1',p_user_id:'synthetic-user',p_roles:['OWNER','COACH'],p_active:true,p_expected_revision:1}]);
  assert.deepEqual(serverRoles,['OWNER']); // nunca se aplicó
  // cualquier otro error de la RPC (p.ej. permiso denegado del lado del
  // servidor): AUTH_FAILED también, nunca se asume éxito.
  const denied=fixtureOwnCoachRole({failWithCode:'42501'});
  assert.deepEqual(await denied.auth.addOwnCoachRole(),{status:'AUTH_FAILED'});
});
test('pilot_set_membership es alcanzable con la MISMA combinación que usa el runner real (readOnly:true, sin admin) — nunca por otro método ni otro origin',async()=>{
  let options,calls=0;
  createClient({...config,readOnly:true},{createClient:(_u,_k,o)=>{options=o;}},async()=>{calls++;return new Response(JSON.stringify({id:'synthetic-membership'}));});
  await options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_set_membership',{method:'POST'});
  assert.equal(calls,1);
  await assert.rejects(options.global.fetch(config.supabaseUrl+'/rest/v1/rpc/pilot_set_membership')); // sin method -> GET, rechazado
  await assert.rejects(options.global.fetch('https://skwjntfknzakhcjlxlnh.supabase.co/rest/v1/rpc/pilot_set_membership',{method:'POST'})); // otro origin
  assert.equal(calls,1);
});
