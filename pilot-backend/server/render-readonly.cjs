'use strict';
const {createPilotServer}=require('./pilot-http.cjs');
const {createProvisioningInfrastructure}=require('./pilot-admin-provisioning-service.cjs');
function prepareRender({env=process.env}={}){
  const origin=env.PILOT_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL;
  if(!origin||!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin))throw new Error('RENDER_ORIGIN_REQUIRED');
  const port=env.PORT??'10000';
  const mergedEnv={...env,PILOT_PUBLIC_ORIGIN:origin,PILOT_HTTP_PORT:port};
  // Corregido (auditoría Codex sobre el commit 9462850, "integración
  // Render"): el servicio de alta de clientes existía y estaba probado
  // (111 tests), pero nunca se conectaba al arranque real de Render — solo
  // vivía en los tests. readOnly sigue cerrando diario/macros/tracking (es
  // ortogonal a propósito, ver pilot-http.cjs); localAdmin sigue sin
  // habilitarse, y ninguna clave administrativa se expone al cliente (solo
  // `adminProvisioningAvailable: true/false` llega a pilot-config.json).
  const adminProvisioningService=createProvisioningInfrastructure({env:mergedEnv});
  const app=createPilotServer({env:mergedEnv,readOnly:true,adminProvisioningService});
  if(!app.config.publicKey)throw new Error('PUBLIC_KEY_REQUIRED');
  return {...app,start:()=>app.server.listen(app.config.port,'0.0.0.0')};
}
if(require.main===module){
  try{const app=prepareRender();app.server.on('error',()=>{console.error('RENDER_START_FAILED');process.exitCode=1;});app.start();}
  catch{console.error('RENDER_CONFIGURATION_FAILED');process.exitCode=1;}
}
module.exports={prepareRender};
