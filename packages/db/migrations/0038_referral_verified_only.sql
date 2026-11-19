-- 0038 (seguridad, re-revisión de fdae0ce, V-1): app.attach_referral decidía si el invitado «ya
-- usó Rocco» con todos los números del negocio, también los empleados que el dueño agrega sin que
-- hayan escrito (sin verified_at). Con eso, alguien podía agregar números ajenos como empleados y,
-- por el resultado (100 o 150, «no se puede usar» o +50), saber si esas personas usaron Rocco.
-- Igual que en 0036, con un solo cambio: solo cuentan los números con verified_at.

CREATE OR REPLACE FUNCTION app.attach_referral(p_code text, p_via text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_invitee uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_inviter uuid;
  v_returning boolean;
  v_flags jsonb;
BEGIN
  IF v_invitee IS NULL THEN RAISE EXCEPTION 'attach_referral: sin negocio'; END IF;
  IF p_via NOT IN ('web', 'chat', 'late') THEN RAISE EXCEPTION 'attach_referral: via'; END IF;
  IF NOT app.referral_code_shape(p_code) THEN RETURN 'not_found'; END IF;
  IF EXISTS (SELECT 1 FROM referral WHERE invitee_tenant_id = v_invitee) THEN RETURN 'already'; END IF;
  v_inviter := app.referral_code_owner(p_code);
  IF v_inviter IS NULL THEN RETURN 'not_found'; END IF;
  IF v_inviter = v_invitee OR app.referral_record_days(v_inviter) < 3 THEN RETURN 'invalid'; END IF;
  -- ¿Nuevo en Rocco? (§P4.4 regla 5, PV-6): sus números no están en otro negocio ni en un registro
  -- que no sea el suyo (los vaciados a los 90 días con marca conservan el número, 0031). Solo los
  -- números verificados (0038, V-1): uno que el dueño agregó y nunca escribió no cuenta.
  SELECT EXISTS (
    SELECT 1 FROM phone_number mine
    WHERE mine.tenant_id = v_invitee AND mine.verified_at IS NOT NULL AND (
      EXISTS (SELECT 1 FROM phone_number o WHERE o.e164 = mine.e164 AND o.tenant_id <> v_invitee)
      OR EXISTS (SELECT 1 FROM signup s WHERE s.e164 = mine.e164
                 AND s.tenant_id IS DISTINCT FROM v_invitee)
    )
  ) INTO v_returning;
  -- Señales para la revisión del fundador (regla 6), solo booleanos.
  v_flags := jsonb_build_object(
    'same_email', EXISTS (
      SELECT 1 FROM tenant_member a JOIN user_account ua ON ua.id = a.user_id
      JOIN user_account ub ON lower(ub.email) = lower(ua.email)
      JOIN tenant_member b ON b.user_id = ub.id
      WHERE a.tenant_id = v_invitee AND b.tenant_id = v_inviter),
    'velocity', (SELECT count(*) FROM referral r
                 WHERE r.tenant_id = v_inviter AND r.signed_up_at > now() - interval '24 hours') >= 3
  );
  INSERT INTO referral (tenant_id, invitee_tenant_id, via, stage, signed_up_at, ended_at, end_reason, flags)
  VALUES (v_inviter, v_invitee, p_via,
          CASE WHEN v_returning THEN 'ended' ELSE 'signed_up' END, now(),
          CASE WHEN v_returning THEN now() END,
          CASE WHEN v_returning THEN 'returning' END, v_flags)
  ON CONFLICT (invitee_tenant_id) DO NOTHING;
  IF NOT FOUND THEN RETURN 'already'; END IF;
  RETURN CASE WHEN v_returning THEN 'returning' ELSE 'attached' END;
END;
$$;
REVOKE ALL ON FUNCTION app.attach_referral(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attach_referral(text, text) TO caja_app;
