# Enlaces administrativos privados del piloto

Preparación local. No ejecutar generateLink, crear usuarios, enviar correo ni cambiar
servicios sin autorización. El origen autorizado es
https://twogramms-preprod-test.onrender.com y el callback exacto es
https://twogramms-preprod-test.onrender.com/auth/callback.html.
El usuario confirmó que esta URL está autorizada en Supabase; no se modificó Auth.

## Procedimiento posterior a autorización

1. En un canal administrativo privado, comprobar por correo exacto y UUID si la
   cuenta ya existe, incluyendo todas las páginas. Invitación: solo nueva cuenta;
   si ya existe, detener creación y revisar estado. Recuperación: solo cuenta
   existente verificada. No crear otra ni definir contraseña por el cliente.
2. Usar auth.admin.generateLink con type=invite o type=recovery, email confirmado y
   options.redirectTo igual al callback exacto. No proporcionar password. Mantener
   credencial administrativa fuera de navegador, aplicación Render, Git y logs.
   Desactivar persistencia/auto-refresh de sesión en esa herramienta administrativa.
   No incluir credenciales en argumentos de terminal ni imprimir respuesta completa.
3. Exigir respuesta sin error, usuario correspondiente al destinatario, tipo y
   redirect_to esperados. Si difieren, detener entrega. Construir en memoria el enlace
   al callback fijo con #token_hash=<properties.hashed_token>&type=<tipo> usando
   URLSearchParams. No usar action_link: puede conducir al flujo bearer que nuestra
   aplicación rechaza. No introducir token en query string, acortadores o analítica.
4. Enviar directamente al correo previamente confirmado con el correo existente,
   sin copias, seguimiento de clics ni enlaces públicos. generateLink no envía correo.
   El enlace es una credencial de un solo uso; no guardarlo en archivos de trabajo,
   logs, capturas, chat o evidencia. La entrega por correo necesariamente deja el
   mensaje en el proveedor: limitarlo a remitente y destinatario autorizados. No
   abrirlo para probarlo, reenviarlo a terceros ni comunicar contraseña temporal.
5. El cliente abre el enlace, el callback elimina el fragmento de la dirección,
   verifica OTP con el tipo exacto y consulta el usuario en Auth. Solo con sesión
   verificada muestra el formulario. La contraseña la elige el cliente y se envía
   por HTTPS directamente a auth.updateUser; el coach no la recibe.
6. Caducidad y reutilización las decide Supabase, no el navegador. Ante rechazo,
   mostrar error genérico y verificar identidad antes de generar un reemplazo
   autorizado; nunca desactivar comprobaciones de token. Si hubo compromiso de
   cuenta, evaluar además revocación explícita de sesiones bajo autorización.
7. Registrar solo resultado, fecha y referencia privada del usuario, sin token,
   enlace, contraseña ni respuesta Auth completa. Confirmar inicio de sesión del
   cliente con su contraseña. Perfil/membresía/asignación son una fase separada;
   ROLE_REQUIRED tras cambiar contraseña indica provisión pendiente, no fallo del
   cambio. Las escrituras del diario siguen deshabilitadas.

## Estado del cambio

El callback local admite invite y recovery mediante fragmento token_hash; PKCE se
conserva. Rechaza tipos distintos, tokens malformados, parámetros extra/duplicados,
mezcla de query/fragmento y bearer tokens. La fecha de caducidad de un hash opaco no
se calcula localmente: verifyOtp debe aceptarlo y getUser confirmar la identidad.
La validación de longitud mínima local es 8; Supabase aplica su política adicional.

Pruebas locales usan exclusivamente valores sintéticos y respuestas Auth simuladas;
no certifican entrega real ni la configuración remota de expiración. Publicar el
commit no despliega Render con Auto Deploy desactivado: el servicio conserva la
versión anterior sin recovery de este tipo hasta el despliegue manual autorizado
y la verificación del callback. El servicio original permanece sin cambios.

Referencias: https://supabase.com/docs/reference/javascript/auth-admin-generatelink
y https://supabase.com/docs/reference/javascript/auth-updateuser.
