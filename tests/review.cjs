// Ejecutar con: node tests/review.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(file, names) {
  const html = fs.readFileSync(file, 'utf8');
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: '', innerHTML: '', textContent: '', style: {},
      classList: { add(){}, remove(){}, contains(){return false;} }, addEventListener(){}, querySelectorAll(){return [];},
      checkValidity(){return true;}, reportValidity(){return true;}, focus(){}, scrollIntoView(){} });
    return nodes.get(id);
  }
  for (const match of html.matchAll(/<input\b([^>]+)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    if(attrs.id) node(attrs.id).value = attrs.value || '';
  }
  node('sexo').value = 'm'; node('actividad').value = '1.55';
  const memory = new Map();
  const document = { getElementById: node, querySelectorAll(){return [];},
    querySelector(){return {value:'bajar_grasa'};}, addEventListener(){}, activeElement:null };
  const context = vm.createContext({ document, window:{}, console, Date, setTimeout, clearTimeout,
    localStorage:{getItem:k=>memory.get(k)||null, setItem:(k,v)=>memory.set(k,v)} });
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  const source = script.replace(/\}\)\(\);\s*$/, 'globalThis.api = {'+names.join(',')+'};\n})();');
  vm.runInContext(source, context, {filename:file});
  return {api:context.api, document, node, memory};
}

const app = load('nutrika/index.html', ['state','storageKey','saveLogEntries','loadLog','calcPlan','calcTargets','getCurrentWeekTarget','computeLogTotals','renderMacroResult','renderPlan','buildEngine','POSTRES','DESAYUNOS','PRINCIPALES','FOODS','loadLogFormForDate','renderLogSection','fillExtraFormFromProduct','resetAccountView','hydrateFromCloud','setSupabase: function(value){supabaseClient=value;}']);
const a = app.api;
a.saveLogEntries([{date:'2026-09-16',notas:'invitado'}]);
a.state.user = {id:'A'};
assert.equal(a.loadLog().length,0);
a.saveLogEntries([{date:'2026-09-16',notas:'A'}]);
a.state.user = {id:'B'};
assert.equal(a.loadLog().length,0);
a.state.user = {id:'A'};
assert.equal(a.loadLog()[0].notas,'A');
a.state.user = null;
assert.equal(a.loadLog()[0].notas,'invitado');
app.memory.set('ctMacroLog_v1','{}');
assert.equal(a.loadLog().length,0);

const meal = {title:'Comida original',kcal:410,p:30,c:50,f:10};
a.saveLogEntries([{date:'2026-09-15',meals:{comida:meal},extras:[]}]);
a.loadLogFormForDate('2026-09-15');
assert.match(app.node('logMeals').innerHTML,/Comida original/);
a.state.recipes.comida = [{id:'nuevo',title:'Otra receta',totals:{kcal:900,p:90,c:90,f:90}}];
a.state.selected.comida = 'nuevo';
app.document.querySelectorAll = selector => selector === '#logMeals input[type=checkbox]:checked' ? [{getAttribute(){return 'comida';}}] : [];
assert.equal(a.computeLogTotals().kcal,410);
assert.equal(a.computeLogTotals().meals.comida.title,'Comida original');
a.loadLogFormForDate('2026-09-16');
assert.equal(a.computeLogTotals().kcal,900);

const hostile = '<img src=x onerror=alert(1)>';
a.renderMacroResult({kcal:2000,p:120,c:200,f:60,text:hostile});
assert.ok(!app.node('strategyBox').innerHTML.includes(hostile));
a.renderPlan({phases:[{name:hostile,desc:hostile,weeks:1,kcal:2000}]},null,8,70);
assert.ok(!app.node('planPhases').innerHTML.includes(hostile));

// Un paso redondeado hacia abajo dejaba la última semana debajo de mantenimiento.
const plan = a.calcPlan({goal:'bajar_grasa',tdee:2001,kcal:1601,p:120},12,70);
assert.equal(plan.weeklyTimeline.at(-1).kcal,2001);
app.node('edad').checkValidity = ()=>false;
assert.equal(a.calcTargets(),null);
app.node('edad').checkValidity = ()=>true;
assert.ok(a.calcTargets().kcal > 0);

const coach = load('nutrika/coach.html',['buildWeeklyMacroSummary','state','renderClientList']);
coach.api.state.clients = [{id:'x',meta:hostile,email:'cliente',peso:70}];
coach.api.renderClientList();
assert.ok(!coach.node('clientListWrap').innerHTML.includes(hostile));
assert.match(coach.node('clientListWrap').innerHTML,/tabindex="0"/);
process.env.TZ = 'America/New_York';
const summary = coach.api.buildWeeklyMacroSummary([
  {date:'2026-03-09',kcal:100,p:10,c:10,f:1},
  {date:'2026-03-02',kcal:100,p:10,c:10,f:1}
],{startDate:'2026-03-02'});
assert.match(summary,/Semana 2/);
const calendar = coach.api.buildWeeklyMacroSummary([
  {date:'2026-09-14',kcal:1,p:1,c:1,f:1},
  {date:'2026-01-05',kcal:1,p:1,c:1,f:1}
],null);
assert.ok(calendar.indexOf('2026-01-05') < calendar.indexOf('2026-09-14'));

const strawberries = a.FOODS.filter(f=>f.key === 'fresas');
const chocolateRecipe = a.POSTRES.find(t=>t.id==='p6');
assert.equal(a.buildEngine(strawberries,'mantenimiento').buildRecipe(chocolateRecipe),null);
const ingredients = strawberries.concat(a.FOODS.filter(f=>f.key==='chocolateoscuro'));
const dessert = a.buildEngine(ingredients,'mantenimiento').buildRecipe(chocolateRecipe);
assert.ok(dessert.ingredients.some(i=>i.includes('chocolate')));
assert.ok(dessert.totals.kcal > 32);

// Todas las plantillas deben poder construirse sin excepciones ni macros no finitos.
for(const recipe of [...a.POSTRES, ...a.DESAYUNOS, ...a.PRINCIPALES]){
  const result = a.buildEngine(a.FOODS,'mantenimiento').buildRecipe(recipe);
  assert.ok(result,recipe.id);
  for(const value of Object.values(result.totals)) assert.ok(Number.isFinite(value));
}
a.fillExtraFormFromProduct({nutriments:{'energy-kj_100g':418.4}},'123');
assert.equal(app.node('extraKcal').value,100);

// Las respuestas pendientes de otra cuenta o anteriores a un guardado se descartan.
const pending = {};
a.setSupabase({from(table){return {select(){return this;},eq(){return this;},maybeSingle(){return this;},order(){return this;},then(callback){pending[table]=callback;}};}});
app.document.querySelectorAll = ()=>[];
a.state.user = {id:'A'};
a.hydrateFromCloud();
a.state.user = {id:'B'};
a.resetAccountView();
pending.daily_logs({data:[{log_date:'2026-09-10',notas:'secreto A'}]});
assert.equal(a.loadLog().length,0);
a.hydrateFromCloud();
a.saveLogEntries([{date:'2026-09-11',notas:'cambio nuevo'}]);
pending.daily_logs({data:[]});
assert.equal(a.loadLog()[0].notas,'cambio nuevo');

console.log('Pruebas de regresión correctas: cuentas, registros, XSS, validación, semanas y recetas.');
