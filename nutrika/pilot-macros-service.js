(function(root){
  'use strict';
  function createModel(client,role,fetchImpl=root.fetch.bind(root)){
    if(!['COACH','CLIENT'].includes(role))throw new Error('MACROS_UNAVAILABLE');
    let generation=0,controller=null;
    function invalidate(){generation++;controller?.abort();controller=null;}
    async function read(path,params){
      invalidate();const ticket=generation;controller=new AbortController();const signal=controller.signal;
      try{
        const session=await client.auth.getSession(),s=session.data?.session;
        if(session.error||!s?.access_token||!s.user?.id||ticket!==generation)throw new Error();
        const response=await fetchImpl(path+'?'+new URLSearchParams({role,...params}),{method:'GET',credentials:'omit',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+s.access_token},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
        if(!response.ok)throw new Error();const result=await response.json();
        const latest=await client.auth.getSession();if(latest.error||ticket!==generation||latest.data?.session?.user?.id!==s.user.id||!Object.hasOwn(result,'data'))throw new Error();
        return result.data;
      }catch{throw new Error('MACROS_UNAVAILABLE');}
    }
    // Read-only transport. No assign method, RPC, write toggle or service key.
    return {invalidate,list:()=>read('/api/manual-macros/clients',{}),read:target=>read('/api/manual-macros/current',{gymId:target.gymId,clientId:target.clientId})};
  }
  function createWriter(client,fetchImpl=root.fetch.bind(root)){
    return {newId:()=>root.crypto.randomUUID(),async assign(command){
      const snapshot=structuredClone(command),session=await client.auth.getSession(),s=session.data?.session;
      if(session.error||!s?.access_token||!s.user?.id)throw new Error('MACROS_UNAVAILABLE');
      const response=await fetchImpl('/api/manual-macros/assign',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
        headers:{Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(15000)});
      const latest=await client.auth.getSession();
      if(!response.ok||latest.error||latest.data?.session?.user?.id!==s.user.id)throw new Error('MANUAL_RESULT_UNKNOWN');
      return (await response.json()).data;
    }};
  }
  const api={createModel,createWriter};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotMacrosService=api;
})(typeof globalThis==='object'?globalThis:this);
