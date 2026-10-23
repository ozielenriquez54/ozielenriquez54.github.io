(function(root){
  'use strict';
  function mount(container,{model,document:doc=root.document,newId=()=>root.crypto.randomUUID()}){
    let epoch=0;
    const node=(tag,text)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
    function clear(){epoch++;container.replaceChildren();}
    async function show(target,date,focusFoodId=null){
      clear();const ticket=epoch;
      try{
        const [day,foods]=await Promise.all([model.read(target,date),model.foods(target)]);
        if(ticket!==epoch)return;
        const datePicker=node('input');datePicker.type='date';datePicker.value=date;datePicker.setAttribute('aria-label','Fecha del diario');datePicker.addEventListener('change',()=>show(target,datePicker.value));container.append(datePicker);
        container.append(node('h3','Alimentos del dia'),node('p',date+' - '+day.status));
        for(const entry of day.entries){
          const food=entry.foodSnapshot.definitionSnapshot,row=node('p',food.displayName+' - '+entry.quantity+' '+entry.unit+' - '+entry.nutritionSnapshot.kcal+' kcal');
          if(day.status==='COMPLETE'){const reopen=node('button','Reabrir dia para editar');reopen.type='button';reopen.addEventListener('click',()=>act(target,date,day,{type:'REOPEN'}));row.append(reopen);}
          else{
            const amount=node('input'),edit=node('button','Actualizar cantidad'),remove=node('button','Quitar alimento');amount.type='number';amount.min='0.01';amount.step='any';amount.value=String(entry.quantity);amount.setAttribute('aria-label','Nueva cantidad de '+food.displayName);edit.type=remove.type='button';
            edit.addEventListener('click',()=>{const qty=Number(amount.value);if(!Number.isFinite(qty)||qty<=0){amount.setCustomValidity('Introduce una cantidad positiva');amount.reportValidity();return;}
              return act(target,date,day,{type:'REPLACE',entryId:entry.entryId,foodId:food.foodId,amount:{kind:entry.foodSnapshot.amountKind,quantity:qty,unit:entry.unit,preparationState:entry.foodSnapshot.preparationState,weighingBasis:entry.foodSnapshot.weighingBasis}});});
            remove.addEventListener('click',()=>act(target,date,day,{type:'REMOVE',entryId:entry.entryId}));row.append(amount,edit,remove);
          }
          container.append(row);
        }
        if(day.totals)container.append(node('p',day.totals.kcal+' kcal - P '+day.totals.proteinG+' g - C '+day.totals.carbsG+' g - G '+day.totals.fatG+' g'));
        const form=node('form'),search=node('input'),choice=node('select'),quantity=node('input'),unitLabel=node('span'),save=node('button','Registrar alimento'),message=node('p');
        search.type='search';search.placeholder='Buscar alimento';search.setAttribute('aria-label','Buscar en el catalogo');choice.setAttribute('aria-label','Alimento');quantity.setAttribute('aria-label','Cantidad');
        quantity.type='number';quantity.min='0.01';quantity.step='any';quantity.required=true;save.type='submit';
        const matches=()=>foods.filter(f=>f.displayName.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
        const selectFood=()=>{const f=foods.find(x=>x.foodId===choice.value);quantity.disabled=f?.weighingBasis==='UNWEIGHED';quantity.required=!quantity.disabled;
          unitLabel.textContent=quantity.disabled?' (sin pesar)':f?.referenceUnit?' '+f.referenceUnit:'';
          if(f&&quantity.value===''&&f.referenceQuantity)quantity.value=String(f.referenceQuantity);
          message.textContent=f?.validationStatus==='PENDING_VALIDATION'?'Alimento personal pendiente de validar; solo tu cuenta puede usarlo.':'';};
        const renderChoices=()=>{choice.replaceChildren();const list=matches();
          if(!list.length){const option=node('option','Sin coincidencias');option.value='';option.disabled=true;choice.append(option);save.disabled=true;}
          else{for(const f of list){const option=node('option',f.displayName+' ('+(f.weighingBasis==='UNWEIGHED'?'sin pesar':f.referenceUnit)+')'+(f.validationStatus==='PENDING_VALIDATION'?' - personal':''));option.value=f.foodId;choice.append(option);}save.disabled=false;}
          if(focusFoodId&&list.some(f=>f.foodId===focusFoodId))choice.value=focusFoodId;else if(list.length)choice.value=list[0].foodId;selectFood();};
        search.addEventListener('input',renderChoices);choice.addEventListener('change',selectFood);renderChoices();
        let busy=false;
        form.addEventListener('submit',async event=>{
          event.preventDefault();if(busy||ticket!==epoch)return;
          const food=foods.find(x=>x.foodId===choice.value),amount=Number(quantity.value);
          if(!food||(food.weighingBasis!=='UNWEIGHED'&&(!Number.isFinite(amount)||amount<=0))){message.textContent='Revisa alimento y cantidad.';return;}
          busy=true;save.disabled=true;
          try{await model.save({...target,nutritionDate:date,operationId:newId(),baseRevision:day.revision??0,type:'ADD',foodId:food.foodId,mealId:'daily',mealType:'MEAL',
            amount:{kind:food.weighingBasis==='UNWEIGHED'?'UNWEIGHED':'MEASURED',quantity:food.weighingBasis==='UNWEIGHED'?null:amount,unit:food.weighingBasis==='UNWEIGHED'?null:food.referenceUnit,
              preparationState:food.preparationState,weighingBasis:food.weighingBasis}});
            if(ticket===epoch)await show(target,date);
          }catch{if(ticket===epoch){message.textContent='No se confirmo el registro. Consulta el dia antes de reintentar.';save.disabled=false;}}
        });
        if(day.status!=='COMPLETE'){
          form.append(search,choice,quantity,unitLabel,save,message);container.append(form);
          const details=node('details'),summary=node('summary','Agregar alimento personal'),createForm=node('form');
          const name=node('input'),profile=node('select'),referenceQuantity=node('input'),referenceUnit=node('select'),sourceKind=node('select'),sourceReference=node('input'),createButton=node('button','Guardar alimento personal'),createMessage=node('p');
          name.type='text';name.maxLength=100;name.required=true;name.setAttribute('aria-label','Nombre del alimento');
          [['AS_SOLD','Producto como se vende'],['COOKED_PROTEIN','Proteina animal pesada cocida'],['DRY','Alimento pesado seco/crudo'],['VEGETABLE_ZERO','Verdura simple sin anadidos (no contabiliza)']].forEach(([v,t])=>{const o=node('option',t);o.value=v;profile.append(o);});
          referenceQuantity.type='number';referenceQuantity.min='0.01';referenceQuantity.step='any';referenceQuantity.value='100';referenceQuantity.setAttribute('aria-label','Cantidad de referencia de etiqueta');
          [['g','g'],['ml','ml'],['pieza','pieza'],['porcion','porcion'],['taza','taza'],['cucharada','cucharada'],['cucharadita','cucharadita']].forEach(([v,t])=>{const o=node('option',t);o.value=v;referenceUnit.append(o);});
          [['LABEL','Datos de etiqueta nutricional'],['MANUAL','Datos manuales pendientes de validar']].forEach(([v,t])=>{const o=node('option',t);o.value=v;sourceKind.append(o);});
          sourceReference.type='text';sourceReference.maxLength=300;sourceReference.placeholder='Referencia o producto (requerida para datos manuales)';sourceReference.setAttribute('aria-label','Referencia nutricional');
          const macroInputs={};for(const [key,label] of [['kcal','kcal'],['proteinG','Proteina (g)'],['carbsG','Carbohidratos (g)'],['fatG','Grasa (g)']]){const input=node('input');input.type='number';input.min='0';input.step='any';input.setAttribute('aria-label',label);macroInputs[key]=input;createForm.append(input);}
          createForm.append(node('p','Los macros son para la cantidad/unidad de referencia. Proteina animal: peso cocido; avena/arroz: peso seco. Aceites, salsas y aderezos se registran medidos, nunca como verdura.'));
          const syncProfile=()=>{const veg=profile.value==='VEGETABLE_ZERO';referenceQuantity.disabled=veg;referenceUnit.disabled=veg;Object.values(macroInputs).forEach(x=>x.required=!veg);
            createMessage.textContent=veg?'VEGETABLE_ZERO: no pide cantidad y aporta cero al diario. No uses esta opcion con aceite, salsa o aderezo.':'';};
          profile.addEventListener('change',syncProfile);syncProfile();createButton.type='submit';
          createForm.append(name,profile,referenceQuantity,referenceUnit,sourceKind,sourceReference,createButton,createMessage);details.append(summary,createForm);container.append(details);
          search.addEventListener('input',()=>{if(!matches().length){name.value=search.value.trim();details.open=true;}});
          createForm.addEventListener('submit',async event=>{event.preventDefault();if(ticket!==epoch||createButton.disabled)return;createButton.disabled=true;
            const draft={displayName:name.value,profile:profile.value,referenceQuantity:referenceQuantity.value,referenceUnit:referenceUnit.value,sourceKind:sourceKind.value,sourceReference:sourceReference.value,
              ...Object.fromEntries(Object.entries(macroInputs).map(([k,v])=>[k,v.value]))};
            try{const created=await model.createFood(target,draft);if(ticket===epoch)await show(target,date,created.foodId);}
            catch{if(ticket===epoch){createMessage.textContent='No se guardo. Revisa nombre, referencia y macros; los alimentos personales no se comparten.';createButton.disabled=false;}}
          });
          const complete=node('button','Cerrar dia'),zero=node('input'),zeroLabel=node('label','Confirmo explicitamente dia en cero ');zero.type='checkbox';zeroLabel.append(zero);complete.type='button';
          complete.addEventListener('click',async()=>{if(day.entries.length===0&&!zero.checked){message.textContent='Confirma que el consumo fue realmente cero.';return;}await act(target,date,day,{type:'COMPLETE',confirmZero:day.entries.length===0&&zero.checked});});container.append(zeroLabel,complete);
        }
      }catch{if(ticket===epoch){clear();container.append(node('p','No se pudo verificar el acceso al diario.'));}}
    }
    async function act(target,date,day,action){const ticket=epoch;try{await model.save({...target,nutritionDate:date,operationId:newId(),baseRevision:day.revision??0,...action});if(ticket===epoch)await show(target,date);}
      catch{if(ticket===epoch){clear();container.append(node('p','No se confirmo el cambio; vuelve a consultar el dia.'));}}}
    return {show,clear};
  }
  const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotDiaryUI=api;
})(typeof globalThis==='object'?globalThis:this);
