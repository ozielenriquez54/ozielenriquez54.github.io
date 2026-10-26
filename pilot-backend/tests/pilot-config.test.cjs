'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPilotConfig } = require('../server/pilot-config.cjs');

// P1 (auditoría sobre el commit 60afc33, "configuración de Supabase
// aislado"): antes, PILOT_SUPABASE_PROJECT_REF/PILOT_SUPABASE_URL solo
// podían CONFIRMAR el proyecto compartido por defecto — cualquier otro
// valor se rechazaba, así que no existía forma de apuntar este servidor a
// un proyecto Supabase realmente distinto (p. ej. una preproducción
// aislada, separada del proyecto compartido/producción). Estas pruebas
// cubren tanto el caso por defecto (sin cambios) como el aislado nuevo, y
// las combinaciones que deben rechazarse.

const DEFAULT_REF = 'otswebncqidqthqplztj';
const DEFAULT_URL = `https://${DEFAULT_REF}.supabase.co`;
// Otro project ref válido (20 caracteres alfanuméricos en minúscula),
// sintético — nunca un proyecto real.
const ISOLATED_REF = 'abcdefghij0123456789';
const ISOLATED_URL = `https://${ISOLATED_REF}.supabase.co`;

test('sin PILOT_SUPABASE_PROJECT_REF ni PILOT_SUPABASE_URL: usa el proyecto compartido por defecto (producción sin cambios)', () => {
  const config = loadPilotConfig({});
  assert.equal(config.projectRef, DEFAULT_REF);
  assert.equal(config.supabaseUrl, DEFAULT_URL);
});

test('con PILOT_SUPABASE_PROJECT_REF y PILOT_SUPABASE_URL dados y consistentes con el valor compartido: acepta, sin cambiar nada', () => {
  const config = loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: DEFAULT_REF, PILOT_SUPABASE_URL: DEFAULT_URL });
  assert.equal(config.projectRef, DEFAULT_REF);
  assert.equal(config.supabaseUrl, DEFAULT_URL);
});

test('configuración AISLADA válida: un project ref y URL distintos del compartido, dados juntos y consistentes, se aceptan', () => {
  const config = loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: ISOLATED_URL, PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_isolated_test' });
  assert.equal(config.projectRef, ISOLATED_REF);
  assert.equal(config.supabaseUrl, ISOLATED_URL);
  assert.equal(config.publicKey, 'sb_publishable_isolated_test');
  // El valor del proyecto compartido/producción no se tocó ni se mezcló.
  assert.notEqual(config.projectRef, DEFAULT_REF);
});

test('RECHAZA dar solo PILOT_SUPABASE_PROJECT_REF sin PILOT_SUPABASE_URL (configuración incompleta)', () => {
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF }), /PILOT_CONFIGURATION_REJECTED/);
});

test('RECHAZA dar solo PILOT_SUPABASE_URL sin PILOT_SUPABASE_PROJECT_REF (configuración incompleta)', () => {
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_URL: ISOLATED_URL }), /PILOT_CONFIGURATION_REJECTED/);
});

test('RECHAZA PILOT_SUPABASE_PROJECT_REF y PILOT_SUPABASE_URL dados pero MEZCLADOS (no corresponden al mismo proyecto)', () => {
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: DEFAULT_URL }), /PILOT_CONFIGURATION_REJECTED/);
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: DEFAULT_REF, PILOT_SUPABASE_URL: ISOLATED_URL }), /PILOT_CONFIGURATION_REJECTED/);
});

test('RECHAZA un PILOT_SUPABASE_PROJECT_REF con formato inválido (mayúsculas, símbolos, longitud distinta)', () => {
  for (const ref of ['ABCDEFGHIJ0123456789', 'short-ref', ISOLATED_REF + 'x', ISOLATED_REF.slice(0, 19), 'abcdefghij012345678!']) {
    assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ref, PILOT_SUPABASE_URL: `https://${ref}.supabase.co` }), /PILOT_CONFIGURATION_REJECTED/, ref);
  }
});

test('RECHAZA una PILOT_SUPABASE_URL con esquema, host o forma distinta de https://<ref>.supabase.co, aunque el ref sea válido', () => {
  for (const url of [`http://${ISOLATED_REF}.supabase.co`, `https://${ISOLATED_REF}.supabase.co/`, `https://${ISOLATED_REF}.supabase.co:443`, `https://evil.example/${ISOLATED_REF}`]) {
    assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: url }), /PILOT_CONFIGURATION_REJECTED/, url);
  }
});

test('la clave pública, el puerto y el origen público siguen validándose igual de estricto con un proyecto aislado', () => {
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: ISOLATED_URL, PILOT_SUPABASE_PUBLIC_KEY: 'sb_secret_not_a_public_key_000000' }), /PILOT_PUBLIC_KEY_REJECTED/);
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: ISOLATED_URL, PILOT_HTTP_PORT: '80' }), /PILOT_PORT_REJECTED/);
  assert.throws(() => loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: ISOLATED_URL, PILOT_PUBLIC_ORIGIN: 'http://not-https.example' }), /PILOT_PUBLIC_ORIGIN_REJECTED/);
});

test('nunca copia ni expone ningún secreto: el resultado solo contiene projectRef/supabaseUrl/publicKey/publicOrigin/host/port', () => {
  const config = loadPilotConfig({ PILOT_SUPABASE_PROJECT_REF: ISOLATED_REF, PILOT_SUPABASE_URL: ISOLATED_URL, PILOT_SUPABASE_PUBLIC_KEY: 'sb_publishable_isolated_test', PILOT_SUPABASE_SERVICE_KEY: 'sb_secret_should_never_appear_here00' });
  assert.deepEqual(new Set(Object.keys(config)), new Set(['host', 'port', 'projectRef', 'supabaseUrl', 'publicKey', 'publicOrigin']));
  assert.ok(Object.isFrozen(config));
});
