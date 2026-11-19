-- 0039 (retención E1–E3, agencia 19/11, A-0051): el «Sí, recuérdame» de E3 / E3-r / E3-t.
--
-- `reengage_opt_in_at`: aceptó que Rocco le escriba a su hora habitual aunque no le haya escrito
-- (la plantilla E1). Es otro consentimiento que el aviso de la noche (H8/H13 solo cubre la ventana
-- de 24 h), por eso no se reusa `nudge_opt_in_at`. El texto que vio va en `audit_log`.
-- `reengage_declined_at`: tocó «No, gracias»; no se le vuelve a preguntar.
-- `reengage_minute`: su hora habitual de Caracas, en minutos desde la medianoche (480–1225).
ALTER TABLE app.phone_number
  ADD COLUMN IF NOT EXISTS reengage_opt_in_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reengage_declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS reengage_minute      integer;
ALTER TABLE app.phone_number DROP CONSTRAINT IF EXISTS phone_number_reengage_minute_check;
ALTER TABLE app.phone_number ADD CONSTRAINT phone_number_reengage_minute_check
  CHECK (reengage_minute IS NULL OR (reengage_minute >= 0 AND reengage_minute < 1440));
