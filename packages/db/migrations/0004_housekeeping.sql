-- S2 día 4: el housekeeping del worker corre sin tenant fijado, y con RLS cada tabla de negocio
-- devuelve cero filas: `expirePendingActions` nunca vencía nada en producción. Una función
-- SECURITY DEFINER devuelve los ids de tenant para recorrerlos uno a uno bajo `withTenant`.
CREATE OR REPLACE FUNCTION app.all_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
AS $$
  SELECT id FROM app.tenant WHERE status <> 'suspended' ORDER BY created_at;
$$;
REVOKE ALL ON FUNCTION app.all_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.all_tenant_ids() TO caja_app;
