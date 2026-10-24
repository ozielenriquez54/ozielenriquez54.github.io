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
    for(const path of ['/admin.html','/pilot-admin.js','/.env','/pilot-backend/audit-005-evidence/test.json'])assert.equal((await request(path)).status,404);
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
test('read-only auth does not create profile and transport blocks application RPCs',async()=>{
  let rpc=0,transport;
  const q={select:()=>q,eq:async()=>({data:[]})};
  const client={auth:{getUser:async()=>({data:{user:{id:'client'}}})},from:()=>q,rpc:()=>rpc++};
  assert.equal((await controller(client,'CLIENT',origin+'/auth/callback.html',{approvedOrigin:origin,readOnly:true}).verify()).status,'ROLE_REQUIRED');assert.equal(rpc,0);
  const base='https://otswebncqidqthqplztj.supabase.co';
  createClient({projectRef:'otswebncqidqthqplztj',supabaseUrl:base,publicKey:'sb_publishable_test',readOnly:true},{createClient:(_u,_k,o)=>{transport=o.global.fetch;}},()=>assert.fail('network must remain unused'),{admin:true});
  for(const name of ['pilot_ensure_profile','pilot_set_membership','pilot_set_coach_client','pilot_assign_manual_macros'])await assert.rejects(transport(base+'/rest/v1/rpc/'+name,{method:'POST'}));
  await assert.rejects(transport(base+'/auth/v1/signup',{method:'POST'}));
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
