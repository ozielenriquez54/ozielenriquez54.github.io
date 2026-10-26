'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {prepareRender}=require('../server/render-readonly.cjs');
const {controller,parseCallback,createClient}=require('../../nutrika/pilot-auth.js');
const origin='https://twogramms-test.onrender.com',token='a'.repeat(64);
test('Render serves both surfaces, rejects wrong host and keeps business writes closed',async()=>{
  const app=prepareRender({env:{RENDER_EXTERNAL_URL:origin,PORT:'10000',PILOT_SUPABASE_PUBLIC_KEY:'sb_publishable_test',DIARY_ENABLED:'true',MACROS_WRITE_ENABLED:'true'}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const request=(path,method='GET',host=new URL(origin).host)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:app.server.address().port,path,method,headers:{host,origin,authorization:'Bearer synthetic','content-type':'application/json'}},res=>{
      let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
  try{
    for(const path of ['/','/coach.html','/auth/callback.html','/vendor/supabase.js'])assert.equal((await request(path)).status,200);
    const config=JSON.parse((await request('/pilot-config.json')).body);
    assert.equal(config.readOnly,true);assert.equal(config.macrosWritable,false);assert.equal(config.diaryAvailable,false);
    // Regresión (auditoría Codex sobre el commit 9462850, "integración
    // Render"): el servicio de alta de clientes debe estar realmente
    // conectado en el arranque de Render — ni ausente del todo (como antes
    // de esta corrección) ni devolviendo 404 por culpa de una guarda de
    // readOnly demasiado amplia (`/pilot-admin*` atrapaba por prefijo la
    // ruta nueva `/pilot-admin-provisioning-ui.js`).
    assert.equal(config.adminProvisioningAvailable,true);
    const provisioningUi=await request('/pilot-admin-provisioning-ui.js');
    assert.equal(provisioningUi.status,200);assert.ok(provisioningUi.body.length>0);
    assert.ok((await request('/coach.html')).body.includes('/pilot-admin-provisioning-ui.js'));
    for(const path of ['/admin.html','/pilot-admin.js','/pilot-admin-ui.js','/.env','/pilot-backend/audit-005-evidence/test.json'])assert.equal((await request(path)).status,404);
    assert.equal((await request('/','GET','evil.example')).status,403);
    assert.equal((await request('/api/diary/save','POST')).status,503);
    assert.equal((await request('/api/manual-macros/assign','POST')).status,503);
  }finally{await new Promise(r=>app.server.close(r));}
  for(const env of [{},{RENDER_EXTERNAL_URL:'http://bad.onrender.com'},{RENDER_EXTERNAL_URL:origin,PORT:'bad'}])assert.throws(()=>prepareRender({env}));
});
test('invite parsing rejects bearer fragments, duplicates, mixed credentials and redirects',()=>{
  assert.deepEqual(parseCallback('','#token_hash='+token+'&type=invite'),{kind:'invite',value:token});
  assert.deepEqual(parseCallback('','#token_hash='+token+'&type=recovery'),{kind:'recovery',value:token});
  assert.deepEqual(parseCallback('?code=abc',''),{kind:'pkce',value:'abc'});
  for(const [s,h] of [['?token_hash='+token+'&type=invite',''],['?code=x','#token_hash='+token+'&type=invite'],['','#access_token=x'],['','#token_hash='+token+'&type=invite&type=invite'],['','#token_hash='+token+'&type=signup'],['?code=x&next=https://evil.test','']])assert.equal(parseCallback(s,h),null);
});
test('invite verifies OTP and server user; expired or mismatched credentials fail without profile writes',async()=>{
  let otp=0,rpc=0;
  const client={auth:{verifyOtp:async args=>{otp++;assert.deepEqual(args,{token_hash:token,type:'invite'});return {data:{session:{user:{id:'client'}}}};},getUser:async()=>({data:{user:{id:'client'}}})},rpc:()=>rpc++};
  const auth=controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true});
  assert.equal((await auth.invitation(token)).status,'RECOVERY');assert.equal(rpc,0);
  assert.equal((await auth.invitation('bad')).status,'AUTH_FAILED');assert.equal(otp,1);
  client.auth.getUser=async()=>({data:{user:{id:'other'}}});assert.equal((await auth.invitation(token)).status,'RECOVERY_SESSION_MISMATCH');
  client.auth.verifyOtp=async()=>({error:{message:'SECRET'}});assert.deepEqual(await auth.invitation(token),{status:'AUTH_FAILED'});
});
test('read-only auth still ensures the caller\'s own profile (identity exception) but transport blocks every other RPC',async()=>{
  // pilot_ensure_profile() crea EXCLUSIVAMENTE profiles.id de quien llama
  // (auth.uid() interno, ON CONFLICT DO NOTHING) — se permite siempre,
  // incluso en readOnly, porque no existe trigger que cree profiles por
  // otra vía y es una excepción de identidad, no una función clínica.
  let rpc=0;const rpcNames=[];
  const q={select:()=>q,eq:()=>q,then:resolve=>resolve({data:[]})};
  const client={auth:{getUser:async()=>({data:{user:{id:'client'}}})},from:()=>q,rpc:name=>{rpc++;rpcNames.push(name);return {data:{id:'client'},error:null};}};
  assert.equal((await controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true}).verify()).status,'ROLE_REQUIRED');
  // pilot_ensure_profile (crea/confirma el propio perfil) y luego
  // pilot_resume_pending_activation (autoservicio, tolerante) — ambas
  // excepciones de identidad permitidas incluso en readOnly.
  assert.equal(rpc,2);assert.deepEqual(rpcNames,['pilot_ensure_profile','pilot_resume_pending_activation']);
  const base='https://otswebncqidqthqplztj.supabase.co';
  let transport,allowedCalls=0;
  // El allowlist deja pasar ambas RPC de identidad hasta el fetch real: se
  // prueba con un fetchImpl que SÍ responde, para distinguir "lo deja
  // pasar" de "lo deja pasar pero igual falla por otra razón".
  createClient({projectRef:'otswebncqidqthqplztj',supabaseUrl:base,publicKey:'sb_publishable_test',readOnly:true},{createClient:(_u,_k,o)=>{transport=o.global.fetch;}},()=>{allowedCalls++;return new Response('{}',{status:200});},{admin:true});
  await assert.doesNotReject(transport(base+'/rest/v1/rpc/pilot_ensure_profile',{method:'POST'}));
  await assert.doesNotReject(transport(base+'/rest/v1/rpc/pilot_resume_pending_activation',{method:'POST'}));
  assert.equal(allowedCalls,2);
  let rejectedTransport;
  createClient({projectRef:'otswebncqidqthqplztj',supabaseUrl:base,publicKey:'sb_publishable_test',readOnly:true},{createClient:(_u,_k,o)=>{rejectedTransport=o.global.fetch;}},()=>assert.fail('network must remain unused'),{admin:true});
  for(const name of ['pilot_set_membership','pilot_set_coach_client','pilot_assign_manual_macros'])await assert.rejects(rejectedTransport(base+'/rest/v1/rpc/'+name,{method:'POST'}));
  await assert.rejects(rejectedTransport(base+'/auth/v1/signup',{method:'POST'}));
});

