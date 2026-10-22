(function(root){
  'use strict';
  function mount(container,{model,document:doc=root.document,newId=()=>root.crypto.randomUUID()}){
    let epoch=0;
    function node(tag,text){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
    function clear(){epoch++;container.replaceChildren();}
    async function show(target,date){
      clear();const ticket=epoch;
      try{
        const [day,foods]=await Promise.all([model.read(target,date),model.foods()]);
        if(ticket!==epoch)return;
        container.append(node('h3','Alimentos del día'),node('p',date+' · '+day.status));
        for(const entry of day.entries)container.append(node('p',entry.foodSnapshot.definitionSnapshot.displayName+' · '+entry.quantity+' '+entry.unit));
        if(day.totals)container.append(node('p',day.totals.kcal+' kcal registradas'));
        const form=node('form'),choice=node('select'),quantity=node('input'),save=node('button','Registrar alimento'),message=node('p');
        choice.setAttribute('aria-label','Alimento');quantity.setAttribute('aria-label','Cantidad');
        quantity.type='number';quantity.min='0.01';quantity.step='any';quantity.required=true;save.type='submit';
        foods.forEach((f,i)=>{const option=node('option',f.displayName+' ('+(f.weighingBasis==='UNWEIGHED'?'sin pesar':f.referenceUnit)+')');option.value=String(i);choice.append(option);});choice.value='0';
        const selectFood=()=>{quantity.disabled=foods[Number(choice.value)]?.weighingBasis==='UNWEIGHED';quantity.required=!quantity.disabled;};
        choice.addEventListener('change',selectFood);selectFood();
        let busy=false;
        form.addEventListener('submit',async event=>{
          event.preventDefault();if(busy||ticket!==epoch)return;
          const food=foods[Number(choice.value)],amount=Number(quantity.value);
          if(!food||(food.weighingBasis!=='UNWEIGHED'&&(!Number.isFinite(amount)||amount<=0))){message.textContent='Revisa alimento y cantidad.';return;}
          busy=true;save.disabled=true;
          try{await model.save({...target,nutritionDate:date,operationId:newId(),baseRevision:day.revision??0,type:'ADD',
            foodId:food.foodId,mealId:'daily',mealType:'MEAL',amount:{kind:food.weighingBasis==='UNWEIGHED'?'UNWEIGHED':'MEASURED',
              quantity:food.weighingBasis==='UNWEIGHED'?null:amount,unit:food.weighingBasis==='UNWEIGHED'?null:food.referenceUnit,
              preparationState:food.preparationState,weighingBasis:food.weighingBasis}});
            if(ticket===epoch)await show(target,date);
          }catch{if(ticket===epoch){message.textContent='No se confirmó el registro. Vuelve a consultar el día antes de reintentar.';}}
        });
        if(day.status!=='COMPLETE'){form.append(choice,quantity,save,message);container.append(form);}
      }catch{if(ticket===epoch){clear();container.append(node('p','No se pudo verificar el acceso al diario.'));}}
    }
    return {show,clear};
  }
  const api={mount};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotDiaryUI=api;
})(typeof globalThis==='object'?globalThis:this);
