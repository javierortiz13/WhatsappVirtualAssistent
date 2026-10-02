-- Cobros (02/10/2026): planes, prueba de 14 días, pagos verificados a mano por el administrador
-- de la plataforma (pago móvil, Zelle, Binance) y tasa euro del BCV para cobrar el pago móvil.
-- Todo aditivo: el código anterior sigue funcionando con esta migración aplicada.

-- Tasa euro oficial del BCV, junto a la del dólar (misma fecha valor).
ALTER TABLE app.bcv_rate ADD COLUMN IF NOT EXISTS rate_eur numeric(18, 8);

-- Plan y vigencia de cada negocio. `status` sigue siendo trial | active | suspended.
ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'negocio',
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_until timestamptz,
  -- Mes (YYYY-MM) en que ya se avisó que pasó el límite de mensajes del plan.
  ADD COLUMN IF NOT EXISTS cap_notified_month text;
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_plan_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_plan_check
  CHECK (plan IN ('personal', 'negocio', 'negocio_plus'));
-- Los negocios que ya existen arrancan su prueba de 14 días desde que se crearon.
UPDATE app.tenant SET trial_ends_at = created_at + interval '14 days' WHERE trial_ends_at IS NULL;
-- Y los nuevos, desde que se registran.
ALTER TABLE app.tenant ALTER COLUMN trial_ends_at SET DEFAULT now() + interval '14 days';

-- Pagos reportados o registrados por el administrador. Aprobar uno extiende `paid_until`.
CREATE TABLE IF NOT EXISTS app.payment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id),
  plan         text NOT NULL,
  months       integer NOT NULL DEFAULT 1,
  method       text NOT NULL,
  amount       numeric(18, 2) NOT NULL,
  currency     text NOT NULL,
  -- Solo en pago móvil: tasa con la que se calculó el monto en bolívares.
  rate_kind    text,
  rate_value   numeric(18, 8),
  amount_usd   numeric(18, 2) NOT NULL,
  reference    text,
  status       text NOT NULL DEFAULT 'pending',
  notes        text,
  reviewed_by  text,
  reviewed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_plan_check CHECK (plan IN ('personal', 'negocio', 'negocio_plus')),
  CONSTRAINT payment_months_check CHECK (months BETWEEN 1 AND 12),
  CONSTRAINT payment_method_check CHECK (method IN ('pago_movil', 'zelle', 'binance')),
  CONSTRAINT payment_currency_check CHECK (currency IN ('VES', 'USD', 'USDT')),
  CONSTRAINT payment_rate_kind_check CHECK (rate_kind IS NULL OR rate_kind IN ('bcv_usd', 'bcv_eur', 'manual')),
  CONSTRAINT payment_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT payment_amount_check CHECK (amount > 0 AND amount_usd >= 0)
);
CREATE INDEX IF NOT EXISTS payment_tenant_idx ON app.payment (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_pending_idx ON app.payment (status) WHERE status = 'pending';
ALTER TABLE app.payment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.payment;
CREATE POLICY tenant_isolation ON app.payment
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.payment TO caja_app;

-- El panel de administración y el job de cobros recorren TODOS los negocios, suspendidos
-- incluidos (`all_tenant_ids` los excluye). Solo devuelve ids; cada lectura sigue bajo RLS.
CREATE OR REPLACE FUNCTION app.every_tenant_id()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT id FROM app.tenant ORDER BY created_at;
$$;
REVOKE ALL ON FUNCTION app.every_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.every_tenant_id() TO caja_app;
