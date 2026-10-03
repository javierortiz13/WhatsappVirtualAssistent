-- Renovar el plan por el bot (03/10/2026, ADR-015 fase 2). El dueño elige método por WhatsApp y
-- el bot guarda la intención (plan, meses, método, monto) como `renew_plan` hasta que llega la
-- referencia. `payment.notified_at` marca el aviso de "pago verificado" o "no verificado" que el
-- worker manda por WhatsApp; los pagos ya revisados quedan marcados para no avisar en masa.
ALTER TABLE app.pending_action DROP CONSTRAINT IF EXISTS pending_action_kind_check;
ALTER TABLE app.pending_action ADD CONSTRAINT pending_action_kind_check
  CHECK (kind IN ('create_expense', 'create_expenses', 'create_income_day_total', 'create_income_single', 'replace_day_total', 'edit_last', 'delete_last', 'renew_plan'));
ALTER TABLE app.payment ADD COLUMN IF NOT EXISTS notified_at timestamptz;
UPDATE app.payment SET notified_at = coalesce(reviewed_at, created_at)
  WHERE status <> 'pending' AND notified_at IS NULL;
