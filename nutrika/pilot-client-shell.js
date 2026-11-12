(function(root){
  'use strict';
  // Shell de la experiencia del cliente: pestañas (Hoy, Alimentación, Progreso,
  // Mi plan), hoja de registro de peso/hábitos e idioma. No toca autenticación,
  // datos ni red: solo muestra/oculta contenedores que ya llenan los módulos.
  const doc=root.document;
  const TABS=['today','food','progress','plan'];
  const i18n=root.PilotClientI18n;
  const listeners=[];
  const $=id=>doc.getElementById(id);
  const storage={get(){try{return root.sessionStorage.getItem('twogramms-tab');}catch{return null;}},set(v){try{root.sessionStorage.setItem('twogramms-tab',v);}catch{}}};

  function applyLanguage(){
    if(!i18n)return;
    const lang=i18n.getLang();doc.documentElement.lang=lang;
    for(const el of doc.querySelectorAll('[data-i18n]'))el.textContent=i18n.t(el.dataset.i18n);
    for(const el of doc.querySelectorAll('[data-i18n-aria]'))el.setAttribute('aria-label',i18n.t(el.dataset.i18nAria));
    const note=$('lang-note');if(note){const text=i18n.t('shell.partial');note.textContent=text;note.hidden=!text;}
  }
  function showTab(tab,{scroll=true}={}){
    if(!TABS.includes(tab))tab='today';
    for(const panel of doc.querySelectorAll('[data-panel]'))panel.hidden=panel.dataset.panel!==tab;
    for(const b of doc.querySelectorAll('[data-tab]')){if(b.dataset.tab===tab)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
    storage.set(tab);
    if(scroll)root.scrollTo?.({top:0,behavior:'instant'});
  }
  const dialog=()=>$('log-dialog');
  function openLog({focus}={}){
    const d=dialog();if(!d)return;
    if(!d.open){if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');}
    // La interfaz de seguimiento se vuelve a dibujar al cargar el día; enfoca después.
    root.setTimeout(()=>{
      const r=$('tracking-root');if(!r)return;
      const target=focus==='habits'?r.querySelector('fieldset input[type=checkbox]'):r.querySelector('input[type=number]');
      target?.focus?.();target?.scrollIntoView?.({block:'center'});
    },350);
  }
  function closeLog(){const d=dialog();if(!d)return;if(typeof d.close==='function'&&d.open)d.close();else d.removeAttribute('open');}
  // Panel de alimentos (Alimentación): PilotDiaryUI dibuja dentro de #food-sheet-root.
  const foodDialog=()=>$('food-dialog');
  function openFood(){const d=foodDialog();if(d&&!d.open){if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');}}
  function closeFood(){const d=foodDialog();if(!d)return;$('food-sheet-root')?.replaceChildren();if(typeof d.close==='function'&&d.open)d.close();else d.removeAttribute('open');}
  const foodPanel=()=>foodDialog()?{get root(){return $('food-sheet-root');},open:openFood,close:closeFood}:null;
  function navigate(opts={}){
    if(opts.tab)showTab(opts.tab);
    if(opts.log)openLog(opts);
  }
  function init(){
    applyLanguage();
    for(const b of doc.querySelectorAll('[data-tab]'))b.addEventListener('click',()=>showTab(b.dataset.tab));
    showTab(storage.get()??'today',{scroll:false});
    $('log-close')?.addEventListener('click',closeLog);
    dialog()?.addEventListener('click',e=>{if(e.target===dialog())closeLog();}); // toque fuera de la hoja
    foodDialog()?.addEventListener('click',e=>{if(e.target===foodDialog())closeFood();});
    foodDialog()?.addEventListener('close',()=>$('food-sheet-root')?.replaceChildren());
    $('lang-toggle')?.addEventListener('click',()=>{i18n.setLang(i18n.getLang()==='en'?'es':'en');applyLanguage();for(const fn of listeners)fn();});
    // Al cerrar sesión o perder la autorización, la hoja de registro se cierra.
    const access=$('pilot-access');
    if(access&&root.MutationObserver)new root.MutationObserver(()=>{if(access.hidden){closeLog();closeFood();}}).observe(access,{attributes:true,attributeFilter:['hidden']});
  }
  root.PilotClientShell={navigate,showTab,openLog,closeLog,foodPanel,onLanguageChange(fn){listeners.push(fn);},applyLanguage};
  if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',init);else init();
})(globalThis);
