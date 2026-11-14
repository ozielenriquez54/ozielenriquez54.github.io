# Historial técnico — Twogramms

Reconstruido el 2026-11-14 a partir de `git log` (73 commits), del código y de
los documentos del repositorio. Los hechos de sesiones anteriores al resumen
disponible no tienen otra fuente que los commits. Las marcas de evidencia se
explican en `ESTADO_ACTUAL.md`.

## 1. Nutrika original (2026-07-10 → 2026-09-17) [C: commits y código]

Aplicación monolítica en `nutrika/index.html` (3 577 líneas) y `nutrika/coach.html`
(709 líneas), con Supabase propio (`skwjntfknzakhcjlxlnh`), tablas `profiles`,
`plan_meta` y `daily_logs`, y la RPC `claim_client`.

Funcionalidades, con sus commits:
- Generador de comidas y macros: `b560551`. Motor `buildEngine` (index.html:1604).
- Calculadora de objetivos: `calcTargets` (:1853), `distributeMacros` (:1906).
- Plan de acción con *reverse dieting* y meta numérica: `2a4922e`, `d9f8425`,
  `c7cef2e`. Funciones `calcPlan` (:1912) y `calcGoalTimeline` (:1983).
- Edición de proteína y grasa con calorías fijas: `db78cb4`.
- Comidas fuera del plan y escaneo de código de barras: `4ab6f9a`, `2c9a463`,
  `1e9abfc`, `244cd40`.
- Base de alimentos (30 Day Challenge) y correcciones USDA: `d62fd31`, `d2539dc`,
  `0e47519`.
- Recetario Complex Training 12 Week Challenge (10 recetas), porciones a partir
  de la meta y relleno de macros: `3257a12`, `3011e15`, `865e2ad`, `4e114ee`, `f3eb883`.
- Proteína calculada sobre el peso meta si la diferencia supera 10 kg: `558cbb0`.
- Sincronización en la nube con Supabase: `d0049f3`, `4454333`, `88f93e9`.
- % de grasa corporal, historial y gráficas: `3d63150`. Funciones
  `buildTrendChart` (:2680) y `buildHabitBars` (:2705).
- Vista de coach, resumen semanal y asignación multi-coach / multi-gimnasio:
  `7e4611e`, `e982d52`, `b255eb1`, `3713fb0`.
- Fotos de progreso (frente, lado y espalda) en Supabase Storage: `fecfc06`.
  Función `uploadProgressPhoto` (:2286).
- Acceso por correo y contraseña (sustituye al magic link y al código):
  `6595c06`, `b88ffe4`, `d40fe7a`.
- Registro diario con progreso de macros y navegación por días: `7586be8`.
- Correcciones de seguridad y fechas (XSS, carreras, zona horaria): `5d6a320`,
  `f509498`, `23f09c2`. Rediseño visual: `5249946`.
- Nombres anteriores: `platoos` (`14cc262`), después Nutrika (`495ca20`).

Ninguna de estas páginas se sirve en el piloto Twogramms [C: `pilot-http.cjs`].

## 2. Piloto Twogramms (2026-10-21 → 2026-11-13) [C: commits]

- `2912afa`, `8ee227b`: Render en solo lectura y preproducción con Docker.
- `33dd07c` → `a1669f6`: recuperación de contraseña e invitaciones (enlaces
  privados, sesión verificada, callbacks implícitos).
- `f5ad9ae`, `a1cc1ec`: alta de clientes y activación automática al primer inicio.
- `9462850` → `f884856`: correcciones de revisiones P1/P2 (permisos, roles,
  aislamiento de proyecto, clasificación de errores, `setCoachClient`).
- `eb142b5` → `b1745ee`: runner local contra twogramms-test (CSP, origen
  `http://127.0.0.1`).
- `93cb311`, `0e4e264`, `7e46479`: autoservicio de gimnasio y rol COACH para
  OWNER; corrección de un `ReferenceError` en `render()`.
- `d157bdd` (2026-11-12): arranque aislado `isolated-pilot.cjs`; paquete SQL
  (001, 002, 005 y `complex-*`) con manifiesto; experiencia del cliente con Hoy,
  Alimentación, Progreso y Mi plan; diario por comidas con
  `mealId`/`mealType`, campos que el dominio ya guardaba; vista previa sintética;
  i18n parcial.
