-- 0036 (PRD hábitos v4.2.1, fase 4, P4-B, US-412): invitaciones. Todo apagado con
-- habits.referrals: sin el interruptor, nadie ve ni usa un código.
--
-- - referral_code: el código del dueño (6 caracteres del alfabeto de §P4.7, al menos 2 dígitos).
-- - referral: quién invitó a quién y en qué paso va. `tenant_id` es el del que INVITA (RLS como
--   siempre, y caja_app solo lee). El lado del invitado se escribe solo con las funciones SECURITY
--   DEFINER de abajo, que leen `app.tenant_id` (nunca un tenant por argumento) y calculan el paso
--   con las filas del propio invitado (SEC-P4-1, SEC-P4-8). Sin columna de nombre (A43).
-- - payment.status `reversed` (US-418), con quién y cuándo.
-- - tenant.referral_late_attempts: intentos de «me invitó CODE» después del registro (máx. 3).
-- Las dos llaves a negocio borran en cascada; los regalos que apuntan a una invitación quedan con
-- `referral_id` en null (ER-1).

ALTER TABLE app.payment DROP CONSTRAINT IF EXISTS payment_status_check;
ALTER TABLE app.payment ADD CONSTRAINT payment_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'reversed'));
ALTER TABLE app.payment
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by text;

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS referral_late_attempts smallint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS app.referral_code (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL UNIQUE REFERENCES app.tenant(id) ON DELETE CASCADE,
  code            text NOT NULL UNIQUE
    CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'
           AND length(regexp_replace(code, '[^0-9]', '', 'g')) >= 2),
  disabled_at     timestamptz,
  -- 'admin' (el fundador) o 'reversals' (dos invitaciones que dejaron de contar, §P4.4 regla 8).
  disabled_reason text CHECK (disabled_reason IN ('admin', 'reversals')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.referral_code ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.referral_code;
CREATE POLICY tenant_isolation ON app.referral_code
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.referral_code TO caja_app;

CREATE TABLE IF NOT EXISTS app.referral (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- El que invita.
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  invitee_tenant_id  uuid NOT NULL UNIQUE REFERENCES app.tenant(id) ON DELETE CASCADE,
  via                text NOT NULL CHECK (via IN ('web', 'chat', 'late')),
  stage              text NOT NULL CHECK (stage IN ('signed_up', 'active', 'paid', 'ended')),
  signed_up_at       timestamptz NOT NULL,
  active_at          timestamptz,
  paid_at            timestamptz,
  -- El pago del invitado (otro negocio): SET NULL.
  payment_id         uuid REFERENCES app.payment(id) ON DELETE SET NULL,
  source_approved_at timestamptz,
  ended_at           timestamptz,
  end_reason         text CHECK (end_reason IN ('expired', 'returning', 'reversed')),
  -- Solo booleanos (§P4.4 regla 6): same_email, same_payer, velocity.
  flags              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_inviter ON app.referral (tenant_id, signed_up_at);
ALTER TABLE app.referral ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.referral;
CREATE POLICY tenant_isolation ON app.referral
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT ON app.referral TO caja_app;

ALTER TABLE app.reward_grant
  DROP CONSTRAINT IF EXISTS reward_grant_referral_fk;
ALTER TABLE app.reward_grant
  ADD CONSTRAINT reward_grant_referral_fk
  FOREIGN KEY (referral_id) REFERENCES app.referral(id) ON DELETE SET NULL;
-- Un mes de regalo por invitación; un +50 por invitado.
CREATE UNIQUE INDEX IF NOT EXISTS reward_grant_ref_month_key ON app.reward_grant (tenant_id, referral_id)
  WHERE kind = 'ref_month' AND referral_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reward_grant_invitee_key ON app.reward_grant (tenant_id)
  WHERE kind = 'ref_invitee_msgs';

-- ---------------------------------------------------------------- funciones (SECURITY DEFINER)

-- ¿El código tiene la forma de §P4.7? Sin consulta a ninguna tabla.
CREATE OR REPLACE FUNCTION app.referral_code_shape(p_code text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = app, pg_temp
AS $$
  SELECT p_code IS NOT NULL
     AND p_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'
     AND length(regexp_replace(p_code, '[^0-9]', '', 'g')) >= 2;
$$;

-- Días con registro del negocio (la regla de `keptDays`, sin los días sin gastos).
CREATE OR REPLACE FUNCTION app.referral_record_days(p_tenant uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT count(DISTINCT d)::integer FROM (
    SELECT (created_at AT TIME ZONE 'America/Caracas')::date AS d, deleted_at, created_at
      FROM movement WHERE tenant_id = p_tenant
    UNION ALL
    SELECT (created_at AT TIME ZONE 'America/Caracas')::date, deleted_at, created_at
      FROM account_transfer WHERE tenant_id = p_tenant
    UNION ALL
    SELECT (created_at AT TIME ZONE 'America/Caracas')::date, deleted_at, created_at
      FROM exchange_lot WHERE tenant_id = p_tenant AND source = 'exchange'
  ) r
  WHERE deleted_at IS NULL
     OR (deleted_at AT TIME ZONE 'America/Caracas')::date <> (created_at AT TIME ZONE 'America/Caracas')::date;
$$;
REVOKE ALL ON FUNCTION app.referral_record_days(uuid) FROM PUBLIC;

-- El dueño de un código habilitado de un negocio activo (no suspendido, no en la papelera), o null.
-- El uuid nunca sale del servidor (SEC-P4-8): solo lo usan las funciones de abajo.
CREATE OR REPLACE FUNCTION app.referral_code_owner(p_code text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE v uuid;
BEGIN
  IF NOT app.referral_code_shape(p_code) THEN RETURN NULL; END IF;
  SELECT c.tenant_id INTO v FROM referral_code c JOIN tenant t ON t.id = c.tenant_id
   WHERE c.code = p_code AND c.disabled_at IS NULL
     AND t.deleted_at IS NULL AND t.status <> 'suspended';
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION app.referral_code_owner(text) FROM PUBLIC;

-- Lo mínimo para el chat y /registro: 'none' (mal escrito, no existe o pausado), 'not_eligible'
-- (existe, pero quien invita no puede invitar todavía: §P4.4 regla 10) u 'ok'. Nunca el uuid.
CREATE OR REPLACE FUNCTION app.referral_code_check(p_code text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE v uuid;
BEGIN
  v := app.referral_code_owner(p_code);
  IF v IS NULL THEN RETURN 'none'; END IF;
  IF app.referral_record_days(v) < 3 THEN RETURN 'not_eligible'; END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION app.referral_code_check(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.referral_code_check(text) TO caja_app;

-- Une al invitado (app.tenant_id) con el código, una sola vez (US-420, US-421). Devuelve
-- 'attached', 'returning' (número que ya usó Rocco: se guarda para los conteos, sin regalos),
-- 'invalid' (su propio código o quien invita no puede invitar), 'not_found' o 'already'.
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
  -- que no sea el suyo (los vaciados a los 90 días con marca conservan el número, 0031).
  SELECT EXISTS (
    SELECT 1 FROM phone_number mine
    WHERE mine.tenant_id = v_invitee AND (
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

-- Mueve el paso de la invitación del negocio actual como invitado (US-422), con sus propias filas:
-- activo con su primer día con registro; pagó con su primer pago de plan aprobado dentro de 90 días;
-- vencido a los 90 días sin pago; devuelto si ese pago se marcó `reversed`. Nada se mueve mientras
-- el invitado está en la papelera (PV-1). Se borra 30 días después del último paso y a los 12 meses.
CREATE OR REPLACE FUNCTION app.referral_sync_invitee()
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_invitee uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  r referral%ROWTYPE;
  v_pay payment%ROWTYPE;
  v_first timestamptz;
BEGIN
  IF v_invitee IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM referral WHERE invitee_tenant_id = v_invitee FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM tenant WHERE id = v_invitee AND deleted_at IS NOT NULL) THEN RETURN; END IF;

  IF r.stage IN ('signed_up', 'active') AND r.active_at IS NULL
     AND app.referral_record_days(v_invitee) >= 1 THEN
    UPDATE referral SET active_at = now(), stage = 'active', updated_at = now() WHERE id = r.id;
    r.active_at := now(); r.stage := 'active';
  END IF;

  IF r.stage IN ('signed_up', 'active') AND r.paid_at IS NULL THEN
    SELECT * INTO v_pay FROM payment
     WHERE tenant_id = v_invitee AND kind = 'plan' AND status = 'approved'
       AND reviewed_at <= r.signed_up_at + interval '90 days'
     ORDER BY reviewed_at LIMIT 1;
    IF FOUND THEN
      UPDATE referral SET
        stage = 'paid', paid_at = v_pay.reviewed_at, payment_id = v_pay.id,
        source_approved_at = v_pay.reviewed_at,
        active_at = coalesce(active_at, v_pay.reviewed_at),
        flags = flags || jsonb_build_object('same_payer', EXISTS (
          SELECT 1 FROM payment p WHERE p.tenant_id = r.tenant_id AND p.status = 'approved'
            AND ((v_pay.reference IS NOT NULL AND p.reference = v_pay.reference)
              OR (v_pay.notes IS NOT NULL AND p.notes = v_pay.notes)))),
        updated_at = now()
      WHERE id = r.id;
      r.stage := 'paid'; r.payment_id := v_pay.id; r.paid_at := v_pay.reviewed_at;
    ELSIF now() > r.signed_up_at + interval '90 days' THEN
      UPDATE referral SET stage = 'ended', end_reason = 'expired', ended_at = now(), updated_at = now()
       WHERE id = r.id;
      r.stage := 'ended'; r.ended_at := now();
    END IF;
  END IF;

  IF r.stage = 'paid' AND r.payment_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM payment WHERE id = r.payment_id AND status = 'reversed') THEN
    UPDATE referral SET stage = 'ended', end_reason = 'reversed', ended_at = now(), updated_at = now()
     WHERE id = r.id;
    r.stage := 'ended'; r.ended_at := now();
  END IF;

  -- Conservación (PR-R3, §P4.13).
  SELECT coalesce(r.ended_at, r.paid_at) INTO v_first;
  IF (r.stage IN ('ended', 'paid') AND v_first < now() - interval '30 days')
     OR r.signed_up_at < now() - interval '12 months' THEN
    DELETE FROM referral WHERE id = r.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.referral_sync_invitee() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.referral_sync_invitee() TO caja_app;

-- Lo que el que invita (app.tenant_id) puede saber de sus invitaciones: el paso y si el invitado
-- está en la papelera (PV-1). `invitee_tenant_id` solo para la revisión de /admin en el servidor.
CREATE OR REPLACE FUNCTION app.my_referrals()
RETURNS TABLE (
  id uuid, invitee_tenant_id uuid, via text, stage text, signed_up_at timestamptz,
  active_at timestamptz, paid_at timestamptz, payment_id uuid, source_approved_at timestamptz,
  ended_at timestamptz, end_reason text, flags jsonb, invitee_trashed boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT r.id, r.invitee_tenant_id, r.via, r.stage, r.signed_up_at, r.active_at, r.paid_at,
         r.payment_id, r.source_approved_at, r.ended_at, r.end_reason, r.flags,
         (t.deleted_at IS NOT NULL)
    FROM referral r JOIN tenant t ON t.id = r.invitee_tenant_id
   WHERE r.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   ORDER BY r.signed_up_at;
$$;
REVOKE ALL ON FUNCTION app.my_referrals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_referrals() TO caja_app;

-- El pago de un invitado para la revisión del fundador (regla 9: los dos planes y montos). Solo
-- si la invitación es del negocio actual. Lee el plan y el monto; nada más.
CREATE OR REPLACE FUNCTION app.referral_invitee_payment(p_referral uuid)
RETURNS TABLE (plan text, amount_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT p.plan, p.amount_usd FROM referral r JOIN payment p ON p.id = r.payment_id
   WHERE r.id = p_referral
     AND r.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;
REVOKE ALL ON FUNCTION app.referral_invitee_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.referral_invitee_payment(uuid) TO caja_app;