test('invitation UI cleans URL before requests, uses CLIENT and enables password form only after verification',async()=>{
  const vm=require('node:vm'),fs=require('node:fs');let clean=false,accepted=0,selected;
  const els={},element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const context={document:{hidden:false,body:{dataset:{role:'COACH'}},getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){}},location:{pathname:'/auth/callback.html',origin,search:'',hash:'#token_hash='+token+'&type=invite'},
    history:{replaceState(){clean=true;}},sessionStorage:{getItem:()=> 'COACH',setItem(){},removeItem(){}},
    fetch:async()=>{assert.ok(clean);return {json:async()=>({publicKey:'sb_publishable_test',publicOrigin:origin,readOnly:true})};},supabase:{},
    PilotAuth:{parseCallback,createClient:()=>({auth:{onAuthStateChange(){}}}),controller:(_c,role,_u,opts)=>{
      selected=role;assert.equal(opts.readOnly,true);return {invitation:async value=>{assert.ok(clean);assert.equal(value,token);accepted++;return {status:'RECOVERY'};},password:async()=>({status:'PASSWORD_UPDATED'})};}},
    PilotMacrosService:{createModel:()=>({})},PilotMacrosUI:{mount:()=>({clear(){},refresh(){},revalidate(){}})},setInterval(){},setTimeout(){}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  assert.equal(selected,'CLIENT');assert.equal(accepted,1);assert.equal(els['password-form'].hidden,false);assert.equal(els['pilot-access'].hidden,true);
  els['new-password']=element('new-password');els['new-password'].value='synthetic-password';
  els['password-form'].submit({preventDefault(){}});await new Promise(r=>setImmediate(r));assert.equal(els['pilot-access'].hidden,true);
});

