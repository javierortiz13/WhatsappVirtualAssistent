-- Presupuestos por categoría (03/10/2026): el dueño fija un tope en dólares por categoría de
-- gasto, mensual (mes calendario) o quincenal (1–15 y 16–fin de mes), en hora de Caracas. Lo
-- gastado se suma en vivo desde movement.amount_usd; aquí solo vive el tope. Uno por categoría.
CREATE TABLE IF NOT EXISTS app.budget (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id),
  category_id  uuid NOT NULL REFERENCES app.category(id),
  period       text NOT NULL,
  amount_usd   numeric(18, 2) NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_period_check CHECK (period IN ('monthly', 'biweekly')),
  CONSTRAINT budget_amount_check CHECK (amount_usd > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_tenant_category_key ON app.budget (tenant_id, category_id);
ALTER TABLE app.budget ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.budget;
CREATE POLICY tenant_isolation ON app.budget
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.budget TO caja_app;
