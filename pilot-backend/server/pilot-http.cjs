'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {loadPilotConfig}=require('./pilot-config.cjs');
const {domainBundle,demoPage}=require('./manual-macros-assets.cjs');
const {createManualMacrosInfrastructure}=require('./manual-macros-service.cjs');
const {handleManualMacros}=require('./manual-macros-http.cjs');
const {handleDiary}=require('./diary-http.cjs');
const {handleAdminProvisioning}=require('./pilot-admin-provisioning-http.cjs');
const PUBLIC_ROOT=path.resolve(__dirname,'../../nutrika');
// Corregido (auditoría sobre el commit 60afc33, "configuración de Supabase
// aislado"): esta CSP estaba FIJA al proyecto Supabase compartido —
// aunque pilot-config.cjs y pilot-auth.js ya aceptaran un proyecto
// aislado distinto, el navegador habría bloqueado toda conexión a ese
// otro origen por violar connect-src. Ahora se construye por request a
// partir de `config.supabaseUrl` (ya validado estrictamente por
// loadPilotConfig), nunca de un valor hardcodeado.
function buildCsp(supabaseUrl){
  return `default-src 'none'; script-src 'self'; connect-src 'self' ${supabaseUrl}; style-src 'unsafe-inline'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'`;
}

// Identidad visual Twogramms para la vista Cliente (sin logotipo ni paleta de
// Complex Training). Tema claro, mobile-first. Solo CSS en línea: la CSP sigue
// sin permitir fuentes, imágenes externas ni @import.
const CLIENT_CSS=`
:root{--tg-bg:#f3f6fb;--tg-card:#fff;--tg-line:#e3e8f0;--tg-ink:#0f172a;--tg-body:#334155;--tg-muted:#64748b;--tg-faint:#eef2f8;
--tg-blue:#2563eb;--tg-blue-soft:#e8f0fe;--tg-protein:#3b6ef6;--tg-carbs:#f2675a;--tg-fat:#14b3a6;--tg-warn:#b45309;--tg-warn-soft:#fdf2e3;--tg-good:#0f9d74;--tg-good-soft:#e5f6ef;
--tg-radius:18px;--tg-radius-sm:12px;--tg-shadow:0 1px 2px rgba(15,23,42,.04),0 4px 16px rgba(15,23,42,.04);--tg-nav-h:64px}
*,*::before,*::after{box-sizing:border-box}[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;color-scheme:light}
body{margin:0;background:var(--tg-bg);color:var(--tg-body);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3{color:var(--tg-ink);line-height:1.2;margin:0;letter-spacing:-.01em}
p{margin:.35em 0}a{color:var(--tg-blue)}
:focus-visible{outline:3px solid var(--tg-blue);outline-offset:2px;border-radius:6px}
.tg-num{font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tg-muted{color:var(--tg-muted);font-size:.86rem}
/* barra superior */
.tg-bar{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--tg-line)}
.tg-bar-in{max-width:1080px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:10px}
.tg-logo{display:flex;align-items:center;gap:8px;font-weight:750;font-size:1.08rem;color:var(--tg-ink);letter-spacing:-.02em}
.tg-mark{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--tg-blue);color:#fff;font-size:.78rem;font-weight:800}
.tg-tag{font-size:.68rem;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--tg-muted);background:var(--tg-faint);border-radius:99px;padding:3px 8px}
.tg-bar-actions{margin-left:auto;display:flex;gap:4px}
/* navegación */
.tg-tabs{display:none}
body:has(#pilot-access:not([hidden])) .tg-tabs-bottom{display:grid}
.tg-tabs-bottom{position:fixed;left:0;right:0;bottom:0;z-index:30;grid-template-columns:repeat(4,1fr);height:calc(var(--tg-nav-h) + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:#fff;border-top:1px solid var(--tg-line)}
.tg-tab{appearance:none;border:0;background:none;margin:0;padding:6px 4px;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--tg-muted);font:inherit;font-size:.72rem;font-weight:600;cursor:pointer;border-radius:12px}
.tg-tab svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tg-tab[aria-current=page]{color:var(--tg-blue)}
.tg-tabs-top .tg-tab{flex-direction:row;font-size:.9rem;padding:8px 14px}
.tg-tabs-top .tg-tab[aria-current=page]{background:var(--tg-blue-soft)}
/* estructura */
.tg-main{max-width:1080px;margin:0 auto;padding:16px 16px calc(var(--tg-nav-h) + 32px)}
.tg-grid{display:grid;gap:14px}
.tg-card{background:var(--tg-card);border:1px solid var(--tg-line);border-radius:var(--tg-radius);padding:18px;box-shadow:var(--tg-shadow);min-width:0}
.tg-card+.tg-card,.tg-grid+.tg-card,[data-panel]>*+*{margin-top:14px}
.tg-grid>.tg-card{margin:0}
.tg-card-title{font-size:1.02rem;font-weight:700;margin-bottom:10px}
.tg-sub{color:var(--tg-muted);font-size:.86rem;margin:-6px 0 10px}
.tg-footnote{color:var(--tg-muted);font-size:.8rem;margin-top:12px}
.tg-pending{background:var(--tg-faint);border:1px dashed var(--tg-line);border-radius:var(--tg-radius-sm);padding:12px 14px;color:var(--tg-muted);font-size:.88rem;margin:8px 0 0}
.tg-chip{display:inline-flex;align-items:center;gap:4px;border-radius:99px;padding:2px 10px;font-size:.76rem;font-weight:600;background:var(--tg-faint);color:var(--tg-body);white-space:nowrap}
.tg-chip.is-info{background:var(--tg-blue-soft);color:var(--tg-blue)}.tg-chip.is-warn{background:var(--tg-warn-soft);color:var(--tg-warn)}.tg-chip.is-muted{color:var(--tg-muted)}
.tg-note{background:var(--tg-blue-soft);color:var(--tg-blue);border-radius:var(--tg-radius-sm);padding:10px 14px;font-size:.85rem;margin:0 0 14px}
.tg-preview{background:var(--tg-warn-soft);color:var(--tg-warn);border-radius:var(--tg-radius-sm);padding:10px 14px;font-size:.85rem;margin:0 0 14px;font-weight:600}
.tg-loading{color:var(--tg-muted)}.tg-error{color:var(--tg-warn)}
/* botones y formularios (también para los módulos existentes) */
input,select,button{font:inherit}
button,.tg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:8px 16px;border-radius:12px;border:1px solid var(--tg-blue);background:var(--tg-blue);color:#fff;font-weight:650;cursor:pointer;margin:4px 4px 4px 0}
button:disabled{opacity:.45;cursor:not-allowed}
.tg-btn-ghost{background:transparent;border-color:transparent;color:var(--tg-blue)}
.tg-btn-ghost:hover{background:var(--tg-blue-soft)}
.tg-btn-sm{min-height:36px;padding:4px 12px;font-size:.86rem;margin:0}
input[type=email],input[type=password],input[type=number],input[type=text],input[type=search],input[type=date],select{display:block;width:100%;max-width:100%;min-height:44px;padding:9px 12px;border:1px solid var(--tg-line);border-radius:12px;background:#fff;color:var(--tg-ink);margin:4px 0}
input[type=date]{width:auto}
input:focus,select:focus{border-color:var(--tg-blue);outline:none;box-shadow:0 0 0 3px var(--tg-blue-soft)}
input[type=checkbox]{width:20px;height:20px;accent-color:var(--tg-blue);flex:none}
fieldset{border:1px solid var(--tg-line);border-radius:var(--tg-radius-sm);padding:8px 14px 10px;margin:10px 0}
legend{font-weight:650;color:var(--tg-ink);padding:0 4px;font-size:.9rem}
fieldset label{display:flex;align-items:center;gap:10px;min-height:40px}
details summary{cursor:pointer;font-weight:650;color:var(--tg-blue);min-height:40px;display:flex;align-items:center}
/* acceso */
.tg-auth{max-width:420px;margin:32px auto;background:var(--tg-card);border:1px solid var(--tg-line);border-radius:var(--tg-radius);padding:24px;box-shadow:var(--tg-shadow)}
.tg-auth h1{font-size:1.4rem;margin-bottom:6px}
.tg-auth form label{display:block;margin:12px 0 2px;font-weight:600;color:var(--tg-ink);font-size:.9rem}
.tg-auth form button[type=submit]{width:100%;margin-top:14px}
.tg-auth-alt{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
#auth-status{color:var(--tg-muted);font-size:.88rem}
body:has(#pilot-access:not([hidden])) .tg-auth{max-width:none;margin:0 0 6px;padding:0 4px;background:none;border:0;box-shadow:none}
body:has(#pilot-access:not([hidden])) :is(#login-form,.tg-auth-alt,.tg-auth h1){display:none}
body:has(#pilot-access:not([hidden])) #auth-status{font-size:.76rem}
body:not(:has(#pilot-access:not([hidden]))) .tg-foot{display:block}
/* Hoy */
.tg-hero{padding:6px 2px 14px}
.tg-eyebrow{color:var(--tg-muted);font-size:.86rem;margin:0}.tg-eyebrow::first-letter{text-transform:uppercase}
.tg-hero h1{font-size:1.65rem;font-weight:750}
.tg-target-body{display:flex;align-items:center;gap:20px;margin-top:12px}
.tg-target-body.is-compact{display:block;margin-top:4px}
.tg-ring{position:relative;width:132px;height:132px;flex:none}
.tg-ring svg{width:100%;height:100%}
.tg-ring-track{fill:none;stroke:var(--tg-blue-soft);stroke-width:11}
.tg-ring-fill{fill:none;stroke:var(--tg-blue);stroke-width:11;stroke-linecap:round;transition:stroke-dashoffset .5s ease}
.tg-ring-fill.is-over{stroke:var(--tg-warn)}
.tg-ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.tg-ring-center strong{font-size:1.75rem;color:var(--tg-ink);line-height:1.1}
.tg-ring-center span{font-size:.72rem;color:var(--tg-muted);max-width:80px}
.tg-macros{flex:1;display:grid;gap:12px;min-width:0}
.tg-macros.is-compact{grid-template-columns:1fr;gap:10px}
.tg-macro-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:5px}
.tg-macro-label{font-weight:650;color:var(--tg-ink);font-size:.88rem;display:flex;align-items:center;gap:7px}
.tg-macro-label::before{content:"";width:9px;height:9px;border-radius:50%;background:var(--tg-macro,var(--tg-blue))}
.tg-macro-value{font-size:.82rem;color:var(--tg-muted);white-space:nowrap}.tg-macro-value strong{color:var(--tg-ink);font-size:1rem}
.tg-track{height:8px;border-radius:99px;background:var(--tg-faint);overflow:hidden}
.tg-track span{display:block;height:100%;width:0;border-radius:99px;background:var(--tg-macro,var(--tg-blue));transition:width .5s ease}
.tg-track span.is-over{background:var(--tg-warn)}.tg-track span.is-low{opacity:.45}
.is-kcal{--tg-macro:var(--tg-blue)}.is-protein{--tg-macro:var(--tg-protein)}.is-carbs{--tg-macro:var(--tg-carbs)}.is-fat{--tg-macro:var(--tg-fat)}.is-info{--tg-macro:var(--tg-blue)}
.tg-target .tg-chip{margin-bottom:2px}
.tg-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.tg-stat{display:flex;flex-direction:column;gap:3px;min-width:0}
.tg-stat-label{font-size:.76rem;color:var(--tg-muted);font-weight:600}
.tg-stat strong{font-size:1.25rem;color:var(--tg-ink)}
.tg-stat .tg-chip{align-self:flex-start}
.tg-stat strong.is-pending{font-size:.95rem;font-weight:600;color:var(--tg-muted);padding-top:4px}
.tg-spark{margin-top:12px}.tg-spark svg{display:block;width:100%;height:60px}
.tg-action-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.tg-action{flex-direction:column;gap:8px;margin:0;min-height:96px;padding:12px 8px;background:var(--tg-faint);border:1px solid transparent;color:var(--tg-ink);border-radius:var(--tg-radius-sm);font-size:.84rem;font-weight:650;text-align:center}
.tg-action:hover:not(:disabled){background:var(--tg-blue-soft);color:var(--tg-blue)}
.tg-action small{font-weight:500;color:var(--tg-muted);font-size:.7rem}
.tg-icon{width:26px;height:26px;fill:none;stroke:var(--tg-blue);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.tg-progress-text{font-weight:650;color:var(--tg-ink);margin:0 0 6px}
.tg-meter{margin-bottom:12px}
.tg-tasks{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.tg-task{display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:12px;padding:10px 12px;border-radius:var(--tg-radius-sm);background:var(--tg-faint)}
.tg-task-mark{width:26px;height:26px;border-radius:50%;border:2px solid var(--tg-line);background:#fff;display:grid;place-items:center;font-weight:800;font-size:.8rem;color:#fff}
.tg-task.is-done .tg-task-mark{background:var(--tg-blue);border-color:var(--tg-blue)}
.tg-task.is-partial .tg-task-mark{border-color:var(--tg-blue);color:var(--tg-blue)}
.tg-task-body{display:flex;flex-direction:column;min-width:0}.tg-task-body strong{color:var(--tg-ink);font-size:.92rem}
.tg-task-state{font-size:.74rem;font-weight:650;color:var(--tg-muted)}
.tg-task.is-done .tg-task-state{color:var(--tg-blue)}
.tg-task.is-unavailable{opacity:.7}
/* Progreso */
.tg-kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.tg-kpi{background:var(--tg-faint);border-radius:var(--tg-radius-sm);padding:12px 14px;display:flex;flex-direction:column;gap:2px;min-width:0}
.tg-kpi strong{font-size:1.45rem;color:var(--tg-ink)}
.tg-kpi .tg-muted{font-size:.76rem}
.tg-kpi.is-good{background:var(--tg-blue-soft)}.tg-kpi.is-good strong{color:var(--tg-blue)}
.tg-details{margin-top:10px}
.tg-weekly p{font-size:.84rem;overflow-wrap:anywhere;color:var(--tg-body)}
.tg-chart{margin:4px 0 0}.tg-chart svg{display:block;width:100%;height:150px;overflow:visible}
.tg-line-daily{fill:none;stroke:#b8c4d6;stroke-width:1.5}
.tg-line-avg{fill:none;stroke:var(--tg-blue);stroke-width:3;stroke-linejoin:round;stroke-linecap:round}
.tg-gridline{stroke:var(--tg-line);stroke-width:1}
.tg-chart-axis{display:flex;justify-content:space-between;gap:8px;font-size:.74rem;color:var(--tg-muted);margin-top:6px}
.tg-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.76rem;color:var(--tg-muted);margin-top:8px}
.tg-key::before{content:"";display:inline-block;width:16px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle;background:#b8c4d6}
.tg-key.is-avg::before{background:var(--tg-blue);height:4px}
.tg-bars{display:grid;gap:12px}
.tg-history{list-style:none;margin:0;padding:0}
.tg-history-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:6px 12px;padding:10px 0;border-top:1px solid var(--tg-line)}
.tg-history-row:first-child{border-top:0}
.tg-history-date{font-weight:650;color:var(--tg-ink);font-size:.9rem}.tg-history-date::first-letter{text-transform:uppercase}
.tg-history-cells{grid-column:1/-1;grid-row:2;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:.84rem}
.tg-num-sm{font-variant-numeric:tabular-nums;font-weight:650;color:var(--tg-ink)}
/* Mi plan */
.tg-pres{display:flex;flex-wrap:wrap;align-items:center;gap:16px 28px;margin-top:12px}
.tg-pres-kcal{display:flex;flex-direction:column}.tg-pres-kcal strong{font-size:2.4rem;color:var(--tg-ink);line-height:1}.tg-pres-kcal span{color:var(--tg-muted);font-size:.84rem}
.tg-pres-macros{display:grid;grid-template-columns:repeat(3,minmax(84px,1fr));gap:10px;flex:1;min-width:240px}
.tg-pres-macro{border-radius:var(--tg-radius-sm);padding:10px 12px;background:var(--tg-faint);border-top:4px solid var(--tg-macro)}
.tg-pres-macro strong{display:block;font-size:1.2rem;color:var(--tg-ink)}
.tg-soon{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.tg-soon-item{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;padding:12px 14px;border-radius:var(--tg-radius-sm);background:var(--tg-faint)}
.tg-soon-item div{display:flex;flex-direction:column}.tg-soon-item strong{color:var(--tg-ink)}
/* módulos existentes dentro de tarjetas */
.tg-module:has(> div:empty){display:none}
.tg-module h2{font-size:1.02rem;margin-bottom:8px}
#macros-root h3{font-size:1rem;margin:12px 0 6px}
#macros-root label{display:block;font-weight:600;color:var(--tg-ink);font-size:.88rem}
/* Alimentación: diario por comidas */
.tg-diary>*+*{margin-top:14px}
.tg-food-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.tg-food-top h1{font-size:1.45rem;margin-right:auto}
.tg-datenav{display:flex;align-items:center;gap:2px}
.tg-datenav input[type=date]{margin:0;min-height:40px;padding:6px 10px}
.tg-daystep{font-size:1.3rem;min-width:40px;padding:0}
.tg-food-kcal{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 12px;margin:2px 0 8px}
.tg-food-kcal-main strong{font-size:2.1rem;color:var(--tg-ink);font-weight:750;line-height:1}
.tg-food-summary>.tg-track{height:10px;margin-bottom:14px}
.tg-food-macros{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.tg-food-macros .tg-macro{display:flex;flex-direction:column;gap:5px;min-width:0}
.tg-food-macros .tg-macro-head{flex-direction:column;align-items:flex-start;gap:0}
.tg-food-macros .tg-muted{font-size:.74rem}
.tg-food-macros .tg-macro-label{display:block;font-size:.78rem;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tg-food-macros .tg-macro-label::before{display:inline-block;margin-right:6px;vertical-align:1px}
.tg-meals{display:grid;gap:12px}
.tg-meals>.tg-card{margin:0}
.tg-meal{padding:16px}
.tg-meal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.tg-meal-head .tg-card-title{margin:0}
.tg-meal-macros{display:block;font-size:.76rem;margin-top:2px}
.tg-meal-kcal{color:var(--tg-ink);white-space:nowrap}
.tg-meal-empty{margin:10px 0 4px}
.tg-entries{list-style:none;margin:10px 0 0;padding:0}
.tg-entry-item+.tg-entry-item{border-top:1px solid var(--tg-line)}
.tg-entry,.tg-result{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:52px;padding:8px 4px;cursor:pointer;border-radius:10px}
div.tg-entry{cursor:default}
button.tg-entry:hover,.tg-result:hover{background:var(--tg-faint)}
.tg-entry:focus-visible,.tg-result:focus-visible{outline:3px solid var(--tg-blue);outline-offset:-2px}
.tg-entry-info{display:flex;flex-direction:column;min-width:0}
.tg-entry-info strong{color:var(--tg-ink);font-weight:600;font-size:.94rem;overflow-wrap:anywhere}
.tg-entry-info .tg-muted{font-size:.8rem}
.tg-entry-kcal{font-weight:650;color:var(--tg-ink);white-space:nowrap;font-size:.9rem}
.tg-add{width:100%;margin:10px 0 0;background:var(--tg-blue-soft);border-color:transparent;color:var(--tg-blue)}
.tg-add:hover{background:#dbe7fd}
.tg-day-close .tg-card-title{margin-bottom:4px}
.tg-check{display:flex;align-items:center;gap:10px;margin:10px 0;font-size:.9rem}
.tg-btn-danger{background:#fff;border-color:#f3c4bf;color:#c2410c;width:100%;margin:12px 0 0}
.tg-btn-danger:hover{background:#fdf0ee}
/* panel de alimentos */
.tg-sheet-body{padding:12px 18px 24px}
.tg-food-sheet{height:92vh}
.tg-meal-chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:6px}
.tg-meal-chip{flex:none;min-height:36px;margin:0;padding:4px 14px;border-radius:99px;background:var(--tg-faint);border-color:transparent;color:var(--tg-body);font-size:.86rem}
.tg-meal-chip[aria-pressed=true]{background:var(--tg-blue);color:#fff}
.tg-results{list-style:none;margin:8px 0 0;padding:0;max-height:38vh;overflow:auto;border:1px solid var(--tg-line);border-radius:var(--tg-radius-sm)}
.tg-result-item+.tg-result-item{border-top:1px solid var(--tg-line)}
.tg-result{padding:8px 12px;border-radius:0}
.tg-result-item.is-selected .tg-result{background:var(--tg-blue-soft)}
.tg-result-empty{padding:12px}
.tg-pick{margin-top:12px;padding:14px;border-radius:var(--tg-radius-sm);background:var(--tg-faint);display:flex;flex-direction:column;gap:2px}
.tg-pick>strong{color:var(--tg-ink)}
.tg-pick-form{margin-top:8px}
.tg-qty{display:grid;grid-template-columns:1fr auto;align-items:center;gap:0 10px}
.tg-qty .tg-stat-label{grid-column:1/-1}
.tg-unit{color:var(--tg-muted);font-weight:600;min-width:3ch}
.tg-pick-form button[type=submit]{width:100%;margin:10px 0 0}
.tg-personal{margin-top:14px;padding:4px 14px;border:1px solid var(--tg-line);border-radius:var(--tg-radius-sm)}
.tg-personal-form{display:grid;gap:4px;padding-bottom:12px}
.tg-personal-ref{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.tg-personal-macros{display:grid;grid-template-columns:repeat(2,1fr);gap:4px 10px}
.tg-personal-macros label{display:flex;flex-direction:column}
.tg-food-panel{margin-top:14px}
/* hoja de registro (peso y hábitos) */
.tg-sheet{border:0;padding:0;margin:auto auto 0;width:100%;max-width:100%;max-height:92vh;border-radius:22px 22px 0 0;background:var(--tg-card);color:var(--tg-body);box-shadow:0 -8px 40px rgba(15,23,42,.18);overflow:auto}
.tg-sheet::backdrop{background:rgba(15,23,42,.35)}
.tg-sheet-head{position:sticky;top:0;z-index:1;background:var(--tg-card);display:flex;align-items:center;justify-content:space-between;padding:14px 18px 10px;border-bottom:1px solid var(--tg-line)}
.tg-sheet-head h2{font-size:1.08rem}
#tracking-root{padding:12px 18px 24px}
#tracking-root>h3{font-size:1rem;margin:10px 0 4px}
#tracking-root>p{color:var(--tg-muted);font-size:.86rem}
#tracking-root form{display:grid;grid-template-columns:repeat(2,1fr);gap:2px 12px;margin-top:8px}
#tracking-root form>label{font-weight:600;color:var(--tg-ink);font-size:.86rem}
#tracking-root form>fieldset,#tracking-root form>button,#tracking-root form>p{grid-column:1/-1}
#tracking-root form>button{width:100%}
.tg-foot{display:none;color:var(--tg-muted);font-size:.76rem;text-align:center;margin-top:24px}
/* escritorio */
@media (min-width:880px){
  :root{--tg-nav-h:0px}
  .tg-main{padding:24px 24px 48px}
  body:has(#pilot-access:not([hidden])) .tg-tabs-bottom{display:none}
  body:has(#pilot-access:not([hidden])) .tg-tabs-top{display:flex;gap:4px;margin-left:16px}
  .tg-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
  .tg-span-2{grid-column:1/-1}
  .tg-kpis{grid-template-columns:repeat(4,1fr)}
  .tg-macros.is-compact{grid-template-columns:repeat(4,1fr);gap:12px 20px}
  .tg-action{flex-direction:row;min-height:60px;font-size:.92rem}
  .tg-hero h1{font-size:1.9rem}
  .tg-ring{width:150px;height:150px}
  .tg-target-body{gap:32px}
  .tg-history-row{grid-template-columns:150px 1fr auto}.tg-history-cells{grid-column:auto;grid-row:auto}
  .tg-sheet{margin:auto;max-width:560px;border-radius:22px;max-height:86vh}
  .tg-food-sheet{height:auto;min-height:60vh}
  .tg-meals{grid-template-columns:repeat(2,minmax(0,1fr))}
  .tg-diary>.tg-food-summary{padding:22px 24px}
  #tracking-root form{grid-template-columns:repeat(3,1fr)}
  body:has(#pilot-access:not([hidden])) .tg-foot{display:block}
}
@media (max-width:380px){.tg-target-body{flex-direction:column;align-items:stretch}.tg-ring{align-self:center}.tg-stats{grid-template-columns:1fr 1fr}.tg-action-list{gap:8px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
`;
const TAB_ICONS={
  today:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  food:'<path d="M5 3v7a3 3 0 0 0 3 3v8M8 3v6M11 3v7a3 3 0 0 1-3 3M18 21V3c-2.5 1.5-3.5 4-3.5 8H18"/>',
  progress:'<path d="M4 19h16M6 15l4-5 3 3 5-6"/>',
  plan:'<path d="M9 4h6v3H9zM7 5H5v16h14V5h-2M8 11h8M8 15h5"/>'
};
function clientTabs(kind){
  const tabs=[['today','nav.today','Hoy'],['food','nav.food','Alimentación'],['progress','nav.progress','Progreso'],['plan','nav.plan','Mi plan']];
  return `<nav class="tg-tabs tg-tabs-${kind}" aria-label="Secciones">${tabs.map(([id,key,label])=>`<button type="button" class="tg-tab" data-tab="${id}"><svg viewBox="0 0 24 24" aria-hidden="true">${TAB_ICONS[id]}</svg><span data-i18n="${key}">${label}</span></button>`).join('')}</nav>`;
}
function clientAccess(preview){
  // Orden pensado para el cliente: Hoy (lo que debe hacer) → Alimentación →
  // Progreso → Mi plan. Los contenedores de los módulos existentes conservan su id.
  return `<section id="pilot-access"${preview?'':' hidden'} aria-label="Tu seguimiento">
  <div data-panel="today"><div id="home-today-root"></div></div>
  <div data-panel="food" hidden><div id="home-food-root"></div><div id="diary-root" class="tg-diary"></div></div>
  <div data-panel="progress" hidden><div id="home-progress-root"></div></div>
  <div data-panel="plan" hidden><div id="home-plan-root"></div><section class="tg-card tg-module"><h2 data-i18n="plan.detail">Detalle y vigencia</h2><div id="macros-root"></div></section></div>
  <dialog id="log-dialog" class="tg-sheet" aria-labelledby="log-title"><div class="tg-sheet-head"><h2 id="log-title" data-i18n="log.title">Peso y hábitos</h2><button id="log-close" type="button" class="tg-btn-ghost tg-btn-sm" data-i18n="log.close">Cerrar</button></div><div id="tracking-root"></div></dialog>
  <dialog id="food-dialog" class="tg-sheet tg-food-sheet" aria-labelledby="food-title"><div id="food-sheet-root"></div></dialog>
  </section>`;
}
function clientHead(title){
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light"><meta name="theme-color" content="#ffffff"><title>${title}</title><style>${CLIENT_CSS}</style></head>`;
}
function clientBar(tag,tagKey,{logout}){
  return `<header class="tg-bar"><div class="tg-bar-in"><span class="tg-logo"><span class="tg-mark" aria-hidden="true">2g</span>twogramms</span><span class="tg-tag" data-i18n="${tagKey}">${tag}</span>${clientTabs('top')}<div class="tg-bar-actions"><button id="lang-toggle" type="button" class="tg-btn-ghost tg-btn-sm" data-i18n="shell.lang">English</button>${logout?'<button id="logout" type="button" class="tg-btn-ghost tg-btn-sm" data-i18n="shell.logout">Cerrar sesión</button>':''}</div></div></header>`;
}
function clientPage(config){
  const trackingScripts=config.trackingAvailable?'<script src="/pilot-tracking-service.js" defer></script><script src="/pilot-tracking-domain.js" defer></script><script src="/pilot-tracking-ui.js" defer></script><script src="/pilot-coach-history-ui.js" defer></script>':'';
  return `${clientHead('Twogramms')}<body data-role="CLIENT">
  ${clientBar('Piloto','shell.pilot',{logout:true})}
  <main class="tg-main"><p id="lang-note" class="tg-note" hidden></p>
  <section class="tg-auth" aria-labelledby="auth-title"><h1 id="auth-title" data-i18n="auth.title">Entra a tu seguimiento</h1>
  <p id="auth-status" role="status" aria-live="polite">Preparando autenticación…</p>
  <h2 id="recovery-title" hidden>Recuperación de contraseña</h2>
  <form id="login-form"><label for="auth-email" data-i18n="auth.email">Correo</label><input id="auth-email" type="email" autocomplete="username" required><label for="auth-password" data-i18n="auth.password">Contraseña</label><input id="auth-password" type="password" autocomplete="current-password"><button type="submit" data-i18n="auth.login">Iniciar sesión</button></form>
  <div class="tg-auth-alt"><button id="magic-link" type="button" class="tg-btn-ghost tg-btn-sm" data-i18n="auth.magic">Enviar Magic Link</button><button id="recover" type="button" class="tg-btn-ghost tg-btn-sm" data-i18n="auth.recover">Recuperar contraseña</button></div>
  <button id="recovery-retry" type="button" hidden>Reintentar verificación de sesión</button>
  <a id="recovery-login" href="/index.html" hidden>Ir al inicio de sesión</a>
  <form id="password-form" hidden><label for="new-password" data-i18n="auth.newPassword">Nueva contraseña</label><input id="new-password" type="password" autocomplete="new-password" minlength="8" required><button type="submit" data-i18n="auth.savePassword">Guardar contraseña</button></form>
  </section>
  ${clientAccess(false)}
  <p class="tg-foot">Twogramms · piloto · ${config.projectRef} · <a href="/coach.html">Coach</a></p>
  </main>${clientTabs('bottom')}<script src="/vendor/supabase.js" defer></script><script src="/pilot-auth.js" defer></script><script src="/manual-macros-domain.js" defer></script><script src="/pilot-macros-service.js" defer></script><script src="/pilot-macros-ui.js" defer></script><script src="/pilot-diary-service.js" defer></script><script src="/pilot-diary-ui.js" defer></script>${trackingScripts}<script src="/pilot-client-i18n.js" defer></script><script src="/pilot-client-home-ui.js" defer></script><script src="/pilot-client-shell.js" defer></script><script src="/pilot-auth-ui.js" defer></script></body></html>`;
}
// Vista previa LOCAL con datos sintéticos (sin SDK, red ni credenciales): solo
// se registra con PILOT_LOCAL_PREVIEW=1, fuera de readOnly y sin origen público.
function clientHomePreviewPage(){
  return `${clientHead('Twogramms — Vista previa')}<body data-role="CLIENT">
  ${clientBar('Vista previa','shell.preview',{logout:false})}
  <main class="tg-main"><p class="tg-preview" role="note">VISTA PREVIA LOCAL · DATOS SINTÉTICOS. Sin sesión, red ni base de datos: nada se guarda en el servidor y todo se pierde al recargar.</p><p id="lang-note" class="tg-note" hidden></p>
  ${clientAccess(true)}
  </main>${clientTabs('bottom')}<script src="/pilot-client-i18n.js" defer></script><script src="/pilot-tracking-domain.js" defer></script><script src="/pilot-tracking-ui.js" defer></script><script src="/manual-macros-domain.js" defer></script><script src="/pilot-macros-ui.js" defer></script><script src="/pilot-diary-ui.js" defer></script><script src="/pilot-client-home-ui.js" defer></script><script src="/pilot-client-shell.js" defer></script><script src="/pilot-client-home-demo.js" defer></script></body></html>`;
}
function page(kind,config){
  if(kind==='Cliente')return clientPage(config);
  // Reuse only trusted presentation CSS. Never serve the legacy document,
  // inline legacy application code, account storage or database configuration.
  const source=fs.readFileSync(path.join(PUBLIC_ROOT,kind==='Coach'?'coach.html':'index.html'),'utf8');
  const css=source.match(/<style>([\s\S]*?)<\/style>/i)?.[1];
  if(!css||/@import|url\s*\(|<\//i.test(css))throw new Error('PILOT_PRESENTATION_REJECTED');
  const trackingScripts=config.trackingAvailable?'<script src="/pilot-tracking-service.js" defer></script><script src="/pilot-tracking-domain.js" defer></script><script src="/pilot-tracking-ui.js" defer></script><script src="/pilot-coach-history-ui.js" defer></script>':'';
  const provisioningScripts=config.adminProvisioningAvailable&&kind==='Coach'?'<script src="/pilot-admin-provisioning-ui.js" defer></script>':'';
  const provisioningRoot=config.adminProvisioningAvailable&&kind==='Coach'?'<div id="admin-provisioning-root"></div>':'';
  // Autoservicio exclusivo de la vista Coach: bootstrap del primer
  // gimnasio (pilot_create_gym) para una cuenta sin ninguna membresía
  // activa todavía. pilot-auth-ui.js decide cuándo mostrarla (solo con
  // NO_MEMBERSHIP); nunca existe en la vista Cliente.
  const createGymSection=kind==='Coach'?'<form id="create-gym-form" hidden><label>Nombre del gimnasio <input id="create-gym-name" type="text" minlength="1" maxlength="160" required></label><button type="submit">Crear gimnasio</button></form>':'';
  // Autoservicio exclusivo de la vista Coach: un OWNER/ADMIN sin el rol
  // COACH todavía se lo agrega a sí mismo (pilot_set_membership), para
  // poder asignarse como coach de un cliente desde el alta. Nunca toca
  // otra cuenta ni existe en la vista Cliente; pilot-auth-ui.js decide
  // cuándo mostrarlo (solo con AUTHORIZED+canAddOwnCoachRole).
  const addOwnCoachRoleButton=kind==='Coach'?'<button id="add-own-coach-role" type="button" hidden>Asignarme también el rol COACH</button>':'';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twogramms — Piloto ${kind}</title><style>${css}
  .pilot-shell{max-width:800px;margin:40px auto;padding:24px;background:white;color:#222;border:2px solid #c9a13b} .pilot-shell nav a{display:inline-block;margin:12px} .pilot-shell img{width:72px} .pilot-shell p{margin:16px 0} .pilot-shell label{display:block;margin:12px 0} .pilot-shell input,.pilot-shell select,.pilot-shell button{padding:8px;margin:5px;max-width:100%} .pilot-shell button:disabled{opacity:.55} .pilot-shell section{margin:20px 0}
  </style></head><body data-role="${kind==='Coach'?'COACH':'CLIENT'}"><main class="pilot-shell"><img src="/assets/logo.jpg" alt="Twogramms"><h1>TWOGRAMMS — MODO PILOTO</h1><h2>Vista ${kind}</h2><p>Objetivos manuales de macros: consulta y vista previa. Guardado no disponible.</p><p>Proyecto permitido: <strong>${config.projectRef}</strong></p>
  <p id="auth-status" role="status" aria-live="polite">Preparando autenticación…</p>
  <form id="login-form"><label>Correo <input id="auth-email" type="email" autocomplete="username" required></label><label>Contraseña <input id="auth-password" type="password" autocomplete="current-password"></label><button type="submit">Iniciar sesión</button></form>
  <button id="magic-link" type="button">Enviar Magic Link</button><button id="recover" type="button">Recuperar contraseña</button><button id="logout" type="button">Cerrar sesión</button>
  ${createGymSection}
  ${addOwnCoachRoleButton}
  <h2 id="recovery-title" hidden>Recuperación de contraseña</h2>
  <button id="recovery-retry" type="button" hidden>Reintentar verificación de sesión</button>
  <a id="recovery-login" href="/index.html" hidden>Ir al inicio de sesión</a>
  <form id="password-form" hidden><label>Nueva contraseña <input id="new-password" type="password" autocomplete="new-password" minlength="8" required></label><button type="submit">Guardar contraseña</button></form>
  <section id="pilot-access" hidden><div id="macros-root"></div><div id="diary-root"></div><div id="tracking-root"></div><div id="coach-history-root"></div>${provisioningRoot}</section>
  <nav aria-label="Vistas del piloto"><a href="/index.html">Cliente</a><a href="/coach.html">Coach</a></nav></main><script src="/vendor/supabase.js" defer></script><script src="/pilot-auth.js" defer></script><script src="/manual-macros-domain.js" defer></script><script src="/pilot-macros-service.js" defer></script><script src="/pilot-macros-ui.js" defer></script><script src="/pilot-diary-service.js" defer></script><script src="/pilot-diary-ui.js" defer></script>${trackingScripts}${provisioningScripts}<script src="/pilot-auth-ui.js" defer></script></body></html>`;
}
function createPilotServer({env=process.env,manualMacrosService,diaryService=null,manualMacrosWriteEnabled=false,trackingService=null,readOnly=false,localAdmin=false,adminProvisioningService=null}={}){
  if(readOnly&&(diaryService||manualMacrosWriteEnabled||trackingService))throw new Error('READ_ONLY_REQUIRED');
  const config=loadPilotConfig(env); // Fail before opening any listener.
  if(localAdmin&&(readOnly||config.publicOrigin))throw new Error('LOCAL_ADMIN_ONLY');
  // El alta administrativa es ortogonal a readOnly a propósito (requisito: las
  // funciones clínicas -diario/macros/tracking- siguen cerradas en el piloto
  // de solo lectura, pero esta alta sí debe poder habilitarse ahí).
  const pageConfig={...config,trackingAvailable:Boolean(trackingService)&&!readOnly,adminProvisioningAvailable:Boolean(adminProvisioningService)};
  const handleTracking=trackingService?require('./pilot-tracking-http.cjs').handleTracking:null;
  const macros=manualMacrosService??createManualMacrosInfrastructure({env});
  const routes=new Map([
    ['/index.html',['text/html; charset=utf-8',Buffer.from(page('Cliente',pageConfig))]],
    ['/coach.html',['text/html; charset=utf-8',Buffer.from(page('Coach',pageConfig))]],
    ['/assets/logo.jpg',['image/jpeg',fs.readFileSync(path.join(PUBLIC_ROOT,'assets/logo.jpg'))]],
    ['/pilot-config.json',['application/json; charset=utf-8',Buffer.from(JSON.stringify({mode:'pilot',phase:2,projectRef:config.projectRef,supabaseUrl:config.supabaseUrl,publicKey:config.publicKey,publicOrigin:config.publicOrigin,diaryAvailable:Boolean(diaryService),trackingAvailable:Boolean(trackingService)&&!readOnly,macrosWritable:manualMacrosWriteEnabled,adminProvisioningAvailable:Boolean(adminProvisioningService)}))]]
  ]);
  routes.set('/',routes.get('/index.html'));
  if(readOnly){
    const [type,data]=routes.get('/pilot-config.json');
    routes.set('/pilot-config.json',[type,Buffer.from(JSON.stringify({...JSON.parse(data),readOnly:true}))]);
  }
  // Experiencia del cliente (shell, textos ES/EN y pantallas): siempre disponible para la vista Cliente.
  for(const name of ['pilot-diary-service.js','pilot-diary-ui.js','pilot-client-i18n.js','pilot-client-home-ui.js','pilot-client-shell.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
  if(trackingService){
    for(const name of ['pilot-tracking-service.js','pilot-tracking-ui.js','pilot-coach-history-ui.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
    routes.set('/pilot-tracking-domain.js',['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,'domain/tracking/adherence.cjs'))]);
  }
  // Vista previa sintética de la pantalla del cliente: solo con activación
  // explícita local (PILOT_LOCAL_PREVIEW=1), sin readOnly y sin origen público.
  // Nunca forma parte de un despliegue (su script no está en el contexto Docker).
  if(env.PILOT_LOCAL_PREVIEW==='1'&&!readOnly&&!config.publicOrigin){
    for(const name of ['pilot-tracking-ui.js','pilot-client-home-demo.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
    routes.set('/pilot-tracking-domain.js',['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,'domain/tracking/adherence.cjs'))]);
    routes.set('/preview/client-home.html',['text/html; charset=utf-8',Buffer.from(clientHomePreviewPage())]);
  }
  routes.set('/manual-macros-domain.js',['text/javascript; charset=utf-8',Buffer.from(domainBundle())]);
  if(adminProvisioningService)routes.set('/pilot-admin-provisioning-ui.js',['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,'pilot-admin-provisioning-ui.js'))]);
  routes.set('/preview/macros-coach.html',['text/html; charset=utf-8',Buffer.from(demoPage('COACH'))]);
  routes.set('/preview/macros-client.html',['text/html; charset=utf-8',Buffer.from(demoPage('CLIENT'))]);
  if(localAdmin)routes.set('/admin.html',['text/html; charset=utf-8',Buffer.from(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twogramms — Administración piloto</title><style>body{font-family:system-ui;max-width:850px;margin:32px auto;padding:20px}button,input,select{margin:8px;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block}</style></head><body><h1>TWOGRAMMS — MODO PILOTO</h1><h2>Administración de la organización existente</h2><p>Solo las dos cuentas personales indicadas. No se crean organizaciones ni se habilitan funciones clínicas. Cada asignación se confirma por separado.</p><p id="admin-status" role="status" aria-live="polite">Verificando sesión…</p><form id="admin-login"><label>Correo <input id="admin-email" type="email" autocomplete="username" required></label><label>Contraseña <input id="admin-password" type="password" autocomplete="current-password" required></label><button type="submit">Iniciar sesión</button></form><button id="admin-logout" type="button">Cerrar sesión</button><button id="admin-refresh" type="button">Revalidar acceso</button><div id="admin-controls"></div><a href="/index.html">Volver al piloto</a><script src="/vendor/supabase.js" defer></script><script src="/pilot-auth.js" defer></script><script src="/pilot-admin.js" defer></script><script src="/pilot-admin-ui.js" defer></script></body></html>`)]);
  routes.set('/auth/callback.html',routes.get('/index.html'));
  for(const name of ['pilot-auth.js','pilot-auth-ui.js',...(localAdmin?['pilot-admin.js','pilot-admin-ui.js']:[]),'pilot-macros.js','pilot-macros-service.js','pilot-macros-ui.js','pilot-macros-demo.js'])routes.set('/'+name,['text/javascript; charset=utf-8',fs.readFileSync(path.join(PUBLIC_ROOT,name))]);
  routes.set('/vendor/supabase.js',['text/javascript; charset=utf-8',fs.readFileSync(path.join(__dirname,'../node_modules/@supabase/supabase-js/dist/umd/supabase.js'))]);
  const csp=buildCsp(config.supabaseUrl);
  const previewCsp=buildCsp(config.supabaseUrl).replace(`connect-src 'self' ${config.supabaseUrl}`,"connect-src 'none'");
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',csp);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    const port=server.address()?.port;
    const allowedHosts=config.publicOrigin?[new URL(config.publicOrigin).host]:[`127.0.0.1:${port}`,`localhost:${port}`];
    if(!allowedHosts.includes(req.headers.host)){
      res.writeHead(403);res.end('PILOT_HOST_REJECTED');return;
    }
    if(await handleManualMacros(req,res,macros,config.publicOrigin))return;
    if(await handleDiary(req,res,diaryService,config.publicOrigin))return;
    if(handleTracking&&await handleTracking(req,res,trackingService,config.publicOrigin??'http://'+req.headers.host))return;
    if(await handleAdminProvisioning(req,res,adminProvisioningService,config.publicOrigin))return;
    if(!['GET','HEAD'].includes(req.method)){
      res.setHeader('Allow','GET, HEAD');res.writeHead(405);res.end('PILOT_METHOD_REJECTED');return;
    }
    // Exact allowlist: no filesystem path is ever constructed from a request.
    // Ignore query parameters without decoding or normalizing the allowlisted path.
    const route=req.url.split('?',1)[0];
    // Coincidencia EXACTA para el administrador antiguo, nunca por
    // prefijo: corregido tras la auditoría de Codex sobre el commit
    // 9462850 (integración Render) — `route.startsWith('/pilot-admin')`
    // también atrapaba por accidente `/pilot-admin-provisioning-ui.js` (el
    // alta de clientes, una ruta legítima y distinta), devolviéndole 404
    // incluso con `adminProvisioningService` ya conectado. localAdmin y
    // readOnly ya son mutuamente excluyentes (ver arriba), así que
    // `/admin.html`/`/pilot-admin.js`/`/pilot-admin-ui.js` nunca se
    // registran de todas formas bajo readOnly — esta lista es defensa en
    // profundidad, no la única barrera.
    if(readOnly&&(route==='/admin.html'||route==='/pilot-admin.js'||route==='/pilot-admin-ui.js'||route.startsWith('/preview/'))){res.writeHead(404);res.end();return;}
    const resource=routes.get(route);
    if(!resource){res.writeHead(404);res.end('PILOT_ROUTE_NOT_FOUND');return;}
    if(route.startsWith('/preview/'))res.setHeader('Content-Security-Policy',previewCsp);
    res.setHeader('Content-Type',resource[0]);res.setHeader('Content-Length',resource[1].length);
    res.writeHead(200);res.end(req.method==='HEAD'?undefined:resource[1]);
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return {server,config,start:()=>server.listen(config.port,config.host)};
}
if(require.main===module){
  try{
    const app=createPilotServer();
    app.server.on('error',()=>{console.error('FAIL PILOT_START');process.exitCode=1;});
    app.server.once('listening',()=>console.log(`TWOGRAMMS — MODO PILOTO\nhttp://127.0.0.1:${app.config.port}/`));
    app.start();
  }catch{console.error('FAIL PILOT_CONFIGURATION_OR_RESOURCES');process.exitCode=1;}
}
module.exports={createPilotServer};
