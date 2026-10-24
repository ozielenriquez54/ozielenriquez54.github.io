(function(root){
  'use strict';
  const REF='otswebncqidqthqplztj',URL_ROOT='https://'+REF+'.supabase.co';
  const STORAGE_KEY='twogramms-pilot-auth-'+REF;
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
    if(config.projectRef!==REF||config.supabaseUrl!==URL_ROOT||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publicKey??''))fail();
    return sdk.createClient(URL_ROOT,config.publicKey,{
      auth:{storageKey:STORAGE_KEY,flowType:'pkce',detectSessionInUrl:false,persistSession:true,autoRefreshToken:true,debug:false},
      global:{fetch:async(input,init={})=>{
        const url=new URL(typeof input==='string'?input:input.url??input.href);
        if(url.origin!==URL_ROOT||url.username||url.password)fail();
        const allowed=['/rest/v1/profiles','/rest/v1/gym_memberships'];
        if(!config.readOnly)allowed.push('/rest/v1/rpc/pilot_ensure_profile');
        if(macros)allowed.push('/rest/v1/clients','/rest/v1/coach_clients','/rest/v1/manual_macro_targets','/rest/v1/manual_macro_target_versions');
        if(admin&&!config.readOnly)allowed.push('/rest/v1/coach_clients','/rest/v1/rpc/pilot_set_membership','/rest/v1/rpc/pilot_set_coach_client');
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
            try{const body=await response.json();const candidate=body.code??body.error_code;if(['42501','40001','23503','23514'].includes(candidate)||(url.pathname.startsWith('/auth/v1/')&&['otp_expired','flow_state_expired','session_not_found','refresh_token_not_found','refresh_token_already_used','bad_jwt'].includes(candidate)))code=candidate;}catch{}
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
    if(!(local&&!approvedOrigin||published)||url.username||url.password||url.pathname!=='/auth/callback.html'||url.search||url.hash)fail();
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
        const profile=readOnly?await client.from('profiles').select('id').eq('id',id):await client.rpc('pilot_ensure_profile');
        if(readOnly&&!profile.error&&Array.isArray(profile.data)&&profile.data.length===0)return {status:'ROLE_REQUIRED'};
        const ownProfile=Array.isArray(profile.data)?(profile.data.length===1?profile.data[0]:null):profile.data;
        if(profile.error||ownProfile?.id!==id)fail();
        const memberships=await client.from('gym_memberships').select('user_id,roles,active').eq('user_id',id).eq('active',true);
        if(memberships.error||!Array.isArray(memberships.data))fail();
        if(ticket!==generation)return {status:'SIGNED_OUT'};
        const allowed=memberships.data.some(m=>m.user_id===id&&m.active===true&&Array.isArray(m.roles)&&m.roles.includes(role));
        return {status:allowed?'AUTHORIZED':'ROLE_REQUIRED'};
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
  const api={createClient,controller,parseCallback,STORAGE_KEY};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PilotAuth=api;
})(typeof globalThis==='object'?globalThis:this);
