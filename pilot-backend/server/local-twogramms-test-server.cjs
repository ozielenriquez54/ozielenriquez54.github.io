'use strict';
// ============================================================================
// RUNNER LOCAL — exclusivo para probar el flujo OWNER -> alta de cliente ->
// activación -> asignación de coach contra el proyecto Supabase de pruebas
// AISLADO `twogramms-test` (fadbkbdbpuoekolfcbjm). NUNCA toca producción ni
// el servicio Render ya desplegado (`twogramms-pilot`, en render.yaml):
//
//   - El project ref y la URL de Supabase quedan FIJOS en este archivo, NO
//     se leen del entorno. Así, ninguna variable que ya exista en tu shell
//     (p. ej. de otra sesión apuntando al proyecto compartido) puede
//     desviar este runner a otro proyecto por accidente.
//   - No crea, modifica ni lee `render.yaml` ni ningún servicio de Render.
//     Es, deliberadamente, un proceso aparte que corre en tu máquina.
//   - Reutiliza `createPilotServer` (pilot-http.cjs) y
//     `createProvisioningInfrastructure` (pilot-admin-provisioning-service.cjs)
//     TAL CUAL — este archivo no reimplementa ninguna lógica de negocio,
//     solo los cablea con la configuración correcta para este entorno.
//   - Escucha exclusivamente en 127.0.0.1: ya lo garantiza `loadPilotConfig`
//     en pilot-config.cjs (`host:'127.0.0.1'`, fijo); este archivo no lo
//     cambia ni lo necesita cambiar.
//   - Nunca imprime `PILOT_SUPABASE_SERVICE_KEY` ni ningún valor derivado
//     de ella — solo confirma, por nombre, si está presente y bien
//     formada.
//
// Variables de entorno que SÍ debes dar (nunca las de producción; todas
// deben pertenecer al proyecto twogramms-test):
//   PILOT_SUPABASE_PUBLIC_KEY   clave publicable (sb_publishable_...)
//   PILOT_SUPABASE_SERVICE_KEY  clave service_role/secret (sb_secret_...
//                               o un JWT eyJ... heredado)
//   PILOT_PUBLIC_ORIGIN         origin https:// exacto (sin ruta/query);
//                               puede ser un valor no alcanzable todavía
//                               si no vas a seguir el enlace real de la
//                               invitación — solo se usa para CONSTRUIR
//                               ese enlace, nunca se contacta desde aquí
//   PILOT_HTTP_PORT             opcional, por defecto 3000 (mismo default
//                               que el resto del proyecto)
//
// Uso:
//   PILOT_SUPABASE_PUBLIC_KEY=sb_publishable_xxx \
//   PILOT_SUPABASE_SERVICE_KEY=sb_secret_xxx \
//   PILOT_PUBLIC_ORIGIN=https://twogramms-test.local \
//   node server/local-twogramms-test-server.cjs
// ============================================================================

const PINNED_PROJECT_REF = 'fadbkbdbpuoekolfcbjm';
const PINNED_SUPABASE_URL = `https://${PINNED_PROJECT_REF}.supabase.co`;

// Fijos, NUNCA leídos del entorno — ver la nota de cabecera. Se
// sobrescribe cualquier valor preexistente en process.env a propósito.
process.env.PILOT_SUPABASE_PROJECT_REF = PINNED_PROJECT_REF;
process.env.PILOT_SUPABASE_URL = PINNED_SUPABASE_URL;

const problems = [];

function requireEnv(name, pattern, hint) {
  const value = process.env[name];
  if (!value) {
    problems.push(`Falta la variable obligatoria ${name}. ${hint}`);
    return null;
  }
  if (pattern && !pattern.test(value)) {
    problems.push(`${name} tiene un formato inválido (su valor no se muestra aquí). ${hint}`);
    return null;
  }
  return value;
}

