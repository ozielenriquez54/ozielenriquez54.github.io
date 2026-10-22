'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {loadPilotConfig}=require('./pilot-config.cjs');
const {domainBundle,demoPage}=require('./manual-macros-assets.cjs');
const {createManualMacrosInfrastructure}=require('./manual-macros-service.cjs');
const {handleManualMacros}=require('./manual-macros-http.cjs');
const {handleDiary}=require('./diary-http.cjs');
const PUBLIC_ROOT=path.resolve(__dirname,'../../nutrika');
const CSP="default-src 'none'; script-src 'self'; connect-src 'self' https://otswebncqidqthqplztj.supabase.co; style-src 'unsafe-inline'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'";

function page(kind,config){
  // Reuse only trusted presentation CSS. Never serve the legacy document,
  // inline legacy application code, account storage or database configuration.
  const source=fs.readFileSync(path.join(PUBLIC_ROOT,kind==='Coach'?'coach.html':'index.html'),'utf8');
  const css=source.match(/<style>([\s\S]*?)<\/style>/i)?.[1];
  if(!css||/@import|url\s*\(|<\//i.test(css))throw new Error('PILOT_PRESENTATION_REJECTED');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twogramms — Piloto ${kind}</title><style>${css}
  .pilot-shell{max-width:800px;margin:40px auto;padding:24px;background:white;color:#222;border:2px solid #c9a13b} .pilot-shell nav a{display:inline-block;margin:12px} .pilot-shell img{width:72px} .pilot-shell p{margin:16px 0} .pilot-shell label{display:block;margin:12px 0} .pilot-shell input,.pilot-shell select,.pilot-shell button{padding:8px;margin:5px;max-width:100%} .pilot-shell button:disabled{opacity:.55} .pilot-shell section{margin:20px 0}
  </style></head><body data-role="${kind==='Coach'?'COACH':'CLIENT'}"><main class="pilot-shell"><img src="/assets/logo.jpg" alt="Twogramms"><h1>TWOGRAMMS — MODO PILOTO</h1><h2>Vista ${kind}</h2><p>Objetivos manuales de macros: consulta y vista previa. Guardado no disponible.</p><p>Proyecto permitido: <strong>${config.projectRef}</strong></p>
  <p id="auth-status" role="status" aria-live="polite">Preparando autenticación…</p>
  <form id="login-form"><label>Correo <input id="auth-email" type="email" autocomplete="username" required></label><label>Contraseña <input id="auth-password" type="password" autocomplete="current-password"></label><button type="submit">Iniciar sesión</button></form>
  <button id="magic-link" type="button">Enviar Magic Link</button><button id="recover" type="button">Recuperar contraseña</button><button id="logout" type="button">Cerrar sesión</button>
  <form id="password-form" hidden><label>Nueva contraseña <input id="new-password" type="password" autocomplete="new-password" minlength="8" required></label><button type="submit">Guardar contraseña</button></form>
  <section id="pilot-access" hidden><div id="macros-root"></div></section>
  <nav aria-label="Vistas del piloto"><a href="/index.html">Cliente</a><a href="/coach.html">Coach</a></nav></main><script src="/vendor/supabase.js" defer></script><script src="/pilot-auth.js" defer></script><script src="/manual-macros-domain.js" defer></script><script src="/pilot-macros-service.js" defer></script><script src="/pilot-macros-ui.js" defer></script><script src="/pilot-auth-ui.js" defer></script></body></html>`;
}
function createPilotServer({env=process.env,manualMacrosService,diaryService=null,manualMacrosWriteEnabled=false,readOnly=false}={}){
  if(readOnly&&(diaryService||manualMacrosWriteEnabled))throw new Error('READ_ONLY_REQUIRED');
  const config=loadPilotConfig(env); // Fail before opening any listener.
  const macros=manualMacrosService??createManualMacrosInfrastructure({env});
  const routes=new Map([
    ['/index.html',['text/html; charset=utf-8',Buffer.from(page('Cliente',config))]],
    ['/coach.html',['text/html; charset=utf-8',Buffer.from(page('Coach',config))]],
    ['/assets/logo.jpg',['image/jpeg',fs.readFileSync(path.join(PUBLIC_ROOT,'assets/logo.jpg'))]],
    ['/pilot-config.json',['application/json; charset=utf-8',Buffer.from(JSON.stringify({mode:'pilot',phase:2,projectRef:config.projectRef,supabaseUrl:config.supabaseUrl,publicKey:config.publicKey,publicOrigin:config.publicOrigin,diaryAvailable:Boolean(diaryService),macrosWritable:manualMacrosWriteEnabled}))]]
  ]);
  routes.set('/',routes.get('/index.html'));
  if(readOnly){
    const [type,data]=routes.get('/pilot-config.json');
    routes.set('/pilot-config.json',[type,Buffer.from(JSON.stringify({...JSON.parse(data),readOnly:true}))]);
  }
  for(const route of ['/','/index.html','/coach.html']){
    const [type,content]=routes.get(route);
    routes.set(route,[type,Buffer.from(content.toString().replace('<div id="macros-root"></div>',
      '<div id="macros-root"></div><div id="diary-root"></div>').replace('<script src="/pilot-auth-ui.js"',
      '<script src="/pilot-diary-service.js" defer></script><script src="/pilot-diary-ui.js" defer></script><script src="/pilot-auth-ui.js"'))]);
  }
  for(const name of ['pilot-diary-service.js','pilot-diary-ui.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
  routes.set('/manual-macros-domain.js',['text/javascript; charset=utf-8',Buffer.from(domainBundle())]);
  routes.set('/preview/macros-coach.html',['text/html; charset=utf-8',Buffer.from(demoPage('COACH'))]);
  routes.set('/preview/macros-client.html',['text/html; charset=utf-8',Buffer.from(demoPage('CLIENT'))]);
  if(!readOnly)routes.set('/admin.html',['text/html; charset=utf-8',Buffer.from(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twogramms — Administración piloto</title><style>body{font-family:system-ui;max-width:850px;margin:32px auto;padding:20px}button,input,select{margin:8px;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block}</style></head><body><h1>TWOGRAMMS — MODO PILOTO</h1><h2>Administración de la organización existente</h2><p>Solo las dos cuentas personales indicadas. No se crean organizaciones ni se habilitan funciones clínicas. Cada asignación se confirma por separado.</p><p id="admin-status" role="status" aria-live="polite">Verificando sesión…</p><form id="admin-login"><label>Correo <input id="admin-email" type="email" autocomplete="username" required></label><label>Contraseña <input id="admin-password" type="password" autocomplete="current-password" required></label><button type="submit">Iniciar sesión</button></form><button id="admin-logout" type="button">Cerrar sesión</button><button id="admin-refresh" type="button">Revalidar acceso</button><div id="admin-controls"></div><a href="/index.html">Volver al piloto</a><script src="/vendor/supabase.js" defer></script><script src="/pilot-auth.js" defer></script><script src="/pilot-admin.js" defer></script><script src="/pilot-admin-ui.js" defer></script></body></html>`)]);
  routes.set('/auth/callback.html',routes.get('/index.html'));
  for(const name of ['pilot-auth.js','pilot-auth-ui.js',...(!readOnly?['pilot-admin.js','pilot-admin-ui.js']:[]),'pilot-macros.js','pilot-macros-service.js','pilot-macros-ui.js','pilot-macros-demo.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
  routes.set('/vendor/supabase.js',['text/javascript; charset=utf-8',fs.readFileSync(path.join(__dirname,'../node_modules/@supabase/supabase-js/dist/umd/supabase.js'))]);
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',CSP);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    const port=server.address()?.port;
    const allowedHosts=config.publicOrigin?[new URL(config.publicOrigin).host]:[`127.0.0.1:${port}`,`localhost:${port}`];
    if(!allowedHosts.includes(req.headers.host)){
      res.writeHead(403);res.end('PILOT_HOST_REJECTED');return;
    }
    if(await handleManualMacros(req,res,macros,config.publicOrigin))return;
    if(await handleDiary(req,res,diaryService,config.publicOrigin))return;
    if(!['GET','HEAD'].includes(req.method)){
      res.setHeader('Allow','GET, HEAD');res.writeHead(405);res.end('PILOT_METHOD_REJECTED');return;
    }
    // Exact allowlist: no filesystem path is ever constructed from a request.
    // Ignore query parameters without decoding or normalizing the allowlisted path.
    const route=req.url.split('?',1)[0];
    if(readOnly&&(route.startsWith('/admin')||route.startsWith('/pilot-admin')||route.startsWith('/preview/'))){res.writeHead(404);res.end();return;}
    const resource=routes.get(route);
    if(!resource){res.writeHead(404);res.end('PILOT_ROUTE_NOT_FOUND');return;}
    if(route.startsWith('/preview/'))res.setHeader('Content-Security-Policy',CSP.replace("connect-src 'self' https://otswebncqidqthqplztj.supabase.co","connect-src 'none'"));
    res.setHeader('Content-Type',resource[0]);res.setHeader('Content-Length',resource[1].length);
    res.writeHead(200);res.end(req.method==='HEAD'?undefined:resource[1]);
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return {server,config,start:()=>server.listen(config.port,config.host)};
}
if(require.main===module){
  try{
    const app=createPilotServer();
    app.server.on('error',()=>{console.error('FAIL PILOT_START');process.exitCode=1;});
    app.server.once('listening',()=>console.log(`TWOGRAMMS — MODO PILOTO\nhttp://127.0.0.1:${app.config.port}/`));
    app.start();
  }catch{console.error('FAIL PILOT_CONFIGURATION_OR_RESOURCES');process.exitCode=1;}
}
module.exports={createPilotServer};
