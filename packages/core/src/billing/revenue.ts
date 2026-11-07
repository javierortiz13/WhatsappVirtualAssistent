import { Decimal } from "../domain/money";
import { planById } from "./plans";
import { withDiscount } from "./pricing";
import { founderDiscount } from "./renew";

/**
 * Lo que un negocio que paga aporta por mes, para «Ingreso mensual recurrente» en /admin
 * (07/11: contaba el precio de lista aunque el negocio pagara con el 40 % de fundador).
 *
 * - Con un pago de plan aprobado del mismo plan: lo que pagó entre los meses que cubre (trae el
 *   descuento de fundador, el de Leyenda o un monto manual tal cual se cobró).
 * - Sin ese pago (activado a mano, o cambió de plan): el precio del plan con el descuento de
 *   fundador vigente hoy.
 */
export function monthlyRevenueUsd(
  t: { plan: string; founderUntil: string | null },
  lastPlanPayment: { plan: string; months: number; amountUsd: string } | null,
  now: Date,
): Decimal {
  if (lastPlanPayment && lastPlanPayment.plan === t.plan && lastPlanPayment.months > 0)
    return new Decimal(lastPlanPayment.amountUsd)
      .div(lastPlanPayment.months)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return withDiscount(new Decimal(planById(t.plan).priceUsd), founderDiscount(t, now));
}

/**
 * El valor en dólares de un pago que el administrador registra a mano: lo que de verdad se cobró
 * (07/11: se guardaba el precio de lista aunque se cobrara el de fundador). En dólares o USDT, el
 * monto; en bolívares, el monto entre la tasa con que se cotizó. Sin tasa, `fallback`.
 */
export function paidAmountUsd(
  amount: Decimal,
  currency: string,
  rateValue: Decimal | null,
  fallback: Decimal,
): Decimal {
  if (currency !== "VES") return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!rateValue || rateValue.lte(0)) return fallback;
  return amount.div(rateValue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
