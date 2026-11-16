# Estado actual — Twogramms (piloto)

## Preparación de entrenamiento y Peso y hábitos para preproducción — 2026-11-16
- [U] Autorizados commit y push exclusivamente a `origin/pilot/isolated-activation`, incluidos los nuevos archivos de esta tarea. Sin despliegue.
- [C] Rama verificada y base local/remota coincidente en `c72ab1fffcc7cf0c7e2f55e126d113beb04134dd`. Revisados diez archivos: cuatro de aplicación, `.dockerignore` para incluir el nuevo módulo, dos pruebas y tres documentos de continuidad. Excluidos AGENTS.md, CSV y SQL.
- [C] Sin cambios funcionales en esta preparación; se conservan las 9/9 pruebas específicas aprobadas en la reanudación. Las restricciones anteriores de commit/push describen sesiones previas. Validación visual remota pendiente; no se requiere migración según las pruebas locales.

## Entrenamiento múltiple y apertura de Peso y hábitos — 2026-11-16
- [C] Reanudación tras interrupción: inspección confirmó ambas mejoras completas localmente en `pilot/isolated-activation`. No fue necesario modificar código. Ejecutadas únicamente `training-ui.test.cjs` y `training-persistence.test.cjs`: 9/9 aprobadas; continúa pendiente la validación visual remota.
- [U] Autorizadas ambas mejoras puntuales, sin duración, cambios nutricionales, commit, push ni despliegue.
- [C] Selección múltiple: Fuerza, Cardio, HIIT/funcional, Deportes, Movilidad/recuperación, Otro y No entrené (excluyente). Las actividades se guardan en `values.trainingActivities`; el campo histórico `training` conserva la clasificación fuerza/sin fuerza compatible con el SQL actual. No se reescriben registros anteriores ni se interpreta «sin fuerza» como «no entrené».
- [C] Peso y hábitos muestra carga inmediatamente y dibuja el formulario al recibir el historial; ya no espera también los macros. La comparación nutricional se añade después, con descarte de respuestas obsoletas. La apertura del diálogo ya era inmediata; el temporizador de 350 ms del shell solo enfoca un campo.
- [C] 33 pruebas distintas aprobadas: 32 en la primera ejecución conjunta y una regresión adicional del resumen semanal (8/8 en la segunda ejecución específica de UI). Persistencia y aislamiento comprobados con SQL existente en PGlite local; sin modificar SQL ni servicios remotos.
- [C] Pendiente validación visual y medición de latencia en navegador/preproducción. El historial autorizado sigue siendo necesario antes de editar; no se usa caché de datos para saltar esa verificación.

## Preparación de Progreso para validación — 2026-11-16
- [U] Autorizados commit y push de esta corrección exclusivamente a `origin/pilot/isolated-activation`; sin despliegue.
- [C] Rama comprobada; base local y remota coinciden en `c7e22e5ed4fc0dbf743f40c16c94e2a7373693ce`. Alcance revisado: cuatro archivos de aplicación, tres de pruebas (incluido el nuevo transporte) y tres documentos de continuidad. AGENTS.md, CSV y SQL quedan excluidos.
- [C] Sin cambios funcionales durante la preparación; se conservan las 59/59 pruebas aprobadas. Las menciones «sin commit/push» siguientes corresponden a la implementación previa a esta autorización. Sigue pendiente validación real en preproducción.

## Progreso — corrección local 2026-11-16
- [U] Progreso vacío en preproducción con sesión autorizada y Alimentación operativa; autorizada corrección mínima local, sin commit, push ni despliegue.
- [C] Historial envía únicamente gimnasio, cliente y fechas; guardados filtran campos por tipo (peso/hábitos), excluyendo `label`. Se mantiene la comprobación de sesión y se comprueba también después de leer el JSON.
- [C] Instancias independientes de macros para resumen de inicio/Progreso, formulario y detalle semanal. Progreso muestra carga, error y reintento, incluida la resolución inicial del cliente; logout y respuestas obsoletas no restauran vistas.
- [C] 59/59 pruebas específicas aprobadas (18 regresiones nuevas). Formulario, gráfica y reglas nutricionales conservados. Sin cambios en Supabase, Render ni producción.
- [C] Pendiente validación visual y de persistencia con sesión real en preproducción; las pruebas usaron datos sintéticos y transportes simulados/locales. No se implementaron mediciones corporales.

