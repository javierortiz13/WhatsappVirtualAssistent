-- Tope de gasto de la prueba gratis (06/10/2026). Mientras un negocio está en prueba, lo que cuesta
-- (IA de cada mensaje + respuestas del bot a la tarifa de Meta + notas de voz) no pasa de un tope:
-- 1,50 USD en Personal, 4 en Negocio, 8 en Negocio Plus. Al llegar, el bot deja de registrar y
-- ofrece activar el plan. Todo aditivo: el código anterior sigue funcionando con esto aplicado.

-- Tope propio del negocio (lo cambia el administrador); null = el del plan.
ALTER TABLE app.tenant ADD COLUMN IF NOT EXISTS trial_budget_usd numeric(8, 2);
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_trial_budget_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_trial_budget_check
  CHECK (trial_budget_usd IS NULL OR trial_budget_usd >= 0);
-- Cuándo se le avisó al administrador que la prueba llegó al tope (una sola vez por tope).
ALTER TABLE app.tenant ADD COLUMN IF NOT EXISTS trial_cap_notified_at timestamptz;

-- Los negocios del piloto, creados antes del tope, quedan con uno amplio de 20 USD.
UPDATE app.tenant SET trial_budget_usd = 20
  WHERE status = 'trial' AND trial_budget_usd IS NULL AND created_at < '2026-10-06T04:00:00Z';

-- El gasto de la prueba suma los mensajes del negocio en cada mensaje entrante.
CREATE INDEX IF NOT EXISTS message_tenant_created_idx ON app.message (tenant_id, created_at);
