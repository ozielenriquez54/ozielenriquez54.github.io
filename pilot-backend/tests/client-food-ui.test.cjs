'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const Diary=require('../../nutrika/pilot-diary-ui.js');
const i18n=require('../../nutrika/pilot-client-i18n.js');
const {createPilotDiary}=require('../../nutrika/application/pilot-diary.cjs');
const {validateRecordData}=require('../../nutrika/domain/tracking/record-validation.cjs');
const {realFoodCatalog,loadCatalogApprovalPackage}=require('../server/real-food-catalog.cjs');

// DOM mínimo: solo lo que usa la interfaz.
function fakeDocument(){
  const make=tag=>({tagName:tag,children:[],attributes:{},style:{},className:'',_text:'',listeners:{},disabled:false,hidden:false,value:'',
    get textContent(){return this._text+this.children.map(c=>c.textContent).join(' ');},set textContent(v){this._text=String(v);this.children=[];},
    append(...c){this.children.push(...c);},replaceChildren(...c){this.children=[...c];this._text='';},setAttribute(k,v){this.attributes[k]=String(v);},
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);},click(){for(const f of this.listeners.click??[])f();},
    async fire(k,e={}){for(const f of this.listeners[k]??[])await f({preventDefault(){},...e});}});
  return {createElement:make};
}
const find=(n,pred,out=[])=>{if(pred(n))out.push(n);for(const c of n.children??[])find(c,pred,out);return out;};
const byClass=(n,cls)=>find(n,x=>String(x.className).split(' ').includes(cls));
const byText=(n,tag,re)=>find(n,x=>x.tagName===tag&&re.test(x.textContent));
const tick=()=>new Promise(r=>setImmediate(r));
const es={t:(k,v)=>i18n.t(k,v,'es'),locale:()=>'es-MX'},en={t:(k,v)=>i18n.t(k,v,'en'),locale:()=>'en-US'};
const target={gymId:'g',clientId:'c'},date='2026-11-12';
const goal={macros:{kcal:2000,proteinG:120,carbsG:245,fatG:60}};

