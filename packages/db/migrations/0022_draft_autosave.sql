-- Autoguardado de borradores (13/10/2026, pedido de Javier). Los borradores de gasto, venta,
-- transferencia y cambio ya no esperan "Guardar": si en 15 minutos no se corrigen ni se cancelan,
-- el worker los guarda y reacciona ✅ sobre el mensaje del usuario. Ahorra el toque y el
-- "Guardado" (dos mensajes de Meta). Borrar, corregir lo guardado y renovar siguen pidiendo
-- confirmación (auto_save = false). Las filas viejas quedan en false: vencen sin guardarse.
ALTER TABLE app.pending_action ADD COLUMN IF NOT EXISTS auto_save boolean NOT NULL DEFAULT false;
-- Mensaje del usuario que originó el borrador (para la reacción) y número de Meta que lo recibió.
ALTER TABLE app.pending_action ADD COLUMN IF NOT EXISTS source_wa_id text;
ALTER TABLE app.pending_action ADD COLUMN IF NOT EXISTS wa_number_id text;

CREATE INDEX IF NOT EXISTS pending_action_due ON app.pending_action (expires_at)
  WHERE status = 'pending';

-- Negocios con borradores vencidos, para el barrido de cada minuto. Solo devuelve ids; cada
-- lectura y escritura sigue bajo RLS con withTenant.
CREATE OR REPLACE FUNCTION app.due_draft_tenant_ids(at timestamptz)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT DISTINCT tenant_id FROM app.pending_action WHERE status = 'pending' AND expires_at <= at;
$$;
REVOKE ALL ON FUNCTION app.due_draft_tenant_ids(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.due_draft_tenant_ids(timestamptz) TO caja_app;
