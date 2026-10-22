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
