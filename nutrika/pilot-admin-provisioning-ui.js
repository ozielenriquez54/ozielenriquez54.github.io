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
  // PROVISIONING-GAP.md. El gimnasio NO se pide a mano: se obtiene de la
  // propia membresía activa de quien inició sesión (gym_memberships ya es
  // legible sin modo admin) — el servidor igual valida que esa membresía
  // sea OWNER/ADMIN activa en ese gym_id exacto.
  //
  // Solo OWNER/ADMIN pueden EJECUTAR esta alta (COACH no tiene permiso; ver
  // PROVISIONER_ROLES en pilot-admin-provisioning-service.cjs). Esta vista
  // vive en coach.html, cuyo propio acceso (pilot-auth.js) exige el rol
  // 'COACH' en gym_memberships — así que un OWNER/ADMIN puro, sin 'COACH'
  // en su arreglo de roles, NUNCA llega a ver esta página. Documentado como
  // hallazgo de integración en PROVISIONING-GAP.md: no se modifica aquí el
  // modelo de acceso por página existente. Mientras tanto, esta vista
  // vuelve a leer el rol real para no mostrar un formulario que el
  // servidor rechazaría igual.
  const MESSAGES = {
    AUTH_REQUIRED: 'Tu sesión expiró. Vuelve a iniciar sesión.',
    '42501': 'Tu cuenta no tiene permiso de OWNER/ADMIN activo para dar de alta clientes en este gimnasio.',
    INVALID_EMAIL: 'Escribe un correo válido.',
    INVALID_NAME: 'Escribe un nombre.',
    // Corregido: el coach destino exige el rol COACH literal (confirmado
    // contra el contrato real de pilot_set_coach_client); OWNER/ADMIN ya no
    // sustituyen a COACH, salvo que la misma persona también tenga COACH.
    INVALID_COACH: 'El coach indicado no tiene una membresía activa con el rol COACH en este gimnasio.',
    INVALID_GYM: 'No se pudo determinar tu gimnasio activo. Vuelve a iniciar sesión.',
    USER_NOT_FOUND: 'Ese correo todavía no tiene cuenta en Twogramms y la creación automática no está disponible en este entorno. Contacta al administrador del proyecto.',
    REVISION_CONFLICT: 'Otra operación modificó este registro al mismo tiempo. Intenta de nuevo.',
    RELATED_RECORD_NOT_FOUND: 'Uno de los registros relacionados no se encontró. Verifica los datos e intenta de nuevo.',
    ADMIN_INVITE_EMAIL_EXISTS: 'Ese correo ya tiene una cuenta activada en Twogramms.',
    ADMIN_INVITE_UNAVAILABLE: 'Reenviar invitaciones no está disponible en este entorno.',
    // P1 (auditoría sobre el commit 26fd7fc): resendInvite ahora exige una
    // solicitud de activación pendiente y vigente en este gimnasio.
    NO_PENDING_ACTIVATION: 'Ese correo no tiene ninguna solicitud de activación pendiente en este gimnasio. Usa "Agregar cliente" en vez de reenviar.',
    // P1 (auditoría sobre el commit 26fd7fc, "sobrescritura de roles"): la
    // cuenta ya tiene un rol administrativo, pero está inactivo — reactivarlo
    // requiere una acción administrativa aparte, nunca "agregar cliente".
    BLOCKED_PRIVILEGED_ROLE: 'Esa cuenta ya tiene un rol administrativo (OWNER/ADMIN/COACH) inactivo en este gimnasio. Reactivarlo requiere una acción administrativa aparte, no se puede hacer agregándola como cliente.',
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

    // Lee TODAS las membresías activas (nunca solo la primera — P2,
    // auditoría sobre el commit 26fd7fc, "multigimnasio") para poder exigir
    // una selección explícita cuando quien inició sesión es OWNER/ADMIN en
    // más de un gimnasio. Elegir silenciosamente memberships.data[0] podía
    // enviar el alta a un gimnasio distinto del que la persona pretendía.
    async function ownActiveMemberships() {
      const session = await client.auth.getSession();
      const id = session.data?.session?.user?.id;
      if (!id) return null;
      const memberships = await client.from('gym_memberships').select('gym_id,roles,active').eq('user_id', id).eq('active', true);
      return (memberships.data ?? []).map(r => ({ gymId: r.gym_id, roles: r.roles ?? [] }));
    }

    async function refresh() {
      clear();
      const ticket = epoch;
      const heading = node('h3', 'Agregar cliente'); container.append(heading);
      const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); container.append(status);

      let ownRows = null;
      try { ownRows = await ownActiveMemberships(); } catch { /* se trata igual que "sin membresía" abajo */ }
      if (ticket !== epoch) return;
      if (!ownRows || ownRows.length === 0) { status.textContent = messageFor('INVALID_GYM'); return; }
      const eligible = ownRows.filter(r => r.roles.includes('OWNER') || r.roles.includes('ADMIN'));
      if (eligible.length === 0) { status.textContent = 'Tu cuenta tiene acceso a esta vista pero no permiso de OWNER/ADMIN para dar de alta clientes.'; return; }
      // Nunca se preselecciona un gimnasio cuando hay más de uno elegible:
      // gymId queda null hasta que la propia persona lo elige explícitamente
      // (o, si solo hay uno, es ese — sin fricción adicional para el caso
      // común). El backend (authorizeCaller) revalida de todas formas que
      // el gymId recibido sea exactamente uno donde el actor es OWNER/ADMIN
      // activo — esta UI nunca es la única barrera.
      let gymId = eligible.length === 1 ? eligible[0].gymId : null;

      const form = doc.createElement('form');
      const nameField = node('label', 'Nombre '), nameInput = doc.createElement('input'); nameInput.required = true; nameInput.maxLength = 200; nameField.append(nameInput);
      const emailField = node('label', 'Correo '), emailInput = doc.createElement('input'); emailInput.type = 'email'; emailInput.required = true; emailField.append(emailInput);
      const coachField = node('label', 'ID del coach asignado '), coachInput = doc.createElement('input'); coachInput.required = true; coachInput.maxLength = 64; coachField.append(coachInput);
      const submit = node('button', 'Agregar cliente'); submit.type = 'submit';
      const resend = node('button', 'Reenviar invitación'); resend.type = 'button';

      let gymSelect = null;
      if (eligible.length > 1) {
        const gymField = node('label', 'Gimnasio ');
        gymSelect = doc.createElement('select'); gymSelect.required = true;
        const placeholder = doc.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Selecciona un gimnasio…'; gymSelect.append(placeholder);
        for (const row of eligible) { const opt = doc.createElement('option'); opt.value = row.gymId; opt.textContent = row.gymId; gymSelect.append(opt); }
        gymSelect.value = '';
        gymSelect.addEventListener('change', () => { gymId = gymSelect.value || null; });
        gymField.append(gymSelect);
        form.append(nameField, emailField, coachField, gymField, submit);
      } else {
        form.append(nameField, emailField, coachField, submit);
      }
      container.append(form, resend);

      function setBusy(value) { busy = value; [nameInput, emailInput, coachInput, submit, resend, gymSelect].forEach(el => { if (el) el.disabled = value; }); }

      // P2 (auditoría sobre el commit 60afc33, "selector multigimnasio"):
      // form.reset() SOLO restaura los valores visibles de los controles —
      // nunca dispara 'change', así que el listener de gymSelect de arriba
      // NO se ejecuta y la variable `gymId` (JS, fuera del DOM) seguía
      // apuntando al gimnasio de la operación anterior aunque el <select>
      // ya se viera vacío otra vez. Eso permitía reenviar/dar de alta con
      // un gymId DISTINTO del que la propia interfaz mostraba seleccionado.
      // Se sincroniza aquí explícitamente al mismo estado que al montar.
      function resetGymSelection() {
        if (gymSelect) gymSelect.value = '';
        gymId = eligible.length === 1 ? eligible[0].gymId : null;
      }

      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy) return;
        // Verificado de nuevo aquí (no solo al montar): el valor viene
        // SIEMPRE de la selección explícita o del único gimnasio elegible,
        // nunca de un valor por defecto silencioso.
        if (!gymId || !eligible.some(r => r.gymId === gymId)) { status.textContent = 'Selecciona el gimnasio antes de continuar.'; return; }
        setBusy(true); status.textContent = 'Agregando…';
        const result = await call('/api/admin/clients', { body: { name: nameInput.value.trim(), email: emailInput.value.trim(), coachId: coachInput.value.trim(), gymId } });
        if (ticket !== epoch) return;
        setBusy(false);
        if (result.error) { status.textContent = messageFor(result.error); return; }
        status.textContent = result.data.status === 'PENDING_PROFILE'
          ? (result.data.invite ? 'Invitación enviada a ' : 'Ya existe una invitación pendiente para ') + result.data.email + '. Falta que esa persona inicie sesión al menos una vez. '
            + (result.data.autoResumable
              ? 'La asignación se completará automáticamente en ese momento, sin que tengas que hacer nada más.'
              : 'La activación automática no está disponible en este entorno todavía: repite "Agregar cliente" manualmente después de que esa persona inicie sesión (no se reenviará la invitación).')
          : (result.data.invite ? 'Cliente agregado. Invitación enviada a ' : 'Cliente agregado y asignado a ') + result.data.email + '.';
        form.reset();
        resetGymSelection();
      });

      resend.addEventListener('click', async () => {
        if (busy) return;
        if (!gymId || !eligible.some(r => r.gymId === gymId)) { status.textContent = 'Selecciona el gimnasio antes de continuar.'; return; }
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
