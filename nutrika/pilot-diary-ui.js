(function(root){
  'use strict';
  // Diario alimenticio del cliente (sección Alimentación). Reutiliza el modelo
  // existente (GET /api/diary/day y /foods; POST /api/diary/save y /personal-foods)
  // con los mismos comandos ADD / REPLACE / REMOVE / COMPLETE / REOPEN. El tipo de
  // comida viaja en mealId/mealType, campos que el dominio ya valida y guarda en
  // cada entrada (nutrika/domain/tracking/diary.cjs → entryFromFood). Esta interfaz
  // no calcula nutrición: muestra lo que devuelve el servidor (nutritionSnapshot y
  // totals). Los subtotales por comida solo suman esas instantáneas para mostrarlas.
  const MEALS=[
    {id:'breakfast',type:'BREAKFAST',key:'meal.breakfast'},
    {id:'lunch',type:'LUNCH',key:'meal.lunch'},
    {id:'dinner',type:'DINNER',key:'meal.dinner'},
    {id:'snacks',type:'SNACK',key:'meal.snacks'}
  ];
  const MACROS=[['proteinG','macro.protein','protein','P'],['carbsG','macro.carbs','carbs','C'],['fatG','macro.fat','fat','G']];
  const KEYS=['kcal','proteinG','carbsG','fatG'];
  const RESULTS_LIMIT=40;
  function mealOf(entry){return MEALS.find(m=>m.type===entry?.mealType)??null;}
  // Entradas registradas antes de este cambio (mealType 'MEAL') no pertenecen a
  // ninguna de las cuatro comidas: se muestran aparte, sin reasignarlas.
  function groupByMeal(entries){
    const groups=new Map(MEALS.map(m=>[m.type,[]])),other=[];
    for(const e of entries??[]){const m=mealOf(e);if(m)groups.get(m.type).push(e);else other.push(e);}
    return {groups,other};
  }
  function subtotal(entries){
    const s={kcal:0,proteinG:0,carbsG:0,fatG:0};
    for(const e of entries)for(const k of KEYS)s[k]=Math.round((s[k]+(Number(e.nutritionSnapshot?.[k])||0))*10)/10;
    return s;
  }
  function addDays(date,days){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
  function localI18n(){
    if(root.PilotClientI18n)return root.PilotClientI18n;
    if(typeof module==='object'&&typeof require==='function'){try{return require('./pilot-client-i18n.js');}catch{}}
    return {t:k=>k,locale:()=>'es-MX'};
  }

  function mount(container,{model,macros=null,panel=null,i18n=null,document:doc=root.document,newId=()=>root.crypto.randomUUID(),onChanged=null}){
    // Aviso opcional tras un guardado confirmado por el servidor (pantalla de inicio del cliente).
    const changed=(target,date)=>{if(typeof onChanged==='function')onChanged(target,date);};
    const lang=()=>i18n??localI18n();
    const t=(k,v)=>lang().t(k,v);
    const fmt=(n,d=0)=>Number(n).toLocaleString(lang().locale(),{minimumFractionDigits:0,maximumFractionDigits:d});
    const unitLabel=u=>{const k='unit.'+u,s=t(k);return s===k?u:s;};
    const node=(tag,text,cls)=>{const el=doc.createElement(tag);if(text!==undefined&&text!==null)el.textContent=String(text);if(cls)el.className=cls;return el;};
    const button=(text,cls,onClick)=>{const b=node('button',text,cls);b.type='button';if(onClick)b.addEventListener('click',onClick);return b;};
    // Panel independiente (hoja inferior en celular). Sin panel, se dibuja debajo del diario.
    let inline=null,epoch=0,state=null;
    const panelRoot=()=>{if(panel)return panel.root;if(!inline){inline=node('section',undefined,'tg-card tg-food-panel');container.append(inline);}return inline;};
    const openPanel=()=>{if(panel)panel.open();};
    function closePanel(){(panel?panel.root:inline)?.replaceChildren();if(panel)panel.close();}
    function clear(){epoch++;state=null;closePanel();inline=null;container.replaceChildren();}

    // ---------- piezas ----------
    function amountText(entry){return entry.foodSnapshot?.amountKind==='UNWEIGHED'||entry.quantity===null||entry.quantity===undefined?t('diary.unweighed'):fmt(entry.quantity,2)+' '+unitLabel(entry.unit);}
    function perReference(food){
      const n=food.nutrition??food;
      if(food.weighingBasis==='UNWEIGHED')return t('diary.unweighedFood');
      const ref=food.referenceQuantity?fmt(food.referenceQuantity,2)+' '+unitLabel(food.referenceUnit):unitLabel(food.referenceUnit);
      return n.kcal===null||n.kcal===undefined?ref:t('diary.perRef',{ref,kcal:fmt(n.kcal)});
    }
    function macroLine(s){return MACROS.map(([k,,,abbr])=>abbr+' '+fmt(s[k],1)).join(' · ');}
    function bar(pct,over,label,target,value){
      const track=node('div',undefined,'tg-track'),fill=node('span',undefined,over?'is-over':'');fill.style.width=pct+'%';track.append(fill);
      track.setAttribute('role','progressbar');track.setAttribute('aria-label',label);track.setAttribute('aria-valuemin','0');
      track.setAttribute('aria-valuemax',String(target??0));track.setAttribute('aria-valuenow',String(value??0));return track;
    }
    function summary(totals,goal){
      const c=node('section',undefined,'tg-card tg-food-summary');
      // Restante = objetivo − consumido, ambos redondeados como se muestran (sin descuadres de 1).
      const consumed=k=>Math.round(Number(totals?.[k]??0)),pct=k=>goal?.[k]>0?Math.min(100,Math.round(consumed(k)/goal[k]*100)):0;
      const head=node('div',undefined,'tg-food-kcal'),big=node('div',undefined,'tg-food-kcal-main');
      big.append(node('strong',fmt(consumed('kcal')),'tg-num'),node('span',goal?' / '+fmt(goal.kcal)+' kcal':' kcal','tg-muted'));
      head.append(big);
      if(goal){const left=goal.kcal-consumed('kcal');head.append(node('span',left>=0?t('diary.kcalLeft',{n:fmt(left)}):t('diary.kcalOver',{n:fmt(-left)}),'tg-chip '+(left>=0?'is-info':'is-warn')));}
      c.append(node('span',t('diary.consumed'),'tg-stat-label'),head);
      if(goal)c.append(bar(pct('kcal'),consumed('kcal')>goal.kcal,t('macro.kcal'),goal.kcal,consumed('kcal')));
      const grid=node('div',undefined,'tg-food-macros');
      for(const [k,label,tone] of MACROS){
        const m=node('div',undefined,'tg-macro is-'+tone),top=node('div',undefined,'tg-macro-head'),value=node('span',undefined,'tg-macro-value');
        value.append(node('strong',fmt(consumed(k)),'tg-num'),node('span',goal?' / '+fmt(goal[k])+' g':' g'));
        top.append(node('span',t(label),'tg-macro-label'),value);m.append(top);
        if(goal){m.append(bar(pct(k),consumed(k)>goal[k],t(label),goal[k],consumed(k)));
          const left=goal[k]-consumed(k);m.append(node('span',left>=0?t('diary.gLeft',{n:fmt(left)}):t('diary.gOver',{n:fmt(-left)}),'tg-muted'));}
        grid.append(m);
      }
      c.append(grid);
      if(!goal)c.append(node('p',t('diary.noGoal'),'tg-pending'));
      return c;
    }
    function entryRow(entry,editable){
      const food=entry.foodSnapshot?.definitionSnapshot??{},li=node('li',undefined,'tg-entry-item');
      const body=node(editable?'button':'div',undefined,'tg-entry');if(editable){body.type='button';body.setAttribute('aria-label',t('diary.editEntry',{name:food.displayName}));body.addEventListener('click',()=>openEdit(entry));}
      const info=node('span',undefined,'tg-entry-info');info.append(node('strong',food.displayName),node('span',amountText(entry),'tg-muted'));
      body.append(info,node('span',fmt(entry.nutritionSnapshot?.kcal??0)+' kcal','tg-entry-kcal tg-num'));
      li.append(body);return li;
    }
    function mealCard(meal,entries,editable){
      const c=node('section',undefined,'tg-card tg-meal'),head=node('div',undefined,'tg-meal-head'),s=subtotal(entries);
      const title=node('div');title.append(node('h2',meal?t(meal.key):t('meal.other'),'tg-card-title'));
      if(entries.length)title.append(node('span',macroLine(s),'tg-muted tg-meal-macros'));
      head.append(title,node('strong',fmt(s.kcal)+' kcal','tg-meal-kcal tg-num'));c.append(head);
      if(!meal)c.append(node('p',t('meal.otherNote'),'tg-muted'));
      if(entries.length){const ul=node('ul',undefined,'tg-entries');for(const e of entries)ul.append(entryRow(e,editable));c.append(ul);}
      else c.append(node('p',t('diary.mealEmpty'),'tg-muted tg-meal-empty'));
      if(meal&&editable)c.append(button('+ '+t('diary.add'),'tg-add',()=>openAdd(meal)));
      return c;
    }

    // ---------- pantalla ----------
    async function show(target,date){
      clear();const ticket=epoch;
      try{
        const [day,foods,goalRead]=await Promise.all([model.read(target,date),model.foods(target),macros?macros.read(target).catch(()=>null):Promise.resolve(null)]);
        if(ticket!==epoch)return;
        state={target,date,day,foods,goal:goalRead?.macros??null,ticket};
        const editable=day.status!=='COMPLETE';
        const top=node('div',undefined,'tg-food-top'),nav=node('div',undefined,'tg-datenav');
        const picker=node('input');picker.type='date';picker.value=date;picker.setAttribute('aria-label',t('diary.date'));picker.addEventListener('change',()=>{if(picker.value)show(target,picker.value);});
        const prev=button('‹','tg-btn-ghost tg-btn-sm tg-daystep',()=>show(target,addDays(date,-1))),next=button('›','tg-btn-ghost tg-btn-sm tg-daystep',()=>show(target,addDays(date,1)));
        prev.setAttribute('aria-label',t('diary.prevDay'));next.setAttribute('aria-label',t('diary.nextDay'));
        nav.append(prev,picker,next);
        top.append(node('h1',t('food.heading')),nav,node('span',editable?t('diary.open'):t('diary.closed'),'tg-chip '+(editable?'is-muted':'is-info')));
        container.append(top,summary(day.totals,state.goal));
        const {groups,other}=groupByMeal(day.entries);
        const meals=node('div',undefined,'tg-meals');
        for(const meal of MEALS)meals.append(mealCard(meal,groups.get(meal.type),editable));
        if(other.length)meals.append(mealCard(null,other,editable));
        container.append(meals,closeCard(day));
      }catch{if(ticket===epoch){clear();container.append(node('p',t('diary.accessError'),'tg-error'));}}
    }
    function closeCard(day){
      const c=node('section',undefined,'tg-card tg-day-close'),message=node('p',undefined,'tg-muted');message.setAttribute('role','status');
      if(day.status==='COMPLETE'){
        c.append(node('h2',t('diary.closedTitle'),'tg-card-title'),node('p',t('diary.closedNote'),'tg-muted'),button(t('diary.reopen'),'tg-btn-ghost',()=>act({type:'REOPEN'},message)));
      }else{
        c.append(node('h2',t('diary.closeTitle'),'tg-card-title'),node('p',t('diary.closeNote'),'tg-muted'));
        const zero=node('input'),zeroLabel=node('label',undefined,'tg-check');zero.type='checkbox';zeroLabel.append(zero,node('span',t('diary.confirmZero')));
        if(day.entries.length===0)c.append(zeroLabel);
        c.append(button(t('diary.closeDay'),'',async()=>{
          if(day.entries.length===0&&!zero.checked){message.textContent=t('diary.zeroRequired');return;}
          await act({type:'COMPLETE',confirmZero:day.entries.length===0&&zero.checked},message);
        }));
      }
      c.append(message);return c;
    }

    // ---------- guardado (comandos existentes) ----------
    let busy=false;
    async function act(action,message){
      const s=state;if(!s||busy)return false;busy=true;const ticket=epoch;
      try{
        await model.save({...s.target,nutritionDate:s.date,operationId:newId(),baseRevision:s.day.revision??0,...action});
        if(ticket===epoch){closePanel();await show(s.target,s.date);changed(s.target,s.date);}
        return true;
      }catch{
        if(ticket===epoch){
          if(message)message.textContent=t('diary.notConfirmed');
          else{closePanel();clear();container.append(node('p',t('diary.notConfirmed'),'tg-error'),button(t('diary.reload'),'tg-btn-ghost',()=>show(s.target,s.date)));}
        }
        return false;
      }finally{busy=false;}
    }

    // ---------- panel: agregar ----------
    function panelHead(title){
      const head=node('div',undefined,'tg-sheet-head'),h=node('h2',title);h.id='food-title';
      head.append(h,button(t('log.close'),'tg-btn-ghost tg-btn-sm',closePanel));return {head,h};
    }
    function openAdd(meal,focusFoodId=null){
      const s=state;if(!s||s.day.status==='COMPLETE')return;
      const r=panelRoot();r.replaceChildren();
      let current=meal,selected=null;
      const {head,h}=panelHead(t('diary.addTo',{meal:t(meal.key)}));
      const body=node('div',undefined,'tg-sheet-body');
      const chips=node('div',undefined,'tg-meal-chips');chips.setAttribute('role','group');chips.setAttribute('aria-label',t('diary.meal'));
      const chipFor=new Map();
      for(const m of MEALS){const b=button(t(m.key),'tg-meal-chip',()=>{current=m;h.textContent=t('diary.addTo',{meal:t(m.key)});for(const [mm,bb] of chipFor)bb.setAttribute('aria-pressed',String(mm===m));});
        b.setAttribute('aria-pressed',String(m===meal));chipFor.set(m,b);chips.append(b);}
      const search=node('input');search.type='search';search.placeholder=t('diary.search');search.setAttribute('aria-label',t('diary.search'));search.autocomplete='off';
      const results=node('ul',undefined,'tg-results'),detail=node('div',undefined,'tg-pick');detail.hidden=true;
      const form=node('form',undefined,'tg-pick-form'),quantity=node('input'),unit=node('span',undefined,'tg-unit'),save=node('button',t('diary.addButton')),message=node('p',undefined,'tg-muted');
      quantity.type='number';quantity.min='0.01';quantity.step='any';quantity.inputMode='decimal';quantity.setAttribute('aria-label',t('diary.quantity'));save.type='submit';message.setAttribute('role','status');
      const name=node('strong'),ref=node('span',undefined,'tg-muted'),note=node('p',undefined,'tg-pending');note.hidden=true;
      const qtyRow=node('label',undefined,'tg-qty');qtyRow.append(node('span',t('diary.quantity'),'tg-stat-label'),quantity,unit);
      form.append(qtyRow,save,message);detail.append(name,ref,note,form);
      const rows=[];const matches=()=>{const q=search.value.trim().toLocaleLowerCase();return s.foods.filter(f=>f.displayName.toLocaleLowerCase().includes(q));};
      function select(food){
        selected=food;detail.hidden=false;name.textContent=food.displayName;ref.textContent=perReference(food);
        const unweighed=food.weighingBasis==='UNWEIGHED';quantity.disabled=unweighed;quantity.required=!unweighed;
        unit.textContent=unweighed?t('diary.unweighed'):unitLabel(food.referenceUnit??'');
        quantity.value=unweighed?'':food.referenceQuantity?String(food.referenceQuantity):'';
        note.hidden=food.validationStatus!=='PENDING_VALIDATION';note.textContent=note.hidden?'':t('diary.personalPending');
        message.textContent='';
        for(const [f,li] of rows)li.className='tg-result-item'+(f.foodId===food.foodId?' is-selected':'');
      }
      function renderResults(){
        results.replaceChildren();rows.length=0;const list=matches();
        if(!list.length){results.append(node('li',t('diary.noMatches'),'tg-muted tg-result-empty'));create.details.open=true;create.name.value=search.value.trim();return;}
        for(const f of list.slice(0,RESULTS_LIMIT)){
          const li=node('li',undefined,'tg-result-item'+(selected?.foodId===f.foodId?' is-selected':''));rows.push([f,li]);
          const b=button(undefined,'tg-result',()=>select(f)),info=node('span',undefined,'tg-entry-info');
          info.append(node('strong',f.displayName),node('span',perReference(f),'tg-muted'));b.append(info);
          if(f.validationStatus==='PENDING_VALIDATION')b.append(node('span',t('diary.personal'),'tg-chip is-warn'));
          li.append(b);results.append(li);
        }
        if(list.length>RESULTS_LIMIT)results.append(node('li',t('diary.moreResults',{n:list.length-RESULTS_LIMIT}),'tg-muted tg-result-empty'));
      }
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(busy||s!==state)return;
        const food=selected,amount=Number(quantity.value);
        if(!food||(food.weighingBasis!=='UNWEIGHED'&&(!Number.isFinite(amount)||amount<=0))){message.textContent=t('diary.checkAmount');return;}
        save.disabled=true;
        const ok=await act({type:'ADD',foodId:food.foodId,mealId:current.id,mealType:current.type,
          amount:{kind:food.weighingBasis==='UNWEIGHED'?'UNWEIGHED':'MEASURED',quantity:food.weighingBasis==='UNWEIGHED'?null:amount,unit:food.weighingBasis==='UNWEIGHED'?null:food.referenceUnit,
            preparationState:food.preparationState,weighingBasis:food.weighingBasis}},message);
        if(!ok){message.textContent=t('diary.addNotConfirmed');save.disabled=false;}
      });
      const create=personalFoodForm(s,()=>current);
      search.addEventListener('input',renderResults);
      body.append(chips,search,results,detail,create.details);r.append(head,body);
      renderResults();
      const focus=focusFoodId&&s.foods.find(f=>f.foodId===focusFoodId);if(focus)select(focus);
      openPanel();
      if(!focus)root.setTimeout?.(()=>search.focus?.(),60);
    }

    // Alimento personal: mismo formulario, mismos perfiles y validaciones del servidor.
    function personalFoodForm(s,currentMeal){
      const details=node('details',undefined,'tg-personal'),summaryEl=node('summary',t('diary.personalAdd')),form=node('form',undefined,'tg-personal-form');
      const name=node('input'),profile=node('select'),referenceQuantity=node('input'),referenceUnit=node('select'),sourceKind=node('select'),sourceReference=node('input'),createButton=node('button',t('diary.personalSave')),createMessage=node('p',undefined,'tg-muted');
      name.type='text';name.maxLength=100;name.required=true;name.setAttribute('aria-label',t('diary.personalName'));name.placeholder=t('diary.personalName');
      [['AS_SOLD','profile.asSold'],['COOKED_PROTEIN','profile.cookedProtein'],['DRY','profile.dry'],['VEGETABLE_ZERO','profile.vegetableZero']].forEach(([v,k])=>{const o=node('option',t(k));o.value=v;profile.append(o);});
      profile.setAttribute('aria-label',t('diary.personalProfile'));
      referenceQuantity.type='number';referenceQuantity.min='0.01';referenceQuantity.step='any';referenceQuantity.value='100';referenceQuantity.setAttribute('aria-label',t('diary.personalRefQty'));
      ['g','ml','pieza','porcion','taza','cucharada','cucharadita'].forEach(v=>{const o=node('option',unitLabel(v));o.value=v;referenceUnit.append(o);});
      referenceUnit.setAttribute('aria-label',t('diary.personalRefUnit'));
      [['LABEL','source.label'],['MANUAL','source.manual']].forEach(([v,k])=>{const o=node('option',t(k));o.value=v;sourceKind.append(o);});
      sourceKind.setAttribute('aria-label',t('diary.personalSource'));
      sourceReference.type='text';sourceReference.maxLength=300;sourceReference.placeholder=t('diary.personalReference');sourceReference.setAttribute('aria-label',t('diary.personalReference'));
      const macroInputs={},macroBox=node('div',undefined,'tg-personal-macros');
      for(const [key,label] of [['kcal','kcal'],['proteinG','diary.proteinG'],['carbsG','diary.carbsG'],['fatG','diary.fatG']]){
        const input=node('input'),l=node('label');input.type='number';input.min='0';input.step='any';input.inputMode='decimal';const text=key==='kcal'?'kcal':t(label);input.setAttribute('aria-label',text);
        l.append(node('span',text,'tg-stat-label'),input);macroInputs[key]=input;macroBox.append(l);
      }
      const help=node('p',t('diary.personalHelp'),'tg-muted');
      const syncProfile=()=>{const veg=profile.value==='VEGETABLE_ZERO';referenceQuantity.disabled=veg;referenceUnit.disabled=veg;Object.values(macroInputs).forEach(x=>x.required=!veg);
        createMessage.textContent=veg?t('diary.personalVegetable'):'';};
      profile.addEventListener('change',syncProfile);syncProfile();createButton.type='submit';
      const refRow=node('div',undefined,'tg-personal-ref');refRow.append(referenceQuantity,referenceUnit);
      form.append(name,profile,refRow,macroBox,help,sourceKind,sourceReference,createButton,createMessage);details.append(summaryEl,form);
      form.addEventListener('submit',async event=>{event.preventDefault();if(s!==state||createButton.disabled)return;createButton.disabled=true;
        const draft={displayName:name.value,profile:profile.value,referenceQuantity:referenceQuantity.value,referenceUnit:referenceUnit.value,sourceKind:sourceKind.value,sourceReference:sourceReference.value,
          ...Object.fromEntries(Object.entries(macroInputs).map(([k,v])=>[k,v.value]))};
        try{const created=await model.createFood(s.target,draft);if(s===state){const meal=currentMeal();await show(s.target,s.date);if(state)openAdd(meal,created.foodId);}}
        catch{if(s===state){createMessage.textContent=t('diary.personalError');createButton.disabled=false;}}
      });
      return {details,name};
    }

    // ---------- panel: editar cantidad o eliminar ----------
    function openEdit(entry){
      const s=state;if(!s||s.day.status==='COMPLETE')return;
      const food=entry.foodSnapshot?.definitionSnapshot??{},meal=mealOf(entry);
      const r=panelRoot();r.replaceChildren();
      const {head}=panelHead(food.displayName);
      const body=node('div',undefined,'tg-sheet-body'),message=node('p',undefined,'tg-muted');message.setAttribute('role','status');
      body.append(node('p',(meal?t(meal.key):t('meal.other'))+' · '+amountText(entry)+' · '+fmt(entry.nutritionSnapshot?.kcal??0)+' kcal','tg-muted'));
      const unweighed=entry.foodSnapshot?.amountKind==='UNWEIGHED';
      if(unweighed)body.append(node('p',t('diary.unweighedEdit'),'tg-pending'));
      else{
        const form=node('form',undefined,'tg-pick-form'),amount=node('input'),qtyRow=node('label',undefined,'tg-qty'),save=node('button',t('diary.saveAmount'));
        amount.type='number';amount.min='0.01';amount.step='any';amount.inputMode='decimal';amount.value=String(entry.quantity);amount.setAttribute('aria-label',t('diary.newAmount',{name:food.displayName}));save.type='submit';
        qtyRow.append(node('span',t('diary.quantity'),'tg-stat-label'),amount,node('span',unitLabel(entry.unit),'tg-unit'));
        form.append(qtyRow,save);body.append(form);
        form.addEventListener('submit',async event=>{event.preventDefault();
          const qty=Number(amount.value);if(!Number.isFinite(qty)||qty<=0){message.textContent=t('diary.positiveAmount');return;}
          save.disabled=true;
          const ok=await act({type:'REPLACE',entryId:entry.entryId,foodId:food.foodId,amount:{kind:entry.foodSnapshot.amountKind,quantity:qty,unit:entry.unit,preparationState:entry.foodSnapshot.preparationState,weighingBasis:entry.foodSnapshot.weighingBasis}},message);
          if(!ok)save.disabled=false;
        });
      }
      const remove=button(t('diary.remove'),'tg-btn-danger',async()=>{remove.disabled=true;if(!await act({type:'REMOVE',entryId:entry.entryId},message))remove.disabled=false;});
      body.append(remove,message);r.append(head,body);openPanel();
    }

    async function refresh(){if(state)await show(state.target,state.date);}
    return {show,clear,refresh};
  }
  const api={mount,MEALS,groupByMeal,subtotal};if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotDiaryUI=api;
})(typeof globalThis==='object'?globalThis:this);
