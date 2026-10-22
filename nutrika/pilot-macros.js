(function(root){
  'use strict';
  const domain=typeof module==='object'&&module.exports?require('./domain/manual-macros.cjs'):root.PilotManualMacros;
  function fail(){throw new Error('MACROS_UNAVAILABLE');}
  function createModel(client,role){
    if(!['COACH','CLIENT'].includes(role))fail();
    let generation=0;
    async function rows(table,fields,filters){
      let q=client.from(table).select(fields);
      for(const [key,value] of Object.entries(filters))q=q.eq(key,value);
      const r=await q;if(r.error||!Array.isArray(r.data))fail();return r.data;
    }
    async function scope(){
      const u=await client.auth.getUser();if(u.error||!u.data?.user?.id)fail();
      const actor=u.data.user.id;
      const memberships=await rows('gym_memberships','id,gym_id,user_id,roles,active',{user_id:actor,active:true});
      const targets=[];
      for(const m of memberships){
        if(m.user_id!==actor||m.active!==true||!m.roles?.includes(role))continue;
        const relations=role==='COACH'?await rows('coach_clients','gym_id,client_id,coach_membership_id,active',{gym_id:m.gym_id,coach_membership_id:m.id,active:true}):null;
        const clients=await rows('clients','id,gym_id,membership_id',role==='CLIENT'?{gym_id:m.gym_id,membership_id:m.id}:{gym_id:m.gym_id});
        for(const c of clients){
          if(c.gym_id!==m.gym_id)continue;
          if(role==='CLIENT'?c.membership_id!==m.id:!relations.some(a=>a.gym_id===m.gym_id&&a.client_id===c.id&&a.coach_membership_id===m.id&&a.active===true))continue;
          targets.push({gymId:m.gym_id,clientId:c.id,label:(role==='CLIENT'?'Mis objetivos':'Cliente '+c.id.slice(-8))+' · organización '+m.gym_id.slice(-8)});
        }
      }
      return {actor,targets};
    }
    const key=t=>t.gymId+'/'+t.clientId;
    const includes=(s,t)=>s.targets.some(x=>key(x)===key(t));
    async function safe(fn){try{return await fn();}catch{fail();}}
    return {
      invalidate(){generation++;},
      list(){return safe(async()=>{
        const ticket=++generation,s=await scope();
        if(ticket!==generation)fail();return structuredClone(s.targets);
      });},
      read(target){return safe(async()=>{
        const ticket=++generation,s=await scope();if(!includes(s,target))fail();
        const filter={gym_id:target.gymId,client_id:target.clientId};
        const heads=await rows('manual_macro_targets','gym_id,client_id,current_id,revision',filter);
        if(heads.length>1)fail();let result=null;
        if(heads.length){
          const h=heads[0];if(h.gym_id!==target.gymId||h.client_id!==target.clientId||!Number.isSafeInteger(h.revision)||h.revision<1)fail();
          const versions=await rows('manual_macro_target_versions','id,gym_id,client_id,revision,protein_g,carbs_g,fat_g,kcal,effective_from',{...filter,id:h.current_id,revision:h.revision});
          const v=versions[0];if(versions.length!==1||v.id!==h.current_id||v.gym_id!==h.gym_id||v.client_id!==h.client_id||v.revision!==h.revision)fail();
          const macros=domain.reviewManualMacros({proteinG:v.protein_g,carbsG:v.carbs_g,fatG:v.fat_g}).macros;
          if(macros.kcal!==v.kcal||!Number.isFinite(Date.parse(v.effective_from)))fail();
          result={macros,revision:v.revision,effectiveFrom:v.effective_from};
        }
        const again=await rows('manual_macro_targets','gym_id,client_id,current_id,revision',filter);
        if(JSON.stringify(heads)!==JSON.stringify(again))fail();
        const current=await scope();if(ticket!==generation||current.actor!==s.actor||!includes(current,target))fail();
        return structuredClone(result);
      });}
      // Deliberately no save method or RPC capability in this stage.
    };
  }
  const api={createModel};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotMacros=api;
})(typeof globalThis==='object'?globalThis:this);
