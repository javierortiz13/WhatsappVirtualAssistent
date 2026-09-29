-- 0001_init: schema app, tablas del MVP, RLS por tenant.
-- Fuente de verdad del esquema. packages/db/src/schema/index.ts debe reflejarlo.
--
-- Roles:
--   caja_app   rol de la aplicación (web y worker). Sujeto a RLS. Se crea NOLOGIN aquí;
--              el administrador le da LOGIN y contraseña fuera del repositorio:
--              ALTER ROLE caja_app LOGIN PASSWORD '...';
--   El rol que ejecuta las migraciones es dueño de las tablas y no está sujeto a RLS
--   (no se usa FORCE ROW LEVEL SECURITY). Las tareas cruzadas entre tenants (retención,
--   métricas) se exponen como funciones SECURITY DEFINER en migraciones posteriores.

CREATE SCHEMA IF NOT EXISTS app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caja_app') THEN
    CREATE ROLE caja_app NOLOGIN;
  END IF;
END
$$;

-- Supabase expone `public` por su API REST a anon/authenticated. `app` no se expone: nada que revocar
-- si los roles no existen (fuera de Supabase), y revocación explícita si existen.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON SCHEMA app FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON SCHEMA app FROM authenticated;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO caja_app;

-- Tenant actual de la transacción. NULL si no se fijó: las políticas devuelven cero filas.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- tenant
CREATE TABLE app.tenant (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  business_type             text NOT NULL,
  default_expense_currency  text,
  ves_threshold             numeric(18,2) NOT NULL DEFAULT 1000,
  timezone                  text NOT NULL DEFAULT 'America/Caracas',
  wa_phone_number_id        text,
  close_reminder_time       time NOT NULL DEFAULT '18:00',
  status                    text NOT NULL DEFAULT 'trial',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_business_type_check CHECK (business_type IN ('car_wash', 'food', 'retail', 'services', 'other')),
  CONSTRAINT tenant_default_expense_currency_check CHECK (default_expense_currency IS NULL OR default_expense_currency IN ('USD', 'VES')),
  CONSTRAINT tenant_status_check CHECK (status IN ('trial', 'active', 'suspended'))
);

-- ---------------------------------------------------------------- user_account (id = auth.users.id)
CREATE TABLE app.user_account (
  id          uuid PRIMARY KEY,
  email       text NOT NULL,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_account_email_key ON app.user_account (lower(email));

CREATE TABLE app.tenant_member (
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id),
  user_id     uuid NOT NULL REFERENCES app.user_account(id),
  role        text NOT NULL DEFAULT 'owner',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT tenant_member_role_check CHECK (role IN ('owner'))
);

-- ---------------------------------------------------------------- phone_number
CREATE TABLE app.phone_number (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES app.tenant(id),
  e164          text NOT NULL UNIQUE,
  wa_user_id    text UNIQUE,
  role          text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  display_name  text,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_number_role_check CHECK (role IN ('owner', 'employee')),
  CONSTRAINT phone_number_status_check CHECK (status IN ('pending', 'active', 'disabled'))
);
CREATE INDEX phone_number_tenant_idx ON app.phone_number (tenant_id);

CREATE TABLE app.phone_verification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id),
  phone_id    uuid NOT NULL REFERENCES app.phone_number(id),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- category
CREATE TABLE app.category (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'expense',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_kind_check CHECK (kind IN ('expense', 'income'))
);
CREATE UNIQUE INDEX category_tenant_kind_name_key ON app.category (tenant_id, kind, name);

-- ---------------------------------------------------------------- bcv_rate (global)
CREATE TABLE app.bcv_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_date  date NOT NULL UNIQUE,
  rate            numeric(18,8) NOT NULL CHECK (rate > 0),
  published_at    timestamptz,
  source          text NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- attachment
CREATE TABLE app.attachment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES app.tenant(id),
  kind         text NOT NULL,
  storage_key  text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   integer NOT NULL,
  sha256       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- ---------------------------------------------------------------- webhook_event (global)
CREATE TABLE app.webhook_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key     text NOT NULL UNIQUE,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  status        text NOT NULL DEFAULT 'received',
  error         text,
  CONSTRAINT webhook_event_status_check CHECK (status IN ('received', 'processing', 'done', 'failed', 'ignored', 'expired'))
);

