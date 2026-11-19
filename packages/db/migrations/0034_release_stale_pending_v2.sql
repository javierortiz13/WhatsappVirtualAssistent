-- 0034 (revisión de seguridad N3): `release_stale_pending` (0027, ya aplicada: no se edita)
-- solo liberaba un negocio cuyo único número era el del dueño. Quien registraba un número ajeno
-- podía agregar un empleado desde su panel y el número del dueño real no se liberaba nunca.
-- Ahora cuenta solo los otros números verificados: los que nunca escribieron se borran con el
-- negocio en `erase_tenant`. Y rechaza un `p_older` de menos de 24 h.
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
  IF p_older < interval '24 hours' THEN
    RAISE EXCEPTION 'p_older too short';
  END IF;
  FOR v_tenant IN
    SELECT p.tenant_id FROM phone_number p
    WHERE p.role = 'owner' AND p.status = 'pending' AND p.verified_at IS NULL
      AND p.created_at < now() - p_older
      AND (p_e164 IS NULL OR p.e164 = p_e164)
      AND NOT EXISTS (
        SELECT 1 FROM phone_number o
        WHERE o.tenant_id = p.tenant_id AND o.id <> p.id AND o.verified_at IS NOT NULL
      )
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
