'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFile}=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createTrackingService}=require('../server/pilot-tracking-service.cjs');
test('training persists through existing SQL, retains history/replays and isolates two gyms',async()=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon nologin; create role authenticated nologin; create role authenticator nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated; grant execute on function auth.uid() to anon,authenticated;`);
    for(const file of ['migrations/202609290001_identity.sql','migrations/202609290002_authorization.sql','migrations/202610170005_manual_macros.sql','activation-drafts/complex-macros.sql','activation-drafts/complex-diary.sql','activation-drafts/complex-tracking.sql'])await db.exec(await readFile(path.join(__dirname,'..',file),'utf8'));
    const rpc=(actor,sql,args=[])=>db.transaction(async tx=>{await tx.exec('set local role authenticated');await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor]);return (await tx.query(sql,args)).rows[0];});
    const users=new Set();
    async function fixture(){
      const owner=randomUUID(),client=randomUUID();
      for(const id of [owner,client]){users.add(id);await db.query('insert into auth.users values($1)',[id]);await rpc(id,'select * from public.pilot_ensure_profile()');}
      const gym=await rpc(owner,'select * from public.pilot_create_gym($1)',['Synthetic gym']);
      const coach=await rpc(owner,"select * from public.pilot_set_membership($1,$2,array['OWNER','COACH']::public.pilot_role[],true,1)",[gym.id,owner]);
      const member=await rpc(owner,"select * from public.pilot_set_membership($1,$2,array['CLIENT']::public.pilot_role[],true,0)",[gym.id,client]);
      const assignment=await rpc(owner,'select * from public.pilot_set_coach_client($1,$2,$3,true,0)',[gym.id,coach.id,member.id]);
      const target={gymId:gym.id,clientId:assignment.client_id};
      await db.query('insert into pilot_private.complex_macro_scope values($1,$2,$3)',[gym.id,owner,target.clientId]);return {client,target};
    }
    const a=await fixture(),b=await fixture();
    const transaction=fn=>db.transaction(async tx=>{await tx.exec('set local role pilot_diary_server');return fn(tx);});
    const service=()=>createTrackingService({transaction,verifySession:async token=>users.has(token)?token:null,newId:randomUUID,now:()=>new Date().toISOString()});
    let tracking=service();
    const command={...a.target,kind:'HABITS_DAY',nutritionDate:'2026-11-16',operationId:'legacy',baseRevision:0,values:{training:'NO_STRENGTH'},completion:{training:false}};
    const legacy=await tracking.save(a.client,command);
    const multi={...command,operationId:'multi',baseRevision:1,values:{trainingActivities:['STRENGTH','CARDIO','SPORTS']}};
    const saved=await tracking.save(a.client,multi);assert.deepEqual(saved.values.trainingActivities,['STRENGTH','CARDIO','SPORTS']);assert.equal(saved.values.training,'STRENGTH');
    assert.deepEqual(await tracking.save(a.client,multi),saved);
    tracking=service(); // Read from PostgreSQL JSON, not from a UI/model cache.
    const read=await tracking.history(a.client,a.target,'2026-11-16','2026-11-16');
    assert.deepEqual(read.days[0].habits.values,saved.values);assert.equal(read.days[0].habits.completion.training,false);
    assert.deepEqual(read.revisions[0].values,legacy.values);assert.equal(Object.hasOwn(read.revisions[0].values,'trainingActivities'),false);
    for(const target of [b.target,{gymId:b.target.gymId,clientId:a.target.clientId}]){
      await assert.rejects(tracking.history(a.client,target,'2026-11-16','2026-11-16'));
      await assert.rejects(tracking.save(a.client,{...multi,...target,operationId:randomUUID(),baseRevision:0}));
    }
    await assert.rejects(tracking.save(a.client,{...multi,operationId:'invalid',baseRevision:2,values:{trainingActivities:['NONE','CARDIO']}}));
    const none=await tracking.save(a.client,{...multi,operationId:'none',baseRevision:2,values:{trainingActivities:['NONE']}});
    assert.equal(none.values.training,'NO_STRENGTH');assert.deepEqual(none.values.trainingActivities,['NONE']);
    assert.equal((await tracking.history(a.client,a.target,'2026-11-16','2026-11-16')).revisions.length,3);
  }finally{await db.close();}
});
