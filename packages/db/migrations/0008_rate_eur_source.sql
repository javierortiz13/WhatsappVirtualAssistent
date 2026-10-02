-- Tasa euro en los movimientos (02/10/2026): muchos negocios cobran y pagan "a tasa euro" del BCV
-- (Bs = monto en $ × euro BCV del día). El movimiento guarda esa tasa con rate_source 'bcv_eur'
-- y rate_id apuntando a la fila de bcv_rate de donde salió.
ALTER TABLE app.movement DROP CONSTRAINT IF EXISTS movement_rate_source_check;
ALTER TABLE app.movement ADD CONSTRAINT movement_rate_source_check
  CHECK (rate_source IN ('bcv', 'bcv_eur', 'manual'));
