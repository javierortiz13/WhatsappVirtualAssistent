-- 0028: un empleado agregado desde el panel queda pendiente hasta que acepta unirse (revisión de
-- seguridad F1). Los que ya estaban activos sin haber escrito nunca (sin verified_at) pasan a
-- pendientes: su primer mensaje les pregunta si trabajan ahí, igual que a los nuevos.
UPDATE app.phone_number
SET status = 'pending'
WHERE role = 'employee' AND status = 'active' AND verified_at IS NULL;