// Servicio REAL del diario (aplicación + dominio + catálogo aprobado) con un
// almacén en memoria en lugar de Postgres: valida que los comandos de la
// interfaz se aceptan y que mealId/mealType se guardan y vuelven en la lectura.
function realService(){
  const pkg=loadCatalogApprovalPackage(),catalog=realFoodCatalog(pkg.registry,undefined,pkg.profileManifest),records=new Map(),actor='actor-1';
  const store={readOwn:async(_s,_t,d)=>structuredClone(records.get(d)??null),
    updateOwn:async(_s,_t,command,change)=>{const next=await change(structuredClone(records.get(command.nutritionDate)??null),actor);validateRecordData(next);records.set(command.nutritionDate,next);return structuredClone(next);}};
  const diary=createPilotDiary({store,resolveFood:catalog.resolve,listSharedFoods:catalog.list,newId:randomUUID,now:()=>new Date().toISOString()});
  const saves=[];
  const model={read:(t,d)=>diary.read('token',t,d),foods:t=>diary.foods('token',t),save:c=>{saves.push(structuredClone(c));return diary.save('token',c);},createFood:async()=>{throw new Error('PERSONAL_FOODS_DISABLED');}};
  return {model,saves,records,catalog};
}
function panelStub(doc){const p={root:doc.createElement('div'),opened:0,closed:0,open(){p.opened++;},close(){p.closed++;}};return p;}
async function mounted({model,macros={read:async()=>goal},lang=es,onChanged}={}){
  const doc=fakeDocument(),container=doc.createElement('div'),panel=panelStub(doc),changed=[];
  const ui=Diary.mount(container,{model,macros,panel,i18n:lang,document:doc,newId:randomUUID,onChanged:onChanged??((t,d)=>changed.push(d))});
  await ui.show(target,date);
  return {doc,container,panel,ui,changed};
}
const mealCards=c=>byClass(c,'tg-meal');
const cardOf=(c,re)=>mealCards(c).find(card=>re.test(find(card,x=>x.tagName==='h2')[0].textContent));

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function authDiaryPage(){
  const vm=require('node:vm'),fs=require('node:fs'),doc=fakeDocument(),els={},handlers={};
  const element=id=>els[id]??=doc.createElement('div');
  Object.assign(doc,{hidden:false,body:{dataset:{role:'CLIENT'}},getElementById:element,querySelectorAll:()=>[],addEventListener(k,f){handlers[k]=f;}});
  let user='user-a',targets=[target],verify=async()=>({status:'AUTHORIZED'}),list=async()=>targets;
  const day=kcal=>({status:'OPEN',entries:[],totals:{kcal,proteinG:0,carbsG:0,fatG:0}});
  let read=async()=>day(100);
  const client={auth:{getSession:async()=>({data:{session:{user:{id:user}}}}),onAuthStateChange(f){handlers.auth=f;}}};
  const context={document:doc,window:{addEventListener(k,f){handlers[k]=f;}},location:{pathname:'/index.html',origin:'https://pilot.example.com',search:'',hash:''},
    history:{replaceState(){}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},URLSearchParams,
    fetch:async()=>({json:async()=>({publicKey:'synthetic',diaryAvailable:true})}),supabase:{},
    PilotAuth:{createClient:()=>client,controller:()=>({verify:()=>verify(),invalidate(){},logout:async()=>({status:'SIGNED_OUT'})})},
    PilotMacrosService:{createModel:()=>({list:()=>list(),read:async()=>goal})},PilotMacrosUI:{mount:()=>({refresh(){},clear(){},revalidate(){}})},
    PilotDiaryService:{createModel:()=>({invalidate(){},read:()=>read(),foods:async()=>[]})},
    PilotDiaryUI:{mount:(container,options)=>Diary.mount(container,{...options,document:doc,i18n:es})},setInterval(){},setTimeout(fn){fn();}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../../nutrika/pilot-auth-ui.js'),'utf8'),context);await tick();
  return {els,handlers,doc,day,setUser:v=>{user=v;},setTargets:v=>{targets=v;},setVerify:v=>{verify=v;},setList:v=>{list=v;},setRead:v=>{read=v;}};
}
for(const trigger of ['focus','visibilitychange','TOKEN_REFRESHED'])test(`diary stays visible and blocked through permission and data refresh: ${trigger}`,async()=>{
  const p=await authDiaryPage(),root=p.els['diary-root'],old=[...root.children],auth=deferred(),clients=deferred(),data=deferred();
  p.setVerify(()=>auth.promise);p.setList(()=>clients.promise);p.setRead(()=>data.promise);
  if(trigger==='TOKEN_REFRESHED')p.handlers.auth(trigger);else p.handlers[trigger]();
  assert.deepEqual(root.children,old);assert.equal(p.els['pilot-access'].inert,true);
  auth.resolve({status:'AUTHORIZED'});await tick();
  assert.deepEqual(root.children,old);assert.equal(p.els['pilot-access'].hidden,false);assert.equal(p.els['pilot-access'].inert,true);
  clients.resolve([target]);await tick();assert.deepEqual(root.children,old);assert.equal(root.inert,true);
  data.resolve(p.day(250));await tick();
  assert.notEqual(root.children[0],old[0]);assert.match(root.textContent,/250/);assert.equal(root.inert,false);assert.equal(p.els['pilot-access'].inert,false);
});
for(const failure of ['logout','other-user','other-client','no-client','denied','data-error'])test(`diary clears and rejects stale data on ${failure}`,async()=>{
  const p=await authDiaryPage(),root=p.els['diary-root'],data=deferred();p.setRead(()=>data.promise);
  if(failure==='other-client')p.setTargets([{gymId:'g',clientId:'other'}]);
  if(failure==='no-client')p.setTargets([]);
  if(failure==='denied')p.setVerify(async()=>({status:'ROLE_REQUIRED'}));
  p.handlers.focus();await tick();
  if(failure==='logout')p.handlers.auth('SIGNED_OUT');
  if(failure==='other-user'){p.setUser('user-b');p.handlers.auth('SIGNED_IN',{user:{id:'user-b'}});}
  if(failure==='data-error')data.reject(new Error('denied'));else data.resolve(p.day(999));
  await tick();assert.equal(root.children.length,0);assert.equal(root.inert,true);assert.equal(p.els['pilot-access'].hidden,true);assert.equal(p.els['pilot-access'].inert,true);
});
test('older diary refresh cannot overwrite a newer refresh',async()=>{
  const p=await authDiaryPage(),first=deferred();p.setRead(()=>first.promise);p.handlers.focus();await tick();
  p.setRead(async()=>p.day(300));p.handlers.focus();await tick();
  first.resolve(p.day(999));await tick();assert.match(p.els['diary-root'].textContent,/300/);assert.doesNotMatch(p.els['diary-root'].textContent,/999/);
});
test('session change without an auth event is rejected before displaying downloaded data',async()=>{
  const p=await authDiaryPage(),data=deferred();p.setRead(()=>data.promise);p.handlers.focus();await tick();
  p.setUser('user-b');data.resolve(p.day(999));await tick();
  assert.equal(p.els['diary-root'].children.length,0);assert.equal(p.els['pilot-access'].hidden,true);
});
test('data finishing in a hidden tab keeps access blocked until the next verification',async()=>{
  const p=await authDiaryPage(),data=deferred();p.setRead(()=>data.promise);p.handlers.focus();await tick();
  p.doc.hidden=true;p.handlers.visibilitychange();data.resolve(p.day(200));await tick();
  assert.match(p.els['diary-root'].textContent,/200/);assert.equal(p.els['pilot-access'].inert,true);
  p.doc.hidden=false;p.setRead(async()=>p.day(300));p.handlers.visibilitychange();await tick();
  assert.match(p.els['diary-root'].textContent,/300/);assert.equal(p.els['pilot-access'].inert,false);
});
test('preserved refresh keeps selected date and clears on identity validation failure',async()=>{
  const dates=[],model={read:async(_t,d)=>{dates.push(d);return {status:'OPEN',entries:[],totals:{}};},foods:async()=>[]};
  const p=await mounted({model});await p.ui.show(target,'2026-11-01');
  await p.ui.show(target,date,{preserve:true,validate:async()=>true});assert.equal(dates.at(-1),'2026-11-01');
  await assert.rejects(p.ui.show(target,date,{preserve:true,validate:async()=>false}));assert.equal(mealCards(p.container).length,0);assert.equal(p.container.inert,true);
});

test('el backend ya guarda el tipo de comida: ADD con mealType se conserva y vuelve en la lectura',async()=>{
  const {model,records,catalog}=realService();
  const food=catalog.list().find(f=>f.weighingBasis!=='UNWEIGHED');
  await model.save({...target,nutritionDate:date,operationId:'op-1',baseRevision:0,type:'ADD',foodId:food.foodId,mealId:'dinner',mealType:'DINNER',
    amount:{kind:'MEASURED',quantity:food.referenceQuantity,unit:food.referenceUnit,preparationState:food.preparationState,weighingBasis:food.weighingBasis}});
  const day=await model.read(target,date);
  assert.equal(day.entries[0].mealId,'dinner');assert.equal(day.entries[0].mealType,'DINNER');
  assert.equal(records.get(date).entries[0].mealType,'DINNER');
});

test('Alimentación: resumen, cuatro tarjetas con subtotales y comidas anteriores sin reasignar',async()=>{
  const {model,catalog}=realService();
  const [a,b]=catalog.list().filter(f=>f.weighingBasis!=='UNWEIGHED');
  const amount=f=>({kind:'MEASURED',quantity:f.referenceQuantity,unit:f.referenceUnit,preparationState:f.preparationState,weighingBasis:f.weighingBasis});
  await model.save({...target,nutritionDate:date,operationId:'1',baseRevision:0,type:'ADD',foodId:a.foodId,mealId:'breakfast',mealType:'BREAKFAST',amount:amount(a)});
  await model.save({...target,nutritionDate:date,operationId:'2',baseRevision:1,type:'ADD',foodId:b.foodId,mealId:'daily',mealType:'MEAL',amount:amount(b)});
  const {container}=await mounted({model});
  const titles=mealCards(container).map(c=>find(c,x=>x.tagName==='h2')[0].textContent);
  assert.deepEqual(titles,['Desayuno','Comida','Cena','Snacks','Sin comida asignada']);
  const breakfast=cardOf(container,/Desayuno/);
  assert.match(breakfast.textContent,new RegExp(a.displayName.replace(/[()]/g,'.')));
  assert.match(breakfast.textContent,new RegExp(Math.round(a.kcal)+' kcal'));
  assert.match(cardOf(container,/Cena/).textContent,/Sin alimentos registrados/);
  assert.equal(byText(container,'button',/\+ Agregar alimento/).length,4); // no se agrega a "Sin comida asignada"
  const summary=byClass(container,'tg-food-summary')[0].textContent;
  const total=Math.round(a.kcal+b.kcal);
  assert.match(summary,/Consumido/);assert.match(summary,new RegExp('Restan '+(2000-total).toLocaleString('es-MX')+' kcal'));
  assert.match(summary,/Proteína/);assert.match(summary,/\/ 120 g/);
});

test('agregar desde una tarjeta: panel independiente, búsqueda, cantidad y mealType de la comida elegida',async()=>{
  const {model,saves,catalog}=realService();
  const {container,panel,changed}=await mounted({model});
  byText(cardOf(container,/^Comida/),'button',/Agregar alimento/)[0].click();
  assert.equal(panel.opened,1);assert.match(find(panel.root,x=>x.tagName==='h2')[0].textContent,/Agregar a Comida/);
  const search=find(panel.root,x=>x.type==='search')[0];
  search.value='pollo';await search.fire('input');
  const results=byClass(panel.root,'tg-result');assert.ok(results.length>=1);
  assert.ok(results.every(r=>/pollo/i.test(r.textContent)));
  results[0].click();
  const food=catalog.list().find(f=>/pollo/i.test(f.displayName));
  const qty=find(panel.root,x=>x.type==='number')[0];assert.equal(qty.value,String(food.referenceQuantity));
  // cambiar de comida dentro del panel
  byText(panel.root,'button',/^Cena$/)[0].click();
  assert.match(find(panel.root,x=>x.tagName==='h2')[0].textContent,/Agregar a Cena/);
  qty.value='150';await find(panel.root,x=>x.tagName==='form')[0].fire('submit');await tick();
  assert.equal(saves.length,1);
  assert.deepEqual({type:saves[0].type,mealId:saves[0].mealId,mealType:saves[0].mealType,baseRevision:saves[0].baseRevision,quantity:saves[0].amount.quantity,unit:saves[0].amount.unit},
    {type:'ADD',mealId:'dinner',mealType:'DINNER',baseRevision:0,quantity:150,unit:food.referenceUnit});
  assert.ok(panel.closed>=1);assert.deepEqual(changed,[date]);
  assert.match(cardOf(container,/Cena/).textContent,/pollo/i);
  assert.doesNotMatch(cardOf(container,/^Comida/).textContent,/pollo/i);
});

test('validación local: cantidad inválida no envía nada; un fallo del servidor no simula el guardado',async()=>{
  const {model,saves}=realService();
  const failing={...model,save:async c=>{saves.push(c);throw new Error('DIARY_RESULT_UNKNOWN');}};
  const {container,panel,changed}=await mounted({model:failing});
  byText(cardOf(container,/Desayuno/),'button',/Agregar alimento/)[0].click();
  byClass(panel.root,'tg-result')[0].click();
  const qty=find(panel.root,x=>x.type==='number')[0],form=find(panel.root,x=>x.tagName==='form')[0];
  qty.value='0';await form.fire('submit');
  assert.equal(saves.length,0);assert.match(panel.root.textContent,/Revisa alimento y cantidad/);
  qty.value='80';await form.fire('submit');await tick();
  assert.equal(saves.length,1);assert.match(panel.root.textContent,/No se confirmó el registro/);
  assert.deepEqual(changed,[]);assert.match(cardOf(container,/Desayuno/).textContent,/Sin alimentos registrados/);
});

test('editar cantidad y eliminar desde la tarjeta usan REPLACE y REMOVE existentes',async()=>{
  const {model,saves,catalog}=realService();
  const food=catalog.list().find(f=>f.weighingBasis!=='UNWEIGHED');
  await model.save({...target,nutritionDate:date,operationId:'seed',baseRevision:0,type:'ADD',foodId:food.foodId,mealId:'snacks',mealType:'SNACK',
    amount:{kind:'MEASURED',quantity:food.referenceQuantity,unit:food.referenceUnit,preparationState:food.preparationState,weighingBasis:food.weighingBasis}});
  saves.length=0;
  const {container,panel}=await mounted({model});
  byClass(cardOf(container,/Snacks/),'tg-entry')[0].click();
  assert.equal(panel.opened,1);
  const qty=find(panel.root,x=>x.type==='number')[0];qty.value='-1';
  await find(panel.root,x=>x.tagName==='form')[0].fire('submit');assert.equal(saves.length,0);assert.match(panel.root.textContent,/cantidad positiva/);
  qty.value=String(food.referenceQuantity*2);await find(panel.root,x=>x.tagName==='form')[0].fire('submit');await tick();
  assert.equal(saves[0].type,'REPLACE');assert.equal(saves[0].amount.quantity,food.referenceQuantity*2);
  const after=await model.read(target,date);assert.equal(after.entries[0].mealType,'SNACK'); // la comida se conserva al editar
  assert.match(cardOf(container,/Snacks/).textContent,new RegExp(Math.round(food.kcal*2)+' kcal'));
  byClass(cardOf(container,/Snacks/),'tg-entry')[0].click();
  byText(panel.root,'button',/Eliminar alimento/)[0].click();await tick();await tick();
  assert.equal(saves[1].type,'REMOVE');assert.equal((await model.read(target,date)).entries.length,0);
  assert.match(cardOf(container,/Snacks/).textContent,/Sin alimentos registrados/);
});

test('día cerrado: sin agregar ni editar; reabrir y cerrar en cero conservan sus reglas',async()=>{
  const {model,saves}=realService();
  const {container}=await mounted({model});
  const closeBtn=()=>byText(container,'button',/^Cerrar día$/)[0];
  closeBtn().click();await tick();
  assert.equal(saves.length,0);assert.match(byClass(container,'tg-day-close')[0].textContent,/realmente cero/);
  find(container,x=>x.type==='checkbox')[0].checked=true;closeBtn().click();await tick();await tick();
  assert.deepEqual([saves[0].type,saves[0].confirmZero],['COMPLETE',true]);
  assert.equal(byText(container,'button',/Agregar alimento/).length,0);
  assert.match(container.textContent,/Día cerrado/);
  byText(container,'button',/Reabrir día/)[0].click();await tick();await tick();
  assert.equal(saves[1].type,'REOPEN');assert.equal(byText(container,'button',/Agregar alimento/).length,4);
});

test('sin macros del coach: solo consumido y aviso; en inglés cambian los textos del diario',async()=>{
  const {model}=realService();
  const {container}=await mounted({model,macros:{read:async()=>{throw new Error('NO_ACCESS');}}});
  assert.match(byClass(container,'tg-food-summary')[0].textContent,/todavía no ha asignado/);
  assert.doesNotMatch(container.textContent,/Restan/);
  const english=(await mounted({model,lang:en})).container;
  assert.deepEqual(mealCards(english).map(c=>find(c,x=>x.tagName==='h2')[0].textContent),['Breakfast','Lunch','Dinner','Snacks']);
  assert.match(english.textContent,/2,000 kcal left/);
});

test('un error de acceso no deja datos visibles',async()=>{
  const {container}=await mounted({model:{read:async()=>{throw new Error('AUTH_REQUIRED');},foods:async()=>[]}});
  assert.match(container.textContent,/No se pudo verificar el acceso/);assert.equal(mealCards(container).length,0);
});
