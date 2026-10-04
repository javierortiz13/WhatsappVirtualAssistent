-- Lotes de cambio (04/10/2026): quien cobra en USDT y los cambia a bolívares registra cada cambio
-- ("cambié 100 usdt a 970"). Los gastos en Bs salen del lote más viejo con saldo (FIFO) y su
-- equivalente en dólares sale a la tasa de ese lote, no a la BCV. `exchange_allocation` dice de
-- qué lote salió cada gasto, para devolver el saldo si el gasto se borra o se corrige.
-- tenant.bs_rate_mode: bcv (como siempre), usdt (siempre de los lotes) o ask (preguntar).
ALTER TABLE app.tenant ADD COLUMN IF NOT EXISTS bs_rate_mode text NOT NULL DEFAULT 'bcv';
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_bs_rate_mode_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_bs_rate_mode_check
  CHECK (bs_rate_mode IN ('bcv', 'usdt', 'ask'));

CREATE TABLE IF NOT EXISTS app.exchange_lot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id),
  business_date       date NOT NULL,
  usd_amount          numeric(14, 2) NOT NULL,
  ves_amount          numeric(18, 2) NOT NULL,
  rate                numeric(18, 8) NOT NULL,
  ves_remaining       numeric(18, 2) NOT NULL,
  created_by_phone_id uuid REFERENCES app.phone_number(id),
  created_by_user_id  uuid REFERENCES app.user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT exchange_lot_amounts_check CHECK (usd_amount > 0 AND ves_amount > 0 AND rate > 0),
  CONSTRAINT exchange_lot_remaining_check CHECK (ves_remaining >= 0 AND ves_remaining <= ves_amount)
);
CREATE INDEX IF NOT EXISTS exchange_lot_tenant_fifo_idx
  ON app.exchange_lot (tenant_id, business_date, created_at) WHERE deleted_at IS NULL;
ALTER TABLE app.exchange_lot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.exchange_lot;
CREATE POLICY tenant_isolation ON app.exchange_lot
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.exchange_lot TO caja_app;

CREATE TABLE IF NOT EXISTS app.exchange_allocation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id),
  movement_id uuid NOT NULL REFERENCES app.movement(id),
  lot_id      uuid NOT NULL REFERENCES app.exchange_lot(id),
  ves_amount  numeric(18, 2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_allocation_amount_check CHECK (ves_amount > 0)
);
CREATE INDEX IF NOT EXISTS exchange_allocation_movement_idx ON app.exchange_allocation (movement_id);
CREATE INDEX IF NOT EXISTS exchange_allocation_lot_idx ON app.exchange_allocation (lot_id);
ALTER TABLE app.exchange_allocation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.exchange_allocation;
CREATE POLICY tenant_isolation ON app.exchange_allocation
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, DELETE ON app.exchange_allocation TO caja_app;

-- Un gasto en Bs de los lotes guarda la tasa efectiva del cambio: fuente 'exchange', sin bcv_rate.
ALTER TABLE app.movement DROP CONSTRAINT IF EXISTS movement_rate_source_check;
ALTER TABLE app.movement ADD CONSTRAINT movement_rate_source_check
  CHECK (rate_source IN ('bcv', 'bcv_eur', 'manual', 'exchange'));
ALTER TABLE app.movement DROP CONSTRAINT IF EXISTS movement_rate_source_id;
ALTER TABLE app.movement ADD CONSTRAINT movement_rate_source_id
  CHECK (rate_source IN ('manual', 'exchange') OR rate_id IS NOT NULL);

ALTER TABLE app.pending_action DROP CONSTRAINT IF EXISTS pending_action_kind_check;
ALTER TABLE app.pending_action ADD CONSTRAINT pending_action_kind_check
  CHECK (kind IN ('create_expense', 'create_expenses', 'create_income_day_total', 'create_income_single', 'replace_day_total', 'edit_last', 'delete_last', 'renew_plan', 'create_exchange'));
