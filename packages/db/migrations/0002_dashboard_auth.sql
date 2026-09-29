-- Día 6: acceso al dashboard. El dashboard entra con Supabase Auth (auth.users.id) y necesita
-- saber a qué negocios pertenece esa persona ANTES de fijar app.tenant_id. Como tenant_member
-- tiene RLS por tenant, dos funciones SECURITY DEFINER hacen lo mínimo, igual que resolve_phone.

-- ---------------------------------------------------------------- claim_account
-- Vincula la identidad de Supabase Auth con user_account:
-- 1. Si ya existe user_account con ese id, no hace nada.
-- 2. Si existe una fila con el mismo correo pero otro id (creada por el seed o por una
--    invitación antes del primer login), la reemplaza por el id real y mueve sus membresías.
-- 3. Si no existe, la crea sin membresías (el onboarding las agrega en S2).
CREATE OR REPLACE FUNCTION app.claim_account(p_id uuid, p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp
AS $$
DECLARE
  v_old uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM app.user_account WHERE id = p_id) THEN
    RETURN;
  END IF;
  SELECT id INTO v_old FROM app.user_account WHERE lower(email) = lower(p_email) LIMIT 1;
  IF v_old IS NOT NULL THEN
    -- El correo es único: se libera antes de insertar el id real.
    UPDATE app.user_account SET email = v_old::text || '@reemplazado.invalid' WHERE id = v_old;
  END IF;
  INSERT INTO app.user_account (id, email) VALUES (p_id, lower(p_email));
  IF v_old IS NOT NULL THEN
    UPDATE app.tenant_member SET user_id = p_id WHERE user_id = v_old;
    UPDATE app.movement SET created_by_user_id = p_id WHERE created_by_user_id = v_old;
    DELETE FROM app.user_account WHERE id = v_old;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.claim_account(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_account(uuid, text) TO caja_app;

-- ---------------------------------------------------------------- memberships_for_user
CREATE OR REPLACE FUNCTION app.memberships_for_user(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, role text, tenant_name text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT m.tenant_id, m.role, t.name, t.status
  FROM app.tenant_member m
  JOIN app.tenant t ON t.id = m.tenant_id
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at;
$$;
REVOKE ALL ON FUNCTION app.memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.memberships_for_user(uuid) TO caja_app;
