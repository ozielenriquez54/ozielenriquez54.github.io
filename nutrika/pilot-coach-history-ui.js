(function(root){
 'use strict';
 function mount(container,{model,macros,tracking,document:doc=root.document}){
  let epoch=0;
  const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
  function clear(){epoch++;container.replaceChildren();model.invalidate();tracking.clear();}
  async function refresh(){clear();const ticket=epoch;
   try{
    const targets=await model.list();if(ticket!==epoch)return;
    const heading=node('h3','Historial de clientes asignados');container.append(heading);
    if(!targets.length){container.append(node('p','No hay un cliente asignado activo.'));return;}
    const select=node('select');select.setAttribute('aria-label','Cliente asignado');
    targets.forEach((t,i)=>{const o=node('option',t.label);o.value=String(i);select.append(o);});
    const day=node('input'),week=node('input');day.type=week.type='date';const now=new Date();day.value=now.toISOString().slice(0,10);week.value=addDays(day.value,-6);
    const show=node('button','Consultar día'),summary=node('button','Resumen de 7 días'),out=node('section');show.type=summary.type='button';container.append(node('label','Cliente '),select,node('label','Fecha '),day,show,node('label','Inicio de semana '),week,summary,out);
    let request=0;
    show.addEventListener('click',async()=>{const n=++request,t=targets[Number(select.value)];out.replaceChildren();try{await tracking.show(t,day.value);if(ticket!==epoch||n!==request){tracking.clear();return;}
    }catch{out.textContent='No se pudo verificar el acceso.';}});
    summary.addEventListener('click',async()=>{const t=targets[Number(select.value)],s=++request;try{await tracking.weekly(t,week.value,macros);if(ticket!==epoch||s!==request)tracking.clear();}catch{out.textContent='No se pudo cargar el resumen.';}});
    select.addEventListener('change',()=>{request++;out.replaceChildren();tracking.clear();});
    day.addEventListener('change',()=>show.click());summary.click();
   }catch{if(ticket===epoch){clear();container.append(node('p','No se pudo verificar la asignación o el historial.'));}}
  }
  return {clear,refresh};
 }
 function addDays(s,n){const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
 const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotCoachHistoryUI=api;
})(typeof globalThis==='object'?globalThis:this);
