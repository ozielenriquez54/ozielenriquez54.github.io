# Decisiones — Twogramms

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
