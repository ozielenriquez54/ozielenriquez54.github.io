'use strict';
const {createPilotServer}=require('./pilot-http.cjs');
function prepareRender({env=process.env}={}){
  const origin=env.PILOT_PUBLIC_ORIGIN||env.RENDER_EXTERNAL_URL;
  if(!origin||!/^https:\/\/[a-z0-9-]+\.onrender\.com$/.test(origin))throw new Error('RENDER_ORIGIN_REQUIRED');
  const port=env.PORT??'10000';
  const app=createPilotServer({env:{...env,PILOT_PUBLIC_ORIGIN:origin,PILOT_HTTP_PORT:port},readOnly:true});
  if(!app.config.publicKey)throw new Error('PUBLIC_KEY_REQUIRED');
  return {...app,start:()=>app.server.listen(app.config.port,'0.0.0.0')};
}
if(require.main===module){
  try{const app=prepareRender();app.server.on('error',()=>{console.error('RENDER_START_FAILED');process.exitCode=1;});app.start();}
  catch{console.error('RENDER_CONFIGURATION_FAILED');process.exitCode=1;}
}
module.exports={prepareRender};
