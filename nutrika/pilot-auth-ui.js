'use strict';
(async()=>{
  const status=document.getElementById('auth-status'),access=document.getElementById('pilot-access');
  const recovery=document.getElementById('password-form');
  const createGym=document.getElementById('create-gym-form');
  const addOwnCoachRole=document.getElementById('add-own-coach-role');
  const messages={SIGNED_OUT:'Inicia sesión con tu cuenta del piloto.',AUTHORIZED:'Sesión verificada y rol autorizado. Las funciones clínicas siguen deshabilitadas.',
    ROLE_REQUIRED:'Sesión verificada. Falta una membresía activa para esta vista; solicítala al administrador.',AUTH_FAILED:'No se pudo completar la operación. Revisa los datos o solicita un enlace nuevo.',
    NO_MEMBERSHIP:'Sesión verificada. Todavía no perteneces a ningún gimnasio: crea el primero para convertirte en su propietario.',
    EMAIL_SENT:'Si la cuenta está habilitada, recibirás un enlace. Ábrelo en este mismo perfil de navegador.',RECOVERY:'Define tu nueva contraseña.',PASSWORD_UPDATED:'Contraseña actualizada. Ya puedes iniciar sesión.',LOGOUT_FAILED:'No se pudo confirmar el cierre de sesión. Vuelve a intentarlo.'};
  Object.assign(messages,{
    LINK_INVALID:'El enlace está incompleto o no es válido. Usa el enlace completo del correo.',
    LINK_EXPIRED:'El enlace ha expirado. Solicita asistencia para recuperar el acceso.',
    LINK_EXPIRED_OR_USED:'El enlace ha expirado o ya fue utilizado. No es posible distinguir ambas causas con la respuesta recibida.',
    RECOVERY_NETWORK:'No se pudo verificar la sesión por un problema de conexión. Reintenta la verificación sin volver a abrir el enlace.',
    RECOVERY_SESSION_MISSING:'No hay una sesión de recuperación válida en este navegador.',
    RECOVERY_SESSION_MISMATCH:'La sesión corresponde a otra cuenta. No se permite cambiar la contraseña.',
    RATE_LIMITED:'Se alcanzó el límite temporal de solicitudes. Espera unos minutos antes de volver a intentarlo y usa solo el último correo recibido.',
    LINK_OTHER_BROWSER:'Este enlace debe abrirse en el mismo navegador donde solicitaste la recuperación. Ábrelo ahí o solicita un enlace nuevo.',
    LINK_SUPERSEDED:'Este enlace ya no es válido: pertenece a una solicitud anterior o ya se usó. Abre el último correo recibido o solicita un enlace nuevo.',
    AUTH_FAILED:'No se pudo verificar la recuperación o completar la operación. Solicita asistencia sin compartir el enlace.',
    // P2 (auditoría sobre el commit 26fd7fc, "errores ocultos"): estos
    // cuatro estados de la reanudación automática de activación ya existían
    // en pilot-auth.js, pero sin entrada aquí caían en el AUTH_FAILED
    // genérico de abajo — nunca se mostraban al usuario como lo que
    // realmente eran. Ninguno expone detalles internos ni datos sensibles.
    ACTIVATION_BLOCKED_PRIVILEGED_ROLE:'Tu cuenta tiene un rol administrativo inactivo en este gimnasio. Reactivarlo requiere una acción explícita del administrador; no ocurre solo al iniciar sesión.',
    ACTIVATION_CANCELLED:'La autorización para activar tu cuenta en este gimnasio ya no es válida (fue revocada o cambió). Solicita una nueva invitación al administrador.',
    ACTIVATION_FAILED:'No se pudo completar la activación automática de tu cuenta. Vuelve a intentarlo o solicita ayuda al administrador.',
    ACTIVATION_NETWORK_ERROR:'No se pudo completar la activación automática por un problema de conexión. Vuelve a intentarlo.',
  });
  let recoveryMode=location.pathname==='/auth/callback.html';
  function recoveryLayout(){
    for(const id of ['login-form','magic-link','recover'])document.getElementById(id).hidden=recoveryMode;
    const title=document.getElementById('recovery-title');if(title)title.hidden=!recoveryMode;
    const link=document.getElementById('recovery-login');if(link)link.hidden=!recoveryMode;
  }
  recoveryLayout();
  let busy=false,updating=false,macrosUI=null,authorized=false,authEpoch=0,diaryUI=null,diaryModel=null,trackingUI=null,trackingModel=null,coachHistoryUI=null,provisioningUI=null,refreshDiary=()=>{},refreshTracking=()=>{},refreshCoachHistory=()=>{},refreshProvisioning=()=>{};
  // `render()` necesita `role` en su cierre (ver abajo, decide si muestra
  // #create-gym-form) — declarada aquí, en el ámbito del IIFE, en vez de
  // con `const` dentro del `try{}` de más abajo (bloque hermano, fuera del
  // alcance de `render`). Se asigna una sola vez, antes de que `render` se
  // llame por primera vez; nunca cambia de valor después.
  let role,diaryUser=null,diaryTarget=null,diaryLoading=false;
  function clearDiary(){diaryModel?.invalidate();diaryUI?.clear();}
  let homeUI=null,refreshHome=()=>{};
  function clearTracking(){trackingModel?.invalidate();trackingUI?.clear();homeUI?.clear();coachHistoryUI?.clear();}
  function clearProvisioning(){provisioningUI?.clear();}
  // Keep the last verified view visible, but non-interactive until revalidation ends.
  // Dialogs live outside pilot-access and must be blocked as well.
  function blockAccess(blocked){
    for(const id of ['pilot-access','food-dialog','log-dialog']){
      const element=document.getElementById(id);if(element)element.inert=blocked;
    }
  }
  function render(result,{userId=null,preserve=false}={}){
    if(result.status==='RECOVERY')recoveryMode=true;
    if(['PASSWORD_UPDATED','AUTHORIZED'].includes(result.status))recoveryMode=false;
    updating=result.status==='RECOVERY';
    recoveryLayout();
    const retry=document.getElementById('recovery-retry');if(retry)retry.hidden=!(recoveryMode&&result.status==='RECOVERY_NETWORK');
    status.textContent=messages[result.status]??messages.AUTH_FAILED;
    access.hidden=result.status!=='AUTHORIZED';
    recovery.hidden=result.status!=='RECOVERY';
    if(createGym)createGym.hidden=!(result.status==='NO_MEMBERSHIP'&&role==='COACH');
    if(addOwnCoachRole)addOwnCoachRole.hidden=!(result.status==='AUTHORIZED'&&result.canAddOwnCoachRole===true&&role==='COACH');
    authorized=result.status==='AUTHORIZED';
    blockAccess(!authorized||busy||diaryLoading||document.hidden);
    if(authorized){
      if(!document.hidden){macrosUI?.refresh();refreshDiary(userId,preserve);refreshTracking();if(!preserve)refreshHome();refreshCoachHistory();refreshProvisioning();}
    }else {diaryUser=null;diaryTarget=null;diaryLoading=false;macrosUI?.clear();clearDiary();clearTracking();clearProvisioning();access.hidden=true;}
  }
  // Capture credentials in memory and immediately clean the address; never log them.
  const callback=location.pathname==='/auth/callback.html';
  const callbackSearch=location.search,callbackHash=location.hash;
  history.replaceState(null,'',location.pathname);
  try{
    const config=await (await fetch('/pilot-config.json',{cache:'no-store'})).json();
    if(!config.publicKey){status.textContent='Configura PILOT_SUPABASE_PUBLIC_KEY con la clave publicable del proyecto piloto y reinicia el servidor.';return;}
    const credential=callback?PilotAuth.parseCallback(callbackSearch,callbackHash):null;
    const invitation=credential?.kind==='invite'||credential?.kind==='implicit'&&credential.type==='invite';
    role=invitation?'CLIENT':callback?(sessionStorage.getItem('twogramms-pilot-view')??'CLIENT'):document.body.dataset.role;
    sessionStorage.setItem('twogramms-pilot-view',role);
    const client=PilotAuth.createClient(config,supabase,fetch.bind(window));
    const recoveryState={get:()=>sessionStorage.getItem('twogramms-pilot-recovery'),set:id=>sessionStorage.setItem('twogramms-pilot-recovery',id),clear:()=>sessionStorage.removeItem('twogramms-pilot-recovery')};
    const auth=PilotAuth.controller(client,role,location.origin+'/auth/callback.html',{approvedOrigin:config.publicOrigin??null,readOnly:config.readOnly===true,recoveryState});
    const macrosModel=PilotMacrosService.createModel(client,role);
    macrosUI=PilotMacrosUI.mount(document.getElementById('macros-root'),{model:PilotMacrosService.createModel(client,role),role,
      writer:config.macrosWritable===true&&role==='COACH'?PilotMacrosService.createWriter(client):null});
    if(role==='CLIENT'&&config.diaryAvailable){
      diaryModel=PilotDiaryService.createModel(client);
      const own=PilotMacrosService.createModel(client,'CLIENT');
      // Alimentación: tarjetas por comida; el panel de búsqueda vive en el shell y el
      // resumen lee la prescripción vigente del coach (solo lectura).
      const shellUI=typeof PilotClientShell!=='undefined'?PilotClientShell:null;
      diaryUI=PilotDiaryUI.mount(document.getElementById('diary-root'),{model:diaryModel,macros:own,panel:shellUI?.foodPanel()??null,
        onChanged:()=>{if(authorized&&!document.hidden)homeUI?.refresh();}});
      shellUI?.onLanguageChange(()=>{if(authorized&&!document.hidden)diaryUI.refresh?.();});
      refreshDiary=async(userId,preserve=false)=>{const ticket=authEpoch;diaryLoading=true;blockAccess(true);try{
        if(!userId)throw new Error('DIARY_UNAVAILABLE');
        if(diaryUser&&diaryUser!==userId)throw new Error('DIARY_UNAVAILABLE');
        const targets=await own.list();if(ticket!==authEpoch||!authorized)return;
        if(targets.length!==1)throw new Error('DIARY_UNAVAILABLE');
        const target=targets[0];
        if(diaryTarget&&(diaryTarget.gymId!==target.gymId||diaryTarget.clientId!==target.clientId))throw new Error('DIARY_UNAVAILABLE');
        const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
        await diaryUI.show(target,date,{preserve,validate:async()=>{
          const session=await client.auth.getSession();
          return ticket===authEpoch&&authorized&&!session.error&&session.data?.session?.user?.id===userId;
        }});
        if(ticket===authEpoch&&authorized){diaryUser=userId;diaryTarget={gymId:target.gymId,clientId:target.clientId};}
      }catch{if(ticket===authEpoch)render({status:'AUTH_FAILED'});}
      finally{if(ticket===authEpoch){diaryLoading=false;blockAccess(!authorized||busy||document.hidden);}}};
    }
    if(config.trackingAvailable===true){
      trackingModel=PilotTrackingService.createModel(client);trackingUI=PilotTrackingUI.mount(document.getElementById('tracking-root'),{model:trackingModel,role,onSaved:()=>{if(authorized&&!document.hidden)homeUI?.refresh();}});
      if(role==='CLIENT')refreshTracking=async()=>{const ticket=authEpoch;trackingUI.clear();try{const targets=await macrosModel.list();if(ticket!==authEpoch||!authorized||document.hidden||targets.length!==1)return;const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');await trackingUI.show(targets[0],date,macrosModel);}catch{trackingUI.clear();}};
      else{coachHistoryUI=PilotCoachHistoryUI.mount(document.getElementById('coach-history-root'),{model:macrosModel,macros:macrosModel,tracking:trackingUI});refreshCoachHistory=async()=>{if(!authorized||document.hidden)return;await coachHistoryUI.refresh();};}
    }
    // Experiencia del cliente (Hoy · Alimentación · Progreso · Mi plan): solo para
    // CLIENT y solo si el módulo está cargado. Sin seguimiento conectado muestra
    // estados pendientes; nunca datos ficticios. Lee con los mismos modelos autorizados.
    if(role==='CLIENT'&&typeof PilotClientHomeUI!=='undefined'){
      const shell=typeof PilotClientShell!=='undefined'?PilotClientShell:null;
      homeUI=PilotClientHomeUI.mount({today:document.getElementById('home-today-root'),food:document.getElementById('home-food-root'),progress:document.getElementById('home-progress-root'),plan:document.getElementById('home-plan-root')},
        {model:trackingModel,macros:macrosModel,log:trackingUI,diaryAvailable:config.diaryAvailable===true,navigate:opts=>shell?.navigate(opts)});
      shell?.onLanguageChange(()=>{if(authorized&&!document.hidden)homeUI.refresh();});
      refreshHome=async()=>{const ticket=authEpoch;homeUI.clear();try{const targets=await macrosModel.list();if(ticket!==authEpoch||!authorized||document.hidden||targets.length!==1)return;const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');await homeUI.show(targets[0],date);}catch{homeUI.clear();}};
    }
    if(config.adminProvisioningAvailable===true&&role==='COACH'){
      provisioningUI=PilotAdminProvisioningUI.mount(document.getElementById('admin-provisioning-root'),{client});
      refreshProvisioning=async()=>{if(!authorized||document.hidden)return;await provisioningUI.refresh();};
    }
    async function run(fn,{revalidate=false}={}){
      if(busy)return;busy=true;
      const preserve=revalidate&&authorized;
      if(preserve){blockAccess(true);diaryModel?.invalidate();diaryUI?.suspend?.();}
      else {access.hidden=true;macrosUI.clear();clearDiary();clearTracking();}
      const ticket=++authEpoch;
      try{
        const before=diaryUI?await client.auth.getSession():null;
        const userId=before?.data?.session?.user?.id;
        if(diaryUI&&preserve&&(before?.error||!userId||diaryUser&&diaryUser!==userId))throw new Error('DIARY_UNAVAILABLE');
        const result=await fn();
        const after=diaryUI&&result.status==='AUTHORIZED'?await client.auth.getSession():null;
        const currentUser=after?.data?.session?.user?.id;
        if(diaryUI&&result.status==='AUTHORIZED'&&(after?.error||!currentUser||userId&&currentUser!==userId))throw new Error('DIARY_UNAVAILABLE');
        if(ticket===authEpoch)render(result,{userId:currentUser,preserve});
      }catch{if(ticket===authEpoch)render({status:'AUTH_FAILED'});}
      finally{busy=false;blockAccess(!authorized||diaryLoading||document.hidden);document.querySelectorAll('input[type=password]').forEach(el=>{el.value='';});}
    }
    document.getElementById('recovery-retry')?.addEventListener('click',()=>run(()=>auth.resumeRecovery()));
    const email=()=>document.getElementById('auth-email').value.trim();
    document.getElementById('login-form').addEventListener('submit',event=>{event.preventDefault();run(()=>auth.login(email(),document.getElementById('auth-password').value));});
    createGym?.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
      const input=document.getElementById('create-gym-name'),result=await auth.createGym(input.value);
      if(result.status==='AUTHORIZED')input.value='';
      return result;
    });});
    addOwnCoachRole?.addEventListener('click',()=>run(()=>auth.addOwnCoachRole()));
    document.getElementById('magic-link').addEventListener('click',()=>run(()=>auth.email(email(),false)));
    document.getElementById('recover').addEventListener('click',()=>run(()=>auth.email(email(),true)));
    document.getElementById('logout').addEventListener('click',async()=>{
      const ticket=++authEpoch;auth.invalidate();updating=false;sessionStorage.removeItem('twogramms-pilot-recovery');render({status:'SIGNED_OUT'});
      const result=await auth.logout();if(ticket===authEpoch)render(result);
    });
    recovery.addEventListener('submit',event=>{event.preventDefault();run(async()=>{
      if(!updating)return {status:'AUTH_FAILED'};
      const result=await auth.password(document.getElementById('new-password').value);
      if(result.status==='PASSWORD_UPDATED'){updating=false;recoveryState.clear();}
      return result;
    });});
    client.auth.onAuthStateChange((event,session)=>{
      if(diaryUI&&session?.user?.id&&diaryUser&&session.user.id!==diaryUser){authEpoch++;auth.invalidate();render({status:'SIGNED_OUT'});return;}
      if(event==='SIGNED_OUT'){authEpoch++;auth.invalidate();updating=false;recoveryState.clear();render({status:'SIGNED_OUT'});}
      // Do not await Auth methods inside its event callback (SDK lock).
      if(event==='TOKEN_REFRESHED'&&!busy&&!updating&&!recoveryMode)setTimeout(()=>run(()=>auth.verify(),{revalidate:true}),0);
    });
    window.addEventListener('focus',()=>{if(!busy&&!updating&&!recoveryMode)run(()=>auth.verify(),{revalidate:true});});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){if(authorized)blockAccess(true);}
      else if(!busy&&!updating&&!recoveryMode)run(()=>auth.verify(),{revalidate:true});
    });
    // Revalidate active roles/relationships while the page is visible; no writes to macros.
    let checkingMacros=false;
    setInterval(async()=>{if(authorized&&!document.hidden&&!busy&&!updating&&!recoveryMode&&!checkingMacros){checkingMacros=true;try{await macrosUI.revalidate();}finally{checkingMacros=false;}}},30000);
    await run(async()=>{
      if(callback){
        if(!credential&&(callbackSearch||callbackHash)){auth.invalidate();return {status:'LINK_INVALID'};}
        if(credential?.kind==='error'){auth.invalidate();return {status:credential.status};}
        const result=!credential?await auth.resumeRecovery():credential.kind==='implicit'?await auth.implicit(credential.value,credential.type):invitation?await auth.invitation(credential.value):credential.kind==='recovery'?await auth.recovery(credential.value):await auth.callback(credential.value);
        if(result.status==='RECOVERY')updating=true;
        return result;
      }
      if(recoveryState.get()){
        recoveryMode=true;
        const result=await auth.resumeRecovery();updating=result.status==='RECOVERY';return result;
      }
      const result=await auth.verify();
      return result;
    });
  }catch{render({status:'AUTH_FAILED'});}
})();
