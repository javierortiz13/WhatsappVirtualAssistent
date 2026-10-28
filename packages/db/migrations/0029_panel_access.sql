-- 0029 (revisión de seguridad F1 y F3):
-- - «Quitar acceso» en Ajustes → Acceso al panel borra la membresía (tenant_member).
-- - «No soy de ahí» de un empleado que nunca aceptó borra su número (phone_number) para que
--   quede libre. Con historial, el código no borra: conserva la fila sin el número.
-- RLS sigue limitando ambos borrados al negocio de la sesión.
GRANT DELETE ON app.tenant_member, app.phone_number TO caja_app;
