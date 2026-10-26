'use strict';
// Proyecto Supabase COMPARTIDO por defecto — nunca cambia solo por tocar
// este archivo; sigue siendo el valor de producción tal cual.
const DEFAULT_PROJECT_REF='otswebncqidqthqplztj';
// Formato real de un project ref de Supabase: 20 caracteres alfanuméricos
// en minúscula (p. ej. 'otswebncqidqthqplztj').
const PROJECT_REF_FORMAT=/^[a-z0-9]{20}$/;
function loadPilotConfig(env=process.env){
  // P1 (auditoría sobre el commit 60afc33, "configuración de Supabase
  // aislado"): antes, PILOT_SUPABASE_PROJECT_REF/PILOT_SUPABASE_URL solo
  // podían CONFIRMAR el proyecto compartido (cualquier otro valor se
  // rechazaba) — no había forma de apuntar este servidor a un proyecto
  // Supabase REALMENTE distinto para una preproducción aislada. Ahora,
  // dando AMBAS variables juntas y mutuamente consistentes, se acepta un
  // proyecto distinto; sin ninguna de las dos, se usa el compartido por
  // defecto (el comportamiento de producción no cambia). Dar solo UNA de
  // las dos (configuración mezclada/incompleta) se rechaza igual que
  // antes — nunca se adivina la otra mitad.
  const refGiven=env.PILOT_SUPABASE_PROJECT_REF!==undefined;
  const urlGiven=env.PILOT_SUPABASE_URL!==undefined;
  if(refGiven!==urlGiven)throw new Error('PILOT_CONFIGURATION_REJECTED');
  let projectRef=DEFAULT_PROJECT_REF;
  if(refGiven){
    if(!PROJECT_REF_FORMAT.test(env.PILOT_SUPABASE_PROJECT_REF))throw new Error('PILOT_CONFIGURATION_REJECTED');
    projectRef=env.PILOT_SUPABASE_PROJECT_REF;
  }
  const supabaseUrl=`https://${projectRef}.supabase.co`;
  // Con ambas dadas, deben ser consistentes ENTRE SÍ — nunca un ref y una
  // URL que apunten a proyectos distintos.
  if(urlGiven&&env.PILOT_SUPABASE_URL!==supabaseUrl)throw new Error('PILOT_CONFIGURATION_REJECTED');
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
  return Object.freeze({host:'127.0.0.1',port:Number(raw),projectRef,supabaseUrl,publicKey,publicOrigin});
}
module.exports={loadPilotConfig};
