(function(root){
  'use strict';
  // P1 (auditoría sobre el commit 60afc33, "configuración de Supabase
  // aislado"): antes, createClient() exigía que config.projectRef/
  // config.supabaseUrl coincidieran EXACTAMENTE con un único proyecto
  // compartido hardcodeado aquí — ningún despliegue (ni siquiera uno con
  // el servidor ya corregido para aceptar un proyecto aislado, ver
  // pilot-config.cjs) podía usar un proyecto Supabase distinto, porque
  // este archivo lo rechazaba de todas formas. Corregido: se valida la
  // ESTRUCTURA de lo que el propio servidor entregó (mismo formato real de
  // project ref de Supabase — 20 caracteres alfanuméricos en minúscula — y
  // que supabaseUrl sea EXACTAMENTE `https://<projectRef>.supabase.co`,
  // nunca otro host), en vez de compararlo contra un único valor fijo.
  // `storageKeyFor` deriva la clave de almacenamiento del projectRef
  // configurado, para que dos proyectos nunca compartan la misma entrada
  // de localStorage en el mismo origen.
  const PROJECT_REF_FORMAT=/^[a-z0-9]{20}$/;
  function storageKeyFor(projectRef){return 'twogramms-pilot-auth-'+projectRef;}
  function fail(){throw new Error('PILOT_AUTH_FAILED');}
  function recoveryError(error){
    if(['bad_jwt','session_not_found','refresh_token_not_found','refresh_token_already_used'].includes(error?.code))return {status:'RECOVERY_SESSION_MISSING'};
    if(error?.code==='otp_expired')return {status:'LINK_EXPIRED_OR_USED'};
    if(error?.code==='flow_state_expired')return {status:'LINK_EXPIRED'};
    if(error?.code==='PILOT_NETWORK_ERROR'||error?.name==='AuthRetryableFetchError'||error?.name==='TypeError'||error?.status>=500)return {status:'RECOVERY_NETWORK'};
    return {status:'AUTH_FAILED'};
  }
  function parseCallback(search,hash){
    const q=new URLSearchParams(search),h=new URLSearchParams((hash??'').replace(/^#/,''));
    if(search&&hash)return null;
    const params=search?q:h,keys=Array.from(params.keys());
    if(new Set(keys).size!==keys.length)return null;
    if(params.has('error')&&keys.every(k=>['error','error_code','error_description'].includes(k)))return {kind:'error',status:params.get('error_code')==='otp_expired'?'LINK_EXPIRED_OR_USED':'LINK_INVALID'};
    if(!hash&&Array.from(q).length===1&&q.has('code')&&q.get('code'))return {kind:'pkce',value:q.get('code')};
    if(!search&&Array.from(h).length===2&&['invite','recovery'].includes(h.get('type'))&&/^[a-zA-Z0-9_-]{20,2048}$/.test(h.get('token_hash')??''))return {kind:h.get('type'),value:h.get('token_hash')};
    if(!search&&['invite','recovery'].includes(h.get('type'))&&h.get('token_type')==='bearer'&&
      keys.every(k=>['access_token','refresh_token','token_type','type','expires_in','expires_at'].includes(k))&&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(h.get('access_token')??'')&&(h.get('access_token')??'').length<=16384&&
      /^[A-Za-z0-9_-]{16,2048}$/.test(h.get('refresh_token')??'')&&
      ['expires_in','expires_at'].every(k=>!h.has(k)||/^\d{1,13}$/.test(h.get(k))))
      return {kind:'implicit',type:h.get('type'),value:{access_token:h.get('access_token'),refresh_token:h.get('refresh_token')}};
    return null;
  }
  function createClient(config,sdk,fetchImpl,{admin=false,macros=false}={}){
    if(!PROJECT_REF_FORMAT.test(config.projectRef??'')||config.supabaseUrl!=='https://'+config.projectRef+'.supabase.co'||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publicKey??''))fail();
    const URL_ROOT=config.supabaseUrl;
    return sdk.createClient(URL_ROOT,config.publicKey,{
      auth:{storageKey:storageKeyFor(config.projectRef),flowType:'pkce',detectSessionInUrl:false,persistSession:true,autoRefreshToken:true,debug:false},
      global:{fetch:async(input,init={})=>{
        const url=new URL(typeof input==='string'?input:input.url??input.href);
        if(url.origin!==URL_ROOT||url.username||url.password)fail();
        // pilot_ensure_profile(), pilot_resume_pending_activation() y
        // pilot_create_gym() son excepciones de identidad/autoservicio —
        // las tres actúan exclusivamente sobre auth.uid() (nunca sobre otro
        // usuario) y ninguna otorga privilegios administrativos sobre datos
        // ajenos: pilot_create_gym() crea un gimnasio NUEVO y asigna OWNER
        // únicamente de quien la invoca, la única vía para que una cuenta
        // sin ninguna membresía todavía pueda arrancar algo. Las tres se
        // permiten siempre, incluso en readOnly, que sigue cerrando toda
        // función clínica (diario/macros/tracking) pero no estas acciones
        // de identidad propia.
        //
        // pilot_set_membership() es distinta: SÍ puede modificar la
        // membresía de OTRO usuario (no solo auth.uid()) si quien llama ya
        // es OWNER/ADMIN de ese gimnasio. Se permite aquí, siempre y sin
        // depender de `admin`/readOnly, porque su propia definición SQL
        // (`pilot_private.lock_admin(p_gym_id)`, confirmado) ya revalida
        // esa condición del lado del servidor antes de tocar cualquier
        // fila — el allowlist de transporte nunca es el límite de
        // seguridad real para esta RPC, igual que no lo es para ninguna
        // función SECURITY DEFINER con EXECUTE otorgado a `authenticated`.
        // La UI solo la usa para que un OWNER se agregue a sí mismo el rol
        // COACH (nunca para tocar otra cuenta), pero esa restricción vive
        // en pilot-auth.js::addOwnCoachRole(), no aquí.
        const allowed=['/rest/v1/profiles','/rest/v1/gym_memberships','/rest/v1/rpc/pilot_ensure_profile','/rest/v1/rpc/pilot_resume_pending_activation','/rest/v1/rpc/pilot_create_gym','/rest/v1/rpc/pilot_set_membership'];
        if(macros)allowed.push('/rest/v1/clients','/rest/v1/coach_clients','/rest/v1/manual_macro_targets','/rest/v1/manual_macro_target_versions');
        if(admin&&!config.readOnly)allowed.push('/rest/v1/coach_clients','/rest/v1/rpc/pilot_set_coach_client');
        if(!url.pathname.startsWith('/auth/v1/')&&!allowed.includes(url.pathname))fail();
        const method=(init.method??(typeof input==='object'?input.method:undefined)??'GET').toUpperCase();
        if(config.readOnly&&url.pathname.startsWith('/auth/v1/')&&
          !['POST /auth/v1/token','GET /auth/v1/user','PUT /auth/v1/user','POST /auth/v1/logout','POST /auth/v1/otp','POST /auth/v1/recover','POST /auth/v1/verify'].includes(method+' '+url.pathname))fail();
        if(url.pathname.startsWith('/rest/v1/')){
          const rpc=url.pathname.startsWith('/rest/v1/rpc/');
          if(rpc?method!=='POST':!['GET','HEAD'].includes(method))fail();
        }
        const abort=new AbortController(),caller=init.signal??input?.signal;
        const cancel=()=>abort.abort();
        const timer=setTimeout(cancel,10000);
        if(caller?.aborted)cancel();else caller?.addEventListener('abort',cancel,{once:true});
        try{
          const response=await fetchImpl(input,{...init,redirect:'error',signal:abort.signal});
          // SDK errors must never carry a server message, echoed input or URL.
          if(!response.ok){
            let code;
            // Se conserva el código SQL/PostgREST reconocido (nunca el
            // mensaje crudo del servidor) — 23505 (unique_violation) se
            // agrega aquí (P2, auditoría sobre el commit a201ed1,
            // "clasificación incorrecta de errores"): antes se descartaba
            // en silencio igual que cualquier código no reconocido, cuando
            // es un conflicto SQL real que conviene distinguir de un
            // simple "no se pudo completar la operación". El código HTTP
            // real (`response.status`) SIEMPRE viaja intacto en el
            // Response sintetizado de abajo — nunca se sustituye por un
            // código inventado: el estado 0 (transporte real, nunca
            // llegó respuesta) y 404 ("no existe todavía") se distinguen
            // más adelante, en verify(), a partir de ESE estado, nunca de
            // `code` (ver la nota de ahí sobre por qué un `code` vacío NO
            // implica por sí mismo un error de red).
            try{const body=await response.json();const candidate=body.code??body.error_code;if(['42501','40001','23503','23505','23514'].includes(candidate)||(url.pathname.startsWith('/auth/v1/')&&['otp_expired','flow_state_expired','session_not_found','refresh_token_not_found','refresh_token_already_used','bad_jwt'].includes(candidate)))code=candidate;}catch{}
            return new Response(JSON.stringify({message:'PILOT_REQUEST_FAILED',error:'PILOT_REQUEST_FAILED',code,error_code:code}),{status:response.status,headers:{'Content-Type':'application/json'}});
          }
          return response;
        }catch{const error=new Error('PILOT_NETWORK_ERROR');error.code='PILOT_NETWORK_ERROR';throw error;}finally{clearTimeout(timer);caller?.removeEventListener('abort',cancel);}
      }}
    });
  }
  function controller(client,role,redirectTo,{approvedOrigin=null,readOnly=false,recoveryState=null}={}){
    if(!['COACH','CLIENT'].includes(role))fail();
    const url=new URL(redirectTo);
    const local=url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);
    const published=approvedOrigin&&url.protocol==='https:'&&url.origin===approvedOrigin;
    // Caso adicional: entorno de pruebas aislado local (runner
    // local-twogramms-test-server.cjs), donde SÍ se configura un
    // approvedOrigin explícito pero sigue siendo http://127.0.0.1 (nunca
    // 'localhost') — mismo criterio exacto que ya aplican
    // pilot-config.cjs e inviteRedirectTo() en
    // pilot-admin-provisioning-service.cjs para el proyecto
    // twogramms-test: ese archivo de servidor es el único que puede
    // producir un `config.publicOrigin` con esta forma, así que esta
    // comprobación no necesita repetir el chequeo de proyecto. Nunca
    // relaja nada para un approvedOrigin HTTPS real ni para 'localhost'.
    const localApproved=approvedOrigin&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.origin===approvedOrigin;
    if(!(local&&!approvedOrigin||published||localApproved)||url.username||url.password||url.pathname!=='/auth/callback.html'||url.search||url.hash)fail();
    let generation=0,pendingUser=null,passwordUser=null;
    const recovery=recoveryState??{get:()=>pendingUser,set:id=>{pendingUser=id;},clear:()=>{pendingUser=null;}};
    function clearRecovery(){passwordUser=null;recovery.clear();}
    async function resumeRecovery(){
      const ticket=generation;passwordUser=null;
      try{
        const expected=recovery.get();
        if(typeof expected!=='string'||!/^[a-zA-Z0-9-]{3,128}$/.test(expected))fail();
        const user=await client.auth.getUser();
        if(ticket!==generation)return {status:'AUTH_FAILED'};
        if(user.error)throw user.error;
        if(!user.data?.user?.id){clearRecovery();return {status:'RECOVERY_SESSION_MISSING'};}
        if(user.data.user.id!==expected){clearRecovery();return {status:'RECOVERY_SESSION_MISMATCH'};}
        passwordUser=expected;return {status:'RECOVERY'};
      }catch(error){
        if(ticket!==generation)return {status:'AUTH_FAILED'};
        const result=recoveryError(error);
        if(result.status!=='RECOVERY_NETWORK')clearRecovery();
        return result;
      }
    }
    async function passwordSession(session){
      const id=session?.user?.id;
      if(typeof id!=='string'||!/^[a-zA-Z0-9-]{3,128}$/.test(id))fail();
      // Only an Auth exchange can establish this reference; never store its tokens.
      recovery.set(id);return resumeRecovery();
    }
    async function verify(){
      const ticket=++generation;
      try{
        const user=await client.auth.getUser();
        if(user.error||!user.data?.user?.id)return {status:'SIGNED_OUT'};
        const id=user.data.user.id;
        // Siempre por autoservicio (auth.uid() interno a la RPC, nunca un
        // id ajeno) y siempre, incluso en readOnly: es una excepción de
        // identidad, no una función clínica. Necesario para que un cliente
        // recién invitado tenga profiles.id en su propio primer login —
        // no existe ningún trigger que lo cree por otra vía.
        const profile=await client.rpc('pilot_ensure_profile');
        // PostgREST puede envolver el resultado en un arreglo según cómo
        // esté declarada la función; se acepta un objeto o un arreglo de
        // exactamente una fila, nunca cero ni más de una (ambiguo).
        const ownProfile=Array.isArray(profile.data)?(profile.data.length===1?profile.data[0]:null):profile.data;
        if(profile.error||ownProfile?.id!==id)fail();
        if(ticket!==generation)return {status:'SIGNED_OUT'};
        // Autoservicio, tolerante a propósito SOLO a que la función todavía
        // no exista (infraestructura propuesta no aplicada — HTTP 404) o a
        // que no hubiera nada pendiente (sin fila): ninguno de los dos es
        // un error. Cualquier OTRO resultado se distingue explícitamente —
        // nunca se oculta tras un AUTHORIZED/ROLE_REQUIRED genérico (P2,
        // auditoría sobre el commit 26fd7fc: "errores ocultos"):
        //   - out_status='blocked_privileged_role' (P0): la reanudación se
        //     negó a reactivar sola una membresía propia inactiva con
        //     OWNER/ADMIN — requiere una acción administrativa explícita.
        //   - out_status='cancelled': la autorización original (el
        //     OWNER/ADMIN que autorizó, o el coach destino) ya no es
        //     válida — la activación falló, no quedó "pendiente".
        //   - out_status='completed' o ninguna fila: se continúa el flujo
        //     normal de abajo (la nueva membresía, si se otorgó, ya se
        //     refleja en la lectura de gym_memberships que sigue).
        //   - un error de transporte DISTINTO de "no existe todavía"
        //     (permiso denegado, HTTP 500, un conflicto SQL como 23505,
        //     etc.): se reporta como fallo de activación explícito, nunca
        //     se finge que no pasó nada NI se confunde con un error de red.
        //   - un fallo de RED real: se distingue de AUTH_FAILED — la
        //     sesión sigue siendo válida, solo falló la reanudación y
        //     conviene reintentar, no volver a iniciar sesión.
        //
        // P2 (auditoría sobre el commit 60afc33, endurecido tras la
        // auditoría sobre el commit a201ed1, "clasificación incorrecta de
        // errores"): el SDK de Supabase, por configuración por defecto
        // (nunca se llamó `.throwOnError()` en este archivo), NO lanza una
        // excepción ante un fallo de fetch real — lo CAPTURA internamente
        // y resuelve `{error}`. La ronda anterior distinguía esto mirando
        // si `resume.error.code` estaba vacío — pero un HTTP 500 (o
        // cualquier error real sin código SQL reconocido) TAMBIÉN llega
        // con `code` vacío/ausente, así que ese chequeo clasificaba un
        // fallo de servidor real como si fuera un problema de red. La
        // señal correcta y estable (confirmada leyendo el código fuente
        // instalado de @supabase/postgrest-js, PostgrestBuilder.ts) es
        // `resume.status`: 0 únicamente cuando el fetch nunca llegó a
        // completarse (fallo de transporte real — nunca hubo respuesta
        // HTTP), y el código HTTP real (404, 500, lo que sea) en cualquier
        // otro caso, incluyendo cuando sí hubo respuesta pero PostgREST
        // reportó un error. El `catch` de abajo nunca se alcanza en la
        // práctica para esto — queda solo como defensa en profundidad si
        // una versión futura del SDK cambiara ese comportamiento.
        try{
          const resume=await client.rpc('pilot_resume_pending_activation');
          if(ticket!==generation)return {status:'SIGNED_OUT'};
          if(resume.error){
            if(resume.status===0)return {status:'ACTIVATION_NETWORK_ERROR'};
            if(resume.status!==404)return {status:'ACTIVATION_FAILED'};
            /* 404: tolerado — la función todavía no existe */
          }else{
            const row=Array.isArray(resume.data)?resume.data[0]:resume.data;
            if(row?.out_status==='blocked_privileged_role')return {status:'ACTIVATION_BLOCKED_PRIVILEGED_ROLE'};
            if(row?.out_status==='cancelled')return {status:'ACTIVATION_CANCELLED'};
          }
        }catch(error){
          if(ticket!==generation)return {status:'SIGNED_OUT'};
          if(error?.code==='PILOT_NETWORK_ERROR')return {status:'ACTIVATION_NETWORK_ERROR'};
          return {status:'ACTIVATION_FAILED'};
        }
        const memberships=await client.from('gym_memberships').select('user_id,roles,active').eq('user_id',id).eq('active',true);
        if(memberships.error||!Array.isArray(memberships.data))fail();
        if(ticket!==generation)return {status:'SIGNED_OUT'};
        // La vista Coach también es accesible para OWNER/ADMIN (permisos
        // administrativos), no solo COACH (permiso clínico/de coacheo) —
        // esto NUNCA otorga el rol COACH en los datos, solo amplía qué
        // roles reales dan acceso a ESTA página. La vista Cliente sigue
        // exigiendo literalmente CLIENT, sin cambios.
        const acceptedRoles=role==='COACH'?['COACH','OWNER','ADMIN']:[role];
        const allowed=memberships.data.some(m=>m.user_id===id&&m.active===true&&Array.isArray(m.roles)&&m.roles.some(r=>acceptedRoles.includes(r)));
        if(allowed){
          // Señal para la UI (nunca una autorización en sí misma — eso lo
          // sigue decidiendo exclusivamente pilot_set_membership del lado
          // del servidor): exactamente una membresía activa OWNER/ADMIN sin
          // COACH todavía. Ambigua (ninguna, o más de una) o fuera de la
          // vista Coach: nunca se adivina, igual que el selector de
          // gimnasio en el alta de clientes.
          const eligibleForOwnCoachRole=memberships.data.filter(m=>m.active===true&&Array.isArray(m.roles)&&(m.roles.includes('OWNER')||m.roles.includes('ADMIN'))&&!m.roles.includes('COACH'));
          return {status:'AUTHORIZED',canAddOwnCoachRole:role==='COACH'&&eligibleForOwnCoachRole.length===1};
        }
        // Distinción mínima dentro del mismo caso "sin acceso a esta vista":
        // NO_MEMBERSHIP (cero membresías ACTIVAS, de cualquier rol, en
        // cualquier gimnasio) es la única situación en la que crear un
        // gimnasio propio (pilot_create_gym) tiene sentido — una cuenta que
        // YA pertenece a algún gimnasio (p. ej. CLIENT viendo /coach.html)
        // sigue viendo ROLE_REQUIRED, nunca la opción de crear otro.
        return {status:memberships.data.length===0?'NO_MEMBERSHIP':'ROLE_REQUIRED'};
      }catch{return {status:'AUTH_FAILED'};}
    }
    async function passwordLink(tokenHash,type){try{
      clearRecovery();
      const ticket=generation;
      if(typeof tokenHash!=='string'||!/^[a-zA-Z0-9_-]{20,2048}$/.test(tokenHash))fail();
      const r=await client.auth.verifyOtp({token_hash:tokenHash,type});
      if(ticket!==generation)fail();if(r.error)throw r.error;if(!r.data?.session)fail();
      return await passwordSession(r.data.session);
    }catch(error){return recoveryError(error);}}
    return {
      verify,
      resumeRecovery,
      async implicit(tokens,type){
        const expected=recovery.get();clearRecovery();const ticket=generation;
        try{
          const parsed=parseCallback('','#'+new URLSearchParams({...tokens,type,token_type:'bearer'}));
          if(parsed?.kind!=='implicit')return {status:'LINK_INVALID'};
          // Validate the incoming token with Auth, never trust decoded JWT claims or an old session.
          const incoming=await client.auth.getUser(parsed.value.access_token);
          if(ticket!==generation)fail();if(incoming.error)throw incoming.error;
          const id=incoming.data?.user?.id;if(!id)fail();
          if(expected&&expected!==id)return {status:'RECOVERY_SESSION_MISMATCH'};
          recovery.set(id);
          const result=await client.auth.setSession(parsed.value);
          if(ticket!==generation)fail();if(result.error)throw result.error;
          if(result.data?.session?.user?.id!==id){clearRecovery();return {status:'RECOVERY_SESSION_MISMATCH'};}
          return await resumeRecovery();
        }catch(error){if(ticket!==generation)return {status:'AUTH_FAILED'};const result=recoveryError(error);if(result.status!=='RECOVERY_NETWORK')clearRecovery();return result;}
      },
      invalidate(){generation++;clearRecovery();},
      async login(email,password){try{clearRecovery();const r=await client.auth.signInWithPassword({email,password});if(r.error)fail();return await verify();}catch{return {status:'AUTH_FAILED'};}},
      // Autoservicio: crea un gimnasio nuevo y asigna OWNER únicamente de
      // auth.uid() (pilot_create_gym, ver pilot-backend). Solo tiene
      // sentido cuando verify() ya devolvió NO_MEMBERSHIP; llamarla con una
      // sesión ya vinculada a algún gimnasio no está prohibido por la RPC
      // en sí, pero la UI solo la ofrece en ese caso (ver pilot-auth-ui.js).
      // Reutiliza verify() al final para reflejar la nueva membresía OWNER
      // sin pedir un nuevo inicio de sesión.
      async createGym(name){try{
        if(typeof name!=='string')fail();
        const trimmed=name.trim();
        if(trimmed.length<1||trimmed.length>160)fail();
        const r=await client.rpc('pilot_create_gym',{p_name:trimmed});
        if(r.error)fail();
        return await verify();
      }catch{return {status:'AUTH_FAILED'};}},
      // Autoservicio acotado: un OWNER/ADMIN se agrega a sí mismo (nunca a
      // otra cuenta — p_user_id es siempre auth.uid(), nunca un parámetro)
      // el rol COACH sobre su propia membresía, conservando el resto de
      // sus roles. gym_id/roles/revision se leen de una fila RECIÉN
      // consultada (nunca de datos ya cacheados de verify() ni fijados en
      // el código) para que p_expected_revision sea siempre el real.
      // Ambigua (ninguna membresía elegible, o más de una): se niega sin
      // adivinar — igual que el selector de gimnasio del alta de clientes.
      // pilot_set_membership() revalida del lado del servidor
      // (pilot_private.lock_admin) que quien llama ya sea OWNER/ADMIN de
      // ese gimnasio; esta función nunca es, por sí sola, el límite de
      // seguridad real.
      async addOwnCoachRole(){try{
        const user=await client.auth.getUser();
        if(user.error||!user.data?.user?.id)fail();
        const id=user.data.user.id;
        const memberships=await client.from('gym_memberships').select('gym_id,roles,active,revision').eq('user_id',id).eq('active',true);
        if(memberships.error||!Array.isArray(memberships.data))fail();
        const eligible=memberships.data.filter(m=>m.active===true&&Array.isArray(m.roles)&&(m.roles.includes('OWNER')||m.roles.includes('ADMIN'))&&!m.roles.includes('COACH'));
        if(eligible.length!==1)fail();
        const target=eligible[0];
        const r=await client.rpc('pilot_set_membership',{p_gym_id:target.gym_id,p_user_id:id,p_roles:[...target.roles,'COACH'],p_active:true,p_expected_revision:target.revision});
        if(r.error)fail();
        return await verify();
      }catch{return {status:'AUTH_FAILED'};}},
      async logout(){generation++;clearRecovery();try{const r=await client.auth.signOut({scope:'local'});return {status:r.error?'LOGOUT_FAILED':'SIGNED_OUT'};}catch{return {status:'LOGOUT_FAILED'};}},
      async email(email,recovery){try{
        const r=recovery?await client.auth.resetPasswordForEmail(email,{redirectTo}):await client.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo,shouldCreateUser:false}});
        if(r.error)fail();return {status:'EMAIL_SENT'};
      }catch{return {status:'AUTH_FAILED'};}},
      async callback(code){try{
        clearRecovery();
        const ticket=generation;
        if(typeof code!=='string'||!code||code.length>2048)fail();
        const r=await client.auth.exchangeCodeForSession(code);if(ticket!==generation)fail();if(r.error)throw r.error;
        if(['recovery','invite'].includes(r.data?.redirectType))return await passwordSession(r.data.session);
        return await verify();
      }catch(error){return recoveryError(error);}},
      invitation:tokenHash=>passwordLink(tokenHash,'invite'),
      recovery:tokenHash=>passwordLink(tokenHash,'recovery'),
      async password(password){try{
        if(typeof password!=='string'||password.length<8||!passwordUser||recovery.get()!==passwordUser)fail();
        const check=await resumeRecovery();if(check.status!=='RECOVERY')return check;
        const r=await client.auth.updateUser({password});if(r.error)fail();
        clearRecovery();return {status:'PASSWORD_UPDATED'};
      }catch{return {status:'AUTH_FAILED'};}}
    };
  }
  const api={createClient,controller,parseCallback,storageKeyFor};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PilotAuth=api;
})(typeof globalThis==='object'?globalThis:this);
