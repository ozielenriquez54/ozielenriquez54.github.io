'use strict';
// Explicit, separate entrypoint. Never migrates or seeds a database.
const {loadPilotConfig}=require('./pilot-config.cjs');
const {loadPostgresConfig}=require('./postgres-config.cjs');
const {prepareComplexServer}=require('../activation-drafts/complex-infrastructure.cjs');
const {createProvisioningInfrastructure}=require('./pilot-admin-provisioning-service.cjs');
const PROJECT='fadbkbdbpuoekolfcbjm';
const ORIGIN='https://twogramms-preprod-test.onrender.com';

function prepareIsolatedPilot({env=process.env}={}){
  if(env.PILOT_ISOLATED_WRITE_ACK!==PROJECT ||
     env.PILOT_SUPABASE_PROJECT_REF!==PROJECT ||
     env.PILOT_SUPABASE_URL!==`https://${PROJECT}.supabase.co`)
    throw new Error('ISOLATED_PROJECT_REQUIRED');
  if(env.PILOT_PUBLIC_ORIGIN!==ORIGIN ||
     (env.RENDER_EXTERNAL_URL && env.RENDER_EXTERNAL_URL!==ORIGIN))
    throw new Error('ISOLATED_ORIGIN_REQUIRED');
  const scoped={...env,PILOT_HTTP_PORT:env.PORT??env.PILOT_HTTP_PORT??'10000'};
  const config=loadPilotConfig(scoped);
  if(!config.publicKey)throw new Error('PUBLIC_KEY_REQUIRED');
  // Validate endpoint, role, TLS and CA before creating services/listeners.
  loadPostgresConfig(scoped,undefined,'pilot_diary_server');
  const adminProvisioningService=createProvisioningInfrastructure({env:scoped});
  const app=prepareComplexServer({activate:true,env:scoped,adminProvisioningService});
  let closing;
  const close=()=>closing??=(async()=>{
    try {
      if(app.server.listening)await new Promise((resolve,reject)=>{
        app.server.close(error=>error?reject(error):resolve());
        app.server.closeIdleConnections();
      });
    } finally { await app.closeDatabase(); }
  })();
  return {...app,close,start:()=>app.server.listen(config.port,'0.0.0.0')};
}

if(require.main===module){
  let app;
  try {
    app=prepareIsolatedPilot();
    app.server.on('error',()=>{
      console.error('ISOLATED_PILOT_SERVER_FAILED');
      process.exitCode=1;
      void app.close().catch(()=>{process.exitCode=1;});
    });
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
      const deadline=setTimeout(()=>process.exit(1),25000);
      deadline.unref();
      void app.close().then(()=>clearTimeout(deadline),()=>{
        console.error('ISOLATED_PILOT_CLOSE_FAILED');process.exitCode=1;
      });
    });
    app.start();
  } catch {
    console.error('ISOLATED_PILOT_CONFIGURATION_REJECTED');process.exitCode=1;
  }
}
module.exports={prepareIsolatedPilot};
