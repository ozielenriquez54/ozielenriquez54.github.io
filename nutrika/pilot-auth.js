(function(root){
  'use strict';
  const REF='otswebncqidqthqplztj',URL_ROOT='https://'+REF+'.supabase.co';
  const STORAGE_KEY='twogramms-pilot-auth-'+REF;
  function fail(){throw new Error('PILOT_AUTH_FAILED');}
  function parseCallback(search,hash){
    const q=new URLSearchParams(search),h=new URLSearchParams((hash??'').replace(/^#/,''));
    if(!hash&&q.size===1&&q.has('code')&&q.get('code'))return {kind:'pkce',value:q.get('code')};
    if(!search&&h.size===2&&h.get('type')==='invite'&&/^[a-zA-Z0-9_-]{20,2048}$/.test(h.get('token_hash')??''))return {kind:'invite',value:h.get('token_hash')};
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
        try{
          const response=await fetchImpl(input,{...init,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
          // SDK errors must never carry a server message, echoed input or URL.
          if(!response.ok){
            let code;
            try{const body=await response.json();if(['42501','40001','23503','23514'].includes(body.code))code=body.code;}catch{}
            return new Response(JSON.stringify({message:'PILOT_REQUEST_FAILED',error:'PILOT_REQUEST_FAILED',code}),{status:response.status,headers:{'Content-Type':'application/json'}});
          }
          return response;
        }catch{fail();}
      }}
    });
  }
  function controller(client,role,redirectTo,{approvedOrigin=null,readOnly=false}={}){
    if(!['COACH','CLIENT'].includes(role))fail();
    const url=new URL(redirectTo);
    const local=url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname);
    const published=approvedOrigin&&url.protocol==='https:'&&url.origin===approvedOrigin;
    if(!(local&&!approvedOrigin||published)||url.username||url.password||url.pathname!=='/auth/callback.html'||url.search||url.hash)fail();
    let generation=0;
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
    return {
      verify,
      invalidate(){generation++;},
      async login(email,password){try{const r=await client.auth.signInWithPassword({email,password});if(r.error)fail();return await verify();}catch{return {status:'AUTH_FAILED'};}},
      async logout(){generation++;try{const r=await client.auth.signOut({scope:'local'});return {status:r.error?'LOGOUT_FAILED':'SIGNED_OUT'};}catch{return {status:'LOGOUT_FAILED'};}},
      async email(email,recovery){try{
        const r=recovery?await client.auth.resetPasswordForEmail(email,{redirectTo}):await client.auth.signInWithOtp({email,options:{emailRedirectTo:redirectTo,shouldCreateUser:false}});
        if(r.error)fail();return {status:'EMAIL_SENT'};
      }catch{return {status:'AUTH_FAILED'};}},
      async callback(code){try{
        if(typeof code!=='string'||!code||code.length>2048)fail();
        const r=await client.auth.exchangeCodeForSession(code);if(r.error)fail();
        const verified=await verify();
        return {status:r.data?.redirectType==='recovery'&&['AUTHORIZED','ROLE_REQUIRED'].includes(verified.status)?'RECOVERY':verified.status};
      }catch{return {status:'AUTH_FAILED'};}},
      async invitation(tokenHash){try{
        if(typeof tokenHash!=='string'||!/^[a-zA-Z0-9_-]{20,2048}$/.test(tokenHash))fail();
        const r=await client.auth.verifyOtp({token_hash:tokenHash,type:'invite'});
        if(r.error||!r.data?.session)fail();
        const user=await client.auth.getUser();
        if(user.error||!user.data?.user?.id||user.data.user.id!==r.data.session.user?.id)fail();
        return {status:'RECOVERY'};
      }catch{return {status:'AUTH_FAILED'};}},
      async password(password){try{
        if(typeof password!=='string'||password.length<8)fail();
        const r=await client.auth.updateUser({password});if(r.error)fail();return await verify();
      }catch{return {status:'AUTH_FAILED'};}}
    };
  }
  const api={createClient,controller,parseCallback,STORAGE_KEY};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PilotAuth=api;
})(typeof globalThis==='object'?globalThis:this);
