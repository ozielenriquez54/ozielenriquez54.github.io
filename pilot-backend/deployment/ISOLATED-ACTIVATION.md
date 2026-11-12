# Paquete local de activación — twogramms-test

Destino único: `fadbkbdbpuoekolfcbjm`. Servicio candidato, pendiente de confirmar:
`https://twogramms-preprod-test.onrender.com`. Rama: `pilot/isolated-activation`.
Base: `7e46479cca7f5bf6076da03cfa24236d70f5e4ba`.

## Estado y límites

Preparación local; NO autoriza ni ejecuta migraciones, despliegues, invitaciones
o cambios de permisos. No se usaron credenciales reales. El Dockerfile y
render.yaml conservan su arranque de lectura. No se repitieron las 199 pruebas.

El usuario confirmó que 001/002 están presentes y que 005 falta. No se recibió
el resultado detallado de las 432 comprobaciones. Por eso NO se afirma equivalencia
con el esquema remoto ni se recomienda ejecutar SQL todavía. Las definiciones
de RLS y funciones tampoco quedan verificadas únicamente por recuentos o firmas.

## Qué se reutiliza

- Siete SQL originales copiados sin cambios desde la copia anterior del repositorio;
  ver `isolated-sql-manifest.json`. No tenían commit de procedencia: eran archivos
  locales sin seguimiento. 001/002 se conservan como referencia y fixtures, no
  como instrucciones de reinstalación remota.
- `prepareComplexServer` y servicios existentes de macros, diario, alimentos
  personales, seguimiento y alta administrativa.
- `server/isolated-pilot.cjs`: arranque separado con ref/URL/origen explícitos y
  cerrados al destino indicado; valida PostgreSQL/TLS/rol antes de preparar
  servicios, escucha en `0.0.0.0:PORT` y cierra servidor/pool al terminar.
- El servicio administrativo existente se conecta a esa composición. Su clave
  administrativa es opcional y solo sirve para invitaciones/búsqueda de cuentas;
  la persistencia clínica usa `pilot_diary_server`, no service_role.

## Revisión de 005

En una base local desechable, las versiones originales 001/002 admiten 005 y los
cuatro candidatos. 005 exige el propietario controlado de `can_access_client`,
superuser/BYPASSRLS, y rechaza propietarios alcanzables por roles de aplicación.
No modifica tablas de identidad. Crea versiones/objetivos/recibos de macros,
RLS/FORCE RLS y triggers; conserva `pilot_assign_manual_macros` sin EXECUTE para
aplicaciones. Solo el wrapper de alcance posterior permite esa operación.

Las pruebas locales también introducen default ACL excesivas de forma deliberada:
005 y los candidatos retiran esos grants de sus objetos nuevos sin cambiar los
default privileges globales. No se propone debilitar las verificaciones del SQL
para acomodarlo al destino remoto.

Conclusión: candidato reutilizable con evidencia local, NO aprobado aún para el
esquema instalado. Falta comparar columnas, tipos, claves/FK, triggers, cuerpos de
funciones/políticas, propietarios, ACL efectivas e herencia del proyecto aislado.

## Interpretación de las alertas remotas pendientes

No se han clasificado filas que no se recibieron. Criterios para hacerlo:

| Evidencia | Interpretación y acción mínima |
|---|---|
| Falta de tablas/funciones de 005 y comprobaciones dependientes | Una causa raíz puede producir muchas alertas. No significa 432 defectos. Confirmar antes de instalar 005. |
| `REVISAR` en funciones, constraints o políticas | La consulta lo emite por diseño incluso con objetos correctos. Comparar con el original; no revocar permisos por esa etiqueta. |
| Propietario privilegiado de SECURITY DEFINER | Esperado por los candidatos. Riesgo si roles de aplicación pueden heredarlo/asumirlo o el cuerpo no revalida acceso. |
| Rol actual distinto al propietario requerido | Bloqueo del instalador; no demuestra fuga de datos. No cambiar propietarios ni conceder BYPASSRLS automáticamente. |
| EXECUTE autenticado en RPC de identidad | Esperado si coincide con 002 y sus controles de rol/gimnasio. No equivale a permiso directo sobre todas las filas. |
| Escritura directa/EXECUTE de 005 para anon, authenticated o service_role | Desviación del contrato de 005. Revisar ACL, herencia, alcance y exposición; no aplicar revocaciones masivas. RLS no elimina un GRANT. |
| service_role con BYPASSRLS | Atributo administrativo esperado; su exposición al navegador sí sería crítica. Los nuevos objetos de 005 deben seguir cerrados también a ese rol. |
| RLS activo y firmas correctas | Insuficiente para validar aislamiento: revisar USING/WITH CHECK y cuerpo de cada función privilegiada. |
| Rol/tabla de activación ya existente | Colisión con CREATE, no prueba automática de vulnerabilidad. Detener instalación y comparar; nunca borrar para hacerla pasar. |

## Orden exacto, condicionado a autorización posterior

1. Recibir CSV/JSON de las 432 comprobaciones y confirmar en el panel el ref aislado.
   Comparar 001/002 instaladas con las referencias y revisar las alertas anteriores.
   Si las huellas no bastan, inspeccionar definiciones en una sesión de solo lectura
   controlada, sin copiar secretos. No reinstalar 001/002.
2. Confirmar en Render el servicio candidato, URL, repositorio/rama, commit, destino
   Supabase y ausencia de usuarios/datos de producción. Comprobar que la URL coincide
   con la constante del arranque. Si difiere, requiere revisión local, no un bypass.
3. Presentar y obtener autorización específica para la instalación en el aislado.
   Confirmar propietario/rol instalador y punto de recuperación del esquema aislado.
   Comparar hashes con el manifiesto. Los archivos tienen BEGIN/COMMIT propios,
   no son idempotentes y no forman una transacción conjunta.
