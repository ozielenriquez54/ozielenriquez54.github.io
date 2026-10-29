'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
test('Auth UI connects diary only for authorized client and clears pending access on logout',async()=>{
  let finish,shown=0,clears=0;const els={},handlers={};
  const element=id=>els[id]??={hidden:false,value:'',textContent:'',addEventListener(k,f){this[k]=f;}};
  const document={hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,querySelectorAll:()=>[],addEventListener(k,f){handlers[k]=f;}};
  const client={auth:{onAuthStateChange(f){handlers.auth=f;}}};
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
