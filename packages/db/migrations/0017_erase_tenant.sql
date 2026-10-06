-- Eliminar un negocio por completo (06/10/2026): lo pide el dueño (por WhatsApp o en Ajustes) o el
-- administrador. Lo promete /eliminar-datos. El rol de la app no tiene DELETE en casi ninguna tabla
-- (todo es borrado lógico), así que esta función SECURITY DEFINER lo hace en una sola transacción.
-- Guarda: solo borra el tenant fijado con `withTenant` (app.tenant_id); quién puede pedirlo lo
-- decide la app (dueño o administrador).
-- Devuelve las claves de las fotos (la app las borra del bucket) y los usuarios del panel que se
-- quedaron sin negocio (la app los borra de Supabase Auth).
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