4. Solo si los objetos de 005 están ausentes y sus prerrequisitos coinciden:
   `migrations/202610170005_manual_macros.sql`.
5. Comprobar propietarios, RLS/FORCE RLS, ACL, triggers y ausencia de EXECUTE directo
   para aplicaciones. No continuar si hay diferencias.
6. Instalar, individualmente y comprobando cada resultado:
   - `activation-drafts/complex-macros.sql`
   - `activation-drafts/complex-diary.sql`
   - `activation-drafts/complex-tracking.sql`
   - `activation-drafts/complex-personal-foods.sql`
   Conservar `complex_macro_scope` vacío y `pilot_diary_server` NOLOGIN al terminar
   esta fase. No ejecutar 003/004: no son dependencias de este recorrido.
7. Verificar las RPC administrativas de alta que ya utiliza el backend:
   `pilot_get_coach_client_state`, perfil, gimnasio, membresías y asignación.
   No asumir que las seis RPC reportadas incluyen las firmas correctas. La
   reanudación automática es opcional: usar el flujo manual existente si falta;
   no instalar PENDING-ACTIVATION automáticamente. Cualquier diferencia de alta se
   presenta para revisión antes de aplicar su SQL existente.
8. Tras autorización de configuración, habilitar credencial del rol limitado y CA
   por canal seguro. Usar `isolated-pilot.env.example`; verificar conexión TLS y
   `current_user=pilot_diary_server`. No usar postgres como sustituto en la app.
   Configurar Auth Site URL/callback exacto, correo e invitaciones en el aislado.
9. Tras autorización de despliegue, construir la imagen del commit revisado con el
   Dockerfile existente. En el servicio aislado únicamente, usar como comando:
   `node server/isolated-pilot.cjs`. No activar por variables el launcher antiguo.
   El marcador `PILOT_ISOLATED_WRITE_ACK` es una guarda, no una autorización humana.
10. Probar primero con datos ficticios: gimnasio A, otro gimnasio B, propietario,
    coach y 3–5 clientes de ensayo. Aprovisionar con flujos existentes. Resolver UUID
    reales del ensayo y autorizar explícitamente solo sus pares gym/coach/client
    en `complex_macro_scope`; no abrir alcance global ni copiar UUID de producción.
11. Completar los cinco controles de aceptación siguientes. Solo después presentar
    evidencia y solicitar autorización para incorporar el gimnasio externo y sus
    3–5 clientes reales. Las cuentas reales no se usan en ensayos destructivos.

## Aceptación remota pendiente (sin duplicar pruebas locales)

| Control | Evidencia requerida |
|---|---|
| Autenticación | Invitación/callback/login real de OWNER, COACH y CLIENT; rechazo de sesión ausente, expirada y ajena. |
| Multigimnasio | Con token de A, API/RPC contra UUID de B devuelve rechazo/sin datos; cero escrituras cruzadas. No usar Complex Training real. |
| Persistencia | Guardar macros, alimento personal, diario y peso/hábitos ficticios; cerrar sesión y reiniciar servicio; recuperar valores y revisiones idénticas. |
| Privacidad | Cliente solo propio; coach solo asignados; OWNER sin COACH no lee historial clínico. Revocar asignación y repetir acceso con la misma sesión. |
| Acceso externo | HTTPS, CSP/config del aislado, callback y recorrido de escritura desde otra red/dispositivo, sin cambiar producción. |

## Riesgos pendientes y retorno

- El wrapper de macros comprueba scope sin bloquear esa fila. Retirar scope no
  garantiza detener una operación que ya pasó esa comprobación. Para retirar el
  acceso de emergencia, detener primero el servicio y drenar solicitudes; la
  prueba local sí verifica revocación de la asignación coach-cliente para llamadas
  posteriores. No se amplía ni modifica SQL original en este paquete.
- RLS de lectura directa del diario permite al cliente activo leer sus propios
  datos aun fuera de scope; no permite leer datos ajenos. No confundir scope de
  piloto con revocación de identidad o membresía.
- `pilot_diary_server` puede suministrar un actor a funciones privadas. Su secreto
  debe permanecer exclusivamente en backend, que verifica JWT antes de cada uso.
- Volver al launcher `render-readonly.cjs` cierra escrituras clínicas, pero no
  necesariamente las operaciones de identidad/alta. Una parada total requiere
  detener el servicio, no confiar en la palabra readOnly. No borrar datos ni ejecutar
  migraciones inversas como retorno automático.
- Docker real, red/TLS PostgreSQL remota, Auth real, esquema remoto y Render siguen
  pendientes; las pruebas locales no los sustituyen.

## Verificación local reproducible

Resultado de esta preparación: **9 pruebas aprobadas, 0 fallidas**, en Node
24.19.0. Incluye seis subpruebas SQL y sus suites/controles HTTP. No demuestra
ejecución del contenedor Node 22 ni autenticación Supabase real. `git diff --check`
y la comprobación de sintaxis del launcher terminaron correctamente.

Desde la raíz del repositorio:

```powershell
node --test --test-reporter=spec pilot-backend/tests/isolated-pilot.test.cjs pilot-backend/tests/isolated-activation-sql.test.cjs
```

La suite SQL usa PGlite persistente en un directorio temporal exclusivo, datos
ficticios, dos gimnasios y las migraciones originales. Cierra/reabre la base para
comprobar persistencia. No importa clientes Supabase ni toma credenciales del entorno.
La suite HTTP usa loopback, claves ficticias, CA pública y rechaza fetch externo;
no envía solicitudes autenticadas que pudieran abrir conexiones PostgreSQL.
