'use strict';
// Proyecto Supabase COMPARTIDO por defecto — nunca cambia solo por tocar
// este archivo; sigue siendo el valor de producción tal cual.
const DEFAULT_PROJECT_REF='otswebncqidqthqplztj';
// Formato real de un project ref de Supabase: 20 caracteres alfanuméricos
// en minúscula (p. ej. 'otswebncqidqthqplztj').
const PROJECT_REF_FORMAT=/^[a-z0-9]{20}$/;
// Proyecto de pruebas AISLADO twogramms-test — la ÚNICA excepción
// conocida a "PILOT_PUBLIC_ORIGIN debe ser HTTPS + dominio real" (ver
// más abajo), exclusivamente para el runner local
// (pilot-backend/server/local-twogramms-test-server.cjs). Nunca es un
// valor por defecto ni se usa para nada más — producción sigue exigiendo
// HTTPS igual que siempre.
const ISOLATED_TEST_PROJECT_REF='fadbkbdbpuoekolfcbjm';
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
      // Única excepción a "HTTPS + dominio real": HTTP hacia 127.0.0.1,
      // y SOLO cuando el proyecto ya resuelto arriba es el de pruebas
      // aislado (ISOLATED_TEST_PROJECT_REF) — nunca el compartido/
      // producción ni ningún otro. Pensada exclusivamente para el
      // runner local de pruebas; cualquier otro origin, protocolo, host
      // o proyecto sigue exigiendo exactamente lo mismo que antes.
      const isLocalTestException=u.protocol==='http:'&&u.hostname==='127.0.0.1'&&projectRef===ISOLATED_TEST_PROJECT_REF;
      if((!isLocalTestException&&u.protocol!=='https:')||u.username||u.password||(!isLocalTestException&&u.port)||u.pathname!=='/'||u.search||u.hash||
        (!isLocalTestException&&!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.hostname))||u.origin!==env.PILOT_PUBLIC_ORIGIN)throw new Error();
      publicOrigin=u.origin;
    }catch{throw new Error('PILOT_PUBLIC_ORIGIN_REJECTED');}
  }
  return Object.freeze({host:'127.0.0.1',port:Number(raw),projectRef,supabaseUrl,publicKey,publicOrigin});
}
module.exports={loadPilotConfig};
