-- 0031: borrado a 90 días de los registros sin terminar (US-AD-05, decisión 3A del 29/10/2026).
-- Fila sin terminar y sin marca: se borra. Con «no me escribas» o con el único mensaje de Rocco:
-- queda solo el número y la marca (purged_at dice cuándo se vació). erase_tenant no cambia (0024:50).
ALTER TABLE app.signup ADD COLUMN IF NOT EXISTS purged_at timestamptz;
GRANT DELETE ON app.signup TO caja_app;
