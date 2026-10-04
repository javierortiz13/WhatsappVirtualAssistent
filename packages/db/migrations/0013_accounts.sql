-- Cuentas (04/10/2026, como Rial): el dinero vive en cuentas (Banco de Venezuela en Bs, Binance
-- en USDT, Zelle, Efectivo) y cada gasto o venta dice de qué cuenta salió o a cuál entró. Son
-- opcionales: un negocio sin cuentas sigue igual que antes.
-- Saldo de una cuenta = saldo inicial + ventas − gastos + cambios que entraron − cambios que salieron.
-- Los lotes (0012) pasan a ser por cuenta: en una cuenta en Bs, cada bolívar tiene su costo en
-- dólares según de dónde vino (un cambio, una venta, o el saldo inicial a la BCV de ese día).
CREATE TABLE IF NOT EXISTS app.account (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id),
  name                text NOT NULL,
  currency            text NOT NULL,
  kind                text NOT NULL DEFAULT 'bank',
  opening_balance     numeric(18, 2) NOT NULL DEFAULT 0,
  opening_date        date NOT NULL,
  sort_order          integer NOT NULL DEFAULT 0,
  created_by_phone_id uuid REFERENCES app.phone_number(id),
  created_by_user_id  uuid REFERENCES app.user_account(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz,
  CONSTRAINT account_currency_check CHECK (currency IN ('USD', 'VES')),
  CONSTRAINT account_kind_check CHECK (kind IN ('bank', 'cash', 'zelle', 'crypto', 'other')),
  CONSTRAINT account_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX IF NOT EXISTS account_tenant_name_key
  ON app.account (tenant_id, lower(name)) WHERE archived_at IS NULL;
ALTER TABLE app.account ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.account;
CREATE POLICY tenant_isolation ON app.account
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.account TO caja_app;

ALTER TABLE app.movement ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES app.account(id);
CREATE INDEX IF NOT EXISTS movement_account_idx
  ON app.movement (account_id) WHERE deleted_at IS NULL AND account_id IS NOT NULL;

-- Lotes por cuenta. source: exchange (un cambio; from_account_id es la cuenta en dólares de donde
-- salieron), income (una venta en Bs; movement_id) u opening (el saldo inicial de la cuenta).
-- account_id null = lotes de antes de las cuentas; la primera cuenta en Bs los adopta (adopted_at):
-- esos Bs ya están dentro del saldo inicial, así que no se suman otra vez al saldo.
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES app.account(id);
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS from_account_id uuid REFERENCES app.account(id);
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'exchange';
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS movement_id uuid REFERENCES app.movement(id);
ALTER TABLE app.exchange_lot ADD COLUMN IF NOT EXISTS adopted_at timestamptz;
ALTER TABLE app.exchange_lot DROP CONSTRAINT IF EXISTS exchange_lot_source_check;
ALTER TABLE app.exchange_lot ADD CONSTRAINT exchange_lot_source_check
  CHECK (source IN ('exchange', 'income', 'opening'));
CREATE UNIQUE INDEX IF NOT EXISTS exchange_lot_movement_key
  ON app.exchange_lot (movement_id) WHERE movement_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS exchange_lot_opening_key
  ON app.exchange_lot (account_id) WHERE source = 'opening' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS exchange_lot_account_fifo_idx
  ON app.exchange_lot (account_id, business_date, created_at) WHERE deleted_at IS NULL;