test('proyecto Supabase AISLADO: la CSP y /pilot-config.json reflejan el proyecto configurado (nunca el compartido), y pilot-auth.js real lo acepta (P1, auditoría sobre el commit 60afc33)',async()=>{
  const {createPilotServer}=require('../server/pilot-http.cjs');
  const isolatedRef='abcdefghij0123456789',isolatedUrl='https://'+isolatedRef+'.supabase.co';
  const app=createPilotServer({env:{PORT:'10000',PILOT_SUPABASE_PROJECT_REF:isolatedRef,PILOT_SUPABASE_URL:isolatedUrl,PILOT_SUPABASE_PUBLIC_KEY:'sb_publishable_isolated_test'}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  try{
    const request=path=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:app.server.address().port,path,method:'GET'},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({headers:res.headers,body}));});req.on('error',reject);req.end();
    });
    const config=JSON.parse((await request('/pilot-config.json')).body);
    assert.equal(config.projectRef,isolatedRef);assert.equal(config.supabaseUrl,isolatedUrl);
    const csp=(await request('/')).headers['content-security-policy'];
    assert.ok(csp.includes("connect-src 'self' "+isolatedUrl),csp);
    assert.ok(!csp.includes('otswebncqidqthqplztj'),csp); // nunca el proyecto compartido, ni de refuerzo
    // pilot-auth.js REAL (no un doble) acepta este proyecto configurado —
    // antes exigía, sin excepción, el project ref compartido hardcodeado.
    let capturedUrl;
    const sdk={createClient:(url)=>{capturedUrl=url;return {auth:{}};}};
    assert.doesNotThrow(()=>createClient(config,sdk,async()=>new Response('{}')));
    assert.equal(capturedUrl,isolatedUrl);
  }finally{await new Promise(r=>app.server.close(r));}
});
test('UI real: los cuatro estados nuevos de reanudación de activación muestran un mensaje propio, nunca el genérico de AUTH_FAILED (P2, auditoría sobre el commit 26fd7fc)',async()=>{
  const vm=require('node:vm'),fs=require('node:fs');
  for(const status of ['ACTIVATION_BLOCKED_PRIVILEGED_ROLE','ACTIVATION_CANCELLED','ACTIVATION_FAILED','ACTIVATION_NETWORK_ERROR']){
    const els={},element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
    const context={document:{hidden:false,body:{dataset:{role:'COACH'}},getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
      window:{addEventListener(){}},location:{pathname:'/coach.html',origin,search:'',hash:''},
      history:{replaceState(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
      fetch:async()=>({json:async()=>({publicKey:'sb_publishable_test',publicOrigin:origin,readOnly:true,macrosWritable:false,diaryAvailable:false,trackingAvailable:false,adminProvisioningAvailable:false})}),supabase:{},
      PilotAuth:{parseCallback:()=>null,createClient:()=>({auth:{onAuthStateChange(){}}}),controller:()=>({verify:async()=>({status})})},
      PilotMacrosService:{createModel:()=>({})},PilotMacrosUI:{mount:()=>({clear(){},refresh(){},revalidate(){}})},setInterval(){},setTimeout(){}};
    await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
    const generic='No se pudo completar la operación. Revisa los datos o solicita un enlace nuevo.';
    assert.notEqual(els['auth-status'].textContent,generic,status+' no debe caer en el mensaje genérico de AUTH_FAILED');
    assert.ok(els['auth-status'].textContent.length>0,status+' debe mostrar un mensaje');
    assert.equal(els['pilot-access'].hidden,true,status+' nunca debe exponer las funciones autorizadas');
  }
});
test('Docker context is explicit and contains the entire local require/resource closure',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const root=path.resolve(__dirname,'../..');
  const lines=fs.readFileSync(path.join(root,'.dockerignore'),'utf8').trim().split(/\r?\n/);
  assert.equal(lines[0],'**');
  const files=lines.slice(1).filter(x=>!x.endsWith('/')).map(x=>x.slice(1));
  for(const file of files){assert.ok(!/[\*?]/.test(file));assert.ok(fs.statSync(path.join(root,file)).isFile());assert.ok(!/backup|evidence|\.env|\.gpg|\.pgpass|\.pem/.test(file));}
  const allowed=new Set(files);
  assert.ok(!allowed.has('nutrika/pilot-admin.js'));
  assert.ok(!allowed.has('nutrika/pilot-admin-ui.js'));
  for(const file of files.filter(x=>/\.(cjs|js)$/.test(x))){
    const source=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of source.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)){
      // This require belongs to the generated browser bundle, not Node's module graph.
      if(file.endsWith('/manual-macros-assets.cjs')&&match[1]==='./manual-macros.cjs')continue;
      const target=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));
      assert.ok(allowed.has(target),'missing dependency: '+target);
    }
  }
});

