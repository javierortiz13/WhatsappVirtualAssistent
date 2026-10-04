-- Transferencias entre cuentas (04/10/2026, fase 2 de cuentas): pasar dinero de una cuenta a otra
-- ("pasé 100$ de Zelle a Binance", "del BDV a Banesco") o comprar USDT con bolívares. No es gasto
-- ni venta: cambia dónde está el dinero. La comisión, si la hay, es un gasto aparte
-- (fee_movement_id) que sale de la cuenta de origen.
-- Entre cuentas en Bs, los bolívares se llevan su costo: salen de los lotes de la cuenta de origen
-- (exchange_allocation con transfer_id) y entran como un lote de la de destino a esa tasa.
-- Dólares → Bs sigue siendo un cambio (exchange_lot), no una transferencia.
CREATE TABLE IF NOT EXISTS app.account_transfer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id),
  from_account_id     uuid NOT NULL REFERENCES app.account(id),
  to_account_id       uuid NOT NULL REFERENCES app.account(id),
  -- En la moneda de cada cuenta. Misma moneda: iguales (la comisión va aparte).
  from_amount         numeric(18, 2) NOT NULL,
  to_amount           numeric(18, 2) NOT NULL,
  business_date       date NOT NULL,
  description         text,
  fee_movement_id     uuid REFERENCES app.movement(id),
  created_by_phone_id uuid REFERENCES app.phone_number(id),
  created_by_user_id  uuid REFERENCES app.user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT account_transfer_amounts_check CHECK (from_amount > 0 AND to_amount > 0),
  CONSTRAINT account_transfer_accounts_check CHECK (from_account_id <> to_account_id)
);
CREATE INDEX IF NOT EXISTS account_transfer_from_idx
  ON app.account_transfer (from_account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS account_transfer_to_idx
  ON app.account_transfer (to_account_id) WHERE deleted_at IS NULL;
ALTER TABLE app.account_transfer ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.account_transfer;
CREATE POLICY tenant_isolation ON app.account_transfer
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.account_transfer TO caja_app;

-- Una asignación de lotes es de un gasto o de una transferencia.
ALTER TABLE app.exchange_allocation ALTER COLUMN movement_id DROP NOT NULL;
ALTER TABLE app.exchange_allocation ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES app.account_transfer(id);
ALTER TABLE app.exchange_allocation DROP CONSTRAINT IF EXISTS exchange_allocation_owner_check;
ALTER TABLE app.exchange_allocation ADD CONSTRAINT exchange_allocation_owner_check
  CHECK ((movement_id IS NULL) <> (transfer_id IS NULL));
CREATE INDEX IF NOT EXISTS exchange_allocation_transfer_idx
  ON app.exchange_allocation (transfer_id) WHERE transfer_id IS NOT NULL;

-- El lote que una transferencia en Bs deja en la cuenta de destino.
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS transfer_id uuid REFERENCES app.account_transfer(id);
ALTER TABLE app.exchange_lot DROP CONSTRAINT IF EXISTS exchange_lot_source_check;
ALTER TABLE app.exchange_lot ADD CONSTRAINT exchange_lot_source_check
  CHECK (source IN ('exchange', 'income', 'opening', 'transfer'));

ALTER TABLE app.pending_action DROP CONSTRAINT IF EXISTS pending_action_kind_check;
ALTER TABLE app.pending_action ADD CONSTRAINT pending_action_kind_check
  CHECK (kind IN ('create_expense', 'create_expenses', 'create_income_day_total', 'create_income_single', 'replace_day_total', 'edit_last', 'delete_last', 'renew_plan', 'create_exchange', 'create_transfer'));
