-- Eliminar un negocio (06/10/2026). Lo pide el dueño (por WhatsApp o en Ajustes) o el
-- administrador, y lo promete /eliminar-datos. Decisiones de Javier:
-- - Papelera de 15 días: pedir la eliminación solo marca el negocio (`deleted_at`, `purge_after`);
--   el bot y el panel dejan de usarlo y el dueño puede recuperarlo. Al vencer, el housekeeping lo
--   borra de verdad con `erase_tenant`. El administrador puede borrar ya (cuentas de prueba).
-- - Impagos: un negocio suspendido guarda sus datos 90 días (`suspended_at`); avisos a los 60 y 83
--   días (`retention_notices`) y después pasa a la papelera con motivo `unpaid`.

ALTER TABLE app.tenant
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS purge_after timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_reason text,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_notices integer NOT NULL DEFAULT 0;
ALTER TABLE app.tenant DROP CONSTRAINT IF EXISTS tenant_deletion_reason_check;
ALTER TABLE app.tenant ADD CONSTRAINT tenant_deletion_reason_check
  CHECK (deletion_reason IS NULL OR deletion_reason IN ('owner', 'admin', 'unpaid'));
-- Los suspendidos de antes cuentan sus 90 días desde la última vez que cambió el negocio.
UPDATE app.tenant SET suspended_at = updated_at WHERE status = 'suspended' AND suspended_at IS NULL;

-- El bot y el panel ven un negocio en la papelera como estado `deleted` (la columna `status` no
-- cambia, así recuperar lo deja como estaba).
CREATE OR REPLACE FUNCTION app.resolve_phone(p_e164 text, p_wa_user_id text)
RETURNS TABLE (phone_id uuid, tenant_id uuid, role text, status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT p.id, p.tenant_id, p.role, p.status,
         CASE WHEN t.deleted_at IS NOT NULL THEN 'deleted' ELSE t.status END
  FROM app.phone_number p
  JOIN app.tenant t ON t.id = p.tenant_id
  WHERE (p_e164 IS NOT NULL AND p.e164 = p_e164)
     OR (p_wa_user_id IS NOT NULL AND p.wa_user_id = p_wa_user_id)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.memberships_for_user(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, role text, tenant_name text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT m.tenant_id, m.role, t.name,
         CASE WHEN t.deleted_at IS NOT NULL THEN 'deleted' ELSE t.status END
  FROM app.tenant_member m
  JOIN app.tenant t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
  ORDER BY t.deleted_at NULLS FIRST, m.created_at;
$$;

-- Borrado definitivo. El rol de la app no tiene DELETE (todo es borrado lógico), así que esta
-- función SECURITY DEFINER lo hace en una sola transacción. Solo borra el tenant fijado con
-- `withTenant` (app.tenant_id); quién y cuándo lo decide la app. Devuelve las claves de las fotos
-- (la app las borra del bucket) y los usuarios del panel que quedaron sin negocio (la app los borra
-- de Supabase Auth).
CREATE OR REPLACE FUNCTION app.erase_tenant(p_tenant uuid)
RETURNS TABLE (storage_keys text[], orphan_user_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_keys text[];
  v_users uuid[];
  v_orphans uuid[];
  v_phones text[];
  v_events uuid[];
BEGIN
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant::text THEN
    RAISE EXCEPTION 'erase_tenant: el tenant no coincide con app.tenant_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant WHERE id = p_tenant) THEN
    RAISE EXCEPTION 'erase_tenant: negocio no encontrado';
  END IF;

  SELECT coalesce(array_agg(storage_key), '{}') INTO v_keys FROM attachment WHERE tenant_id = p_tenant;
  SELECT coalesce(array_agg(user_id), '{}') INTO v_users FROM tenant_member WHERE tenant_id = p_tenant;
  SELECT coalesce(array_agg(e164), '{}') INTO v_phones FROM phone_number WHERE tenant_id = p_tenant;
  SELECT coalesce(array_agg(DISTINCT webhook_event_id), '{}') INTO v_events
    FROM message WHERE tenant_id = p_tenant AND webhook_event_id IS NOT NULL;

  -- En orden de dependencias (todas las llaves son NO ACTION).
  DELETE FROM exchange_allocation WHERE tenant_id = p_tenant;
  DELETE FROM exchange_lot WHERE tenant_id = p_tenant;
  DELETE FROM account_transfer WHERE tenant_id = p_tenant;
  DELETE FROM budget WHERE tenant_id = p_tenant;
  DELETE FROM movement WHERE tenant_id = p_tenant;
  DELETE FROM pending_action WHERE tenant_id = p_tenant;
  DELETE FROM message WHERE tenant_id = p_tenant;
  DELETE FROM attachment WHERE tenant_id = p_tenant;
  DELETE FROM phone_verification WHERE tenant_id = p_tenant;
  DELETE FROM account WHERE tenant_id = p_tenant;
  DELETE FROM category WHERE tenant_id = p_tenant;
  DELETE FROM phone_number WHERE tenant_id = p_tenant;
  DELETE FROM tenant_member WHERE tenant_id = p_tenant;
  DELETE FROM payment WHERE tenant_id = p_tenant;
  DELETE FROM integration WHERE tenant_id = p_tenant;
  DELETE FROM audit_log WHERE tenant_id = p_tenant;
  DELETE FROM tenant WHERE id = p_tenant;

  -- Los eventos del webhook guardan el mensaje tal como llegó: los de sus mensajes y los de sus
  -- números que no llegaron a mensaje (código de vinculación, número pendiente).
  DELETE FROM webhook_event WHERE id = ANY (v_events);
  IF array_length(v_phones, 1) > 0 THEN
    DELETE FROM webhook_event w
      WHERE EXISTS (SELECT 1 FROM unnest(v_phones) p WHERE w.payload::text LIKE '%' || p || '%');
    DELETE FROM unknown_sender_hit WHERE e164 = ANY (v_phones);
  END IF;

  -- Usuarios del panel que no son miembros de otro negocio ni figuran en sus registros.
  SELECT coalesce(array_agg(u), '{}') INTO v_orphans FROM unnest(v_users) u
    WHERE NOT EXISTS (SELECT 1 FROM tenant_member m WHERE m.user_id = u)
      AND NOT EXISTS (SELECT 1 FROM movement x WHERE x.created_by_user_id = u)
      AND NOT EXISTS (SELECT 1 FROM exchange_lot x WHERE x.created_by_user_id = u)
      AND NOT EXISTS (SELECT 1 FROM account x WHERE x.created_by_user_id = u)
      AND NOT EXISTS (SELECT 1 FROM account_transfer x WHERE x.created_by_user_id = u);
  DELETE FROM user_account WHERE id = ANY (v_orphans);

  RETURN QUERY SELECT v_keys, v_orphans;
END;
$$;
REVOKE ALL ON FUNCTION app.erase_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.erase_tenant(uuid) TO caja_app;
