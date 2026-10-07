-- Registro por WhatsApp (07/10/2026). Pedido de Javier: compartir el número de Rocco y que la
-- gente cree su cuenta en el chat, sin pasar por la web. Mismo contenido que el asistente web:
-- nombre, para mí o para mi negocio, moneda, categorías, cuentas y un presupuesto.
-- - `signup`: un registro en curso por número (global, sin tenant hasta terminar). Guarda el paso
--   y lo respondido; sirve también para medir el embudo (dónde se quedan).
-- - `dashboard_link`: quien se registró por WhatsApp entra al panel con su correo y prueba que el
--   número es suyo mandándole a Rocco el código que ve en la web. Solo se guarda el hash.
-- - `tenant.signup_channel`: por dónde llegó cada negocio (web o WhatsApp), para el CRM.
-- Sin llaves foráneas a tenant ni a user_account: así no estorban a `erase_tenant` ni al
-- borrado de usuarios huérfanos. Un `tenant_id` viejo no hace daño: si el número ya no existe,
-- el registro empieza de nuevo.

CREATE TABLE IF NOT EXISTS app.signup (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164          text NOT NULL UNIQUE,
  wa_user_id    text,
  profile_name  text,
  step          text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  messages      integer NOT NULL DEFAULT 0,
  tenant_id     uuid,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_created_idx ON app.signup (created_at);

CREATE TABLE IF NOT EXISTS app.dashboard_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  tenant_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dashboard_link_code_idx ON app.dashboard_link (code_hash)
  WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON app.signup, app.dashboard_link TO caja_app;

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS signup_channel text NOT NULL DEFAULT 'dashboard';
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_signup_channel_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_signup_channel_check
  CHECK (signup_channel IN ('dashboard', 'whatsapp'));
