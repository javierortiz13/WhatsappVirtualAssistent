-- Cola de borradores (02/10, piloto): una factura tarda en leerse y, si el dueño manda otro gasto
-- mientras tanto, el borrador nuevo descartaba el de la factura. Ahora varios borradores pueden
-- esperar confirmación a la vez en el mismo teléfono; uno nuevo solo reemplaza a otro cuando es
-- una corrección. El tope (5 por teléfono) lo aplica la aplicación.
DROP INDEX IF EXISTS app.pending_action_one_active;
CREATE INDEX IF NOT EXISTS pending_action_phone_pending
  ON app.pending_action (phone_id, created_at) WHERE status = 'pending';
