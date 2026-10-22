# Render Free: frontend y backend, escritura de negocio cerrada

Preparado localmente. No se creó servicio, cuenta o invitación; no se modificó
Supabase. El Dockerfile usa Node 22, lockfile y usuario sin privilegios.
El launcher no carga la composición activa ni recibe credenciales PostgreSQL.
Guardar, diario, administración y creación automática de perfiles están cerrados.
Auth permite iniciar/cerrar sesión y, cuando se autorice una invitación real,
aceptarla y definir contraseña. Estas operaciones Auth no activan datos de negocio.

## Publicación futura, sujeta a autorización

1. Subir una revisión revisada a GitHub con los archivos enumerados literalmente
   en `.dockerignore`, además de `.dockerignore` y `render.yaml`. No usar `git add .`:
   este workspace contiene trabajo anterior y material privado no versionado.
   `.gitignore` es una defensa adicional; no elimina secretos ya versionados.
2. Render → New → Blueprint → conectar repositorio y revisión revisada → leer
   `render.yaml`. Seleccionar Free y proporcionar solo
   `PILOT_SUPABASE_PUBLIC_KEY` (clave publicable de este proyecto). La creación del
   Blueprint realiza el primer despliegue: no confirmarla sin autorización.
   Los siguientes despliegues automáticos quedan desactivados.
3. Render proporciona `PORT` y `RENDER_EXTERNAL_URL`; el launcher escucha en
   `0.0.0.0:PORT` y solo admite el Host HTTPS asignado. Opcionalmente se puede
   fijar `PILOT_PUBLIC_ORIGIN` exactamente a ese origen. No introducir DB passwords,
   claves secretas, service_role ni variables para activar escrituras.
4. Verificar frontend, callback servido y capacidades cerradas en
   `/pilot-config.json`. No hay migraciones al arrancar ni durante la build.

## Invitación (preparada; NO enviar todavía)

- Con autorización independiente: Site URL = origen HTTPS realmente asignado;
  añadir exactamente `ORIGEN/auth/callback.html` a Redirect URLs, conservando
  otras URLs necesarias. Sin comodines.
- La plantilla `invite-template.html` debe configurarse en Supabase Auth antes
  de invitar. Usa TokenHash en fragmento, que no se envía al host ni a sus logs.
  El callback limpia la dirección antes de cargar configuración y verifica
  `type: invite` con Supabase; comprueba usuario real, permite definir contraseña
  y deja el acceso pendiente si todavía no hay perfil/membresía.
- El enlace predeterminado de invitación con access_token en fragmento se rechaza
  intencionalmente. La plantilla preparada es obligatoria. PKCE sigue funcionando
  para enlaces iniciados en el navegador; no se acepta `next` ni redirects libres.
- Confirmar SMTP para destinatarios externos, comprobar duplicados por correo,
  y solo entonces enviar la invitación desde una herramienta administrativa
  controlada. No incluir la credencial administrativa en Render.
- Perfil CLIENT, membresía y asignación al coach se provisionan por separado
  bajo autorización; el despliegue de lectura no los crea automáticamente.

## Validación y límites

Resultado local: PASS, 20 pruebas relacionadas. Incluye arranque de un artefacto
aislado sin los dos m?dulos administrativos. Ambos originales se conservan fuera
del contexto Docker y del commit. Build Docker: PENDIENTE (Docker no disponible).
Comando: `node --test tests/render-readonly.test.cjs tests/pilot-auth.test.cjs
tests/complex-auth-ui.test.cjs` desde pilot-backend.
La regresi?n HTTP local adicional (4 pruebas) pas? en el workspace original;
no se incluye en el paquete porque prueba administraci?n local excluida.
No se repitieron auditorías de migraciones ni se hicieron peticiones a Supabase.
Docker no está disponible en esta sesión: la build del contenedor y la recepción
de correo real quedan pendientes. Render Free puede dormir y suspender por cuotas.
No confundir publicación de lectura con autorización para el piloto con escritura.

Referencias: https://render.com/docs/blueprint-spec ;
https://supabase.com/docs/guides/auth/auth-email-templates ;
https://supabase.com/docs/reference/javascript/auth-verifyotp