const publicKey = requireEnv(
  'PILOT_SUPABASE_PUBLIC_KEY',
  /^sb_publishable_[A-Za-z0-9_-]+$/,
  `Cópiala de twogramms-test (${PINNED_PROJECT_REF}) -> Project Settings -> API Keys -> Publishable key. Nunca la del proyecto compartido/producción.`,
);
const serviceKey = requireEnv(
  'PILOT_SUPABASE_SERVICE_KEY',
  /^(eyJ[A-Za-z0-9._-]{20,}|sb_secret_[A-Za-z0-9_-]{20,})$/,
  `Cópiala de twogramms-test (${PINNED_PROJECT_REF}) -> Project Settings -> API Keys -> service_role/secret key. Sin ella, "alta de cliente" para un correo que todavía no tiene cuenta falla con USER_NOT_FOUND.`,
);
const publicOrigin = requireEnv(
  'PILOT_PUBLIC_ORIGIN',
  // Acepta https:// (cualquier host) o, EXCLUSIVAMENTE,
  // http://127.0.0.1[:puerto] — el mismo y único relajo que ya aplican
  // pilot-config.cjs e inviteRedirectTo() en pilot-admin-provisioning-service.cjs
  // para el proyecto de pruebas aislado. Este runner nunca apunta a otro
  // proyecto (PINNED_PROJECT_REF, fijo arriba), así que no hace falta
  // repetir aquí esa condición — pero sigue exigiendo HTTPS para
  // cualquier host que no sea 127.0.0.1.
  /^(https:\/\/[^/?#\s]+|http:\/\/127\.0\.0\.1(?::\d+)?)$/,
  'Un origin https:// exacto (sin ruta/query/hash), o http://127.0.0.1[:puerto] — la única excepción, válida solo para este runner. Sin ella, invitar a un correo nuevo falla con PILOT_PUBLIC_ORIGIN_REQUIRED en el momento de enviar la invitación.',
);

if (problems.length > 0) {
  console.error('ARRANQUE DETENIDO — configuración obligatoria incompleta o inválida:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const { createPilotServer } = require('./pilot-http.cjs');
const { createProvisioningInfrastructure } = require('./pilot-admin-provisioning-service.cjs');

let adminProvisioningService;
try {
  adminProvisioningService = createProvisioningInfrastructure({ env: process.env });
} catch (e) {
  console.error('No se pudo preparar el servicio de alta de clientes:', e.message);
  process.exit(1);
}

let app;
try {
  // readOnly:true, igual que el arranque real de Render
  // (render-readonly.cjs): cierra diario/macros/tracking (que aquí ni
  // siquiera se conectan) sin afectar en nada a la alta de clientes ni a
  // la asignación de coach, que nunca dependen de readOnly.
  app = createPilotServer({ env: process.env, readOnly: true, adminProvisioningService });
} catch (e) {
  console.error('No se pudo iniciar el servidor piloto:', e.message);
  process.exit(1);
}

if (!app.config.publicKey) {
  console.error('PUBLIC_KEY_REQUIRED');
  process.exit(1);
}
if (app.config.projectRef !== PINNED_PROJECT_REF || app.config.supabaseUrl !== PINNED_SUPABASE_URL) {
  // Nunca debería ocurrir (ref y URL quedan fijos arriba) — defensa en
  // profundidad por si algo en el futuro cambia ese cableado. Si esto
  // llega a dispararse, créelo: significa que ESTE proceso ya no tiene
  // la CSP (connect-src) apuntando al proyecto de pruebas, así que nunca
  // debe quedar escuchando con esa configuración.
  console.error(`PROJECT_REF_MISMATCH: este runner solo debe apuntar a ${PINNED_PROJECT_REF} (${PINNED_SUPABASE_URL}), pero createPilotServer resolvió projectRef=${app.config.projectRef} supabaseUrl=${app.config.supabaseUrl}.`);
  process.exit(1);
}

app.server.on('error', e => { console.error('FAIL_PILOT_START', e.code || e.message); process.exitCode = 1; });
app.server.once('listening', () => {
  console.log('TWOGRAMMS — entorno de pruebas aislado (twogramms-test)');
  console.log(`Proyecto Supabase: ${app.config.projectRef} (fijo — nunca el compartido/producción)`);
  // Confirma explícitamente, con el valor REAL que createPilotServer
  // resolvió (no solo la constante fija de este archivo), el único
  // origen que la CSP del navegador permitirá en connect-src para esta
  // página — exactamente lo que hay que comparar contra cualquier
  // mensaje de "violates Content Security Policy directive: connect-src"
  // que Chrome muestre. Si alguna vez no coinciden, el proceso real que
  // está respondiendo en ese puerto NO es este runner con su código
  // actual (p. ej. quedó otro proceso viejo escuchando ahí, o se arrancó
  // pilot-http.cjs/render-readonly.cjs directamente) — nunca un defecto
  // de esta validación, que ya lo habría rechazado arriba antes de
  // llegar a escuchar.
  console.log(`CSP connect-src (Supabase permitido): ${app.config.supabaseUrl}`);
  console.log(`Escuchando en http://127.0.0.1:${app.config.port}/`);
  console.log('Alta de clientes (admin-provisioning): habilitada. Abre /coach.html para probar OWNER -> alta -> asignación de coach.');
});
app.start();