## Preparación para validación en Render — 2026-11-16
- [U] Autorizados commit de los siete archivos de esta corrección y push exclusivamente a `pilot/isolated-activation`; despliegue todavía no autorizado.
- [C] Revisión del diff: únicamente dos archivos de UI, dos archivos de pruebas y los tres documentos de continuidad. Los archivos sin seguimiento quedan excluidos. Antes del commit, la rama remota apunta a `50f25726e0269b5f6f2448eec962154fb4344a86`, base local de la corrección.
- [C] Se conservan los resultados 34/34 de la sesión de implementación; no se modificó código ni se repitieron pruebas durante la preparación. Sigue pendiente la validación visual tras un despliegue autorizado por separado.
- [C] Las menciones «sin commit/push» del apartado siguiente describen la sesión de implementación previa a esta autorización.

## 2026-11-16 — Alimentación durante la revalidación
- [C] Corrección local sin commit: el diario conserva contenido y fecha seleccionada, con interacción bloqueada, durante la verificación de sesión y la descarga. Sustituye el DOM tras comprobar usuario, cliente y gimnasio; rechazo, error o logout limpian la vista. Las respuestas obsoletas no restauran contenido.
- [C] 34/34 pruebas específicas de `complex-auth-ui.test.cjs` y `client-food-ui.test.cjs`, incluidas 13 regresiones nuevas. No se ejecutaron pruebas remotas ni se modificaron Supabase o Render; sin commit, push ni despliegue.
- [C] Pendiente validación visual en navegador real. La carga inicial con F5 no conserva contenido previo. El resumen de inicio conserva su última lectura durante una revalidación; el diario sí actualiza sus datos y resumen nutricional.
- [C] La corrección anterior del login ya está en el commit local `50f2572`; las referencias inferiores a aquella corrección como «sin commit» son históricas.

## Corrección local pendiente de revisión — parpadeo de autenticación
- [U] Al recuperar foco reaparece el login brevemente y vuelve Alimentación sin introducir credenciales.
- [C] `pilot-auth-ui.js` conserva la vista autorizada durante revalidaciones de foco, visibilidad y renovación de token; bloquea interacción con `inert`, incluidos los diálogos. Un rechazo o cierre de sesión oculta y limpia la vista.
- [C] 83 pruebas específicas pasan, incluidas 10 regresiones nuevas de revalidación, rechazo y respuestas tardías tras logout. Sin commit ni despliegue; pendiente comprobación visual en navegador. La carga inicial con F5 no se ha modificado.

Última actualización: 2026-11-14. Leer este archivo, `DECISIONES.md` e
`HISTORIAL_TECNICO.md` antes de proponer acciones; actualizarlos al cerrar cada
sesión solo con resultados comprobados.

Convención de evidencia:
- **[C]** Comprobado en código, git o pruebas locales ejecutadas.
- **[U]** Informado por el usuario; no verificable desde el repositorio.
- **[H]** Hipótesis pendiente de confirmar.

No registrar aquí contraseñas, tokens, claves, correos ni identificadores de
personas reales.

## 1. Repositorio

| Dato | Valor |
|---|---|
| Rama de trabajo | `pilot/isolated-activation` [C] |
| Remoto | `origin` → `github.com/ozielenriquez54/ozielenriquez54.github.io` [C] |
| Último commit enviado | `b707b58` (2026-11-14) — archivos de continuidad; presente en `origin/pilot/isolated-activation` [C] |
| Commit local sin enviar | `CLAUDE.md` con las reglas de continuidad (2026-11-14) [C] |
| Último cambio funcional | `e0a9aba` (2026-11-13) — mensajes de error de recuperación [C] |
| Commit anterior | `d157bdd` (2026-11-12) — activación aislada y experiencia del cliente [C] |
| Base de la rama | `7e46479`, igual que `origin/preprod-docker-test` [C] |
| `main` remoto | `2912afa` [C] |
| Sin seguimiento (no versionar) | `Supabase Snippet Untitled query (1).csv`, `verificacion-piloto.sql` [C] |

## 2. Proyectos Supabase que aparecen en el código [C]

| Ref | Uso según el código |
|---|---|
| `skwjntfknzakhcjlxlnh` | Nutrika original (`nutrika/index.html`, `coach.html`). |
| `otswebncqidqthqplztj` | Proyecto compartido por defecto del piloto (`pilot-config.cjs`, "producción"). |
| `fadbkbdbpuoekolfcbjm` | twogramms-test, proyecto aislado de pruebas (`isolated-pilot.cjs`). |

## 3. Despliegue

- Servicio Render `twogramms-preprod-test`, plan Free (sin Shell) [U].
- Repositorio conectado: el de la sección 1; rama configurada:
  `pilot/isolated-activation`; Auto-Deploy OFF [U].
