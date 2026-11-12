(function(root){
  'use strict';
  // Experiencia del cliente Twogramms (Hoy · Alimentación · Progreso · Mi plan).
  // Solo compone piezas y datos existentes; nunca escribe ni inventa datos:
  //  - model:      PilotTrackingService (GET /api/tracking/history) o null si no está conectado
  //  - macros:     PilotMacrosService (prescripción vigente del coach, solo lectura)
  //  - log:        instancia de PilotTrackingUI (registro de peso y hábitos existente)
  //  - TrackingUI: PilotTrackingUI, reutilizada para el resumen semanal detallado
  //  - domain:     PilotTrackingDomain.dailyAdherence (tolerancias existentes, sin cambios)
  //  - navigate:   callback del shell para cambiar de pestaña o abrir el registro
  // La gráfica de tendencia y las barras de hábitos son la lógica de Nutrika
  // (buildTrendChart / buildHabitBars / rollingAverage) trasladada a nodos DOM.
  const SVG_NS='http://www.w3.org/2000/svg';
  const HABITS=['waterLiters','steps','sleepHours','sleepQuality','stress','training'];
  const MACROS=[['proteinG','macro.protein','protein'],['carbsG','macro.carbs','carbs'],['fatG','macro.fat','fat']];
  const HISTORY_DAYS=30; // El endpoint acepta como máximo 31 días por consulta.
  const fallbackI18n={t:(k,v={})=>String(k).replace(/\{(\w+)\}/g,(_,x)=>v[x]??''),locale:()=>'es-MX'};

  function addDays(date,days){const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
  function rollingAverage(vals,window){return vals.map((_,i)=>{const s=vals.slice(Math.max(0,i-window+1),i+1);return s.reduce((a,b)=>a+b,0)/s.length;});}
  function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;}
  function hasValue(v){return v!==null&&v!==undefined;}
  function hasAnyRecord(d){return Boolean(d.weight||d.habits||d.intake);}
  function marked(d){return d.habits?HABITS.filter(k=>d.habits.completion?.[k]===true).length:0;}

  // Resúmenes puros (exportados para pruebas).
  function summarize(days,goal,domain){
    const last7=days.slice(-7),prev7=days.slice(-14,-7);
    let complete=0,adherent=0;
    for(const d of last7){if(d.intake?.status==='COMPLETE'&&d.intake.totals){complete++;if(goal&&domain.dailyAdherence(d.intake,goal).status==='ADHERENT')adherent++;}}
    const w7=mean(last7.filter(d=>d.weight).map(d=>d.weight.weightKg)),wPrev=mean(prev7.filter(d=>d.weight).map(d=>d.weight.weightKg));
    const weights=days.filter(d=>d.weight);
    const habitDays=last7.filter(d=>d.habits);
    let yes=0,answered=0;for(const d of habitDays)for(const k of HABITS){const m=d.habits.completion?.[k];if(m===true||m===false){answered++;if(m)yes++;}}
    let streak=0;const ordered=[...days].reverse();const startAt=ordered[0]&&!hasAnyRecord(ordered[0])?1:0;
    for(const d of ordered.slice(startAt)){if(hasAnyRecord(d))streak++;else break;}
    return {complete,adherent,hasGoal:Boolean(goal),weekAvgWeight:w7,prevAvgWeight:wPrev,latestWeight:weights.at(-1)?.weight.weightKg??null,
      firstWeight:weights[0]?.weight.weightKg??null,firstWeightDate:weights[0]?.date??null,
      weightCount:weights.length,habitDays:habitDays.length,habitYes:yes,habitAnswered:answered,streak};
  }
  function habitRates(days){
    const withHabits=days.filter(d=>d.habits);
    return HABITS.map(k=>{const yes=withHabits.filter(d=>d.habits.completion?.[k]===true).length;return {key:k,yes,total:withHabits.length,pct:withHabits.length?Math.round(yes/withHabits.length*100):0};});
  }
  // Consumo frente a prescripción, sin redondeos que cambien las reglas: solo presentación.
  function macroProgress(goal,totals){
    return [['kcal','macro.kcal','kcal'],...MACROS].map(([key,label,tone])=>{
      const target=goal?.[key]??null,consumed=totals?.[key]??null;
      const pct=hasValue(target)&&target>0&&hasValue(consumed)?Math.min(100,Math.round(consumed/target*100)):0;
      return {key,label,tone,target,consumed,pct,over:hasValue(target)&&hasValue(consumed)&&consumed>target};
    });
  }

  function mount(slots,{model=null,macros=null,log=null,TrackingUI=root.PilotTrackingUI,domain=root.PilotTrackingDomain,i18n=root.PilotClientI18n??fallbackI18n,
    document:doc=root.document,diaryAvailable=false,navigate=null,now=()=>new Date()}){
    let epoch=0,current=null,weeklyUI=null;
    const t=(k,v)=>i18n.t(k,v);
    const fmt=(n,d=1)=>Number(n).toLocaleString(i18n.locale(),{minimumFractionDigits:d,maximumFractionDigits:d});
    const dateLabel=(date,opts)=>{try{return new Intl.DateTimeFormat(i18n.locale(),{...opts,timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));}catch{return date;}};
    const longDate=date=>dateLabel(date,{weekday:'long',day:'numeric',month:'long'});
    const shortDate=date=>dateLabel(date,{weekday:'short',day:'numeric',month:'short'});
    const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined&&text!==null)n.textContent=String(text);if(cls)n.className=cls;return n;};
    const svg=(tag,attrs)=>{const n=doc.createElementNS(SVG_NS,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
    const card=(title,cls)=>{const c=node('section',undefined,'tg-card'+(cls?' '+cls:''));if(title)c.append(node('h2',title,'tg-card-title'));return c;};
    // Abrir el registro siempre muestra el día pedido (o hoy) en la interfaz de seguimiento existente.
    const go=opts=>{if(opts.log&&log&&current)log.show(current.target,opts.date??current.today,macros);if(typeof navigate==='function')navigate(opts);};
    function clear(){epoch++;current=null;weeklyUI?.clear();weeklyUI=null;for(const s of Object.values(slots))s?.replaceChildren();}
    function pending(text){const p=node('p',text,'tg-pending');return p;}
    function chip(text,tone){return node('span',text,'tg-chip'+(tone?' is-'+tone:''));}

    // ---------- piezas visuales ----------
    function ring(goal,totals){
      const kcalGoal=goal?.kcal,kcal=Math.round(totals?.kcal??0),pct=kcalGoal?Math.min(1,kcal/kcalGoal):0;
      const wrap=node('div',undefined,'tg-ring'),r=52,c=2*Math.PI*r;
      const s=svg('svg',{viewBox:'0 0 120 120','aria-hidden':'true'});
      s.append(svg('circle',{cx:60,cy:60,r,class:'tg-ring-track'}));
      const arc=svg('circle',{cx:60,cy:60,r,class:'tg-ring-fill'+(kcalGoal&&kcal>kcalGoal?' is-over':''),'stroke-dasharray':c.toFixed(2),'stroke-dashoffset':(c*(1-pct)).toFixed(2),transform:'rotate(-90 60 60)'});
      s.append(arc);
      const center=node('div',undefined,'tg-ring-center');
      const left=kcalGoal-kcal;
      center.append(node('strong',fmt(Math.abs(left),0),'tg-num'),node('span',left>=0?t('today.kcalLeft'):t('today.kcalOver')));
      wrap.append(s,center);
      wrap.setAttribute('role','img');wrap.setAttribute('aria-label',fmt(kcal,0)+' '+t('today.of')+' '+fmt(kcalGoal,0)+' kcal');
      return wrap;
    }
    function macroBars(goal,totals,{compact=false,withKcal=false}={}){
      const list=node('div',undefined,'tg-macros'+(compact?' is-compact':''));
      for(const m of macroProgress(goal,totals)){
        if(m.key==='kcal'&&!withKcal)continue;
        const row=node('div',undefined,'tg-macro is-'+m.tone);
        const head=node('div',undefined,'tg-macro-head');
        const value=node('span',undefined,'tg-macro-value');
        value.append(node('strong',hasValue(m.consumed)?fmt(m.consumed,0):'—','tg-num'),node('span',' / '+fmt(m.target,0)+(m.key==='kcal'?' kcal':' g')));
        head.append(node('span',t(m.label),'tg-macro-label'),value);
        const track=node('div',undefined,'tg-track'),fill=node('span',undefined,m.over?'is-over':'');fill.style.width=m.pct+'%';track.append(fill);
        track.setAttribute('role','progressbar');track.setAttribute('aria-label',t(m.label));track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax',String(m.target));track.setAttribute('aria-valuenow',String(m.consumed??0));
        row.append(head,track);list.append(row);
      }
      return list;
    }
    function sparkline(entries,{w=600,h=140,grid=true,label=''}={}){
      const vals=entries.map(d=>d.weight.weightKg),avg=rollingAverage(vals,7);
      let min=Math.min(...vals,...avg),max=Math.max(...vals,...avg);if(min===max){min-=1;max+=1;}
      const pad=8,pts=series=>series.map((v,i)=>{const x=pad+(series.length>1?i/(series.length-1):0)*(w-2*pad),y=h-pad-((v-min)/(max-min))*(h-2*pad);return x.toFixed(1)+','+y.toFixed(1);}).join(' ');
      const chart=svg('svg',{viewBox:`0 0 ${w} ${h}`,preserveAspectRatio:'none',role:'img','aria-label':label});
      if(grid)for(const f of [0,.5,1])chart.append(svg('line',{x1:pad,x2:w-pad,y1:pad+f*(h-2*pad),y2:pad+f*(h-2*pad),class:'tg-gridline','vector-effect':'non-scaling-stroke'}));
      chart.append(svg('polyline',{points:pts(vals),class:'tg-line-daily','vector-effect':'non-scaling-stroke'}),svg('polyline',{points:pts(avg),class:'tg-line-avg','vector-effect':'non-scaling-stroke'}));
      return {chart,min,max};
    }
    function icon(name){
      const paths={food:'M4 3v7a3 3 0 0 0 3 3v8M7 3v6M10 3v7a3 3 0 0 1-3 3M17 21V3c-2.5 1.5-3.5 4-3.5 8h3.5',
        weight:'M5 4h14l2 16H3L5 4zM12 8v4M9.5 10.5 12 12',habits:'M4 12l5 5L20 6'};
      const s=svg('svg',{viewBox:'0 0 24 24','aria-hidden':'true',class:'tg-icon'});s.append(svg('path',{d:paths[name]}));return s;
    }

    // ---------- Hoy ----------
    function renderToday(today,day,goal,days){
      const s=slots.today;if(!s)return;
      const hour=now().getHours();
      const head=node('header',undefined,'tg-hero');
      head.append(node('p',longDate(today),'tg-eyebrow'),node('h1',t(hour<12?'greet.morning':hour<19?'greet.afternoon':'greet.evening')));
      const grid=node('div',undefined,'tg-grid');

      // 1. Objetivo de hoy (prescripción del coach + consumo registrado)
      const target=card(t('today.goalTitle'),'tg-span-2 tg-target');
      if(!goal)target.append(pending(t('today.noGoal')));
      else{
        const body=node('div',undefined,'tg-target-body');
        body.append(ring(goal,day.intake?.totals),macroBars(goal,day.intake?.totals));
        target.append(chip(t('today.prescribed'),'info'),body);
        if(!model)target.append(pending(t('today.intakeUnavailable')));
        else if(!day.intake)target.append(node('p',t('today.noIntake'),'tg-muted'));
      }

      // 2. Peso (objetivo físico con la información real disponible)
      const weight=card(t('weight.title'),'tg-weight');
      if(!model)weight.append(pending(t('weight.unavailable')));
      else{
        const sum=summarize(days,goal,domain),entries=days.filter(d=>d.weight);
        if(!entries.length)weight.append(node('p',t('weight.empty'),'tg-muted'));
        else{
          const stats=node('div',undefined,'tg-stats');
          const stat=(label,value,note,cls)=>{const d=node('div',undefined,'tg-stat');d.append(node('span',label,'tg-stat-label'),node('strong',value,'tg-num'+(cls?' '+cls:'')));if(note)d.append(note);return d;};
          const delta=entries.length>1?sum.latestWeight-sum.firstWeight:null;
          stats.append(stat(t('weight.current'),fmt(sum.latestWeight)+' kg',delta===null?null:chip((delta>0?'+':delta<0?'−':'±')+fmt(Math.abs(delta))+' kg',delta<0?'info':null)),
            stat(t('weight.firstRecord'),fmt(sum.firstWeight)+' kg'),
            stat(t('weight.goal'),t('weight.goalPending'),null,'is-pending'));
          weight.append(stats);
          if(entries.length>1){const spark=node('div',undefined,'tg-spark');spark.append(sparkline(entries,{h:60,grid:false,label:t('progress.title')}).chart);weight.append(spark);}
        }
        weight.append(node('p',t('weight.goalNote'),'tg-footnote'));
      }

      // 3. Acciones rápidas
      const actions=card(t('actions.title'),'tg-actions tg-span-2');
      const list=node('div',undefined,'tg-action-list');
      for(const [key,ic,enabled,opts] of [['actions.food','food',diaryAvailable,{tab:'food'}],['actions.weight','weight',Boolean(model),{log:true,focus:'weight'}],['actions.habits','habits',Boolean(model),{log:true,focus:'habits'}]]){
        const b=node('button',undefined,'tg-action');b.type='button';b.append(icon(ic),node('span',t(key)));
        if(enabled)b.addEventListener('click',()=>go(opts));else{b.disabled=true;b.append(node('small',t('actions.unavailable')));}
        list.append(b);
      }
      actions.append(list);

      // 4. Cumplimiento de hoy
      const tasksCard=card(t('tasks.title'),'tg-tasks-card');
      const intake=day.intake,habitsMarked=marked(day);
      const adherence=intake?.status==='COMPLETE'&&goal?domain.dailyAdherence(intake,goal).status:null;
      const tasks=[
        {key:'tasks.weight',state:!model?'unavailable':day.weight?'done':'pending',detail:day.weight?t('tasks.weightDone',{v:fmt(day.weight.weightKg)}):t('tasks.weightTodo')},
        {key:'tasks.habits',state:!model?'unavailable':day.habits?'done':'pending',detail:day.habits?t('tasks.habitsDone',{n:habitsMarked,total:HABITS.length}):t('tasks.habitsTodo')},
        {key:'tasks.food',state:!model&&!diaryAvailable?'unavailable':intake?.status==='COMPLETE'?'done':intake?'partial':'pending',
          detail:intake?.status==='COMPLETE'?t('tasks.foodClosed')+(adherence==='ADHERENT'?' · '+t('tasks.adherent'):adherence==='NOT_ADHERENT'?' · '+t('tasks.notAdherent'):''):intake?t('tasks.foodOpen'):t('tasks.foodTodo')}
      ];
      const available=tasks.filter(x=>x.state!=='unavailable'),done=available.filter(x=>x.state==='done').length;
      if(available.length){
        tasksCard.append(node('p',done===available.length?t('tasks.allDone'):t('tasks.count',{n:done,total:available.length}),'tg-progress-text'));
        const meter=node('div',undefined,'tg-track tg-meter');meter.setAttribute('role','progressbar');meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax',String(available.length));meter.setAttribute('aria-valuenow',String(done));meter.setAttribute('aria-label',t('tasks.title'));
        const fill=node('span');fill.style.width=Math.round(done/available.length*100)+'%';meter.append(fill);tasksCard.append(meter);
      }
      const ol=node('ol',undefined,'tg-tasks');
      for(const x of tasks){
        const li=node('li',undefined,'tg-task is-'+x.state);
        const mark=node('span',x.state==='done'?'✓':x.state==='partial'?'•':'','tg-task-mark');mark.setAttribute('aria-hidden','true');
        const body=node('div',undefined,'tg-task-body');body.append(node('strong',t(x.key)),node('span',x.state==='unavailable'?t('actions.unavailable'):x.detail,'tg-muted'));
        li.append(mark,body,node('span',t('tasks.'+x.state),'tg-task-state'));ol.append(li);
      }
      tasksCard.append(ol);

      grid.append(target,actions,weight,tasksCard);
      s.append(head,grid);
    }

    // ---------- Alimentación ----------
    // Con el diario conectado, PilotDiaryUI dibuja su propio resumen del día elegido;
    // aquí solo queda el aviso de diario no habilitado.
    function renderFood(day,goal){
      const s=slots.food;if(!s||diaryAvailable)return;
      const c=card(t('food.title'),'tg-food-summary');
      if(goal){
        const body=node('div',undefined,'tg-target-body is-compact');body.append(macroBars(goal,day.intake?.totals,{compact:true,withKcal:true}));c.append(body);
      }else c.append(pending(t('today.noGoal')));
      c.append(pending(t('food.unavailable')));
      s.append(c);
    }

    // ---------- Progreso ----------
    function kpi(label,value,note,tone){const c=node('div',undefined,'tg-kpi'+(tone?' is-'+tone:''));c.append(node('span',label,'tg-stat-label'),node('strong',value,'tg-num'),node('span',note,'tg-muted'));return c;}
    function trendChart(days){
      const entries=days.filter(d=>d.weight);if(entries.length<2)return node('p',t('progress.needTwo'),'tg-muted');
      const vals=entries.map(d=>d.weight.weightKg),{chart,min,max}=sparkline(entries,{label:t('progress.title')+': '+fmt(vals[0])+' → '+fmt(vals.at(-1))+' kg'});
      const fig=node('figure',undefined,'tg-chart');
      const axis=node('div',undefined,'tg-chart-axis');axis.append(node('span',shortDate(entries[0].date)),node('span',fmt(min)+'–'+fmt(max)+' kg'),node('span',shortDate(entries.at(-1).date)));
      const legend=node('figcaption',undefined,'tg-legend');legend.append(node('span',t('progress.daily'),'tg-key'),node('span',t('progress.avg'),'tg-key is-avg'));
      fig.append(chart,axis,legend);return fig;
    }
    function habitBars(days){
      const rates=habitRates(days),wrap=node('div',undefined,'tg-bars');
      if(!rates[0].total){wrap.append(node('p',t('progress.noHabits'),'tg-muted'));return wrap;}
      for(const r of rates){
        const row=node('div',undefined,'tg-macro is-info'),head=node('div',undefined,'tg-macro-head');
        head.append(node('span',t('habit.'+r.key),'tg-macro-label'),node('span',r.yes+'/'+r.total+' · '+r.pct+'%','tg-muted'));
        const track=node('div',undefined,'tg-track'),fill=node('span',undefined,r.pct>=70?'':'is-low');fill.style.width=r.pct+'%';track.append(fill);
        row.append(head,track);wrap.append(row);
      }
      return wrap;
    }
    function historyList(days,goal){
      const list=node('ul',undefined,'tg-history');
      for(const d of [...days].reverse().slice(0,14)){
        const li=node('li',undefined,'tg-history-row');
        const intake=d.intake;let food=t('history.none'),tone='muted';
        if(intake?.status==='COMPLETE'&&intake.totals){
          const r=goal?domain.dailyAdherence(intake,goal):{status:'NO_OBJECTIVE'};
          food=fmt(intake.totals.kcal,0)+' kcal · '+(r.status==='ADHERENT'?t('history.in'):r.status==='NOT_ADHERENT'?t('history.out'):t('history.noGoal'));tone=r.status==='ADHERENT'?'info':r.status==='NOT_ADHERENT'?'warn':'muted';
        }else if(intake){food=t('history.open');}
        const cells=node('div',undefined,'tg-history-cells');
        cells.append(node('span',d.weight?fmt(d.weight.weightKg)+' kg':'—','tg-num-sm'),chip(food,tone),node('span',d.habits?t('history.habits',{n:marked(d),total:HABITS.length}):t('history.noHabits'),'tg-muted'));
        const view=node('button',t('history.view'),'tg-btn-ghost tg-btn-sm');view.type='button';view.setAttribute('aria-label',t('history.view')+' · '+shortDate(d.date));
        view.addEventListener('click',()=>go({log:true,date:d.date}));
        li.append(node('span',shortDate(d.date),'tg-history-date'),cells,view);list.append(li);
      }
      return list;
    }
    function renderProgress(today,days,goal,target){
      const s=slots.progress;if(!s)return;
      if(!model){const c=card(t('nav.progress'));c.append(pending(t('progress.unavailable')));s.append(c);return;}
      const sum=summarize(days,goal,domain);
      const week=card(t('week.title'),'tg-span-2');week.append(node('p',t('week.sub'),'tg-sub'));
      const grid=node('div',undefined,'tg-kpis');
      const delta=hasValue(sum.weekAvgWeight)&&hasValue(sum.prevAvgWeight)?sum.weekAvgWeight-sum.prevAvgWeight:null;
      grid.append(
        kpi(t('week.adherence'),sum.hasGoal?sum.adherent+'/7':'—',sum.hasGoal?t('week.adherenceNote',{n:sum.complete}):t('week.noGoal'),sum.hasGoal&&sum.adherent>=5?'good':null),
        kpi(t('week.avgWeight'),hasValue(sum.weekAvgWeight)?fmt(sum.weekAvgWeight)+' kg':'—',delta===null?(sum.latestWeight!==null?t('week.lastRecord',{v:fmt(sum.latestWeight)}):t('week.noWeight')):t('week.vsPrev',{d:(delta>0?'+':delta<0?'−':'±')+fmt(Math.abs(delta))})),
        kpi(t('week.habits'),t('week.days',{n:sum.habitDays}),sum.habitAnswered?t('week.habitsNote',{p:Math.round(sum.habitYes/sum.habitAnswered*100)}):t('week.noHabits'),sum.habitDays>=5?'good':null),
        kpi(t('week.streak'),sum.streak+' '+t(sum.streak===1?'week.day':'week.dayPlural'),t('week.streakNote'),sum.streak>=7?'good':null)
      );
      week.append(grid);
      const details=node('details',undefined,'tg-details'),summary=node('summary',t('week.detail')),detailRoot=node('div',undefined,'tg-weekly');
      details.append(summary,detailRoot);
      if(TrackingUI){
        weeklyUI=TrackingUI.mount(detailRoot,{model,document:doc,role:'CLIENT'});
        details.addEventListener('toggle',()=>{if(details.open)weeklyUI.weekly(target,addDays(today,-6),macros);else weeklyUI.clear();});
      }
      week.append(details);
      const trend=card(t('progress.title'));trend.append(node('p',t('progress.sub'),'tg-sub'),trendChart(days));
      const habits=card(t('progress.habits'));habits.append(node('p',t('progress.habitsSub'),'tg-sub'),habitBars(days));
      const hist=card(t('history.title'),'tg-span-2');hist.append(node('p',t('history.sub'),'tg-sub'),historyList(days,goal));
      const g=node('div',undefined,'tg-grid');
      g.append(week,trend,habits,hist);s.append(g);
    }

    // ---------- Mi plan ----------
    function renderPlan(target,goalRead){
      const s=slots.plan;if(!s)return;
      const g=node('div',undefined,'tg-grid');
      const pres=card(t('plan.prescription'),'tg-span-2 tg-prescription');
      if(!goalRead?.macros)pres.append(pending(t('plan.noPrescription')));
      else{
        const m=goalRead.macros,big=node('div',undefined,'tg-pres');
        const kc=node('div',undefined,'tg-pres-kcal');kc.append(node('strong',fmt(m.kcal,0),'tg-num'),node('span',t('plan.kcalDay')));
        const ms=node('div',undefined,'tg-pres-macros');
        for(const [key,label,tone] of MACROS){const d=node('div',undefined,'tg-pres-macro is-'+tone);d.append(node('span',t(label),'tg-stat-label'),node('strong',fmt(m[key],0)+' g','tg-num'));ms.append(d);}
        big.append(kc,ms);pres.append(chip(t('today.prescribed'),'info'),big);
        if(goalRead.effectiveFrom){const d=goalRead.effectiveFrom.slice(0,10);pres.append(node('p',t('plan.since',{d:dateLabel(d,{day:'numeric',month:'long',year:'numeric'}),r:goalRead.revision??'—'}),'tg-footnote'));}
      }
      if(target?.label){const p=node('p',undefined,'tg-footnote');p.append(node('strong',t('plan.gym')+': '),node('span',target.label));pres.append(p);}
      const soon=card(t('plan.pendingTitle'),'tg-span-2');
      const items=node('ul',undefined,'tg-soon');
      for(const [k,n] of [['plan.goal','plan.goalNote'],['plan.photos','plan.photosNote'],['plan.menus','plan.menusNote']]){
        const li=node('li',undefined,'tg-soon-item');const b=node('div');b.append(node('strong',t(k)),node('span',t(n),'tg-muted'));li.append(b,chip(t('plan.pending'),'muted'));items.append(li);
      }
      soon.append(items);
      g.append(pres,soon);s.append(g);
    }

    async function show(target,today){
      clear();const ticket=epoch;
      slots.today?.append(node('p',t('state.loading'),'tg-loading'));
      try{
        const [history,goalRead]=await Promise.all([model?model.history(target,addDays(today,-(HISTORY_DAYS-1)),today):Promise.resolve(null),macros?macros.read(target):Promise.resolve(null)]);
        if(ticket!==epoch)return;
        for(const s of Object.values(slots))s?.replaceChildren();
        current={target,today};
        const days=history?.days??[],goal=goalRead?.macros??null,day=days.at(-1)??{date:today};
        renderToday(today,day,goal,days);renderFood(day,goal);renderProgress(today,days,goal,target);renderPlan(target,goalRead);
      }catch{if(ticket===epoch){clear();slots.today?.append(node('p',t('state.error'),'tg-error'));}}
    }
    async function refresh(){if(current)await show(current.target,current.today);}
    return {show,refresh,clear};
  }
  const api={mount,summarize,habitRates,rollingAverage,macroProgress};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PilotClientHomeUI=api;
})(typeof globalThis==='object'?globalThis:this);
