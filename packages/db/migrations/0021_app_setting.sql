-- Ajustes globales de Rocco (07/10/2026). El primero es el modo de lanzamiento: en "beta" Rocco no
-- da precios durante la prueba gratis (solo días y mensajes que quedan); al terminar la prueba sí.
-- En "live" los da siempre. Se cambia en /admin sin redesplegar. También los días de la encuesta
-- y del resumen de la prueba. Tabla global como bcv_rate: sin tenant_id ni RLS.
CREATE TABLE IF NOT EXISTS app.app_setting (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
GRANT SELECT, INSERT, UPDATE ON app.app_setting TO caja_app;
INSERT INTO app.app_setting (key, value) VALUES ('launch', '{"beta": true, "surveyDay": 10, "valueDay": 12}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
