'use strict';
// Isolated synthetic presentation: no SDK, network, credentials or persistence.
(()=>{
  const role=document.body.dataset.role;
  const targets=[{gymId:'synthetic-gym',clientId:'synthetic-client-a',label:'Cliente ficticio A'},{gymId:'synthetic-gym',clientId:'synthetic-client-b',label:'Cliente ficticio B — sin asignación'}];
  let authorized=true;
  const model={invalidate(){},async list(){if(!authorized)throw new Error('DEMO_REVOKED');return structuredClone(role==='CLIENT'?targets.slice(0,1):targets);},async read(target){
    if(!authorized)throw new Error('DEMO_REVOKED');return target.clientId==='synthetic-client-a'?{macros:{proteinG:120,carbsG:245,fatG:60,kcal:2000},revision:1,effectiveFrom:'2026-01-01T12:00:00Z'}:null;
  }};
  const ui=PilotMacrosUI.mount(document.getElementById('macros-root'),{model,role});ui.refresh();
  document.getElementById('demo-logout').addEventListener('click',()=>{authorized=false;ui.clear();});
  document.getElementById('demo-revoke').addEventListener('click',()=>{authorized=false;ui.refresh();});
})();
