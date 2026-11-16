'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {createModel}=require('../../nutrika/pilot-tracking-service.js');
const {handleTracking}=require('../server/pilot-tracking-http.cjs');
const target={gymId:'gym-a',clientId:'client-a',label:'Synthetic label'};
function session(id='user-a'){return {data:{session:{user:{id},access_token:'synthetic'}}};}
function transport(service){return async(url,options)=>{
  const req=Readable.from(options.body?[Buffer.from(options.body)]:[]);
  Object.assign(req,{url,method:options.method,headers:{host:'pilot.example',origin:'https://pilot.example',authorization:options.headers.Authorization,'content-type':'application/json'}});
  let status,result;
  await handleTracking(req,{writeHead(s){status=s;},end(body){result=JSON.parse(body);}},service,'https://pilot.example');
  return {ok:status===200,json:async()=>result};
};}
test('history sends exactly four fields through the real HTTP handler',async()=>{
  const model=createModel({auth:{getSession:async()=>session()}},transport({history:async(token,t,from,to)=>{
    assert.equal(token,'synthetic');assert.deepEqual(t,{gymId:'gym-a',clientId:'client-a'});
    assert.equal(from,'2026-11-01');assert.equal(to,'2026-11-16');return {days:[]};
  }}));
  assert.deepEqual(await model.history(target,'2026-11-01','2026-11-16'),{days:[]});
});
for(const kind of ['WEIGHT_DAY','HABITS_DAY'])test(`save ${kind} strips UI metadata and fields of other kinds`,async()=>{
  const common={gymId:target.gymId,clientId:target.clientId,nutritionDate:'2026-11-16',operationId:'op-a',baseRevision:0,kind};
  const specific=kind==='WEIGHT_DAY'?{weightKg:70}:{values:{steps:5000},completion:{steps:true}};
  const model=createModel({auth:{getSession:async()=>session()}},transport({save:async(token,command)=>{
    assert.equal(token,'synthetic');assert.deepEqual(command,{...common,...specific});return {revision:1};
  }}));
  assert.deepEqual(await model.save({...common,label:'display only',weightKg:70,values:{steps:5000},completion:{steps:true},extra:true}),{revision:1});
});
for(const operation of ['history','save'])for(const failure of ['session','rejected','changed-user','invalidated','late-json'])test(`${operation} rejects ${failure}`,async()=>{
  let user='user-a',model,calls=0;
  const client={auth:{getSession:async()=>failure==='session'?{data:{session:null}}:session(user)}};
  model=createModel(client,async()=>{calls++;if(failure==='changed-user')user='user-b';if(failure==='invalidated')model.invalidate();
    return {ok:failure!=='rejected',json:async()=>{if(failure==='late-json')model.invalidate();return {data:{days:[]}};}};
  });
  await assert.rejects(operation==='history'?model.history(target,'2026-11-16','2026-11-16'):model.save({...target,kind:'WEIGHT_DAY',weightKg:70}),/TRACKING_UNAVAILABLE/);
  if(failure==='session')assert.equal(calls,0);
});
test('requests retain the exact gym/client pair and never reuse another target',async()=>{
  const pairs=[];const model=createModel({auth:{getSession:async()=>session()}},async(url)=>{
    const q=new URL(url,'https://pilot.example').searchParams;pairs.push([q.get('gymId'),q.get('clientId')]);return {ok:true,json:async()=>({data:{days:[]}})};
  });
  await Promise.all([model.history(target,'2026-11-16','2026-11-16'),model.history({gymId:'gym-b',clientId:'client-b',label:'other'},'2026-11-16','2026-11-16')]);
  assert.deepEqual(pairs,[['gym-a','client-a'],['gym-b','client-b']]);
});
test('unsupported save kind never reaches the backend',async()=>{
  const model=createModel({auth:{getSession:async()=>session()}},async()=>{assert.fail('unexpected write');});
  await assert.rejects(model.save({...target,kind:'INTAKE_DAY'}),/TRACKING_UNAVAILABLE/);
});