- `e0a9aba` (2026-11-13): clasificación de HTTP 429 y de los errores PKCE en
  la recuperación.
- `b707b58` (2026-11-14): archivos de continuidad `ESTADO_ACTUAL.md`,
  `DECISIONES.md` e `HISTORIAL_TECNICO.md`; enviado a `origin`.
- 2026-11-14: `CLAUDE.md` con las reglas de continuidad; commit local.

## 3. Estado de las funciones de Nutrika en Twogramms [C: código]
- **Reutilizado:** macros manuales del coach, solo lectura para el cliente;
  tolerancias de adherencia; lógica de tendencia de peso y barras de hábitos
  (trasladadas a `pilot-client-home-ui.js`).
- **Desarrollado y conectado solo con la activación aislada:** diario, peso,
  hábitos, historial del coach y alimentos personales.
- **No integrado:** calculadora de objetivos y plan, generador de menús y
  recetario, % de grasa, fotos de progreso y escáner de código de barras.

## 4. Activación de twogramms-test (cronología de 2026-11-12/13)
1. Primera verificación remota (CSV del 2026-11-12, 432 filas, previa a 005):
   faltaban las tablas de 005; los objetos `complex-*` estaban ausentes [C: CSV
   local]. La misma verificación marcó con BLOQUEO los privilegios de
   `anon`/`authenticated` sobre las tablas de identidad, con RLS forzado y solo
   políticas SELECT [C]. Sin revisión posterior.
2. Instalación de 005 y de `complex-macros`, `-diary`, `-tracking` y
   `-personal-foods`; verificación 18/18 [U].
3. Commit `d157bdd` y push de la rama [C].
4. Render configurado con la rama y Auto-Deploy OFF [U].
5. Autorización del par en `complex_macro_scope` [U: `scope_cliente = true`].

## 5. Intentos fallidos y diagnósticos

### 5.1 HTTP 400 en el diario y el seguimiento (abierto)
| Fecha | Acción | Resultado |
|---|---|---|
| 2026-11-13 | Consulta del estado del cliente | Membresía, rol, scope y LOGIN correctos [U] |
| 2026-11-13 | Propuesta de prueba desde Render Shell | No disponible en el plan Free [U] |
| 2026-11-13 | `twogramms-db-check.cjs` local por Session Pooler | 28P01 [U] |
| 2026-11-13 | Cambio de contraseña (verificador SCRAM) en Supabase y Render, 1.ª vez | 28P01 persiste [U] |
| 2026-11-13 | Segundo cambio de contraseña | 28P01 persiste [U] |
| 2026-11-13 | Comparación del algoritmo SCRAM contra PostgreSQL (PGlite) | Idéntico [C] |
| 2026-11-13 | Prueba directa, sin pooler | 28P01; longitud de contraseña 32 [U] |
| 2026-11-13 | Comprobación de configuración efectiva (sin autenticar) | Propuesta; resultado no recibido |

Conclusión provisional: el código del cliente PostgreSQL no altera las
credenciales [C], y el 28P01 también ocurre sin pooler [U]. La causa está en la
correspondencia entre la contraseña enviada y la almacenada en el proyecto
destino [H]. Ver H1 y H2 en `ESTADO_ACTUAL.md`.

### 5.2 Recuperación de contraseña
| Fecha | Acción | Resultado |
|---|---|---|
| 2026-11-13 | Diagnóstico del mensaje genérico | Cualquier error de Auth acababa en `AUTH_FAILED` [C] |
| 2026-11-13 | Varios correos de recuperación seguidos | Nuevas solicitudes bloqueadas [U]; límite 429 probable [H] |
| 2026-11-13 | Corrección `e0a9aba` | Mensajes específicos; 6 pruebas nuevas, 83/83 [C] |

## 6. Información no verificable desde el repositorio
- El estado real de Render: comando efectivo, variables, despliegue de
  `e0a9aba` y registros.
- El contenido real de twogramms-test (objetos instalados, roles, datos y
  contraseña vigente) y en qué proyecto se ejecutó cada `ALTER ROLE`.
- Los registros de Supabase (Auth, Postgres y Pooler).
- Si el repositorio de GitHub es público.
- El estado del proyecto compartido `otswebncqidqthqplztj` y del Nutrika
  original `skwjntfknzakhcjlxlnh`.
- Las decisiones o pruebas de sesiones anteriores que no dejaron commit ni
  documento.
