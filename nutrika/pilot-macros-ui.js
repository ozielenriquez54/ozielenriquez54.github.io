(function(root){
  'use strict';
  const domain=typeof module==='object'&&module.exports?require('./domain/manual-macros.cjs'):root.PilotManualMacros;
  const names={proteinG:'Proteínas',carbsG:'Carbohidratos',fatG:'Grasas'};
  function mount(container,{model,role,document:doc=root.document,writer=null}){
    let generation=0,visible=null;
    function node(tag,text){const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
    function clear(){generation++;visible=null;model.invalidate();container.replaceChildren();}
    function summary(macros){return `${macros.kcal} kcal · Proteínas: ${macros.proteinG} g · Carbohidratos: ${macros.carbsG} g · Grasas: ${macros.fatG} g`;}
    function editor(parent,current,target){
      const form=node('form'),fields={},out=node('output','— kcal'),feedback=node('p'),preview=node('section');
      out.setAttribute('aria-live','polite');feedback.setAttribute('role','status');
      const save=node('button','Guardar asignación');save.type='button';save.disabled=true;
      save.title='Guardado no disponible en esta etapa';
      const zeros=node('div'),energyLabel=node('label'),energy=node('input');energy.type='checkbox';
      energyLabel.append(energy,node('span',' Confirmo el cambio energético superior al 25 %'));energyLabel.hidden=true;
      const previewButton=node('button','Revisar vista previa');previewButton.type='submit';previewButton.disabled=true;
      const checks=new Map();let review=null,prepared=null,saving=false;
      const ticket=generation;
      // Writer is an explicit local integration port. Production passes none.
      if(writer&&role==='COACH')save.addEventListener('click',async()=>{
        if(!prepared||saving||ticket!==generation||visible?.target!==target)return;
        saving=true;save.disabled=true;
        const command=structuredClone(prepared);
        try{await writer.assign(command);if(ticket===generation&&visible?.target===target)await refresh();}
        catch{if(ticket===generation&&visible?.target===target){
          feedback.textContent='No se confirmó el guardado. Revisa el objetivo vigente antes de volver a guardar.';
          prepared=null;
        }}finally{saving=false;}
      });
      function values(){const result={};for(const key of Object.keys(names)){
        const raw=fields[key].value;if(!/^\d+$/.test(raw))throw new Error('INVALID_INPUT');result[key]=Number(raw);
      }return result;}
      function update(){
        prepared=null;preview.replaceChildren();zeros.replaceChildren();checks.clear();energy.checked=false;energyLabel.hidden=true;
        previewButton.disabled=true;review=null;out.textContent='— kcal';feedback.textContent='';save.disabled=true;
        try{
          review=domain.reviewManualMacros(values(),current?.macros.kcal??null);out.textContent=review.macros.kcal+' kcal';
          for(const key of review.requiredConfirmations.zeroMacros){const label=node('label'),check=node('input');check.type='checkbox';checks.set(key,check);label.append(check,node('span',' Confirmo '+names[key].toLowerCase()+' en 0 g'));zeros.append(label);}
          energyLabel.hidden=!review.requiredConfirmations.energyChange;
          if(review.requiredConfirmations.energyChange)feedback.textContent=`Cambio de ${current.macros.kcal} a ${review.macros.kcal} kcal: requiere confirmación adicional.`;
          previewButton.disabled=false;
        }catch{feedback.textContent='Introduce gramos enteros: proteínas 0–400, carbohidratos 0–1000 y grasas 0–300; el total debe ser 500–6000 kcal.';}
      }
      for(const key of Object.keys(names)){
        const label=node('label',names[key]+' (g) '),input=node('input');input.type='number';input.min='0';input.max=String(domain.LIMITS[key].max);input.step='1';input.required=true;input.value='';input.name=key;
        input.addEventListener('input',update);fields[key]=input;label.append(input);form.append(label);
      }
      for(const el of [zeros,energy])el.addEventListener('change',()=>{prepared=null;save.disabled=true;preview.replaceChildren();});
      form.addEventListener('submit',event=>{
        event.preventDefault();preview.replaceChildren();save.disabled=true;prepared=null;
        try{
          if(!review)throw new Error('INVALID_INPUT');
          const validated=domain.validateManualMacros(values(),{zeroMacros:[...checks].filter(([,check])=>check.checked).map(([key])=>key),energyChange:energy.checked===true},current?.macros.kcal??null);
          if(writer&&!saving&&ticket===generation){
            prepared={gymId:target.gymId,clientId:target.clientId,operationId:writer.newId(),
              baseRevision:current?.revision??0,macros:values(),confirmations:structuredClone(validated.confirmations)};
            save.disabled=false;
          }
          preview.append(node('h4','Vista previa — sin guardar'),node('p',target.label),node('p',summary(validated.macros)),node('p','Revisión base: '+(current?.revision??0)+'. No se ha creado ni modificado ninguna asignación.'));
          feedback.textContent=writer?'Vista previa preparada. Confirma con Guardar asignación.':'Vista previa preparada. El guardado todavía no está habilitado.';
        }catch{feedback.textContent='Revisa los límites y acepta todas las confirmaciones indicadas. Ninguna confirmación permite superar los límites.';}
      });
      form.append(node('p','Calorías calculadas automáticamente: 4P + 4C + 9G.'),out,zeros,energyLabel,feedback,previewButton,preview,save,node('p',writer?'Guardado disponible únicamente en este ensayo local autorizado.':'Solo vista previa. Podrás guardar cuando esté disponible el servicio de asignación.'));
      parent.append(form);
    }
    async function refresh(){
      clear();const ticket=generation;const status=node('p','Verificando acceso a objetivos…');status.setAttribute('role','status');container.append(status);
      try{
        const targets=await model.list();if(ticket!==generation)return;
        container.replaceChildren();container.append(node('h3',role==='COACH'?'Objetivos manuales de tus clientes':'Mis objetivos de macros'));
        if(!targets.length){container.append(node('p',role==='COACH'?'No tienes clientes con relación activa.':'No hay un Cliente activo autorizado para esta cuenta.'));return;}
        const label=node('label',role==='COACH'?'Cliente asignado ':'Organización '),select=node('select'),detail=node('section');
        select.setAttribute('aria-label',role==='COACH'?'Cliente asignado':'Organización');
        targets.forEach((target,i)=>{const option=node('option',target.label);option.value=String(i);select.append(option);});select.value='0';label.append(select);container.append(label,detail);
        let selection=0;
        async function show(){
          const request=++selection;visible=null;detail.replaceChildren();const target=targets[Number(select.value)];if(!target)return;
          try{
            const current=await model.read(target);if(ticket!==generation||request!==selection)return;
            visible={targets,target,current};
            detail.append(node('h4','Objetivo vigente'));
            if(current)detail.append(node('p',summary(current.macros)),node('p',`Revisión ${current.revision} · Vigente desde ${new Date(current.effectiveFrom).toLocaleString('es-MX')}`));
            else detail.append(node('p','Sin asignación de macros.'));
            if(role==='COACH')editor(detail,current,target);else detail.append(node('p','Solo tu Coach asignado puede establecer estos objetivos.'));
          }catch{if(ticket===generation&&request===selection){clear();container.append(node('p','No se pudieron verificar los objetivos o el acceso. No se muestran datos guardados previamente.'));}}
        }
        select.addEventListener('change',show);await show();
      }catch{if(ticket===generation){clear();container.append(node('p','No se pudo verificar el acceso a los objetivos. Vuelve a iniciar sesión o actualiza la vista.'));}}
    }
    async function revalidate(){
      const prior=visible,ticket=generation;if(!prior)return;
      try{
        const targets=await model.list(),current=await model.read(prior.target);
        if(ticket!==generation||visible!==prior)return;
        if(JSON.stringify(targets)!==JSON.stringify(prior.targets)||JSON.stringify(current)!==JSON.stringify(prior.current))await refresh();
      }catch{if(ticket===generation&&visible===prior){clear();container.append(node('p','El acceso ya no pudo verificarse. Los objetivos se han ocultado.'));}}
    }
    return {clear,refresh,revalidate};
  }
  const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotMacrosUI=api;
})(typeof globalThis==='object'?globalThis:this);
