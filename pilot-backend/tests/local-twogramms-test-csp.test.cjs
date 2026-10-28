'use strict';
// Prueba de regresión del CSP connect-src que recibe el navegador contra
// una instancia REAL de http.Server (puerto 0, asignado por el SO —
// nunca uno fijo, nunca deja nada escuchando al terminar), con
// EXACTAMENTE la misma combinación de configuración que usa
// pilot-backend/server/local-twogramms-test-server.cjs (readOnly:true +
// adminProvisioningService conectado + PILOT_PUBLIC_ORIGIN=http://127.0.0.1)
// contra el proyecto Supabase de pruebas aislado twogramms-test.
//
// Esto es, deliberadamente, una verificación de EXTREMO A EXTREMO del
// encabezado HTTP real que produce el servidor — no una inspección de
// código — para la auditoría sobre el commit 2835eb8 ("el problema CSP
// persiste"). Nunca accede a Supabase real ni a ningún Supabase: solo
// inspecciona el encabezado Content-Security-Policy que esta instancia
// efímera envía.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPilotServer } = require('../server/pilot-http.cjs');
const { createProvisioningInfrastructure } = require('../server/pilot-admin-provisioning-service.cjs');

const TEST_PROJECT_REF = 'fadbkbdbpuoekolfcbjm';
const TEST_SUPABASE_URL = `https://${TEST_PROJECT_REF}.supabase.co`;
const PUBLIC_ORIGIN = 'http://127.0.0.1:3000'; // mismo valor que usaría el runner contra ese proyecto

test('CSP connect-src del runner local permite EXCLUSIVAMENTE el proyecto de pruebas twogramms-test, nunca el compartido', async () => {
  const env = {
    PILOT_SUPABASE_PROJECT_REF: TEST_PROJECT_REF,
    PILOT_SUPABASE_URL: TEST_SUPABASE_URL,
    PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_test_runner',
    PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_test_runner_test_runner_test',
    PILOT_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    PILOT_HTTP_PORT: '3000', // solo para pasar loadPilotConfig; el test escucha en un puerto efímero (0) más abajo
  };
  const adminProvisioningService = createProvisioningInfrastructure({ env });
  const app = createPilotServer({ env, readOnly: true, adminProvisioningService });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const request = path => new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: app.server.address().port, path, method: 'GET', headers: { host: '127.0.0.1:3000' } },
        res => { let body = ''; res.on('data', x => body += x); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); },
      );
      req.on('error', reject); req.end();
    });

    const config = JSON.parse((await request('/pilot-config.json')).body);
    assert.equal(config.projectRef, TEST_PROJECT_REF);
    assert.equal(config.supabaseUrl, TEST_SUPABASE_URL);
    assert.equal(config.adminProvisioningAvailable, true);

    for (const path of ['/coach.html', '/index.html', '/auth/callback.html', '/']) {
      const response = await request(path);
      assert.equal(response.status, 200, path);
      const csp = response.headers['content-security-policy'];
      // La aserción que de verdad responde al hallazgo reportado: el
      // navegador solo puede conectar vía fetch/XHR al proyecto de
      // pruebas exacto — nunca al compartido/producción.
      assert.ok(csp.includes(`connect-src 'self' ${TEST_SUPABASE_URL}`), `${path}: ${csp}`);
      assert.ok(!csp.includes('otswebncqidqthqplztj'), `${path}: ${csp}`); // el proyecto compartido NUNCA debe aparecer
      assert.ok(csp.includes("form-action 'none'"), `${path}: ${csp}`); // la protección que NO debía debilitarse
    }
  } finally {
    app.server.close();
  }
});