test('isolated deployable starts without either administrative module',()=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
  const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'twogramms-package-'));
  try{
    const files=fs.readFileSync(path.join(root,'.dockerignore'),'utf8').trim().split(/\r?\n/).filter(x=>x.startsWith('!')&&!x.endsWith('/')).map(x=>x.slice(1));
    for(const file of files){const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}
    for(const name of ['pilot-admin.js','pilot-admin-ui.js'])assert.equal(fs.existsSync(path.join(dir,'nutrika',name)),false);
    // Supply installed SDK asset/dependencies for the smoke test only; Docker uses npm ci.
    const asset='pilot-backend/node_modules/@supabase/supabase-js/dist/umd/supabase.js';
    fs.mkdirSync(path.dirname(path.join(dir,asset)),{recursive:true});fs.copyFileSync(path.join(root,asset),path.join(dir,asset));
    const result=spawnSync(process.execPath,['-e',`
      const assert=require('node:assert/strict');
      const {prepareRender}=require('./pilot-backend/server/render-readonly.cjs');
      const {prepareComplexServer}=require('./pilot-backend/activation-drafts/complex-infrastructure.cjs');
      const {createPilotServer}=require('./pilot-backend/server/pilot-http.cjs');
      const {loadCatalogApprovalPackage,realFoodCatalog}=require('./pilot-backend/server/real-food-catalog.cjs');
      const pkg=loadCatalogApprovalPackage();assert.equal(realFoodCatalog(pkg.registry,undefined,pkg.profileManifest).list().length,30);
      const env={RENDER_EXTERNAL_URL:'https://test.onrender.com',PILOT_SUPABASE_PUBLIC_KEY:'sb_publishable_test'};
      const a=prepareRender({env});a.server.listen(0,'127.0.0.1',()=>a.server.close());
      const b=prepareComplexServer({env});b.server.listen(0,'127.0.0.1',()=>b.server.close());
      const c=createPilotServer({env,diaryService:{},trackingService:{}});c.server.listen(0,'127.0.0.1',()=>c.server.close());
    `],{cwd:dir,env:{...process.env,NODE_PATH:path.join(root,'pilot-backend/node_modules')},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,'isolated startup failed');
  }finally{
    const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('twogramms-package-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
