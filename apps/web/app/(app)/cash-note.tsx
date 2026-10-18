import { es } from "@caja/core";

/**
 * Ventas y gastos del día sin cuenta, bajo "Debería haber en caja" (PRD cash-in-drawer, C15):
 * cada monto con su tipo, nunca sumados, y el enlace a Movimientos del mes para ponerles la cuenta.
 */
export function CashNote({
  unassigned,
  day,
}: {
  unassigned: es.UnassignedView | null;
  day: string;
}) {
  const missing = es.unassignedParts(unassigned);
  if (!missing) return null;
  return (
    <p className="kpi-sub">
      {missing.text} sin cuenta {missing.one ? "no entra" : "no entran"} aquí.{" "}
      <a href={`/movimientos?mes=${day.slice(0, 7)}`}>
        {missing.one ? "Ponle la cuenta ›" : "Ponles la cuenta ›"}
      </a>
    </p>
  );
}
