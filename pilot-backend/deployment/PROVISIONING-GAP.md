# Alta de clientes — estado y pendientes (preprod-docker-test)

Implementado y probado localmente (sin tocar Supabase real). Resume lo que
queda por confirmar antes de usar esto contra la base de datos de verdad.

**5ª ronda: activación automática.** Las rondas 3–4 dejaban la reanudación
como una acción manual (el OWNER/ADMIN tenía que volver a pulsar "Agregar
cliente" después de que el cliente iniciara sesión). Esta ronda la
automatiza — **pero depende de infraestructura SQL que todavía no existe
en Supabase real.** No se declara el flujo terminado de extremo a extremo:
ver la sección "Bloqueo real" más abajo.

## Qué cambia

- **`pilot-backend/deployment/PENDING-ACTIVATION-MIGRATION.sql`** (nuevo,
  **propuesta, NO aplicada**): una tabla `pilot_pending_activations`
  (bloqueada por RLS para todos excepto OWNER/ADMIN del gimnasio
  correspondiente) y una función `pilot_resume_pending_activation()`
  (SECURITY DEFINER, autoservicio, otorgada a `authenticated`). Diseño
  explicado con comentarios dentro del propio archivo: por qué no
  reutiliza `pilot_set_membership`/`pilot_set_coach_client` directamente
  (esas RPC autorizan comprobando el rol de `auth.uid()` en el momento de
  la llamada, y el cliente nunca es OWNER/ADMIN), por qué revalida en vivo
  que el autorizador original sigue siendo OWNER/ADMIN activo (en vez de
  confiar ciegamente en una autorización histórica), y cómo evita
  condiciones de carrera (`FOR UPDATE SKIP LOCKED`).
- **`pilot-admin-provisioning-service.cjs`**: cuando `addClient` cae en
  `PENDING_PROFILE`, además intenta guardar (upsert por `gym_id,user_id`,
  nunca duplica) la solicitud en `pilot_pending_activations`, con la
  sesión del propio OWNER/ADMIN que ya se autorizó (nunca `service_role`).
  Si esa tabla todavía no existe, el intento falla en silencio — el
  resultado sigue siendo `PENDING_PROFILE`, solo que con
  `autoResumable: false` en vez de `true`, para que la UI sepa cuál
  mensaje mostrar y **nunca prometa algo que no puede cumplir**.
- **`pilot-auth.js`**: `verify()` llama `pilot_resume_pending_activation()`
  justo después de `pilot_ensure_profile()` — autoservicio, tolerante (si
  la función no existe todavía o no hay nada pendiente, no rompe la
  verificación normal). Si había una solicitud pendiente aplicable, la
  membresía y la asignación quedan completas en el MISMO `verify()` que
  crea el perfil — el cliente queda `AUTHORIZED` en su primer login, sin
  que el OWNER/ADMIN haga nada más.
- **`pilot-admin-provisioning-ui.js`**: el mensaje tras `PENDING_PROFILE`
  distingue `autoResumable` — si es `true`, dice que se completará solo;
  si es `false`, dice explícitamente que la activación automática no está
  disponible todavía y que hay que repetir la acción a mano.

## ⚠️ Bloqueo real: esto no funciona contra Supabase real hasta aplicar la migración

**No se simula que esto funciona hoy.** `PENDING-ACTIVATION-MIGRATION.sql`
es una propuesta escrita por este módulo, nunca ejecutada contra ningún
Supabase (ni real ni de prueba) — nadie en esta sesión tiene ese acceso.
Hasta que alguien con acceso real:
1. Confirme los nombres de columna reales de
   `gym_memberships`/`clients`/`coach_clients` (el archivo SQL los asume
   iguales a los ya usados en el resto de este módulo) y ajuste la función
   si difieren;
2. Pruebe la migración en un proyecto de Supabase **desechable**, nunca en
   producción directamente;
3. La aplique al proyecto real;

...el código Node.js seguirá funcionando exactamente como en la ronda
anterior: `addClient` devuelve `PENDING_PROFILE` con `autoResumable:
false`, y la reanudación sigue siendo manual (el OWNER/ADMIN repite
"Agregar cliente"). **Nada se rompe por no tener la migración aplicada** —
simplemente no se obtiene el beneficio de la activación automática todavía.

## Pruebas nuevas (14, sobre el contrato SQL PROPUESTO — nunca contra Supabase real)

- Activación automática de punta a punta: alta → solicitud persistida →
  primer login → perfil creado → reanudación automática → `AUTHORIZED`,
  sin segunda acción del OWNER/ADMIN.
- Idempotencia: un segundo login no duplica membresía ni asignación.
- Sesión expirada/inválida: `verify()` nunca intenta reanudar sin una
  sesión válida (cero llamadas RPC).
- Solicitudes manipuladas: `created_by` que ya no es OWNER/ADMIN activo,
  coach destino ya no válido, y una fila apuntando a otro gimnasio — las
  tres se cancelan en vez de aplicarse.
- Concurrencia: dos intentos de reanudación no duplican nada (la primera
  completa, la segunda no encuentra nada pendiente); una fila ya bloqueada
  (`SKIP LOCKED`) no se procesa dos veces en la misma ventana.
- 110 pruebas en total, ninguna toca la red real.

## Lo que NO pude verificar (ninguno se puede cerrar con mocks en memoria;
## hace falta una base de datos Postgres desechable, separada de producción)

1. Nombres exactos de columna en `clients`/`coach_clients`/`gym_memberships`
   (sin cambios respecto a rondas anteriores).
2. Si RLS permite exactamente las políticas propuestas en
   `PENDING-ACTIVATION-MIGRATION.sql` (la sintaxis asume un tipo
   `pilot_role[]` para `roles` — confirmar que coincide con el real).
3. Si `pilot_private.lock_admin` (mencionado en tareas anteriores como el
   mecanismo de serialización de las RPC existentes) necesita algún
   tratamiento especial dentro de `pilot_resume_pending_activation()` — la
   propuesta no lo toca ni lo reemplaza, solo evita necesitarlo al no pasar
   por `pilot_set_membership`/`pilot_set_coach_client` directamente; si eso
   resulta insuficiente en la práctica, hay que revisarlo con quien
   mantenga ese mecanismo.
4. Rendimiento/bloqueo real de `FOR UPDATE SKIP LOCKED` bajo concurrencia
   genuina (las pruebas de concurrencia de este módulo son deterministas,
   no una prueba de carga real).

## Siguiente paso recomendado

1. Revisar `PENDING-ACTIVATION-MIGRATION.sql` con quien administre
   Supabase; ajustar nombres de columna si difieren; probarlo en un
   proyecto desechable.
2. Aplicarlo al proyecto real cuando esté validado.
3. Confirmar que `autoResumable` pasa a `true` en un alta de prueba real
   después de aplicar la migración — si sigue en `false`, algo en los
   permisos de escritura de `pilot_pending_activations` no coincide con lo
   propuesto.
