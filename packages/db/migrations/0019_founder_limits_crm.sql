-- Fundadores, límites duros, encuesta y CRM (07/10/2026). Decisiones de Javier:
-- - Precio fundador: 40 % de descuento hasta `founder_until` para los primeros 50 negocios (los
--   amigos de la beta). Los negocios de hoy ya son fundadores.
-- - Límite duro del plan: al pasar los mensajes del mes, Rocco deja de registrar y ofrece una
--   recarga (+100 mensajes) o cambiar de plan. `extra_messages` vale solo en `extra_month`.
--   Aviso único al 80 % (`cap_warned_month`).
-- - Un pago puede ser del plan o una recarga (`payment.kind`).
-- - Día 10: encuesta de precio; día 12: resumen de lo anotado. Respuestas en `survey` (jsonb).
-- - CRM interno: notas y etiquetas del administrador.
-- Todo en columnas de tenant/payment: `erase_tenant` ya los borra con el negocio.

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS founder_until date,
  ADD COLUMN IF NOT EXISTS extra_messages integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_month text,
  ADD COLUMN IF NOT EXISTS cap_warned_month text,
  ADD COLUMN IF NOT EXISTS survey_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS value_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS survey jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS crm_notes text,
  ADD COLUMN IF NOT EXISTS crm_tags text[] NOT NULL DEFAULT '{}';

UPDATE app.tenant SET founder_until = (current_date + interval '7 months')::date
  WHERE founder_until IS NULL AND deleted_at IS NULL;

ALTER TABLE app.payment ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'plan';
ALTER TABLE app.payment DROP CONSTRAINT IF EXISTS payment_kind_check;
ALTER TABLE app.payment ADD CONSTRAINT payment_kind_check CHECK (kind IN ('plan', 'recharge'));
