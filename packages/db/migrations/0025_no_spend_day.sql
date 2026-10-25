-- 0025 (PRD hábitos US-105): "hoy no gasté nada". Un día sin gastos por negocio y día de Caracas,
-- para que la racha lo cuente. No se guarda lo que escribió, solo el día y qué teléfono lo dijo.
-- Las llaves borran en cascada: al eliminar el negocio (`app.erase_tenant`) o el teléfono, sus
-- días sin gastos se van con ellos, sin cambiar la función.
CREATE TABLE IF NOT EXISTS app.no_spend_day (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  phone_id    uuid NOT NULL REFERENCES app.phone_number(id) ON DELETE CASCADE,
  day         date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS no_spend_day_tenant_day_key ON app.no_spend_day (tenant_id, day);
ALTER TABLE app.no_spend_day ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.no_spend_day;
CREATE POLICY tenant_isolation ON app.no_spend_day
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT ON app.no_spend_day TO caja_app;
