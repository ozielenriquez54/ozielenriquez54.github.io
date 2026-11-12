'use strict';
// VISTA PREVIA LOCAL Y SINTÉTICA de la experiencia del cliente. Sin SDK, red,
// credenciales ni persistencia: los modelos de abajo imitan la forma de
// /api/tracking/history, /api/diary/* y del objetivo de macros para montar las
// MISMAS interfaces reales (PilotDiaryUI, PilotTrackingUI, PilotMacrosUI y
// PilotClientHomeUI). Solo se sirve con PILOT_LOCAL_PREVIEW=1.
(()=>{
  const pad=n=>String(n).padStart(2,'0');
  const now=new Date(),today=now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate());
  const addDays=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  const target={gymId:'synthetic-gym',clientId:'synthetic-client-a',label:'Gimnasio ficticio · Cliente A'};
  const goal={macros:{proteinG:120,carbsG:245,fatG:60,kcal:2000},revision:2,effectiveFrom:addDays(today,-21)+'T12:00:00Z'};
  const keys=['waterLiters','steps','sleepHours','sleepQuality','stress','training'];
  const clone=v=>v===undefined||v===null?null:structuredClone(v);
  let seq=0;const uid=()=>'synthetic-'+(++seq);

  // Catálogo sintético (valores por cantidad de referencia, en la misma forma
  // que /api/diary/foods: nutrientes en la raíz del alimento).
  const foods=[
    ['Avena en hojuelas','g',40,'DRY','WEIGHED',{kcal:150,proteinG:5,carbsG:27,fatG:3}],
    ['Huevo entero','pieza',1,'AS_SOLD','WEIGHED',{kcal:72,proteinG:6,carbsG:0.4,fatG:5}],
    ['Pechuga de pollo (cocida)','g',100,'COOKED','WEIGHED',{kcal:165,proteinG:31,carbsG:0,fatG:3.6}],
    ['Arroz blanco (seco)','g',50,'DRY','WEIGHED',{kcal:180,proteinG:3.5,carbsG:40,fatG:0.3}],
    ['Plátano','pieza',1,'AS_SOLD','WEIGHED',{kcal:105,proteinG:1.3,carbsG:27,fatG:0.4}],
    ['Aguacate','g',50,'AS_SOLD','WEIGHED',{kcal:80,proteinG:1,carbsG:4,fatG:7.5}],
    ['Yogur griego natural','g',170,'AS_SOLD','WEIGHED',{kcal:100,proteinG:17,carbsG:6,fatG:0.7}],
    ['Brócoli','',null,'AS_SOLD','UNWEIGHED',{kcal:0,proteinG:0,carbsG:0,fatG:0}]
  ].map(([displayName,referenceUnit,referenceQuantity,preparationState,weighingBasis,nutrition])=>({foodId:uid(),displayName,referenceUnit,referenceQuantity,preparationState,weighingBasis,validationStatus:'VALIDATED',...nutrition}));
  const round1=n=>Math.round(n*10)/10;
  const sum=entries=>entries.reduce((t,e)=>{for(const k of Object.keys(t))t[k]=round1(t[k]+e.nutritionSnapshot[k]);return t;},{kcal:0,proteinG:0,carbsG:0,fatG:0});
  const NUTRIENTS=['kcal','proteinG','carbsG','fatG'];
  function entryFor(food,quantity,meal){
    const f=food.weighingBasis==='UNWEIGHED'?0:quantity/food.referenceQuantity;
    return {entryId:uid(),mealId:meal.mealId,mealType:meal.mealType,quantity:food.weighingBasis==='UNWEIGHED'?null:quantity,unit:food.weighingBasis==='UNWEIGHED'?null:food.referenceUnit,
      foodSnapshot:{amountKind:food.weighingBasis==='UNWEIGHED'?'UNWEIGHED':'MEASURED',preparationState:food.preparationState,weighingBasis:food.weighingBasis,definitionSnapshot:{foodId:food.foodId,displayName:food.displayName}},
      nutritionSnapshot:Object.fromEntries(NUTRIENTS.map(k=>[k,Math.round(food[k]*f*10)/10]))};
  }

  // Estado compartido: diario por fecha + peso/hábitos por fecha.
  const diary=new Map(),records=new Map();
  for(let i=40;i>=1;i--){
    const date=addDays(today,-i),n=(i*7919)%13,rec={};
    if(n%5!==0)rec.weight={weightKg:Math.round((80.5-(40-i)*0.06+((n%4)-1.5)*0.25)*10)/10,revision:1};
    if(n%6!==0)rec.habits={values:{waterLiters:2+(n%3)*0.5,steps:6000+n*400,sleepHours:6+(n%3),sleepQuality:3+(n%3),stress:1+(n%4),training:n%2?'STRENGTH':'NO_STRENGTH'},
      completion:Object.fromEntries(keys.map((k,j)=>[k,(n+j)%3!==0])),revision:1};
    records.set(date,rec);
    if(n%4!==0){const f=1+((n%5)-2)*0.03;diary.set(date,{status:'COMPLETE',revision:1,entries:[],totals:{kcal:Math.round(2000*f),proteinG:Math.round(120*f),carbsG:Math.round(245*f),fatG:Math.round(60*f)}});}
  }
  const byName=name=>foods.find(f=>f.displayName===name);
  const BREAKFAST={mealId:'breakfast',mealType:'BREAKFAST'},LUNCH={mealId:'lunch',mealType:'LUNCH'};
  const entries=[entryFor(byName('Avena en hojuelas'),60,BREAKFAST),entryFor(byName('Huevo entero'),2,BREAKFAST),entryFor(byName('Plátano'),1,BREAKFAST),
    entryFor(byName('Pechuga de pollo (cocida)'),150,LUNCH),entryFor(byName('Arroz blanco (seco)'),70,LUNCH),entryFor(byName('Brócoli'),null,LUNCH)];
  diary.set(today,{status:'PARTIAL',revision:1,entries});
  const dayOf=date=>{const d=diary.get(date);if(!d)return {status:'PARTIAL',revision:0,entries:[],totals:null};return {...structuredClone(d),totals:d.totals??(d.entries.length?sum(d.entries):null)};};

  const trackingModel={invalidate(){},
    async history(_t,from,to){const days=[];for(let d=from;;d=addDays(d,1)){const r=records.get(d)??{},dd=diary.get(d);
      const intake=dd&&(dd.status==='COMPLETE'||dd.entries.length)?{status:dd.status,totals:dd.totals??sum(dd.entries)}:null;
      days.push({date:d,intake:clone(intake),weight:clone(r.weight),habits:clone(r.habits)});if(d===to)break;}return {days,revisions:[]};},
    async save(c){const r=records.get(c.nutritionDate)??{};
      if(c.kind==='WEIGHT_DAY')r.weight={weightKg:c.weightKg,revision:(r.weight?.revision??0)+1};
      if(c.kind==='HABITS_DAY')r.habits={values:{...c.values},completion:{...c.completion},revision:(r.habits?.revision??0)+1};
      records.set(c.nutritionDate,r);return {ok:true};}};
  const diaryModel={invalidate(){},
    async foods(){return structuredClone(foods);},
    async read(_t,date){return dayOf(date);},
    async createFood(_t,draft){const food={foodId:uid(),displayName:String(draft.displayName).trim()||'Alimento personal',referenceUnit:draft.referenceUnit,referenceQuantity:Number(draft.referenceQuantity)||100,
      preparationState:'AS_SOLD',weighingBasis:draft.profile==='VEGETABLE_ZERO'?'UNWEIGHED':'WEIGHED',validationStatus:'PENDING_VALIDATION',
      kcal:Number(draft.kcal)||0,proteinG:Number(draft.proteinG)||0,carbsG:Number(draft.carbsG)||0,fatG:Number(draft.fatG)||0};foods.push(food);return {foodId:food.foodId};},
    async save(c){const d=diary.get(c.nutritionDate)??{status:'PARTIAL',revision:0,entries:[]};
      if(d.totals&&!d.entries.length&&c.type!=='REOPEN')d.totals=null;
      if(c.type==='ADD'){const food=foods.find(f=>f.foodId===c.foodId);d.entries.push(entryFor(food,c.amount.quantity,{mealId:c.mealId,mealType:c.mealType}));}
      if(c.type==='REMOVE')d.entries=d.entries.filter(e=>e.entryId!==c.entryId);
      if(c.type==='REPLACE'){const i=d.entries.findIndex(e=>e.entryId===c.entryId),food=foods.find(f=>f.foodId===c.foodId);if(i>=0)d.entries[i]={...entryFor(food,c.amount.quantity,d.entries[i]),entryId:c.entryId};}
      if(c.type==='COMPLETE')d.status='COMPLETE';
      if(c.type==='REOPEN')d.status='PARTIAL';
      if(d.entries.length)delete d.totals;
      d.revision++;diary.set(c.nutritionDate,d);return {ok:true};}};

  const macrosModel={invalidate(){},async list(){return [structuredClone(target)];},async read(){return structuredClone(goal);}};

  const $=id=>document.getElementById(id);
  let home=null;
  const refresh=()=>home?.refresh();
  const log=PilotTrackingUI.mount($('tracking-root'),{model:trackingModel,role:'CLIENT',onSaved:refresh});
  const diaryUI=PilotDiaryUI.mount($('diary-root'),{model:diaryModel,macros:macrosModel,panel:PilotClientShell.foodPanel(),onChanged:refresh});
  home=PilotClientHomeUI.mount({today:$('home-today-root'),food:$('home-food-root'),progress:$('home-progress-root'),plan:$('home-plan-root')},
    {model:trackingModel,macros:macrosModel,log,diaryAvailable:true,navigate:opts=>PilotClientShell.navigate(opts)});
  PilotClientShell.onLanguageChange(()=>{refresh();diaryUI.refresh();});
  PilotMacrosUI.mount($('macros-root'),{model:macrosModel,role:'CLIENT'}).refresh();
  log.show(target,today,macrosModel);diaryUI.show(target,today);home.show(target,today);
})();
