'use strict';
(function (root) {
  // UI "Agregar cliente" para el panel de coach. Mismo patrón que
  // pilot-coach-history-ui.js (mount/clear/refresh) y el manejo de estado
  // ocupado/errores de pilot-auth-ui.js. No decide por sí sola si está
  // autorizada a mostrarse — vive dentro de #pilot-access, que ya se
  // oculta/muestra según el estado de autenticación.
  //
  // Elección de UX deliberada: el selector de "coach asignado" pide el ID
  // del coach (no un nombre) porque no pude confirmar si profiles expone un
  // nombre/correo legible por otro coach sin verificar su contrato — ver
  // PROVISIONING-GAP.md. Se precarga con el ID del propio coach que hizo
  // sesión, que cubre el caso común de un solo coach por gimnasio sin pedir
  // que nadie copie/pegue un UUID a mano. El gimnasio NO se pide a mano: se
  // obtiene de la propia membresía activa del coach que inició sesión
  // (gym_memberships ya es legible sin modo admin) — el servidor igual
  // valida que esa membresía sea COACH/OWNER activa en ese gym_id exacto.
  const MESSAGES = {
    AUTH_REQUIRED: 'Tu sesión expiró. Vuelve a iniciar sesión.',
    '42501': 'Tu cuenta no tiene permiso de coach activo para dar de alta clientes.',
    INVALID_EMAIL: 'Escribe un correo válido.',
    INVALID_NAME: 'Escribe un nombre.',
    INVALID_COACH: 'El coach indicado no tiene una membresía de coach activa en este gimnasio.',
    INVALID_GYM: 'No se pudo determinar tu gimnasio activo. Vuelve a iniciar sesión.',
    USER_NOT_FOUND: 'Ese correo todavía no tiene cuenta en Twogramms y la creación automática no está disponible en este entorno. Contacta al administrador del proyecto.',
    REVISION_CONFLICT: 'Otra operación modificó este registro al mismo tiempo. Intenta de nuevo.',
    RELATED_RECORD_NOT_FOUND: 'Uno de los registros relacionados no se encontró. Verifica los datos e intenta de nuevo.',
    ADMIN_INVITE_EMAIL_EXISTS: 'Ese correo ya tiene una cuenta activada en Twogramms.',
    ADMIN_INVITE_UNAVAILABLE: 'Reenviar invitaciones no está disponible en este entorno.',
    RATE_LIMIT_EXCEEDED: 'Demasiadas solicitudes seguidas. Espera un minuto e intenta de nuevo.',
    PROVISIONING_SERVICE_UNAVAILABLE: 'No se pudo completar la operación. Intenta de nuevo.',
    PROVISIONING_RESULT_UNKNOWN: 'No se pudo confirmar el resultado (problema de conexión). Verifica el estado antes de reintentar.',
  };
  function messageFor(code) { return MESSAGES[code] ?? 'No se pudo completar la operación. Intenta de nuevo.'; }

  function mount(container, { client, document: doc = root.document }) {
    let epoch = 0, busy = false;
    const node = (tag, text) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = String(text); return n; };

    function clear() { epoch++; container.replaceChildren(); }

    async function call(path, { method = 'POST', body: payload } = {}) {
      const session = await client.auth.getSession();
      const token = session.data?.session?.access_token;
      if (!token) return { error: 'AUTH_REQUIRED' };
      const res = await fetch(path, {
        method, headers: payload ? { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token } : { Authorization: 'Bearer ' + token },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const json = await res.json().catch(() => ({ error: 'PROVISIONING_RESULT_UNKNOWN' }));
      return res.ok ? { data: json.data } : { error: json.error ?? 'PROVISIONING_SERVICE_UNAVAILABLE' };
    }

    async function ownActiveGymId() {
      const session = await client.auth.getSession();
      const id = session.data?.session?.user?.id;
      if (!id) return null;
      const membership = await client.from('gym_memberships').select('gym_id,active').eq('user_id', id).eq('active', true);
      return membership.data?.[0]?.gym_id ?? null;
    }

    async function refresh() {
      clear();
      const ticket = epoch;
      const heading = node('h3', 'Agregar cliente'); container.append(heading);
      const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); container.append(status);
      const form = doc.createElement('form');
      const nameField = node('label', 'Nombre '), nameInput = doc.createElement('input'); nameInput.required = true; nameInput.maxLength = 200; nameField.append(nameInput);
      const emailField = node('label', 'Correo '), emailInput = doc.createElement('input'); emailInput.type = 'email'; emailInput.required = true; emailField.append(emailInput);
      const coachField = node('label', 'ID del coach asignado '), coachInput = doc.createElement('input'); coachInput.required = true; coachInput.maxLength = 64; coachField.append(coachInput);
      const submit = node('button', 'Agregar cliente'); submit.type = 'submit';
      const resend = node('button', 'Reenviar invitación'); resend.type = 'button';
      form.append(nameField, emailField, coachField, submit); container.append(form, resend);

      let gymId = null;
      try {
        const session = await client.auth.getSession();
        if (ticket !== epoch) return;
        const id = session.data?.session?.user?.id;
        if (id) coachInput.value = id;
        gymId = await ownActiveGymId();
        if (ticket !== epoch) return;
      } catch { /* deja los campos vacíos; el coach puede escribir el ID a mano */ }
      if (!gymId) status.textContent = messageFor('INVALID_GYM');

      function setBusy(value) { busy = value; [nameInput, emailInput, coachInput, submit, resend].forEach(el => { el.disabled = value; }); }

      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        if (!gymId) { status.textContent = messageFor('INVALID_GYM'); return; }
        setBusy(true); status.textContent = 'Agregando…';
        const result = await call('/api/admin/clients', { body: { name: nameInput.value.trim(), email: emailInput.value.trim(), coachId: coachInput.value.trim(), gymId } });
        if (ticket !== epoch) return;
        setBusy(false);
        if (result.error) { status.textContent = messageFor(result.error); return; }
        status.textContent = 'Cliente agregado. Invitación enviada a ' + result.data.email + '.';
        form.reset();
        const id2 = (await client.auth.getSession()).data?.session?.user?.id;
        if (id2) coachInput.value = id2;
      });

      resend.addEventListener('click', async () => {
        if (busy) return;
        if (!gymId) { status.textContent = messageFor('INVALID_GYM'); return; }
        if (!emailInput.value.trim()) { status.textContent = 'Escribe el correo antes de reenviar.'; return; }
        setBusy(true); status.textContent = 'Reenviando…';
        const result = await call('/api/admin/clients/resend-invite', { body: { email: emailInput.value.trim(), gymId } });
        if (ticket !== epoch) return;
        setBusy(false);
        status.textContent = result.error ? messageFor(result.error) : 'Invitación reenviada a ' + result.data.email + '.';
      });
    }

    return { clear, refresh };
  }

  const api = { mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PilotAdminProvisioningUI = api;
})(typeof globalThis === 'object' ? globalThis : this);
