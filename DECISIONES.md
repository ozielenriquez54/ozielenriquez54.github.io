# Decisiones — Twogramms

- [U, 2026-11-16, preparación de entrenamiento] Autorizados commit de los diez archivos revisados y push exclusivamente a `origin/pilot/isolated-activation`, incluyendo los tres archivos nuevos de esta tarea. Sustituye la prohibición anterior de commit/push para estas mejoras. Excluir AGENTS.md, CSV, SQL y archivos ajenos; sin despliegue ni cambios en Supabase, producción u otras ramas.

- [U/C, reanudación de entrenamiento] Conservar los cambios locales existentes y completar solo lo pendiente. La inspección confirmó implementación completa; se mantuvo el código y se verificaron únicamente las dos suites específicas solicitadas. No requiere migración de base de datos: utiliza el JSON y las funciones SQL existentes, comprobado localmente.

- [U, 2026-11-16, entrenamiento] Implementar selección múltiple sin duración y mejorar la espera de Peso y hábitos; conservar historia, aislamiento y reglas nutricionales. Sin commit, push ni despliegue.
- [C] Persistencia aditiva en el JSON existente: `trainingActivities` es opcional, validado y excluye combinar NONE con actividades. `training` mantiene el significado histórico STRENGTH/NO_STRENGTH/null, derivado para registros nuevos. Un registro antiguo NO_STRENGTH no implica ausencia de toda actividad.
- [C] Guardar otros hábitos sin cambiar la selección conserva el dato histórico. El cumplimiento declarado de entrenamiento sigue independiente de las actividades; no se recalculan estadísticas históricas. El resumen semanal muestra los tipos registrados.
- [C] El historial autoriza y habilita el formulario; los macros enriquecen después su comparación nutricional. Se mantienen las comprobaciones de sesión, generaciones y aislamiento, sin modificar SQL.

- [U, 2026-11-16, preparación de Progreso] Autorizados commit de los diez archivos de corrección/pruebas/continuidad y push exclusivamente a `origin/pilot/isolated-activation`. Sustituye la restricción previa de commit/push para Progreso. No autoriza despliegue ni cambios en Supabase, producción u otras ramas; excluye AGENTS.md, CSV, SQL y archivos ajenos.

- [U, 2026-11-16, Progreso] Autorizada corrección mínima de campos, consultas concurrentes y estados de error/reintento, con pruebas específicas. Sin commit, push, despliegue, cambios de infraestructura ni reglas nutricionales.
- [C] El transporte de seguimiento usa listas explícitas de campos por endpoint y tipo de registro; el servidor mantiene sus validaciones. Se separan modelos cancelables del resumen, formulario y detalle semanal, reutilizando el formulario y la gráfica actuales.
- [C] Reintentar desde Progreso vuelve a consultar el cliente autorizado. La UI invalida botones y respuestas anteriores al limpiar la sesión; no muestra datos anteriores en estados de error.

- [U, 2026-11-16, preparación] Autorizados un commit local con los siete archivos de la corrección y push únicamente a `pilot/isolated-activation`. Esta autorización sustituye la prohibición anterior de commit/push para esta corrección. Se mantienen las prohibiciones de desplegar, incluir archivos sin seguimiento, modificar Supabase, producción u otras ramas.

- [U, 2026-11-16] Corregir únicamente la continuidad visual de Alimentación, con pruebas específicas y sin commit, push, despliegue ni cambios en Supabase o Render.
- [C] La recarga del diario conserva el DOM bloqueado y la fecha elegida hasta completar las lecturas. Se comprueba la sesión antes/después de verificar permisos y antes de sustituir el contenido; usuario, cliente o gimnasio distintos invalidan la vista. Se descartan cargas anteriores mediante generaciones.
- [C] Ante fallos de carga durante esta revalidación se limpia y bloquea el contenido. No se modificaron reglas nutricionales, comandos de registro ni cálculos de macros. El resumen de inicio no se recarga por foco para evitar su vaciado; conserva las actualizaciones existentes tras guardados y cambios de idioma.

- Revalidación visual (cambio local pendiente): conservar la última vista autorizada sin interacción mientras se comprueba la sesión; ocultar y limpiar ante rechazo, error o logout. Mantener las verificaciones de sesión y autorización existentes. No cambiar Supabase ni Render. [U: alcance autorizado; C: implementación local]

