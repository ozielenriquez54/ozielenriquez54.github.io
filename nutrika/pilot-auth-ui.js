'use strict';
(async()=>{
  const status=document.getElementById('auth-status'),access=document.getElementById('pilot-access');
  const recovery=document.getElementById('password-form');
  const messages={SIGNED_OUT:'Inicia sesión con tu cuenta del piloto.',AUTHORIZED:'Sesión verificada y rol autorizado. Las funciones clínicas siguen deshabilitadas.',
    ROLE_REQUIRED:'Sesión verificada. Falta una membresía activa para esta vista; solicítala al administrador.',AUTH_FAILED:'No se pudo completar la operación. Revisa los datos o solicita un enlace nuevo.',
    EMAIL_SENT:'Si la cuenta está habilitada, recibirás un enlace. Ábrelo en este mismo perfil de navegador.',RECOVERY:'Define tu nueva contraseña.',PASSWORD_UPDATED:'Contraseña actualizada. Ya puedes iniciar sesión.',LOGOUT_FAILED:'No se pudo confirmar el cierre de sesión. Vuelve a intentarlo.'};
  Object.assign(messages,{
    LINK_INVALID:'El enlace está incompleto o no es válido. Usa el enlace completo del correo.',
    LINK_EXPIRED:'El enlace ha expirado. Solicita asistencia para recuperar el acceso.',
    LINK_EXPIRED_OR_USED:'El enlace ha expirado o ya fue utilizado. No es posible distinguir ambas causas con la respuesta recibida.',
    RECOVERY_NETWORK:'No se pudo verificar la sesión por un problema de conexión. Reintenta la verificación sin volver a abrir el enlace.',
    RECOVERY_SESSION_MISSING:'No hay una sesión de recuperación válida en este navegador.',
    RECOVERY_SESSION_MISMATCH:'La sesión corresponde a otra cuenta. No se permite cambiar la contraseña.',
    AUTH_FAILED:'No se pudo verificar la recuperación o completar la operación. Solicita asistencia sin compartir el enlace.',
  });
  let recoveryMode=location.pathname==='/auth/callback.html';
  function recoveryLayout(){
    for(const id of ['login-form','magic-link','recover'])document.getElementById(id).hidden=recoveryMode;
    const title=document.getElementById('recovery-title');if(title)title.hidden=!recoveryMode;
    const link=document.getElementById('recovery-login');if(link)link.hidden=!recoveryMode;
  }
  recoveryLayout();
  let busy=false,updating=false,macrosUI=null,authorized=false,authEpoch=0,diaryUI=null,diaryModel=null,trackingUI=null,trackingModel=null,coachHistoryUI=null,provisioningUI=null,refreshDiary=()=>{},refreshTracking=()=>{},refreshCoachHistory=()=>{},refreshProvisioning=()=>{};
  function clearDiary(){diaryModel?.invalidate();diaryUI?.clear();}
  function clearTracking(){trackingModel?.invalidate();trackingUI?.clear();coachHistoryUI?.clear();}
  function clearProvisioning(){provisioningUI?.clear();}
  function render(result){
    if(result.status==='RECOVERY')recoveryMode=true;
    if(['PASSWORD_UPDATED','AUTHORIZED'].includes(result.status))recoveryMode=false;
    updating=result.status==='RECOVERY';
    recoveryLayout();
    const retry=document.getElementById('recovery-retry');if(retry)retry.hidden=!(recoveryMode&&result.status==='RECOVERY_NETWORK');
    status.textContent=messages[result.status]??messages.AUTH_FAILED;
    access.hidden=result.status!=='AUTHORIZED';
    recovery.hidden=result.status!=='RECOVERY';
    authorized=result.status==='AUTHORIZED';
    if(authorized&&!document.hidden){macrosUI?.refresh();refreshDiary();refreshTracking();refreshCoachHistory();refreshProvisioning();}else {macrosUI?.clear();clearDiary();clearTracking();clearProvisioning();access.hidden=true;}
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
    const role=invitation?'CLIENT':callback?(sessionStorage.getItem('twogramms-pilot-view')??'CLIENT'):document.body.dataset.role;
    sessionStorage.setItem('twogramms-pilot-view',role);
    const client=PilotAuth.createClient(config,supabase,fetch.bind(window));
    const recoveryState={get:()=>sessionStorage.getItem('twogramms-pilot-recovery'),set:id=>sessionStorage.setItem('twogramms-pilot-recovery',id),clear:()=>sessionStorage.removeItem('twogramms-pilot-recovery')};
    const auth=PilotAuth.controller(client,role,location.origin+'/auth/callback.html',{approvedOrigin:config.publicOrigin??null,readOnly:config.readOnly===true,recoveryState});
    const macrosModel=PilotMacrosService.createModel(client,role);
    macrosUI=PilotMacrosUI.mount(document.getElementById('macros-root'),{model:PilotMacrosService.createModel(client,role),role,
      writer:config.macrosWritable===true&&role==='COACH'?PilotMacrosService.createWriter(client):null});
    if(role==='CLIENT'&&config.diaryAvailable){
      diaryModel=PilotDiaryService.createModel(client);
      diaryUI=PilotDiaryUI.mount(document.getElementById('diary-root'),{model:diaryModel});
      const own=PilotMacrosService.createModel(client,'CLIENT');
      refreshDiary=async()=>{const ticket=authEpoch;clearDiary();try{
        const targets=await own.list();if(ticket!==authEpoch||!authorized||document.hidden||targets.length!==1)return;
        const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
        await diaryUI.show(targets[0],date);
      }catch{clearDiary();}};
    }
    if(config.trackingAvailable===true){
      trackingModel=PilotTrackingService.createModel(client);trackingUI=PilotTrackingUI.mount(document.getElementById('tracking-root'),{model:trackingModel,role});
      if(role==='CLIENT')refreshTracking=async()=>{const ticket=authEpoch;trackingUI.clear();try{const targets=await macrosModel.list();if(ticket!==authEpoch||!authorized||document.hidden||targets.length!==1)return;const d=new Date(),date=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');await trackingUI.show(targets[0],date,macrosModel);}catch{trackingUI.clear();}};
      else{coachHistoryUI=PilotCoachHistoryUI.mount(document.getElementById('coach-history-root'),{model:macrosModel,macros:macrosModel,tracking:trackingUI});refreshCoachHistory=async()=>{if(!authorized||document.hidden)return;await coachHistoryUI.refresh();};}
    }
    if(config.adminProvisioningAvailable===true&&role==='COACH'){
      provisioningUI=PilotAdminProvisioningUI.mount(document.getElementById('admin-provisioning-root'),{client});
      refreshProvisioning=async()=>{if(!authorized||document.hidden)return;await provisioningUI.refresh();};
    }
    async function run(fn){
      if(busy)return;busy=true;access.hidden=true;macrosUI.clear();clearDiary();clearTracking();
      const ticket=++authEpoch;
      try{const result=await fn();if(ticket===authEpoch)render(result);}catch{if(ticket===authEpoch)render({status:'AUTH_FAILED'});}
      finally{busy=false;document.querySelectorAll('input[type=password]').forEach(el=>{el.value='';});}
    }
    document.getElementById('recovery-retry')?.addEventListener('click',()=>run(()=>auth.resumeRecovery()));
    const email=()=>document.getElementById('auth-email').value.trim();
    document.getElementById('login-form').addEventListener('submit',event=>{event.preventDefault();run(()=>auth.login(email(),document.getElementById('auth-password').value));});
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
    client.auth.onAuthStateChange(event=>{
      if(event==='SIGNED_OUT'){authEpoch++;auth.invalidate();updating=false;recoveryState.clear();render({status:'SIGNED_OUT'});}
      // Do not await Auth methods inside its event callback (SDK lock).
      if(event==='TOKEN_REFRESHED'&&!busy&&!updating&&!recoveryMode)setTimeout(()=>run(()=>auth.verify()),0);
    });
    window.addEventListener('focus',()=>{if(!busy&&!updating&&!recoveryMode)run(()=>auth.verify());});
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden){macrosUI.clear();clearDiary();clearTracking();access.hidden=true;}
      else if(!busy&&!updating&&!recoveryMode)run(()=>auth.verify());
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
