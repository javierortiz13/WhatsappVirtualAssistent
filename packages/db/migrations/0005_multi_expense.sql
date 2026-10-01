-- Bug del 01/10 (piloto): "los gastos de hoy fueron 7$ en una arepa y 7.5$ en pádel" solo
-- registraba el primero. Un mensaje con varios gastos crea un único borrador `create_expenses`
-- (lista de gastos) que Guardar escribe de una vez en `movement`, uno por renglón.
ALTER TABLE app.pending_action DROP CONSTRAINT pending_action_kind_check;
ALTER TABLE app.pending_action ADD CONSTRAINT pending_action_kind_check
  CHECK (kind IN ('create_expense', 'create_expenses', 'create_income_day_total', 'create_income_single', 'replace_day_total', 'edit_last', 'delete_last'));
