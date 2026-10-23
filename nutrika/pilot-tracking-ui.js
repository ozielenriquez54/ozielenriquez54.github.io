(function(root){
  'use strict';
  function mount(container,{model,document:doc=root.document,newId=()=>root.crypto.randomUUID(),role='CLIENT'}){
    let epoch=0;
    const node=(tag,text)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
    function clear(){epoch++;container.replaceChildren();}
    async function show(target,date,macroModel=null){
      clear();const ticket=epoch;
      try{
        const [history,goal]=await Promise.all([model.history(target,date,date),macroModel?macroModel.read(target):Promise.resolve(null)]);if(ticket!==epoch)return;
        const dateControl=node('input');dateControl.type='date';dateControl.value=date;dateControl.setAttribute('aria-label','Fecha del seguimiento');dateControl.addEventListener('change',()=>show(target,dateControl.value,macroModel));container.append(dateControl);
        const day=history.days[0];container.append(node('h3','Seguimiento diario · '+date));
        const form=node('form'),status=node('p');status.setAttribute('role','status');
        const previous=day.habits,values=previous?.values??{},completion=previous?.completion??{};
        const fields=[['weightKg','Peso (kg)',day.weight?.weightKg,'WEIGHT_DAY'],['waterLiters','Agua (L)',values.waterLiters,'HABITS_DAY'],['steps','Pasos',values.steps,'HABITS_DAY'],['sleepHours','Sueño (h)',values.sleepHours,'HABITS_DAY'],['sleepQuality','Calidad del sueño (1–5)',values.sleepQuality,'HABITS_DAY'],['stress','Estrés (1–5)',values.stress,'HABITS_DAY']];
        const inputs={};
        for(const [key,label,value] of fields){const wrap=node('label',label+' '),input=node('input');input.type='number';input.step=key==='steps'||key==='sleepQuality'||key==='stress'?'1':'any';input.min=key==='weightKg'?'0.01':'0';if(['sleepQuality','stress'].includes(key))input.min='1';if(['sleepQuality','stress'].includes(key))input.max='5';input.value=value===null||value===undefined?'':String(value);input.setAttribute('aria-label',label);wrap.append(input);form.append(wrap);inputs[key]=input;}
        const habits=doc.createElement('fieldset'),legend=node('legend','Hábitos (registro del cliente)');habits.append(legend);const checks={};
        for(const key of ['waterLiters','steps','sleepHours','sleepQuality','stress','training']){const label=node('label'),check=node('input');check.type='checkbox';check.checked=completion[key]===true;check.indeterminate=completion[key]===null||completion[key]===undefined;check.setAttribute('aria-label','Cumplí '+key);check.addEventListener('change',()=>{check.indeterminate=false;});label.append(check,node('span',' Cumplí: '+({waterLiters:'agua',steps:'pasos',sleepHours:'sueño',sleepQuality:'calidad de sueño',stress:'manejo de estrés',training:'entrenamiento'}[key])));habits.append(label);checks[key]=check;}
        const training=node('select'),trainingEmpty=node('option','Sin registro');trainingEmpty.value='';training.append(trainingEmpty);for(const [v,label] of [['STRENGTH','Entrenamiento de fuerza'],['NO_STRENGTH','Sin entrenamiento de fuerza']]){const o=node('option',label);o.value=v;training.append(o);}training.value=values.training??null;training.setAttribute('aria-label','Entrenamiento');
        form.append(habits,node('label','Entrenamiento '),training);const save=node('button','Guardar seguimiento'),message=node('p');save.type='submit';form.append(save,message);
        if(role==='CLIENT'){
          let busy=false;form.addEventListener('submit',async e=>{e.preventDefault();if(busy||ticket!==epoch)return;
            const weight=inputs.weightKg.value,patch={};for(const key of ['waterLiters','steps','sleepHours','sleepQuality','stress'])patch[key]=inputs[key].value===''?null:Number(inputs[key].value);patch.training=training.value||null;
            if(inputs.steps.value!==''&&!Number.isSafeInteger(Number(inputs.steps.value))){message.textContent='Los pasos deben ser un número entero.';return;}
            busy=true;save.disabled=true;
            try{
              if(weight!=='')await model.save({...target,nutritionDate:date,kind:'WEIGHT_DAY',operationId:newId(),baseRevision:day.weight?.revision??0,weightKg:Number(weight)});
              if(fields.slice(1).some(([, ,v])=>v!==undefined)||Object.values(inputs).slice(1).some(x=>x.value!=='' )||Object.values(checks).some(x=>!x.indeterminate)){
                const current=await model.history(target,date,date),rev=current.days[0].habits;
                await model.save({...target,nutritionDate:date,kind:'HABITS_DAY',operationId:newId(),baseRevision:rev?.revision??0,values:patch,completion:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v.indeterminate?null:v.checked]))});
              }
              if(ticket===epoch)await show(target,date);
            }catch{if(ticket===epoch)message.textContent='No se confirmó el registro; vuelve a consultar la fecha antes de reintentar.';}
            finally{busy=false;}
          });
        }else{save.disabled=true;message.textContent='Solo lectura: el coach asignado no puede modificar los registros.';}
        if(day.weight)container.append(node('p','Peso guardado: '+day.weight.weightKg+' kg'));else container.append(node('p','Peso: sin registro'));
        if(day.habits){container.append(node('p','Agua: '+(values.waterLiters===null||values.waterLiters===undefined?'sin registro':values.waterLiters+' L')+' · Pasos: '+(values.steps===null||values.steps===undefined?'sin registro':values.steps)));}
        else container.append(node('p','Agua, pasos y hábitos: sin registros'));
        container.append(form);if(!day.intake)container.append(node('p','Alimentación: sin registro'));else{
          const totals=day.intake.totals;container.append(node('p','Alimentación: '+day.intake.status+' · '+(totals?totals.kcal+' kcal · P/C/G '+totals.proteinG+'/'+totals.carbsG+'/'+totals.fatG:'sin total')));
          if(goal?.macros&&totals)container.append(node('p','Consumo / objetivo vigente · kcal '+totals.kcal+'/'+goal.macros.kcal+' · proteína '+totals.proteinG+'/'+goal.macros.proteinG+' g · carbohidratos '+totals.carbsG+'/'+goal.macros.carbsG+' g · grasas '+totals.fatG+'/'+goal.macros.fatG+' g'));
        }
      }catch{if(ticket===epoch){clear();container.append(node('p','No se pudo verificar el historial o el acceso.'));}}
    }
    async function weekly(target,from,macroModel){
      clear();const ticket=epoch;
      try{const [h,goal]=await Promise.all([model.history(target,from,addDays(from,6)),macroModel.read(target)]);if(ticket!==epoch)return;
        const section=node('section');section.append(node('h3','Resumen semanal · '+from));const totals={kcal:0,proteinG:0,carbsG:0,fatG:0},coverage={food:0,weight:0,water:0,steps:0,habits:0},weights=[],water=[],steps=[],adherent=[],habitStatus=Object.fromEntries(['waterLiters','steps','sleepHours','sleepQuality','stress','training'].map(k=>[k,{yes:0,no:0,unknown:0}]));
        for(const d of h.days){const intake=d.intake;if(intake?.status==='COMPLETE'&&intake.totals){coverage.food++;for(const k of Object.keys(totals))totals[k]+=intake.totals[k];const result=root.PilotTrackingDomain.dailyAdherence(intake,goal?.macros);d.nutritionAdherence=result;if(result.status==='ADHERENT')adherent.push(d.date);}
          if(d.weight){coverage.weight++;weights.push(d.weight.weightKg);}if(d.habits){coverage.habits++;const v=d.habits.values;if(v.waterLiters!==null&&v.waterLiters!==undefined){coverage.water++;water.push(v.waterLiters);}if(v.steps!==null&&v.steps!==undefined){coverage.steps++;steps.push(v.steps);}for(const k of Object.keys(habitStatus)){const mark=d.habits.completion?.[k];if(mark===true)habitStatus[k].yes++;else if(mark===false)habitStatus[k].no++;else habitStatus[k].unknown++;}}else for(const v of Object.values(habitStatus))v.unknown++;}
        const avg=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):'sin datos';
        section.append(node('p','Días completos: '+coverage.food+'/7; '+(goal?(coverage.food?['kcal','proteinG','carbsG','fatG'].map(k=>k+': '+(totals[k]/coverage.food).toFixed(1)+' promedio/día / '+goal.macros[k]+' objetivo/día').join(' · '):'sin días completos para comparar'):'objetivo: sin registro')+'.'));
        section.append(node('p','Promedios: peso '+avg(weights)+' kg ('+coverage.weight+'/7); agua '+avg(water)+' L ('+coverage.water+'/7); pasos '+avg(steps)+' ('+coverage.steps+'/7); días con registro de hábitos '+coverage.habits+'/7.'));
        section.append(node('p','Días dentro de las tolerancias existentes: '+(goal?adherent.length+'/7; sin registro/incompleto no se cuenta como incumplimiento.':'no evaluable: sin objetivo vigente.')));
        section.append(node('p','Cumplimiento declarado, cumplido/no cumplido/sin dato · '+Object.entries(habitStatus).map(([k,v])=>k+' '+v.yes+'/'+v.no+'/'+v.unknown).join(' · ')));
        for(const d of h.days){const intake=d.intake,food=intake?.status==='COMPLETE'?'Completo · '+intake.totals.kcal+' kcal · '+(d.nutritionAdherence?.status??'sin objetivo')+' · P/C/G '+intake.totals.proteinG+'/'+intake.totals.carbsG+'/'+intake.totals.fatG:intake?'Parcial · no evaluable':'Sin registro · no evaluable';const habit=d.habits?['waterLiters','steps','sleepHours','sleepQuality','stress','training'].map(k=>k+': '+(d.habits.completion?.[k]===true?'cumplido':d.habits.completion?.[k]===false?'no cumplido':'sin dato')).join(' · '):'hábitos: sin registro';section.append(node('p',d.date+' · alimentación '+food+' · agua '+(d.habits?.values.waterLiters??'sin registro')+' · pasos '+(d.habits?.values.steps??'sin registro')+' · peso '+(d.weight?.weightKg??'sin registro')+' · '+habit));}
        container.append(section);
      }catch{if(ticket===epoch){clear();container.append(node('p','No se pudo cargar el resumen semanal.'));}}
    }
    return {show,weekly,clear};
  }
  function addDays(date,days){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
  const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotTrackingUI=api;
})(typeof globalThis==='object'?globalThis:this);
