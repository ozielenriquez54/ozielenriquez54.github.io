(function(root){
  'use strict';
  function createModel(client,fetchImpl=root.fetch.bind(root)){
    let epoch=0;
    async function request(path,{params,body}={}){
      const ticket=epoch,session=await client.auth.getSession(),s=session.data?.session;
      if(session.error||!s?.access_token||!s.user?.id||ticket!==epoch)throw Error('TRACKING_UNAVAILABLE');
      const response=await fetchImpl(path+(params?'?'+new URLSearchParams(params):''),{method:body?'POST':'GET',credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+s.access_token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(structuredClone(body))}:{})});
      const result=await response.json();
      const latest=await client.auth.getSession();
      if(!response.ok||ticket!==epoch||latest.error||latest.data?.session?.user?.id!==s.user.id)throw Error('TRACKING_UNAVAILABLE');
      if(!result||!Object.hasOwn(result,'data'))throw Error('TRACKING_UNAVAILABLE');return result.data;
    }
    async function save(command){
      if(!['WEIGHT_DAY','HABITS_DAY'].includes(command?.kind))throw Error('TRACKING_UNAVAILABLE');
      const fields=['gymId','clientId','nutritionDate','kind','operationId','baseRevision',...(command.kind==='WEIGHT_DAY'?['weightKg']:['values','completion'])];
      const body=structuredClone(Object.fromEntries(fields.filter(k=>Object.hasOwn(command,k)).map(k=>[k,command[k]])));
      return request('/api/tracking/save',{body});
    }
    return {invalidate(){epoch++;},history:(target,from,to)=>request('/api/tracking/history',{params:{gymId:target.gymId,clientId:target.clientId,from,to}}),save};
  }
  const api={createModel};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotTrackingService=api;
})(typeof globalThis==='object'?globalThis:this);
