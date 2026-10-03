-- Un ingreso suelto sin método de pago (03/10/2026). La herramienta draft_income_single acepta
-- "unspecified" desde el principio y el borrador se mostraba, pero al Guardar esta restricción lo
-- rechazaba ("no es un gasto, es una venta" sobre un PDF). La venta del día ya lo permitía; los
-- cierres tratan "Sin especificar" igual en ambos casos.
ALTER TABLE app.movement DROP CONSTRAINT IF EXISTS movement_income_needs_method;