Registro de decisiones vigentes y de por qué se tomaron. Solo se incluyen las que
constan en código, commits, documentos del repositorio o en instrucciones
explícitas del usuario. Las marcas de evidencia se explican en `ESTADO_ACTUAL.md`.

## Producto y marca
- D1. La marca visible es **Twogramms**, no Complex Training [U, instrucción
  explícita]. Complex Training aparece como nombre del gimnasio de prueba y en
  contenidos heredados de Nutrika (recetario, aviso de privacidad) [C].
- D2. Twogramms se construye sobre Nutrika, reutilizando sus reglas, sin
  reconstruir funciones existentes [U].
- D3. No se cambian las reglas nutricionales. Tolerancias de adherencia en
  `nutrika/domain/tracking/adherence.cjs`: kcal 5 %, proteína 5 %,
  carbohidratos 10 %, grasas 10 % [C].
- D4. No se calcula ni se muestra % de grasa corporal en Twogramms mientras no
  exista en su backend [U]. (Nutrika original sí lo tenía; ver historial.)
- D5. Textos en español e inglés; la app avisa de que la traducción es parcial [C].

## Datos y seguridad
- D6. La experiencia autenticada no muestra datos ficticios ni simula
  guardados. La única excepción es la vista previa local, identificada como
  «DATOS SINTÉTICOS» y disponible solo con `PILOT_LOCAL_PREVIEW=1`, fuera de
  `readOnly` y sin origen público [C].
- D7. Aislamiento multigimnasio. Toda lectura y escritura del diario, el
  seguimiento y los alimentos personales pasa por funciones `SECURITY DEFINER`
  que exigen la membresía activa del propio cliente en el mismo gimnasio y una
  fila en `pilot_private.complex_macro_scope` [C: `complex-*.sql`].
- D8. El backend se conecta como `pilot_diary_server` (no `service_role` ni
  `postgres`), verifica el JWT con Supabase Auth antes de cada transacción y
  exige `current_user = pilot_diary_server` [C: `supabase-diary-store.cjs`].
- D9. `complex_macro_scope` empieza vacía; cada par gimnasio-coach-cliente se
  autoriza de forma explícita [C: `complex-macros.sql`, `ISOLATED-ACTIVATION.md`].
- D10. Los errores devueltos al navegador nunca incluyen mensajes del servidor,
  tokens ni URL. Solo pasan códigos de una lista permitida y el estado HTTP
  [C: `pilot-auth.js`].
- D11. Autenticación con PKCE (`flowType:'pkce'`). No cambiar el método sin
  aprobación [C, U].
- D12. Las contraseñas de roles se fijan con un verificador SCRAM generado
  localmente, nunca en texto plano en el chat ni en el editor SQL [U, 2026-11-13].

## Infraestructura
- D13. Render arranca por defecto en solo lectura (`render-readonly.cjs`). La
  escritura requiere un comando explícito (`isolated-pilot.cjs`) limitado a
  twogramms-test y a su origen [C].
- D14. `.dockerignore` funciona como lista blanca. La vista previa sintética
  no entra en la imagen [C].
- D15. Los 7 SQL de activación se versionan byte a byte (`.gitattributes`,
  `-text`) para conservar las huellas del manifiesto [C, d157bdd].
- D16. Conexión desde Render con el Session Pooler (`PILOT_PG_MODE=session`,
  usuario `pilot_diary_server.<ref>`), porque la conexión directa suele ser
  solo IPv6 [H en su origen; recomendado por el asistente, configurado según U].

## Forma de trabajo (instrucciones vigentes del usuario) [U]
- No modificar producción, SQL, Supabase, Render, permisos ni contraseñas sin
  autorización explícita para esa acción concreta.
- No hacer commit, push, merge ni despliegues sin autorización. Nunca usar
  `git add .`.
- No hacer auditorías generales. Probar solo lo relacionado con los archivos
  modificados.
- No afirmar que algo está listo para producción.
- No continuar con otras funcionalidades sin aprobación.
- Distinguir hechos comprobados de hipótesis y no inventar antecedentes.
- No usar comandos de eliminación (`rm`) en diagnósticos (2026-11-13).
- Instrucciones al usuario breves, una acción a la vez (2026-11-14).
- Continuidad: las reglas de sesión están en `CLAUDE.md`. Se leen los tres
  archivos de continuidad antes de actuar y se actualizan al cerrar, solo con
  resultados verificados (2026-11-14).
