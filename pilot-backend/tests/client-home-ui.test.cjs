'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const Home=require('../../nutrika/pilot-client-home-ui.js');
const i18n=require('../../nutrika/pilot-client-i18n.js');
const domain=require('../../nutrika/domain/tracking/adherence.cjs');
const {createPilotServer}=require('../server/pilot-http.cjs');

// DOM mínimo: solo lo que usan las interfaces del piloto.
function fakeDocument(){
  const make=tag=>{const n={tagName:tag,children:[],attributes:{},style:{},className:'',_text:'',listeners:{},disabled:false,
    get textContent(){return this._text+this.children.map(c=>c.textContent).join(' ');},set textContent(v){this._text=String(v);this.children=[];},
    append(...c){this.children.push(...c);},replaceChildren(...c){this.children=[...c];this._text='';},setAttribute(k,v){this.attributes[k]=String(v);},
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);},click(){for(const f of this.listeners.click??[])f();}};return n;};
  return {createElement:make,createElementNS:(_ns,tag)=>make(tag),getElementById:()=>null};
}
const find=(n,pred,out=[])=>{if(pred(n))out.push(n);for(const c of n.children??[])find(c,pred,out);return out;};
const addDays=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const goal={kcal:2000,proteinG:120,carbsG:245,fatG:60};
const complete=f=>({status:'COMPLETE',totals:{kcal:2000*f,proteinG:120*f,carbsG:245*f,fatG:60*f}});
const es={t:(k,v)=>i18n.t(k,v,'es'),locale:()=>'es-MX'};
const slotsFor=doc=>({today:doc.createElement('div'),food:doc.createElement('div'),progress:doc.createElement('div'),plan:doc.createElement('div')});

test('summarize usa las tolerancias existentes de adherencia y no cuenta días sin registro como incumplimiento',()=>{
  const today='2026-11-12';
  const days=Array.from({length:14},(_,i)=>({date:addDays(today,i-13)}));
  days[13].intake=complete(1);days[12].intake=complete(1.2);days[11].intake={status:'PARTIAL',totals:goal};
  days[13].weight={weightKg:80};days[12].weight={weightKg:81};days[2].weight={weightKg:83};
  days[13].habits={values:{},completion:{waterLiters:true,steps:false,sleepHours:null}};
  const s=Home.summarize(days,goal,domain);
  assert.equal(s.complete,2);assert.equal(s.adherent,1);
  assert.equal(s.weekAvgWeight,80.5);assert.equal(s.prevAvgWeight,83);assert.equal(s.latestWeight,80);assert.equal(s.firstWeight,83);
  assert.equal(s.habitDays,1);assert.equal(s.habitYes,1);assert.equal(s.habitAnswered,2);
  assert.equal(s.streak,3);
  assert.equal(Home.summarize(days,null,domain).adherent,0);
});

test('habitRates y macroProgress solo presentan datos (sin cambiar reglas)',()=>{
  const days=[{habits:{completion:{waterLiters:true,training:true}}},{habits:{completion:{waterLiters:true,training:false}}},{}];
  const r=Object.fromEntries(Home.habitRates(days).map(x=>[x.key,x]));
  assert.equal(r.waterLiters.pct,100);assert.equal(r.training.pct,50);assert.equal(r.training.total,2);
  assert.deepEqual(Home.rollingAverage([1,2,3,4],2),[1,1.5,2.5,3.5]);
  const m=Object.fromEntries(Home.macroProgress(goal,{kcal:1000,proteinG:150,carbsG:0,fatG:30}).map(x=>[x.key,x]));
  assert.equal(m.kcal.pct,50);assert.equal(m.proteinG.pct,100);assert.equal(m.proteinG.over,true);assert.equal(m.carbsG.pct,0);
  assert.equal(Home.macroProgress(goal,null)[0].consumed,null);
});

