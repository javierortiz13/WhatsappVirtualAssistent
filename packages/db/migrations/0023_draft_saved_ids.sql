-- Guardado al instante (14/10/2026, pedido de Javier). El autoguardado a los 15 minutos (0022)
-- dejaba el cierre de caja y el dashboard sin los gastos recién anotados. Ahora el gasto se guarda
-- en el mismo turno y la tarjeta queda abierta 15 minutos para corregirlo (lo reemplaza) o
-- deshacerlo (lo borra). `saved_ids` dice qué escribió esa tarjeta: movimientos, la transferencia
-- o el cambio, según el `kind`. Sin barrido: `due_draft_tenant_ids` de 0022 queda sin uso.
ALTER TABLE app.pending_action ADD COLUMN IF NOT EXISTS saved_ids uuid[];
