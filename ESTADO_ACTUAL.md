# Estado actual — Twogramms (piloto)

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