test('Hoy, Alimentación, Progreso y Mi plan con datos reales del endpoint, sin escribir',async()=>{
  const doc=fakeDocument(),today='2026-11-12',calls=[],navigations=[],shown=[];
  const model={history:async(t,from,to)=>{calls.push([from,to]);const days=[];for(let d=from;;d=addDays(d,1)){days.push({date:d,weight:d===to?null:{weightKg:80},habits:null,intake:d===to?{status:'PARTIAL',totals:{kcal:500,proteinG:30,carbsG:60,fatG:10}}:complete(1)});if(d===to)break;}return {days};},
    save:async()=>{throw new Error('la experiencia del cliente no debe escribir');}};
  const macros={read:async()=>({macros:goal,revision:3,effectiveFrom:'2026-10-01T12:00:00Z'})};
  const log={show:(t,date)=>shown.push(date)};
  const slots=slotsFor(doc);
  const ui=Home.mount(slots,{model,macros,log,TrackingUI:null,domain,i18n:es,document:doc,diaryAvailable:true,navigate:o=>navigations.push(o),now:()=>new Date('2026-11-12T09:00:00')});
  await ui.show({gymId:'g',clientId:'c',label:'Gimnasio A'},today);
  assert.deepEqual(calls,[[addDays(today,-29),today]]); // ≤31 días, límite del endpoint
  const todayText=slots.today.textContent;
  assert.match(todayText,/Buenos días/);assert.match(todayText,/1,500/); // 2000 − 500 kcal restantes
  assert.match(todayText,/Prescrito por tu coach/);assert.match(todayText,/Meta/);assert.match(todayText,/Pendiente/);
  assert.match(todayText,/0 de 3 registros completos/);
  // acciones rápidas: comida → pestaña Alimentación; peso → hoja de registro con el día de hoy
  const actions=find(slots.today,n=>n.className==='tg-action');assert.equal(actions.length,3);
  actions[0].click();actions[1].click();
  assert.deepEqual(navigations,[{tab:'food'},{log:true,focus:'weight'}]);assert.deepEqual(shown,[today]);
  assert.equal(slots.food.children.length,0); // con diario conectado, el resumen lo dibuja PilotDiaryUI
  const titles=find(slots.progress,n=>n.tagName==='h2').map(n=>n.textContent);
  assert.deepEqual(titles,['Tu semana','Tendencia de peso','Hábitos cumplidos','Historial']);
  assert.match(slots.progress.textContent,/6\/7/);
  assert.equal(find(slots.progress,n=>n.tagName==='polyline').length,2);
  assert.equal(find(slots.progress,n=>n.className==='tg-history-row').length,14);
  assert.match(slots.plan.textContent,/2,000/);assert.match(slots.plan.textContent,/Gimnasio A/);assert.match(slots.plan.textContent,/Pendiente de conexión/);
  ui.clear();for(const s of Object.values(slots))assert.equal(s.children.length,0);
});

test('sin seguimiento ni diario conectados: estados pendientes y ninguna acción simulada',async()=>{
  const doc=fakeDocument(),slots=slotsFor(doc),navigations=[];
  const ui=Home.mount(slots,{model:null,macros:{read:async()=>null},TrackingUI:null,domain,i18n:es,document:doc,diaryAvailable:false,navigate:o=>navigations.push(o)});
  await ui.show({gymId:'g',clientId:'c'},'2026-11-12');
  assert.match(slots.today.textContent,/todavía no ha asignado/);assert.match(slots.today.textContent,/no está conectado/);
  const actions=find(slots.today,n=>n.className==='tg-action');assert.ok(actions.every(a=>a.disabled));
  actions.forEach(a=>a.click());assert.deepEqual(navigations,[]);
  assert.match(slots.food.textContent,/no está habilitado/);assert.match(slots.progress.textContent,/cuando el seguimiento esté conectado/);
  assert.equal(find(slots.progress,n=>n.tagName==='polyline').length,0);
});

