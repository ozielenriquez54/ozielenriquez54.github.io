'use strict';
const fs=require('node:fs');
const path=require('node:path');
// Fixed public domain modules only; no generic filesystem or backend exposure.
function domainBundle(){
  const names=['values','energy','manual-macros'];
  return `(function(){'use strict';const factories={${names.map(name=>JSON.stringify('./'+name+'.cjs')+':function(module,exports,require){\n'+fs.readFileSync(path.join(__dirname,'../../nutrika/domain',name+'.cjs'),'utf8')+'\n}').join(',')}};const cache={};function require(id){if(!Object.hasOwn(factories,id))throw new Error('PUBLIC_MODULE_REJECTED');if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](m,m.exports,require);}return cache[id].exports;}globalThis.PilotManualMacros=require('./manual-macros.cjs');})();`;
}
function demoPage(role){return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twogramms — Demo de macros</title><style>body{font-family:system-ui;max-width:800px;margin:32px auto;padding:20px}label{display:block;margin:12px 0}button,input,select{padding:8px;margin:6px}section{margin:20px 0}button:disabled{opacity:.55}</style></head><body data-role="${role}"><h1>TWOGRAMMS — MODO PILOTO</h1><h2>DEMO LOCAL — DATOS SINTÉTICOS</h2><p>Sin sesión ni conexión a Supabase. Esta demostración no muestra cuentas reales ni guarda asignaciones.</p><p><a href="/preview/macros-coach.html">Demo Coach</a> · <a href="/preview/macros-client.html">Demo Cliente</a></p><button id="demo-logout">Simular cierre de sesión</button><button id="demo-revoke">Simular pérdida de autorización</button><main id="macros-root"></main><script src="/manual-macros-domain.js" defer></script><script src="/pilot-macros-ui.js" defer></script><script src="/pilot-macros-demo.js" defer></script></body></html>`;}
module.exports={domainBundle,demoPage};
