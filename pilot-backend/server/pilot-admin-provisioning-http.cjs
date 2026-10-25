'use strict';
const { ProvisioningError } = require('./pilot-admin-provisioning-service.cjs');
const { INPUT_LIMITS } = require('./gateway-safety.cjs');
const paths = new Set(['/api/admin/clients', '/api/admin/clients/resend-invite', '/api/admin/clients/status']);
const failure = (code, status) => new ProvisioningError(code, status);

function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const fail = e => { if (done) return; done = true; chunks = []; reject(e); };
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { req.resume(); fail(failure('CONTENT_ENCODING_REJECTED', 415)); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) { req.resume(); fail(failure('JSON_REQUIRED', 415)); return; }
    if (Number(req.headers['content-length']) > INPUT_LIMITS.bytes) { req.resume(); fail(failure('BODY_TOO_LARGE', 413)); return; }
    req.on('data', chunk => { if (done) return; size += chunk.length; if (size > INPUT_LIMITS.bytes) { fail(failure('BODY_TOO_LARGE', 413)); return; } chunks.push(chunk); });
    req.on('error', () => fail(failure('INVALID_BODY', 400)));
    req.on('aborted', () => fail(failure('INVALID_BODY', 400)));
    req.on('end', () => { if (done) return; done = true; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(failure('INVALID_JSON', 400)); } finally { chunks = []; } });
  });
}

// Misma forma que handleManualMacros/handleDiary: ruta exacta, chequeo de
// origen/sec-fetch-site, token Bearer del propio llamador, cuerpo JSON
// acotado. Solo se activa si se pasa un `service` — omitirlo en
// createPilotServer deja el comportamiento previo intacto (opt-in).
async function handleAdminProvisioning(req, res, service, approvedOrigin = null) {
  const route = req.url.split('?', 1)[0];
  if (!paths.has(route)) return false;
  if (!service) { res.writeHead(404); res.end(); return true; }
  const controller = new AbortController();
  req.once('aborted', () => controller.abort());
  res.once('close', () => controller.abort());
  const send = (status, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  try {
    const statusRoute = route.endsWith('/status');
    if (req.method !== (statusRoute ? 'GET' : 'POST')) throw failure('METHOD_REJECTED', 405);
    const origin = approvedOrigin ?? 'http://' + req.headers.host;
    if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw failure('ORIGIN_REJECTED', 403);
    const token = /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw failure('AUTH_REQUIRED', 401);
    const url = new URL(req.url, origin);
    let result;
    if (statusRoute) {
      const keys = [...url.searchParams.keys()];
      if (keys.length !== 2 || url.searchParams.getAll('email').length !== 1 || url.searchParams.getAll('gymId').length !== 1) throw failure('INVALID_QUERY', 400);
      result = await service.clientStatus({ token, email: url.searchParams.get('email'), gymId: url.searchParams.get('gymId'), signal: controller.signal });
    } else if (route.endsWith('/resend-invite')) {
      if ([...url.searchParams.keys()].length) throw failure('INVALID_QUERY', 400);
      result = await service.resendInvite({ token, command: await body(req), signal: controller.signal });
    } else {
      if ([...url.searchParams.keys()].length) throw failure('INVALID_QUERY', 400);
      result = await service.addClient({ token, command: await body(req), signal: controller.signal });
    }
    send(200, { data: result });
  } catch (e) {
    const known = e instanceof ProvisioningError;
    send(known ? e.status : 503, { error: known ? e.code : 'PROVISIONING_SERVICE_UNAVAILABLE' });
  }
  return true;
}

module.exports = { handleAdminProvisioning };
