# Twogramms — instrucciones de continuidad

Estas reglas aplican a cualquier sesión de trabajo en este repositorio.

1. **Leer antes de actuar.** Antes de analizar, modificar o recomendar cualquier
   cambio, leer `ESTADO_ACTUAL.md`, `DECISIONES.md` e `HISTORIAL_TECNICO.md`.
2. **No repetir.** No repetir pruebas que ya fallaron ni reabrir decisiones
   descartadas sin evidencia nueva. Consultar las tablas de intentos de
   `HISTORIAL_TECNICO.md`.
3. **Evidencia.** Distinguir siempre:
   - **[C]** hechos comprobados en código, git o pruebas ejecutadas;
   - **[U]** información aportada por el usuario;
   - **[H]** hipótesis pendientes de confirmar.
4. **Foco.** Trabajar sobre el problema actual, sin auditorías generales
   innecesarias. Ejecutar solo las pruebas locales relacionadas con lo modificado.
5. **Cierre de sesión.** Antes de cerrar una sesión de trabajo, actualizar los
   tres archivos únicamente con cambios y resultados verificados, conservando
   las marcas [C], [U] y [H]. Registrar también los intentos fallidos.
6. **Privacidad.** Nunca incluir en esos documentos credenciales (contraseñas,
   tokens, claves, verificadores SCRAM, cadenas de conexión) ni datos
   personales (correos, nombres, identificadores de clientes reales).
7. **Comunicación.** Dar al usuario instrucciones breves, una acción a la vez.
8. **Autorización.** No ejecutar operaciones destructivas (eliminar archivos o
   datos, `reset --hard`, `push --force`, `DROP`, etc.) ni desplegar cambios sin
   autorización explícita para esa acción concreta. Tampoco modificar Supabase,
   Render, SQL, permisos ni contraseñas, ni hacer commit o push, sin esa
   autorización.