-- ---------------------------------------------------------------- message
CREATE TABLE app.message (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenant(id),
  phone_id          uuid NOT NULL REFERENCES app.phone_number(id),
  direction         text NOT NULL,
  wa_message_id     text UNIQUE,
  kind              text NOT NULL,
  body              text,
  media_id          text,
  tool_calls        jsonb,
  tokens_in         integer,
  tokens_out        integer,
  latency_ms        integer,
  cost_usd          numeric(10,6),
  status            text NOT NULL DEFAULT 'ok',
  webhook_event_id  uuid REFERENCES app.webhook_event(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_direction_check CHECK (direction IN ('in', 'out'))
);
CREATE INDEX message_phone_recent_idx ON app.message (phone_id, created_at DESC);

-- ---------------------------------------------------------------- movement
CREATE TABLE app.movement (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES app.tenant(id),
  type                 text NOT NULL,
  business_date        date NOT NULL,
  amount               numeric(18,2) NOT NULL,
  currency             text NOT NULL,
  rate_id              uuid NOT NULL REFERENCES app.bcv_rate(id),
  rate_value           numeric(18,8) NOT NULL,
  amount_usd           numeric(14,2) NOT NULL,
  amount_ves           numeric(18,2) NOT NULL,
  category_id          uuid REFERENCES app.category(id),
  payment_method       text NOT NULL DEFAULT 'unspecified',
  description          text,
  origin               text NOT NULL DEFAULT 'single',
  source_channel       text NOT NULL,
  created_by_phone_id  uuid REFERENCES app.phone_number(id),
  created_by_user_id   uuid REFERENCES app.user_account(id),
  source_message_id    uuid REFERENCES app.message(id),
  attachment_id        uuid REFERENCES app.attachment(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT movement_type_check CHECK (type IN ('expense', 'income')),
  CONSTRAINT movement_currency_check CHECK (currency IN ('USD', 'VES')),
  CONSTRAINT movement_amount_positive CHECK (amount > 0),
  CONSTRAINT movement_payment_method_check CHECK (payment_method IN ('cash_usd', 'cash_ves', 'pago_movil', 'punto', 'zelle', 'transfer_usd', 'transfer_ves', 'other', 'unspecified')),
  CONSTRAINT movement_origin_check CHECK (origin IN ('single', 'day_total')),
  CONSTRAINT movement_source_channel_check CHECK (source_channel IN ('text', 'voice', 'image', 'dashboard')),
  CONSTRAINT movement_single_author CHECK ((created_by_phone_id IS NULL) <> (created_by_user_id IS NULL)),
  CONSTRAINT movement_income_needs_method CHECK (type = 'expense' OR payment_method <> 'unspecified' OR origin = 'day_total')
);
CREATE INDEX movement_tenant_date_idx ON app.movement (tenant_id, business_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX movement_tenant_category_idx ON app.movement (tenant_id, category_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- pending_action
CREATE TABLE app.pending_action (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES app.tenant(id),
  phone_id           uuid NOT NULL REFERENCES app.phone_number(id),
  kind               text NOT NULL,
  payload            jsonb NOT NULL,
  status             text NOT NULL DEFAULT 'pending',
  prompt_message_id  uuid,
  expires_at         timestamptz NOT NULL,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_action_kind_check CHECK (kind IN ('create_expense', 'create_income_day_total', 'create_income_single', 'replace_day_total', 'edit_last', 'delete_last')),
  CONSTRAINT pending_action_status_check CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired'))
);
CREATE UNIQUE INDEX pending_action_one_active ON app.pending_action (phone_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- audit_log (solo INSERT para la app)
CREATE TABLE app.audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES app.tenant(id),
  actor_type  text NOT NULL,
  actor_id    uuid,
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   uuid NOT NULL,
  before      jsonb,
  after       jsonb,
  channel     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('phone', 'user', 'system'))
);
CREATE INDEX audit_tenant_entity_idx ON app.audit_log (tenant_id, entity, entity_id);

-- ---------------------------------------------------------------- integration (reservada, Odoo)
CREATE TABLE app.integration (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES app.tenant(id),
  provider          text NOT NULL,
  config_encrypted  text,
  status            text NOT NULL DEFAULT 'disabled',
  last_sync_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- unknown_sender_hit (global, sin contenido)
CREATE TABLE app.unknown_sender_hit (
  e164          text PRIMARY KEY,
  hits          integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- permisos
GRANT SELECT, INSERT, UPDATE ON
  app.tenant, app.user_account, app.tenant_member, app.phone_number, app.phone_verification,
  app.category, app.attachment, app.message, app.movement, app.pending_action, app.integration
TO caja_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.webhook_event, app.unknown_sender_hit, app.bcv_rate TO caja_app;
GRANT INSERT, SELECT ON app.audit_log TO caja_app;
GRANT USAGE, SELECT ON SEQUENCE app.audit_log_id_seq TO caja_app;

-- ---------------------------------------------------------------- RLS
-- Una política por tabla con tenant_id. tenant usa su propio id.
ALTER TABLE app.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());

ALTER TABLE app.tenant_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_member
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.phone_number ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.phone_number
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
-- Resolver un número a su tenant ocurre antes de conocer el tenant: política de lectura global
-- restringida a las columnas necesarias mediante la función app.resolve_phone (abajo).

ALTER TABLE app.phone_verification ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.phone_verification
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.category ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.category
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.attachment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.attachment
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.message ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.message
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.movement
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.pending_action ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.pending_action
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.audit_log
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE app.integration ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.integration
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

-- user_account no tiene tenant: la app la usa solo para mapear auth.users -> tenant_member.
-- Sin RLS, pero caja_app solo puede leer por id o email exactos a través de la capa de acceso.

-- ---------------------------------------------------------------- resolución de teléfono
-- El worker recibe un mensaje y aún no sabe el tenant. Esta función SECURITY DEFINER devuelve
-- lo mínimo para enrutar, sin abrir phone_number a lectura global.
CREATE OR REPLACE FUNCTION app.resolve_phone(p_e164 text, p_wa_user_id text)
RETURNS TABLE (phone_id uuid, tenant_id uuid, role text, status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT p.id, p.tenant_id, p.role, p.status, t.status
  FROM app.phone_number p
  JOIN app.tenant t ON t.id = p.tenant_id
  WHERE (p_e164 IS NOT NULL AND p.e164 = p_e164)
     OR (p_wa_user_id IS NOT NULL AND p.wa_user_id = p_wa_user_id)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.resolve_phone(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_phone(text, text) TO caja_app;

-- Un número pertenece a un solo tenant en toda la plataforma (UNIQUE e164). Comprobar
-- disponibilidad durante el onboarding también ocurre antes de tener tenant:
CREATE OR REPLACE FUNCTION app.phone_is_taken(p_e164 text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app.phone_number WHERE e164 = p_e164)
$$;
REVOKE ALL ON FUNCTION app.phone_is_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.phone_is_taken(text) TO caja_app;
