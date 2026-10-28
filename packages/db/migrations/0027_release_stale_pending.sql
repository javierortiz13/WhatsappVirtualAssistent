-- 0027: un número registrado desde el panel y nunca verificado deja de estar ocupado a las 48 h
-- (revisión de seguridad F2). Antes, alguien podía registrar un negocio con un número ajeno y el
-- dueño real quedaba bloqueado: `phone_is_taken` lo veía ocupado para siempre.
--
-- Se borra el negocio entero con `erase_tenant`, solo si no tiene nada propio: su único número es
-- el del dueño, pendiente, sin verificar y más viejo que `p_older`, sin movimientos ni pagos.
-- `p_e164` limita la búsqueda a ese número (registro web y mensaje de un número nuevo); sin él,
-- recorre todos (housekeeping). Devuelve lo que vive fuera de la base, como `erase_tenant`.

CREATE OR REPLACE FUNCTION app.release_stale_pending(p_older interval, p_e164 text DEFAULT NULL)
RETURNS TABLE (tenant_id uuid, storage_keys text[], orphan_user_ids uuid[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_prev text := current_setting('app.tenant_id', true);
  v_tenant uuid;
  v_keys text[];
  v_orphans uuid[];
BEGIN
  FOR v_tenant IN
    SELECT p.tenant_id FROM phone_number p
    WHERE p.role = 'owner' AND p.status = 'pending' AND p.verified_at IS NULL
      AND p.created_at < now() - p_older
      AND (p_e164 IS NULL OR p.e164 = p_e164)
      AND NOT EXISTS (SELECT 1 FROM phone_number o WHERE o.tenant_id = p.tenant_id AND o.id <> p.id)
      AND NOT EXISTS (SELECT 1 FROM movement m WHERE m.tenant_id = p.tenant_id)
      AND NOT EXISTS (SELECT 1 FROM payment x WHERE x.tenant_id = p.tenant_id)
  LOOP
    -- `erase_tenant` exige que app.tenant_id sea el negocio que borra.
    PERFORM set_config('app.tenant_id', v_tenant::text, true);
    SELECT e.storage_keys, e.orphan_user_ids INTO v_keys, v_orphans FROM erase_tenant(v_tenant) e;
    tenant_id := v_tenant;
    storage_keys := v_keys;
    orphan_user_ids := v_orphans;
    RETURN NEXT;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(v_prev, ''), true);
END;
$$;
REVOKE ALL ON FUNCTION app.release_stale_pending(interval, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_stale_pending(interval, text) TO caja_app;
