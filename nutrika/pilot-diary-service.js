(function(root){
  'use strict';
  function createModel(client,fetchImpl=root.fetch.bind(root)){
    let epoch=0;
    async function request(path,body){
      const ticket=epoch,session=await client.auth.getSession(),user=session.data?.session;
      if(session.error||!user?.user?.id||!user.access_token||ticket!==epoch)throw new Error('DIARY_UNAVAILABLE');
      const response=await fetchImpl(path,{method:body?'POST':'GET',credentials:'omit',cache:'no-store',redirect:'error',
        signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+user.access_token,...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      const again=await client.auth.getSession();
      if(!response.ok||ticket!==epoch||again.error||again.data?.session?.user?.id!==user.user.id)throw new Error('DIARY_UNAVAILABLE');
      return (await response.json()).data;
    }
    return {invalidate(){epoch++;},foods:()=>request('/api/diary/foods'),
      read:(target,date)=>request('/api/diary/day?'+new URLSearchParams({gymId:target.gymId,clientId:target.clientId,date})),
      save:command=>request('/api/diary/save',structuredClone(command))};
  }
  const api={createModel};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotDiaryService=api;
})(typeof globalThis==='object'?globalThis:this);