test('un error de acceso no deja datos visibles',async()=>{
  const doc=fakeDocument(),slots=slotsFor(doc);
  const ui=Home.mount(slots,{model:{history:async()=>{throw new Error('TRACKING_UNAVAILABLE');}},macros:null,TrackingUI:null,domain,i18n:es,document:doc});
  await ui.show({gymId:'g',clientId:'c'},'2026-11-12');
  assert.match(slots.today.textContent,/No se pudo cargar/);for(const k of ['food','progress','plan'])assert.equal(slots[k].children.length,0);
});

test('textos: inglés disponible para el shell y las pantallas, con aviso de traducción parcial',()=>{
  const es=Object.keys(i18n.STRINGS.es),en=Object.keys(i18n.STRINGS.en);
  assert.deepEqual(en.filter(k=>!es.includes(k)),[]);assert.deepEqual(es.filter(k=>!en.includes(k)),[]);
  assert.equal(i18n.t('nav.plan',{},'en'),'My plan');assert.match(i18n.t('shell.partial',{},'en'),/partial/);
  assert.equal(i18n.t('tasks.count',{n:1,total:3},'es'),'1 de 3 registros completos');
});

function get(app,route){return new Promise((resolve,reject)=>{const port=app.server.address().port;
  http.get({host:'127.0.0.1',port,path:route,headers:{host:'127.0.0.1:'+port}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject);});}
async function withServer(options,fn){const app=createPilotServer({env:{},...options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));try{await fn(app);}finally{await new Promise(r=>app.server.close(r));}}

test('vista Cliente: marca Twogramms, cuatro secciones y los contenedores existentes conservan su id',async()=>{
  await withServer({trackingService:{}},async app=>{
    const page=(await get(app,'/index.html')).body;
    for(const id of ['auth-status','login-form','password-form','logout','pilot-access','home-today-root','home-food-root','home-progress-root','home-plan-root','tracking-root','macros-root','diary-root','log-dialog','food-dialog','food-sheet-root'])assert.ok(page.includes(`id="${id}"`),id);
    for(const tab of ['today','food','progress','plan'])assert.ok(page.includes(`data-tab="${tab}"`)&&page.includes(`data-panel="${tab}"`),tab);
    assert.ok(page.includes('twogramms'));assert.ok(!/Complex Training|logo\.jpg/.test(page));
    const at=s=>page.indexOf(s);
    assert.ok(at('/pilot-client-i18n.js')<at('/pilot-client-home-ui.js')&&at('/pilot-client-home-ui.js')<at('/pilot-client-shell.js')&&at('/pilot-client-shell.js')<at('/pilot-auth-ui.js'));
    assert.ok(at('/pilot-tracking-ui.js')<at('/pilot-auth-ui.js'));
    for(const s of ['/pilot-client-home-ui.js','/pilot-client-shell.js','/pilot-client-i18n.js'])assert.equal((await get(app,s)).status,200,s);
    assert.ok((await get(app,'/coach.html')).body.includes('Vista Coach')); // la vista Coach no cambia
  });
  await withServer({readOnly:true},async app=>{
    const page=(await get(app,'/index.html')).body;
    assert.ok(!page.includes('/pilot-tracking-ui.js'));assert.ok(page.includes('/pilot-client-home-ui.js'));assert.ok(page.includes('id="macros-root"'));
    assert.equal((await get(app,'/preview/client-home.html')).status,404);
    assert.equal((await get(app,'/pilot-client-home-demo.js')).status,404);
  });
  await withServer({},async app=>{assert.equal((await get(app,'/preview/client-home.html')).status,404);});
  await withServer({env:{PILOT_LOCAL_PREVIEW:'1'}},async app=>{
    const preview=await get(app,'/preview/client-home.html');
    assert.equal(preview.status,200);assert.match(preview.body,/DATOS SINTÉTICOS/);assert.ok(preview.body.includes('/pilot-client-home-demo.js'));
    assert.ok(!preview.body.includes('/vendor/supabase.js'));
    assert.equal((await get(app,'/pilot-client-home-demo.js')).status,200);
  });
});
