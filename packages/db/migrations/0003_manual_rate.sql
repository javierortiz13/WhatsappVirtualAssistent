-- S2 (ADR-013): un movimiento puede llevar una tasa indicada por el dueño al corregir
-- ("a tasa 850"). Se guarda en rate_value con rate_source = 'manual' y sin fila en bcv_rate.
ALTER TABLE app.movement ALTER COLUMN rate_id DROP NOT NULL;
ALTER TABLE app.movement
  ADD COLUMN rate_source text NOT NULL DEFAULT 'bcv'
  CONSTRAINT movement_rate_source_check CHECK (rate_source IN ('bcv', 'manual'));
ALTER TABLE app.movement
  ADD CONSTRAINT movement_rate_source_id CHECK (rate_source = 'manual' OR rate_id IS NOT NULL);
