-- Dos recargas (07/10/2026, decisión de Javier): +20 mensajes por $1 y +100 por $4. El pago de
-- una recarga guarda cuántos mensajes suma al aprobarse; los de antes (sin dato) eran de 100.
-- La prueba gratis pasa a medirse en mensajes (100 / 200 / 300): no requiere columnas nuevas.
ALTER TABLE app.payment ADD COLUMN IF NOT EXISTS extra_messages integer;
ALTER TABLE app.payment DROP CONSTRAINT IF EXISTS payment_extra_messages_check;
ALTER TABLE app.payment ADD CONSTRAINT payment_extra_messages_check
  CHECK (extra_messages IS NULL OR extra_messages > 0);
