-- 0028 (28/10/2026, decisión de Javier): la prueba gratis pasa a 31 días o 100 mensajes, lo que llegue primero.
-- Solo cambia el default para los negocios nuevos. Los que ya existen los ajusta `pnpm --filter @caja/worker trial:31` (1A y 2A).
ALTER TABLE app.tenant ALTER COLUMN trial_ends_at SET DEFAULT now() + interval '31 days';
