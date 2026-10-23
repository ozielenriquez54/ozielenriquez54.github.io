(function(root){
 'use strict';
 function dailyAdherence(day,goal){
  if(!goal)return {status:'NO_OBJECTIVE',adherent:null,checks:null};
  if(day?.status!=='COMPLETE'||!day.totals||['kcal','proteinG','carbsG','fatG'].some(k=>day.totals[k]===null||day.totals[k]===undefined))return {status:'UNKNOWN_CONSUMPTION',adherent:null,checks:null};
  const tolerances={kcal:.05,proteinG:.05,carbsG:.10,fatG:.10};
  const checks=Object.fromEntries(Object.keys(tolerances).map(k=>{const diff=Math.abs(day.totals[k]-goal[k]),allowed=goal[k]*tolerances[k],precision=Number.EPSILON*8*Math.max(1,day.totals[k],goal[k]);return[k,diff<=allowed+precision];}));
  return {status:Object.values(checks).every(Boolean)?'ADHERENT':'NOT_ADHERENT',adherent:Object.values(checks).every(Boolean),checks};
 }
 const api={dailyAdherence};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotTrackingDomain=api;
})(typeof globalThis==='object'?globalThis:this);
