-- 0030: recordatorios del registro por WhatsApp (PRD signup-reminders v1.2, US-SR-01). Solo en
-- app.signup: un mensaje automático por persona en la vida, (A) en la ventana o (B) plantilla,
-- o el grupo de control (`rescue_via`, compartido); «no me escribas» dentro del registro
-- (`contact_off_at`); y la marca del fundador «Le escribí yo» (`founder_contacted_at`).
-- Sin permisos nuevos (caja_app ya tiene SELECT, INSERT, UPDATE en app.signup, 0018) y
-- `erase_tenant` no cambia: borra la fila entera (0024).
ALTER TABLE app.signup
  ADD COLUMN IF NOT EXISTS rescue_at timestamptz,
  ADD COLUMN IF NOT EXISTS rescue_via text,
  ADD COLUMN IF NOT EXISTS rescue_wa_message_id text,
  ADD COLUMN IF NOT EXISTS contact_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS founder_contacted_at timestamptz;

ALTER TABLE app.signup DROP CONSTRAINT IF EXISTS signup_rescue_via_check;
ALTER TABLE app.signup
  ADD CONSTRAINT signup_rescue_via_check CHECK (rescue_via IN ('window', 'template', 'holdout'));

-- El job de cada 5 minutos solo mira registros sin terminar, sin rescate y sin «no me escribas».
CREATE INDEX IF NOT EXISTS signup_rescue_due_idx ON app.signup (updated_at)
  WHERE completed_at IS NULL AND rescue_via IS NULL AND contact_off_at IS NULL;
