-- 0026 (PRD hábitos US-201, US-301): preferencias de contacto por teléfono y recordatorios de plata.
--
-- Preferencias (US-201): si aceptó el aviso de las 8 pm, si apagó los avisos ("no me recuerdes"),
-- si apagó todo lo que Rocco manda por su cuenta ("no me escribas"), la pausa automática y el
-- apagado pendiente de confirmar (D10: desde que se manda la tarjeta, ya cuenta como apagado).
-- Nunca se guarda lo que escribió: el consentimiento va en `audit_log` con el id del texto.
ALTER TABLE app.phone_number
  ADD COLUMN IF NOT EXISTS nudge_opt_in_at    timestamptz,
  ADD COLUMN IF NOT EXISTS nudge_off_at       timestamptz,
  ADD COLUMN IF NOT EXISTS unsolicited_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS nudge_paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS pref_pending       text,
  ADD COLUMN IF NOT EXISTS pref_pending_at    timestamptz;
ALTER TABLE app.phone_number DROP CONSTRAINT IF EXISTS phone_number_pref_pending_check;
ALTER TABLE app.phone_number ADD CONSTRAINT phone_number_pref_pending_check
  CHECK (pref_pending IS NULL OR pref_pending IN ('nudges_off', 'all_off'));

-- Recordatorios (US-301, PRD §6.2). Solo de plata. Quien lo crea es quien lo recibe (el dueño).
-- El texto, el monto y la contraparte se borran al tocar Borrar; la fila se borra 90 días después
-- de hecha, vencida o cancelada. Cascada desde el negocio y el teléfono: `erase_tenant` no cambia.
-- `linked_movement_id` y `source_message_id` son SET NULL porque `erase_tenant` borra movimientos y
-- mensajes antes que el negocio (ER-1).
CREATE TABLE IF NOT EXISTS app.reminder (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  phone_id            uuid NOT NULL REFERENCES app.phone_number(id) ON DELETE CASCADE,
  text                text CHECK (text IS NULL OR char_length(text) <= 80),
  kind                text NOT NULL CHECK (kind IN ('pay', 'collect', 'other_money')),
  amount              numeric(18, 2),
  currency            text CHECK (currency IS NULL OR currency IN ('USD', 'VES', 'EUR')),
  counterparty        text CHECK (counterparty IS NULL OR char_length(counterparty) <= 40),
  due_at              timestamptz NOT NULL,
  due_date            date NOT NULL,
  time_was_default    boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered', 'done', 'cancelled', 'expired')),
  delivered_via       text CHECK (delivered_via IS NULL OR delivered_via IN ('a', 'b', 'c', 'd')),
  early_sent_at       timestamptz,
  delivered_at        timestamptz,
  done_at             timestamptz,
  linked_movement_id  uuid REFERENCES app.movement(id) ON DELETE SET NULL,
  source_message_id   uuid REFERENCES app.message(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
-- La cola de cada minuto busca `status = 'pending' and due_at <= now()` (DQ-5).
CREATE INDEX IF NOT EXISTS reminder_due_idx ON app.reminder (status, due_at);
CREATE INDEX IF NOT EXISTS reminder_tenant_idx ON app.reminder (tenant_id, status);
ALTER TABLE app.reminder ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.reminder;
CREATE POLICY tenant_isolation ON app.reminder
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.reminder TO caja_app;
