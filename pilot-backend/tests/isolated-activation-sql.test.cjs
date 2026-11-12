'use strict';
// Real SQL in disposable local PGlite, synthetic identities, no Supabase clients.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {PGlite}=require('@electric-sql/pglite');
const {supabaseDiaryStore}=require('../server/supabase-diary-store.cjs');
const {createTrackingService}=require('../server/pilot-tracking-service.cjs');
const {createPersonalFoodService}=require('../server/personal-food-service.cjs');
const {createPilotDiary}=require('../../nutrika/application/pilot-diary.cjs');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const actors=Object.fromEntries(['owner','coach','client','otherOwner','otherCoach','otherClient','unassigned']
  .map((name,i)=>[name,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));

test('original 001/002/005 and activation SQL: two gyms, permissions, writes and restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'twogramms-isolated-sql-'));
  let db=new PGlite(path.join(dir,'db'));
  const as=(actor,sql,args=[],role='authenticated')=>db.transaction(async tx=>{
    assert.ok(['authenticated','anon','pilot_diary_server'].includes(role));
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[actor??'']);
    return tx.query(sql,args);
  });
  const rpc=async(actor,sql,args)=>(await as(actor,sql,args)).rows[0];
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create role authenticator nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth,public to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;`);
    for(const file of ['migrations/202609290001_identity.sql','migrations/202609290002_authorization.sql'])
      await db.exec(await fs.readFile(path.join(root,file),'utf8'));
    // Deliberately hostile defaults on NEW objects: candidates must strip these
    // without changing global default privileges or pre-existing identity ACLs.
    await db.exec(`alter default privileges grant all on tables to service_role;
      alter default privileges grant execute on functions to service_role;`);
    const baseline=await db.query('select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid');
    for(const file of ['migrations/202610170005_manual_macros.sql','activation-drafts/complex-macros.sql',
      'activation-drafts/complex-diary.sql','activation-drafts/complex-tracking.sql','activation-drafts/complex-personal-foods.sql'])
      await db.exec(await fs.readFile(path.join(root,file),'utf8'));
    await t.test('installation preserves default ACL and keeps original 005 RPC closed',async()=>{
      assert.deepEqual((await db.query('select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows,baseline.rows);
      for(const role of ['anon','authenticated','authenticator','service_role']){
        assert.equal((await db.query("select has_function_privilege($1,'public.pilot_assign_manual_macros(jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
        assert.equal((await db.query("select has_function_privilege($1,'pilot_private.diary_commit(uuid,uuid,uuid,date,jsonb,jsonb)','EXECUTE') allowed",[role])).rows[0].allowed,false);
        for(const table of ['public.manual_macro_targets','public.manual_macro_target_versions','pilot_private.manual_macro_receipts',
          'pilot_private.complex_macro_scope','public.pilot_intake_days','pilot_private.pilot_intake_history',
          'pilot_private.pilot_intake_receipts','pilot_private.tracking_history','pilot_private.tracking_receipts','pilot_private.pilot_personal_foods'])
          assert.equal((await db.query("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') allowed",[role,table])).rows[0].allowed,false,role+' '+table);
      }
      const role=(await db.query("select rolcanlogin,rolsuper,rolbypassrls,rolinherit from pg_roles where rolname='pilot_diary_server'")).rows[0];
      assert.deepEqual(role,{rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:false});
    });
    for(const id of Object.values(actors)){
      await db.query('insert into auth.users values($1)',[id]);
      await rpc(id,'select * from public.pilot_ensure_profile()');
    }
    async function fixture(owner,coach,client,label){
      const gym=await rpc(owner,'select * from public.pilot_create_gym($1)',[label]);
      const cm=await rpc(owner,"select * from public.pilot_set_membership($1,$2,array['COACH']::public.pilot_role[],true,0)",[gym.id,coach]);
      const cl=await rpc(owner,"select * from public.pilot_set_membership($1,$2,array['CLIENT']::public.pilot_role[],true,0)",[gym.id,client]);
      const assignment=await rpc(owner,'select * from public.pilot_set_coach_client($1,$2,$3,true,0)',[gym.id,cm.id,cl.id]);
      return {gymId:gym.id,clientId:assignment.client_id,cm,cl,assignment};
    }
    const a=await fixture(actors.owner,actors.coach,actors.client,'Synthetic gym A');
    const b=await fixture(actors.otherOwner,actors.otherCoach,actors.otherClient,'Synthetic gym B');
    await rpc(actors.owner,"select * from public.pilot_set_membership($1,$2,array['COACH']::public.pilot_role[],true,0)",[a.gymId,actors.unassigned]);
    const target={gymId:a.gymId,clientId:a.clientId};
    const cmd={...target,operationId:'macro-1',baseRevision:0,macros:{proteinG:120,carbsG:245,fatG:60},confirmations:{zeroMacros:[],energyChange:false}};
    const assign=(actor,command=cmd)=>rpc(actor,'select public.pilot_save_complex_macros($1::jsonb) result',[JSON.stringify(command)]);
    await t.test('empty scope rejects writes; assigned coach can write only scoped gym/client',async()=>{
      await assert.rejects(assign(actors.coach),e=>e.code==='42501');
      for(const [x,coach] of [[a,actors.coach],[b,actors.otherCoach]])await db.query('insert into pilot_private.complex_macro_scope values($1,$2,$3)',[x.gymId,coach,x.clientId]);
      for(const who of [actors.owner,actors.client,actors.otherCoach,actors.unassigned])await assert.rejects(assign(who),e=>e.code==='42501');
      await assert.rejects(assign(actors.coach,{...cmd,gymId:b.gymId,clientId:b.clientId}),e=>e.code==='42501');
      const saved=await assign(actors.coach);assert.equal(saved.result.revision,1);
      assert.deepEqual(await assign(actors.coach),saved);
      await assert.rejects(assign(actors.coach,{...cmd,operationId:'stale'}),e=>e.code==='40001');
      assert.equal((await as(actors.otherClient,'select * from public.manual_macro_targets')).rows.length,0);
      assert.equal((await as(actors.client,'select * from public.manual_macro_targets')).rows.length,1);
      assert.equal((await as(actors.owner,'select * from public.manual_macro_targets')).rows.length,0);
    });
    const transaction=fn=>db.transaction(async tx=>{await tx.exec('set local role pilot_diary_server');return fn(tx);});
    const verifySession=async token=>Object.values(actors).includes(token)?token:null;
    const store=supabaseDiaryStore({transaction,verifySession});
    const tracking=createTrackingService({transaction,verifySession,newId:randomUUID,now:()=>new Date().toISOString()});
    const personalFoods=createPersonalFoodService({transaction,verifySession,catalog:{list:()=>[]}});
    const diary=createPilotDiary({store,resolveFood:async()=>null,personalFoods,newId:randomUUID,now:()=>new Date().toISOString()});
    let personalFoodId;
    await t.test('personal food and diary services save through original SQL, replay and isolate records',async()=>{
      const food=await personalFoods.create(actors.client,target,{displayName:'Synthetic oats',profile:'AS_SOLD',
        sourceKind:'MANUAL',sourceReference:'Synthetic fixture',referenceQuantity:100,referenceUnit:'g',
        kcal:380,proteinG:12,carbsG:65,fatG:8});
      personalFoodId=food.foodId;
      assert.equal((await personalFoods.resolve(actors.client,target,food.foodId)).foodId,food.foodId);
      await assert.rejects(personalFoods.resolve(actors.otherClient,target,food.foodId));
      assert.deepEqual(await personalFoods.list(actors.otherClient,{gymId:b.gymId,clientId:b.clientId}),[]);
      const command={...target,nutritionDate:'2026-11-12',operationId:'diary-1',baseRevision:0,type:'ADD',
        foodId:food.foodId,mealId:'breakfast',mealType:'BREAKFAST',
        amount:{kind:'MEASURED',quantity:100,unit:'g',preparationState:'AS_SOLD',weighingBasis:'AS_SOLD'}};
      const saved=await diary.save(actors.client,command);
      assert.equal(saved.totals.kcal,380);
      assert.deepEqual(await diary.save(actors.client,command),saved);
      await assert.rejects(diary.save(actors.otherClient,{...command,operationId:'foreign'}));
      assert.equal((await as(actors.otherClient,'select * from public.pilot_intake_days')).rows.length,0);
      assert.equal((await as(actors.owner,'select * from public.pilot_intake_days')).rows.length,0);
    });
    await t.test('tracking service persists actual SQL and rejects other clients, owner and unassigned coaches',async()=>{
      const command={...target,nutritionDate:'2026-11-12',operationId:'weight-1',baseRevision:0,kind:'WEIGHT_DAY',weightKg:75};
      const saved=await tracking.save(actors.client,command);assert.ok(saved);
      assert.deepEqual(await tracking.save(actors.client,command),saved);
      for(const who of [actors.owner,actors.otherClient,actors.unassigned])
        await assert.rejects(tracking.history(who,target,'2026-11-12','2026-11-12'));
      const read=await tracking.history(actors.coach,target,'2026-11-12','2026-11-12');
      assert.equal(read.days[0].weight.weightKg,75);
      await assert.rejects(store.readOwn('invalid',target,'2026-11-12'));
      await assert.rejects(store.readOwn(actors.otherClient,target,'2026-11-12'));
    });
    await t.test('personal food helpers deny foreign ownership and browser execution',async()=>{
      const own=await as(null,'select pilot_private.personal_food_list($1,$2,$3) result',[actors.client,a.gymId,a.clientId],'pilot_diary_server');
      assert.equal(own.rows[0].result[0].foodId,personalFoodId);
      await assert.rejects(as(null,'select pilot_private.personal_food_list($1,$2,$3)',[actors.otherClient,a.gymId,a.clientId],'pilot_diary_server'),e=>e.code==='42501');
      await assert.rejects(as(actors.client,'select pilot_private.personal_food_list($1,$2,$3)',[actors.client,a.gymId,a.clientId]),e=>e.code==='42501');
    });
    await t.test('database restart retains weights and macro versions; revocation removes coach read access',async()=>{
      await db.close();db=new PGlite(path.join(dir,'db'));
      assert.equal((await tracking.history(actors.client,target,'2026-11-12','2026-11-12')).days[0].weight.weightKg,75);
      assert.equal((await diary.read(actors.client,target,'2026-11-12')).totals.kcal,380);
      assert.equal((await personalFoods.list(actors.client,target))[0].foodId,personalFoodId);
      assert.equal((await as(actors.client,'select revision from public.manual_macro_targets')).rows[0].revision,1);
      await rpc(actors.owner,'select * from public.pilot_set_coach_client($1,$2,$3,false,$4)',[a.gymId,a.cm.id,a.cl.id,a.assignment.revision]);
      await assert.rejects(tracking.history(actors.coach,target,'2026-11-12','2026-11-12'));
      await assert.rejects(assign(actors.coach),e=>e.code==='42501');
    });
  } finally {
    await db.close();
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('twogramms-isolated-sql-'));
    await fs.rm(dir,{recursive:true});
  }
});
