'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const UI=require('../../nutrika/pilot-tracking-ui.js');
const {recordHabits}=require('../../nutrika/domain/tracking/observations.cjs');
const {validateRecordData}=require('../../nutrika/domain/tracking/record-validation.cjs');
const meta={recordId:'r1',clientId:'c',actorId:'a',nutritionDate:'2026-11-16',at:'2026-11-16T12:00:00Z'};
function document(){return {createElement:tag=>({tag,children:[],attrs:{},events:{},value:'',checked:false,disabled:false,_text:'',
  set textContent(v){this._text=String(v);this.children=[];},get textContent(){return this._text+this.children.map(n=>n.textContent).join(' ');},
  append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;this._text='';},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;}})};}
function find(n,p){return [n,...n.children.flatMap(c=>find(c,()=>true))].filter(p);}
const tick=()=>new Promise(r=>setImmediate(r));
async function page(training){
  const doc=document(),container=doc.createElement('div');let saved=training===undefined?null:recordHabits(null,meta,{training});const commands=[];
  const model={history:async()=>({days:[{habits:saved}]}),save:async c=>{commands.push(c);saved=recordHabits(saved,{...meta,recordId:'r'+(commands.length+1)},c.values);}};
  const ui=UI.mount(container,{model,document:doc,newId:()=>String(commands.length)});await ui.show({gymId:'g',clientId:'c'},meta.nutritionDate);
  const check=(label,value=true)=>{const n=find(container,n=>n.attrs['aria-label']===label)[0];n.checked=value;n.events.change();};
  return {container,ui,commands,check,get saved(){return saved;},submit:()=>find(container,n=>n.tag==='form')[0].events.submit({preventDefault(){}})};
}
test('multiple activities save alone, reload, exclude No entrené, and request no duration',async()=>{
  const p=await page();p.check('Fuerza');p.check('Cardio');await p.submit();
  assert.deepEqual(p.saved.values.trainingActivities,['STRENGTH','CARDIO']);assert.equal(p.saved.values.training,'STRENGTH');validateRecordData(p.saved);
  assert.equal(find(p.container,n=>n.attrs['aria-label']==='Cardio')[0].checked,true);
  p.check('No entrené');assert.equal(find(p.container,n=>n.attrs['aria-label']==='Fuerza')[0].checked,false);
  p.check('Movilidad/recuperación');assert.equal(find(p.container,n=>n.attrs['aria-label']==='No entrené')[0].checked,false);
  await p.submit();assert.deepEqual(p.saved.values.trainingActivities,['MOBILITY_RECOVERY']);
  p.check('No entrené');await p.submit();assert.deepEqual(p.saved.values.trainingActivities,['NONE']);
  assert.doesNotMatch(p.container.textContent,/minutos|duración/);assert.equal(find(p.container,n=>n.tag==='select').length,0);
});
for(const old of [null,'STRENGTH','NO_STRENGTH'])test(`historical ${old} is preserved when saving another habit`,async()=>{
  const p=await page(old);p.check('Cumplí steps');await p.submit();
  assert.equal(p.saved.values.training,old);assert.equal(Object.hasOwn(p.saved.values,'trainingActivities'),false);
  if(old==='NO_STRENGTH'){assert.match(p.container.textContent,/otras actividades no especificadas/);assert.equal(find(p.container,n=>n.attrs['aria-label']==='No entrené')[0].checked,false);}
});
test('domain rejects incompatible/unknown activities and preserves revisions',()=>{
  const old=recordHabits(null,meta,{training:'NO_STRENGTH'});
  for(const trainingActivities of [['NONE','CARDIO'],['CARDIO','CARDIO'],['UNKNOWN'],'CARDIO',null])assert.throws(()=>recordHabits(old,{...meta,recordId:'r2'},{trainingActivities}));
  const next=recordHabits(old,{...meta,recordId:'r2'},{trainingActivities:['CARDIO','SPORTS','HIIT_FUNCTIONAL','OTHER']});
  assert.equal(old.values.training,'NO_STRENGTH');assert.equal(Object.hasOwn(old.values,'trainingActivities'),false);validateRecordData(next);
  assert.equal(next.previousRecordId,'r1');assert.equal(next.revision,2);
  const cleared=recordHabits(next,{...meta,recordId:'r3'},{trainingActivities:[]});assert.equal(cleared.values.training,null);
  const olderClient=recordHabits(next,{...meta,recordId:'r3'},{steps:100,training:'NO_STRENGTH'});assert.deepEqual(olderClient.values.trainingActivities,next.values.trainingActivities);
  const changedLegacy=recordHabits(next,{...meta,recordId:'r3'},{training:'STRENGTH'});assert.equal(Object.hasOwn(changedLegacy.values,'trainingActivities'),false);validateRecordData(changedLegacy);
});
test('weekly summary displays activities without changing historical completion interpretation',async()=>{
  const doc=document(),container=doc.createElement('div');
  const old=recordHabits(null,meta,{training:'NO_STRENGTH'}),multi=recordHabits(null,{...meta,recordId:'r2',nutritionDate:'2026-11-17'},{trainingActivities:['HIIT_FUNCTIONAL','OTHER']});
  const ui=UI.mount(container,{document:doc,model:{history:async()=>({days:[{date:'2026-11-16',habits:{...old,completion:{training:false}}},{date:'2026-11-17',habits:{...multi,completion:{training:true}}}]})}});
  await ui.weekly({gymId:'g',clientId:'c'},'2026-11-16',{read:async()=>null});
  assert.match(container.textContent,/HIIT\/funcional, Otro/);assert.match(container.textContent,/otras actividades no especificadas/);assert.match(container.textContent,/training 1\/1\/0/);
});
test('loading appears immediately; slow macros do not block the form; stale enrichment is discarded',async()=>{
  const doc=document(),container=doc.createElement('div');let historyDone,macrosDone;
  const ui=UI.mount(container,{document:doc,model:{history:()=>new Promise(r=>{historyDone=r;})}});
  const pending=ui.show({gymId:'g',clientId:'c'},meta.nutritionDate,{read:()=>new Promise(r=>{macrosDone=r;})});
  assert.match(container.textContent,/Cargando peso y hábitos/);assert.equal(find(container,n=>n.tag==='form').length,0);
  historyDone({days:[{intake:{status:'PARTIAL',totals:{kcal:100}}}]});await pending;
  assert.equal(find(container,n=>n.tag==='form').length,1);
  ui.clear();macrosDone({macros:{kcal:2000}});await tick();assert.equal(container.children.length,0);
});
test('history failure never exposes an editable form and logout discards pending history',async()=>{
  const doc=document(),container=doc.createElement('div');let finish;
  const ui=UI.mount(container,{document:doc,model:{history:()=>new Promise(r=>{finish=r;})}});
  const pending=ui.show({gymId:'g',clientId:'c'},meta.nutritionDate);ui.clear();finish({days:[{}]});await pending;assert.equal(container.children.length,0);
  const denied=UI.mount(container,{document:doc,model:{history:async()=>{throw Error('denied');}}});await denied.show({},meta.nutritionDate);
  assert.match(container.textContent,/No se pudo verificar/);assert.equal(find(container,n=>n.tag==='form').length,0);
});
