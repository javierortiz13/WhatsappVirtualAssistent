-- 0035 (PRD hábitos v4.2.1, fase 4, US-411): puntos, niveles y regalos. Todo apagado con
-- habits.xp / habits.rewards: sin los interruptores nada escribe aquí.
--
-- - points_event: el libro de puntos. Una fila por regla y clave (fecha, corrida o regla), así
--   que volver a sincronizar nunca suma dos veces. Las reversas son filas negativas con `reverses`.
--   Sin texto ni montos de dinero.
-- - reward_grant: el regalo de cada nivel (y, con la fase P4-B, los de invitaciones), con su
--   estado y por qué espera.
-- - points_notice: las líneas que salen en la próxima respuesta del dueño (RW2, RW8…), una vez.
-- - reward_month: lo reservado del tope del mes, para todos los negocios. Solo se escribe con
--   app.book_reward_cost (SECURITY DEFINER): caja_app solo lo lee.
-- - tenant.points_level / points_level_at: el nivel guardado; nunca baja.
--
-- Las tablas por negocio borran en cascada con el negocio (`app.erase_tenant`), como 0025.

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS points_level smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS points_level_at timestamptz;

CREATE TABLE IF NOT EXISTS app.points_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  rule          text NOT NULL,
  ref_key       text NOT NULL,
  points        integer NOT NULL,
  business_date date NOT NULL,
  -- Reversas (N-2): record_deleted, manual (con su motivo), ref_reversed.
  reason        text,
  reverses      uuid REFERENCES app.points_event(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT points_event_reason_check
    CHECK (reason IS NULL OR reason ~ '^(record_deleted|ref_reversed|manual(:[a-z_]+)?)$')
);
CREATE UNIQUE INDEX IF NOT EXISTS points_event_rule_key ON app.points_event (tenant_id, rule, ref_key);
CREATE INDEX IF NOT EXISTS points_event_tenant_date ON app.points_event (tenant_id, business_date);
ALTER TABLE app.points_event ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.points_event;
CREATE POLICY tenant_isolation ON app.points_event
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT ON app.points_event TO caja_app;

CREATE TABLE IF NOT EXISTS app.reward_grant (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  kind               text NOT NULL
    CHECK (kind IN ('level_n2', 'level_n3', 'level_n4', 'level_n5', 'ref_month', 'ref_invitee_msgs')),
  status             text NOT NULL
    CHECK (status IN ('applied', 'waiting', 'pending_review', 'cancelled', 'refused', 'test')),
  wait_reason        text CHECK (wait_reason IN ('ceiling', 'not_paying', 'flag_off', 'paused')),
  -- Lo que se aplicó, para el texto: «messages» (20/50), «trial_days», «week», «discount».
  applied_as         text,
  cost_usd_estimate  numeric(10, 2) NOT NULL DEFAULT 0,
  -- Mes ('YYYY-MM' de Caracas) al que se reservó su costo; null si no se reservó.
  booked_month       text,
  applied_at         timestamptz,
  -- Con la fase P4-B: la invitación y el pago del invitado (otro negocio): SET NULL.
  referral_id        uuid,
  payment_id         uuid REFERENCES app.payment(id) ON DELETE SET NULL,
  source_approved_at timestamptz,
  flags              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Un regalo por nivel y negocio, en toda la vida.
CREATE UNIQUE INDEX IF NOT EXISTS reward_grant_level_key ON app.reward_grant (tenant_id, kind)
  WHERE kind LIKE 'level_%';
CREATE INDEX IF NOT EXISTS reward_grant_waiting ON app.reward_grant (status, wait_reason, created_at);
ALTER TABLE app.reward_grant ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.reward_grant;
CREATE POLICY tenant_isolation ON app.reward_grant
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.reward_grant TO caja_app;

CREATE TABLE IF NOT EXISTS app.points_notice (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES app.tenant(id) ON DELETE CASCADE,
  -- RW2 (level), RW8a…RW8h: qué línea y sus datos (sin texto, nombres ni montos de otros).
  kind       text NOT NULL,
  args       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  shown_at   timestamptz
);
CREATE INDEX IF NOT EXISTS points_notice_pending ON app.points_notice (tenant_id, created_at)
  WHERE shown_at IS NULL;
ALTER TABLE app.points_notice ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON app.points_notice;
CREATE POLICY tenant_isolation ON app.points_notice
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON app.points_notice TO caja_app;

-- El tope del mes, sumado entre negocios (no son datos de nadie). caja_app solo lee (/admin).
CREATE TABLE IF NOT EXISTS app.reward_month (
  month      text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  booked_usd numeric(10, 2) NOT NULL DEFAULT 0 CHECK (booked_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON app.reward_month TO caja_app;

-- Reserva `p_usd` del mes `p_month` si cabe bajo el tope (leído aquí de app_setting `rewards`,
-- 20 si falta); con p_force, sin mirar el tope (el 10 % de Leyenda y la entrega del día 1).
-- Crea la fila del mes y reserva en una sola sentencia condicionada: dos llamadas a la vez no
-- pasan el tope. Devuelve true solo si reservó.
CREATE OR REPLACE FUNCTION app.book_reward_cost(p_month text, p_usd numeric, p_force boolean DEFAULT false)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_ceiling numeric;
  v_done text;
BEGIN
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'bad month';
  END IF;
  IF p_usd IS NULL OR p_usd < 0 OR p_usd > 1000 THEN
    RAISE EXCEPTION 'bad usd';
  END IF;
  SELECT coalesce((value->>'monthlyCeilingUsd')::numeric, 20) INTO v_ceiling
    FROM app_setting WHERE key = 'rewards';
  v_ceiling := coalesce(v_ceiling, 20);
  INSERT INTO reward_month (month) VALUES (p_month) ON CONFLICT (month) DO NOTHING;
  UPDATE reward_month
     SET booked_usd = booked_usd + round(p_usd, 2), updated_at = now()
   WHERE month = p_month
     AND (coalesce(p_force, false) OR booked_usd + round(p_usd, 2) <= v_ceiling)
  RETURNING month INTO v_done;
  RETURN v_done IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.book_reward_cost(text, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.book_reward_cost(text, numeric, boolean) TO caja_app;