- `Dockerfile` (`pilot-backend/deployment/Dockerfile`) arranca por defecto
  `node server/render-readonly.cjs` (solo lectura) [C]. El modo escritura exige
  Docker Command `node server/isolated-pilot.cjs` [C]. Si está configurado así: [U]
  (el HTTP 400, y no 503, de los endpoints del diario indica que el servicio de
  diario está activo [C por código: en solo lectura la ruta responde 503 `DIARY_DISABLED`]).
- Variables de Render cargadas y servicio "Live" [U]. Valores no verificables aquí.
- `isolated-pilot.cjs` exige origen `https://twogramms-preprod-test.onrender.com`
  y proyecto `fadbkbdbpuoekolfcbjm` [C].

## 4. Base de datos twogramms-test

- Instalados: 005, `complex-macros.sql`, `complex-diary.sql`,
  `complex-tracking.sql`, `complex-personal-foods.sql`; verificación 18/18 OK [U].
- Los 7 SQL del repositorio coinciden con `isolated-sql-manifest.json` (SHA-256) [C].
- Datos de prueba: 1 gimnasio, 2 membresías, 1 cliente, 1 asignación coach-cliente [U].
- Cliente de prueba: membresía activa, rol `CLIENT`, `scope_cliente = true`,
  `pilot_diary_server.rolcanlogin = true` [U].

## 5. Funciona

- Autenticación y sesión autorizada en Render [U].
- Redirección de recuperación a `/auth/callback.html` [U].
- Pruebas locales de los archivos tocados en las últimas sesiones: 83/83 de
  autenticación y recuperación; 30/30 y 36/36 de cliente, Render e
  isolated [C, ejecutadas 2026-11-12/13].
- Vista previa local sintética: `PILOT_LOCAL_PREVIEW=1`,
  `/preview/client-home.html` [C].

## 6. Problemas abiertos

### P1 — Diario, alimentos e historial devuelven HTTP 400 en Render
- Respuesta: `DIARY_REQUEST_REJECTED_OR_RESULT_UNKNOWN` [U]. Se genera en
  `pilot-backend/server/diary-http.cjs:23` y en `pilot-tracking-http.cjs:21`, que
  descartan el error real sin registrarlo [C].
- Prueba local con la misma configuración (`twogramms-db-check.cjs`):
  `28P01 password authentication failed for user "pilot_diary_server"` [U],
  tanto por Session Pooler como por conexión directa [U]. La contraseña local
  tiene 32 caracteres [U].
- El algoritmo del verificador SCRAM coincide byte a byte con el de PostgreSQL
  (PGlite, contraseña sintética) [C].
- `loadPostgresConfig` envía usuario y contraseña sin transformarlos [C].
- Pendiente: el resultado de la comprobación de configuración efectiva (host,
  puerto, usuario, longitud), propuesta el 2026-11-13, no se ha recibido.
- Hipótesis abiertas:
  - [H1] El `ALTER ROLE … PASSWORD` se ejecutó en el editor SQL de otro proyecto
    Supabase (el código usa tres refs; sección 2).
  - [H2] El valor pegado en el editor SQL o en la ventana local no es el generado.
  - [H3] Caché de credenciales del pooler compartido. Por sí sola no explica el
    28P01 por conexión directa [C: documentación de Supabase].

### P2 — Recuperación de contraseña
- Error previo «No se pudo verificar la recuperación…» [U]. Causa probable:
  verificador PKCE ausente (enlace abierto en otro navegador) o enlace de una
  solicitud anterior [H]; sin evidencia de red recibida.
- Bloqueo de nuevas solicitudes tras varios intentos [U]; probablemente HTTP 429
  del límite de correos de Supabase [H].
- Mitigado en código: `e0a9aba` muestra mensajes específicos (`RATE_LIMITED`,
  `LINK_OTHER_BROWSER`, `LINK_SUPERSEDED`) [C]. No consta que esté desplegado.
- Propuesto, sin aplicar: plantilla de correo con
  `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=recovery`.

## 7. Siguiente paso pendiente
Ejecutar la comprobación de configuración efectiva (sin autenticar) y, si es
correcta, confirmar en qué proyecto Supabase se aplicó el `ALTER ROLE` (H1),
antes de cualquier nuevo cambio de contraseña.

## 8. Archivos temporales fuera del repositorio [C]
- `%TEMP%\twogramms-db-check.cjs`: diagnóstico de solo lectura (conexión +
  `diary_state` con ROLLBACK).
- `%TEMP%\twogramms-pg-password.cjs`: generador de contraseña y verificador
  SCRAM; no guarda nada.
