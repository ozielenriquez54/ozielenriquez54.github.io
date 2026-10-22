'use strict';
const PROJECT_REF='otswebncqidqthqplztj';
const SUPABASE_URL=`https://${PROJECT_REF}.supabase.co`;
function loadPilotConfig(env=process.env){
  if((env.PILOT_SUPABASE_PROJECT_REF!==undefined&&env.PILOT_SUPABASE_PROJECT_REF!==PROJECT_REF)||
    (env.PILOT_SUPABASE_URL!==undefined&&env.PILOT_SUPABASE_URL!==SUPABASE_URL)){
    throw new Error('PILOT_CONFIGURATION_REJECTED');
  }
  const raw=env.PILOT_HTTP_PORT??'3000';
  if(!/^\d+$/.test(raw)||Number(raw)<1024||Number(raw)>65535)throw new Error('PILOT_PORT_REJECTED');
  const publicKey=env.PILOT_SUPABASE_PUBLIC_KEY??'';
  if(publicKey&&!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publicKey))throw new Error('PILOT_PUBLIC_KEY_REJECTED');
  let publicOrigin=null;
  if(env.PILOT_PUBLIC_ORIGIN){
    try{const u=new URL(env.PILOT_PUBLIC_ORIGIN);
      if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.hostname)||u.origin!==env.PILOT_PUBLIC_ORIGIN)throw new Error();
      publicOrigin=u.origin;
    }catch{throw new Error('PILOT_PUBLIC_ORIGIN_REJECTED');}
  }
  return Object.freeze({host:'127.0.0.1',port:Number(raw),projectRef:PROJECT_REF,supabaseUrl:SUPABASE_URL,publicKey,publicOrigin});
}
module.exports={loadPilotConfig};
