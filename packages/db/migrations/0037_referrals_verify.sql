-- 0037 (PRD hábitos v4.2.1, fase 4, P4-B; revisión de seguridad P4 del 06/11, F1 y F2).
-- Todo sigue apagado con habits.referrals.
--
-- - tenant.pending_ref_code (F1): el código de invitación que se escribió en /registro, guardado
--   hasta que el dueño verifica su número por WhatsApp. Recién ahí se une la invitación y se dan
--   los +50 (antes, la cuenta web los recibía con un número sin verificar). Solo la forma del
--   código, nunca a quién pertenece.
-- - referral_month (F2): lo reservado por los +50 de los invitados, aparte del tope de los regalos
--   de nivel (`reward_month`), que ya no lo cuenta (§P4.6 regla 2, §P4.9 fila 5, SEC-P4-9 d).
--   Solo se escribe con app.book_referral_cost (SECURITY DEFINER); caja_app solo lee.
--
-- 0032, 0033 y 0034 quedan para otra rama: el migrador aplica por nombre los archivos que faltan,
-- así que en una base que ya tiene 0037 se aplican después, y en una nueva, antes. Antes de
-- fusionar esa rama: correr todas en orden de nombre en un PGlite nuevo (H4 de la revisión).

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS pending_ref_code text
    CONSTRAINT tenant_pending_ref_code_check
    CHECK (pending_ref_code IS NULL OR app.referral_code_shape(pending_ref_code));

-- Lo reservado por los +50 de los invitados, por mes (no son datos de nadie). caja_app solo lee.
CREATE TABLE IF NOT EXISTS app.referral_month (
  month      text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  booked_usd numeric(10, 2) NOT NULL DEFAULT 0 CHECK (booked_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON app.referral_month TO caja_app;

-- Reserva `p_usd` del mes `p_month` en el contador de invitados, sin tope (no detiene el +50,
-- A39). Mismas validaciones que app.book_reward_cost. Una sola sentencia: dos a la vez suman bien.
CREATE OR REPLACE FUNCTION app.book_referral_cost(p_month text, p_usd numeric)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
BEGIN
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'bad month';
  END IF;
  IF p_usd IS NULL OR p_usd < 0 OR p_usd > 1000 THEN
    RAISE EXCEPTION 'bad usd';
  END IF;
  INSERT INTO referral_month (month, booked_usd) VALUES (p_month, round(p_usd, 2))
  ON CONFLICT (month) DO UPDATE
    SET booked_usd = referral_month.booked_usd + round(p_usd, 2), updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION app.book_referral_cost(text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.book_referral_cost(text, numeric) TO caja_app;
