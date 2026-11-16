'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
async function revalidationPage(){
  const els={},handlers={};let next=()=>Promise.resolve({status:'AUTHORIZED'}),checks=0,clears=0;
  const element=id=>els[id]??={hidden:false,inert:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const document={hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,querySelectorAll:()=>[],addEventListener(k,f){handlers[k]=f;}};
  const context={document,window:{addEventListener(k,f){handlers[k]=f;}},location:{pathname:'/index.html',origin:'https://pilot.example.com',search:'',hash:''},
    history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},URLSearchParams,
    fetch:async()=>({json:async()=>({publicKey:'synthetic',publicOrigin:'https://pilot.example.com'})}),supabase:{},
    PilotAuth:{createClient:()=>({auth:{onAuthStateChange(f){handlers.auth=f;}}}),controller:()=>({verify(){checks++;return next();},invalidate(){},logout:async()=>({status:'SIGNED_OUT'})})},
    PilotMacrosService:{createModel:()=>({})},PilotMacrosUI:{mount:()=>({refresh(){},clear(){clears++;},revalidate(){}})},setInterval(){},setTimeout(fn){fn();}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  return {els,handlers,document,get checks(){return checks;},get clears(){return clears;},pending(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});next=()=>promise;return {resolve,reject};}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('home, tracking form and weekly detail use independent cancellable macro models; retry rechecks target',async()=>{
  const els={},handlers={};let homeOptions,homeReads=0,trackingReads=0,errors=0,failList=false,loading=0;
  const element=id=>els[id]??={hidden:false,value:'',addEventListener(k,f){this[k]=f;}};
  const client={auth:{getSession:async()=>({data:{session:{user:{id:'synthetic-user'},access_token:'synthetic'}}}),onAuthStateChange(f){handlers.auth=f;}}};
  const transport=async(url,{signal})=>{await settle();if(signal.aborted)throw new Error('aborted');
    if(url.includes('/clients')&&failList)throw new Error('denied');
    return {ok:true,json:async()=>({data:url.includes('/clients')?[{gymId:'g',clientId:'c',label:'synthetic'}]:{macros:{}}})};};
  const home={loading(){loading++;},error(){errors++;},clear(){},refresh(){},async show(t){await homeOptions.macros.read(t);homeReads++;}};
  const context={document:{hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,querySelectorAll:()=>[],addEventListener(){}},
    window:{addEventListener(){}},location:{pathname:'/index.html',origin:'https://pilot.example.com',search:'',hash:''},history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},
    fetch:async()=>({json:async()=>({publicKey:'synthetic',trackingAvailable:true})}),supabase:{},
    PilotAuth:{createClient:()=>client,controller:()=>({verify:async()=>({status:'AUTHORIZED'}),invalidate(){}})},
    PilotMacrosService:{createModel:()=>require('../../nutrika/pilot-macros-service.js').createModel(client,'CLIENT',transport)},
    PilotMacrosUI:{mount:()=>({refresh(){},clear(){}})},PilotTrackingService:{createModel:()=>({invalidate(){}})},
    PilotTrackingUI:{mount:()=>({clear(){},async show(t,d,m){await m.read(t);trackingReads++;}})},
    PilotClientHomeUI:{mount:(slots,options)=>{homeOptions=options;return home;}},setInterval(){},setTimeout(){}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  for(let i=0;i<6;i++)await settle();
  assert.equal(homeReads,1);assert.equal(trackingReads,1);assert.equal(errors,0);
  assert.notEqual(homeOptions.macros,homeOptions.logMacros);assert.notEqual(homeOptions.macros,homeOptions.weeklyMacros);
  await Promise.all([homeOptions.macros.read({gymId:'g',clientId:'c'}),homeOptions.logMacros.read({gymId:'g',clientId:'c'}),homeOptions.weeklyMacros.read({gymId:'g',clientId:'c'})]);
  failList=true;await homeOptions.onRetry();assert.equal(errors,1);
  failList=false;await homeOptions.onRetry();assert.equal(homeReads,2);
  handlers.auth('SIGNED_OUT');const before=loading;await homeOptions.onRetry();assert.equal(loading,before);
});
for(const trigger of ['focus','visibilitychange','TOKEN_REFRESHED'])test(`revalidation ${trigger} keeps the authorized view visible and blocks interaction`,async()=>{
  const p=await revalidationPage(),pending=p.pending(),clears=p.clears;
  if(trigger==='visibilitychange'){
    p.document.hidden=true;p.handlers.visibilitychange();
    assert.equal(p.els['pilot-access'].hidden,false);
    assert.equal(p.els['pilot-access'].inert,true);
    p.document.hidden=false;p.handlers.visibilitychange();
  }else if(trigger==='TOKEN_REFRESHED')p.handlers.auth(trigger);
  else p.handlers.focus();
  assert.equal(p.els['pilot-access'].hidden,false);
  for(const id of ['pilot-access','food-dialog','log-dialog'])assert.equal(p.els[id].inert,true);
  assert.equal(p.clears,clears);
  p.handlers.focus();assert.equal(p.checks,2,'duplicate focus does not start a concurrent verification');
  pending.resolve({status:'AUTHORIZED'});await settle();
  assert.equal(p.els['pilot-access'].hidden,false);
  for(const id of ['pilot-access','food-dialog','log-dialog'])assert.equal(p.els[id].inert,false);
});
for(const result of ['SIGNED_OUT','ROLE_REQUIRED','AUTH_FAILED','throw'])test(`revalidation fails closed on ${result}`,async()=>{
  const p=await revalidationPage(),pending=p.pending(),clears=p.clears;p.handlers.focus();
  if(result==='throw')pending.reject(new Error('network'));else pending.resolve({status:result});
  await settle();assert.equal(p.els['pilot-access'].hidden,true);assert.ok(p.clears>clears);
});
for(const logout of ['event','button'])test(`late verification cannot restore access after logout ${logout}`,async()=>{
  const p=await revalidationPage(),pending=p.pending();p.handlers.focus();
  if(logout==='event')p.handlers.auth('SIGNED_OUT');else await p.els.logout.click();
  assert.equal(p.els['pilot-access'].hidden,true);
  pending.resolve({status:'AUTHORIZED'});await settle();assert.equal(p.els['pilot-access'].hidden,true);
});
test('verification finishing in a hidden tab keeps interactions blocked until visible revalidation',async()=>{
  const p=await revalidationPage(),pending=p.pending();p.handlers.focus();p.document.hidden=true;p.handlers.visibilitychange();
  pending.resolve({status:'AUTHORIZED'});await settle();
  assert.equal(p.els['pilot-access'].hidden,false);assert.equal(p.els['pilot-access'].inert,true);
  const resumed=p.pending();p.document.hidden=false;p.handlers.visibilitychange();
  assert.equal(p.els['pilot-access'].inert,true);resumed.resolve({status:'SIGNED_OUT'});await settle();
  assert.equal(p.els['pilot-access'].hidden,true);
});
test('Auth UI connects diary only for authorized client and clears pending access on logout',async()=>{
  let finish,shown=0,clears=0;const els={},handlers={};
  const element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const document={hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,querySelectorAll:()=>[],addEventListener(k,f){handlers[k]=f;}};
  const client={auth:{getSession:async()=>({data:{session:{user:{id:'synthetic-user'}}}}),onAuthStateChange(f){handlers.auth=f;}}};
  const context={document,window:{addEventListener(){}},location:{pathname:'/index.html',origin:'https://pilot.example.com',search:'',hash:''},
    history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},URLSearchParams,
    fetch:async()=>({json:async()=>({publicKey:'sb_publishable_synthetic',publicOrigin:'https://pilot.example.com',diaryAvailable:true,macrosWritable:false})}),
    supabase:{},PilotAuth:{createClient:()=>client,controller:()=>({verify:async()=>({status:'AUTHORIZED'}),invalidate(){},logout:async()=>({status:'SIGNED_OUT'})})},
    PilotMacrosService:{createModel:()=>({list:()=>new Promise(r=>{finish=r;})})},PilotMacrosUI:{mount:()=>({refresh(){},clear(){},revalidate(){}})},
    PilotDiaryService:{createModel:()=>({invalidate(){}})},PilotDiaryUI:{mount:()=>({show:async()=>{shown++;},clear(){clears++;}})},
    setInterval(){},setTimeout(){}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  assert.ok(finish);await els.logout.click();finish([{gymId:'g',clientId:'c'}]);await new Promise(r=>setImmediate(r));
  assert.equal(shown,0);assert.ok(clears>0);assert.equal(els['pilot-access'].hidden,true);
});
// Regresión (commit 93cb311, "autoservicio pilot_create_gym"): render()
// referenciaba `role` sin tenerlo en su cierre (estaba declarada con
// `const` dentro de un bloque `try{}` hermano, fuera del alcance de
// render, definida ANTES de ese bloque) — un ReferenceError que el `&&`
// de la línea ocultaba siempre, salvo exactamente cuando
// result.status==='NO_MEMBERSHIP' (el único caso real que depende de
// `role`), mostrando en su lugar el AUTH_FAILED genérico sin ningún error
// visible en consola (el throw lo capturaba el propio catch interno de
// run()). Esta prueba falla si esa condición vuelve a quedar fuera del
// alcance de render().
test('NO_MEMBERSHIP (al verificar sesión y al iniciar sesión) muestra el formulario de crear gimnasio en la vista Coach, nunca el AUTH_FAILED genérico',async()=>{
  const els={};
  const element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const document={hidden:false,body:{dataset:{role:'COACH'}},getElementById:element,querySelectorAll:()=>[],addEventListener(){}};
  const client={auth:{onAuthStateChange(){}}};
  let loginCalls=0;
  const context={document,window:{addEventListener(){}},location:{pathname:'/coach.html',origin:'http://127.0.0.1:3000',search:'',hash:''},
    history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},URLSearchParams,
    fetch:async()=>({json:async()=>({publicKey:'sb_publishable_synthetic',publicOrigin:'http://127.0.0.1:3000',readOnly:true})}),
    supabase:{},PilotAuth:{createClient:()=>client,controller:()=>({verify:async()=>({status:'NO_MEMBERSHIP'}),invalidate(){},logout:async()=>({status:'SIGNED_OUT'}),
      login:async()=>{loginCalls++;return {status:'NO_MEMBERSHIP'};}})},
    PilotMacrosService:{createModel:()=>({list:async()=>[]}),createWriter:()=>({})},PilotMacrosUI:{mount:()=>({refresh(){},clear(){},revalidate(){}})},
    PilotDiaryService:{createModel:()=>({invalidate(){}})},PilotDiaryUI:{mount:()=>({show:async()=>{},clear(){}})},
    setInterval(){},setTimeout(fn){fn();}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  // Al verificar sesión al cargar la página (sin login todavía).
  assert.equal(els['create-gym-form'].hidden,false);
  assert.match(els['auth-status'].textContent,/Todavía no perteneces a ningún gimnasio/);
  // Al iniciar sesión explícitamente (el caso reportado: "el error persiste
  // al intentar iniciar sesión").
  element('auth-email').value='owner@example.test';element('auth-password').value='synthetic';
  await els['login-form'].submit({preventDefault(){}});
  assert.equal(loginCalls,1);
  assert.equal(els['create-gym-form'].hidden,false);
  assert.match(els['auth-status'].textContent,/Todavía no perteneces a ningún gimnasio/);
  assert.ok(!els['auth-status'].textContent.includes('No se pudo verificar la recuperación'));
});
// Regresión (desbloqueo del alta del primer cliente): AUTHORIZED con
// canAddOwnCoachRole=true debe mostrar el botón de autoservicio en la
// vista Coach, y un click debe llamar a auth.addOwnCoachRole() y
// reflejar el resultado (incluyendo que el botón se oculte en cuanto deja
// de ser elegible, sin recargar la página).
test('AUTHORIZED con canAddOwnCoachRole muestra el botón de autoservicio en Coach; un click lo invoca y refleja el resultado',async()=>{
  const els={};
  const element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const document={hidden:false,body:{dataset:{role:'COACH'}},getElementById:element,querySelectorAll:()=>[],addEventListener(){}};
  const client={auth:{onAuthStateChange(){}}};
  let addCalls=0;
  const context={document,window:{addEventListener(){}},location:{pathname:'/coach.html',origin:'http://127.0.0.1:3000',search:'',hash:''},
    history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},URLSearchParams,
    fetch:async()=>({json:async()=>({publicKey:'sb_publishable_synthetic',publicOrigin:'http://127.0.0.1:3000',readOnly:true})}),
    supabase:{},PilotAuth:{createClient:()=>client,controller:()=>({verify:async()=>({status:'AUTHORIZED',canAddOwnCoachRole:true}),invalidate(){},logout:async()=>({status:'SIGNED_OUT'}),
      addOwnCoachRole:async()=>{addCalls++;return {status:'AUTHORIZED',canAddOwnCoachRole:false};}})},
    PilotMacrosService:{createModel:()=>({list:async()=>[]}),createWriter:()=>({})},PilotMacrosUI:{mount:()=>({refresh(){},clear(){},revalidate(){}})},
    PilotDiaryService:{createModel:()=>({invalidate(){}})},PilotDiaryUI:{mount:()=>({show:async()=>{},clear(){}})},
    setInterval(){},setTimeout(fn){fn();}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);
  assert.equal(els['add-own-coach-role'].hidden,false);
  await els['add-own-coach-role'].click();
  assert.equal(addCalls,1);
  assert.equal(els['add-own-coach-role'].hidden,true); // ya no elegible: el botón se oculta sin recargar
});
