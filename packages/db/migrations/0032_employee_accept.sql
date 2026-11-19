-- 0032 (era 0028 en la rama de seguridad; renumerada para correr después de 0031): un empleado
-- agregado desde el panel queda pendiente hasta que acepta unirse (revisión de seguridad F1). Los
-- que ya estaban activos sin haber escrito nunca (sin verified_at) pasan a pendientes: su primer
-- mensaje les pregunta si trabajan ahí, igual que a los nuevos.
--
-- N7: cada fila que cambia queda en audit_log (`employee_pending_0032`), para poder deshacerlo
-- exacto:
--   UPDATE app.phone_number p SET status = 'active' FROM app.audit_log a
--   WHERE a.action = 'employee_pending_0032' AND a.entity_id = p.id
--     AND p.status = 'pending' AND p.verified_at IS NULL;
WITH changed AS (
  UPDATE app.phone_number SET status = 'pending'
  WHERE role = 'employee' AND status = 'active' AND verified_at IS NULL
  RETURNING id, tenant_id
)
INSERT INTO app.audit_log (tenant_id, actor_type, actor_id, action, entity, entity_id, before, after, channel)
SELECT tenant_id, 'system', NULL, 'employee_pending_0032', 'phone_number', id,
       '{"status":"active"}', '{"status":"pending"}', 'system'
FROM changed;
