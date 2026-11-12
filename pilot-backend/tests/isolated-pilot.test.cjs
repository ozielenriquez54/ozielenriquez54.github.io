'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {rootCertificates}=require('node:tls');
const {prepareIsolatedPilot}=require('../server/isolated-pilot.cjs');
const project='fadbkbdbpuoekolfcbjm',origin='https://twogramms-preprod-test.onrender.com';

test('isolated writable entrypoint rejects mixed destinations before opening services',()=>{
  const base={PILOT_ISOLATED_WRITE_ACK:project,PILOT_SUPABASE_PROJECT_REF:project,
    PILOT_SUPABASE_URL:`https://${project}.supabase.co`,PILOT_PUBLIC_ORIGIN:origin,
    PILOT_SUPABASE_PUBLIC_KEY:'sb_publishable_synthetic'};
  for(const patch of [
    {PILOT_ISOLATED_WRITE_ACK:''},{PILOT_SUPABASE_PROJECT_REF:'otswebncqidqthqplztj'},
    {PILOT_SUPABASE_URL:'https://otswebncqidqthqplztj.supabase.co'},
    {PILOT_PUBLIC_ORIGIN:'https://twogramms-pilot.onrender.com'},
    {RENDER_EXTERNAL_URL:'https://twogramms-pilot.onrender.com'},
    {PILOT_PG_MODE:'direct',PILOT_PG_HOST:'db.otswebncqidqthqplztj.supabase.co'},
    {NODE_TLS_REJECT_UNAUTHORIZED:'0'}, {PORT:'invalid'}
  ])assert.throws(()=>prepareIsolatedPilot({env:{...base,...patch}}));
});

test('actual isolated HTTP composition advertises writes, rejects anonymous APIs and closes pool',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'twogramms-isolated-http-'));
  const ca=path.join(dir,'ca.crt');fs.writeFileSync(ca,rootCertificates[0]);
  let app;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('UNEXPECTED_NETWORK');};
  try {
    const env={PILOT_ISOLATED_WRITE_ACK:project,PILOT_SUPABASE_PROJECT_REF:project,
      PILOT_SUPABASE_URL:`https://${project}.supabase.co`,PILOT_PUBLIC_ORIGIN:origin,
      PILOT_SUPABASE_PUBLIC_KEY:'sb_publishable_synthetic',PILOT_PG_MODE:'direct',
      PILOT_PG_HOST:`db.${project}.supabase.co`,PILOT_PG_USER:'pilot_diary_server',
      PILOT_PG_PASSWORD:'synthetic-not-a-credential',PILOT_PG_CA_FILE:ca};
    assert.throws(()=>prepareIsolatedPilot({env:{...env,PILOT_PG_USER:'postgres'}}));
    app=prepareIsolatedPilot({env});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const request=(route,method='GET')=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:route,method,
        headers:{host:new URL(origin).host,origin,'content-type':'application/json'}},res=>{
        let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body,headers:res.headers}));
      });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
    });
    const response=await request('/pilot-config.json'),config=JSON.parse(response.body);
    assert.equal(config.projectRef,project);
    for(const flag of ['macrosWritable','diaryAvailable','trackingAvailable','adminProvisioningAvailable'])assert.equal(config[flag],true,flag);
    assert.ok(!response.body.includes(env.PILOT_PG_PASSWORD));
    assert.ok(!response.headers['content-security-policy'].includes('otswebncqidqthqplztj'));
    for(const route of ['/coach.html','/index.html','/auth/callback.html','/pilot-tracking-domain.js','/pilot-admin-provisioning-ui.js'])assert.equal((await request(route)).status,200,route);
    for(const route of ['/api/manual-macros/assign','/api/admin/clients'])assert.equal((await request(route,'POST')).status,401,route);
    // Existing diary HTTP contract deliberately returns a generic 400.
    const denied=await request('/api/diary/save','POST');
    assert.equal(denied.status,400);
    assert.equal(JSON.parse(denied.body).error,'DIARY_REQUEST_REJECTED_OR_RESULT_UNKNOWN');
    assert.equal((await request('/admin.html')).status,404);
    await app.close();await app.close();assert.equal(app.server.listening,false);
  } finally {
    globalThis.fetch=originalFetch;
    if(app)await app.close();
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('twogramms-isolated-http-'));
    fs.rmSync(dir,{recursive:true});
  }
});
