import { desc, isNotNull, type Queryable, schema } from "@caja/db";
import { Decimal } from "../domain/money";
import type { Plan } from "./plans";

/**
 * Cuánto cobrar según el método (02/10/2026). Zelle y Binance se cobran en dólares o USDT al
 * precio del plan. El pago móvil llega en bolívares: si se convirtiera a la tasa del dólar BCV,
 * al comprar USDT para pagar Anthropic, Meta y Railway se perdería la brecha (~11 % el 01/10).
 * Por eso se cobra a la tasa EURO del BCV, que también es oficial y hoy cubre esa brecha.
 */
export type BillingMethod = "pago_movil" | "zelle" | "binance";
export type BillingRateKind = "bcv_usd" | "bcv_eur";

export type LatestRates = {
  effectiveDate: string;
  usd: Decimal;
  eur: Decimal | null;
};

export type Quote = {
  method: BillingMethod;
  currency: "VES" | "USD" | "USDT";
  amount: Decimal;
  amountUsd: Decimal;
  rateKind: BillingRateKind | null;
  rateValue: Decimal | null;
};

/** Última tasa publicada y el último euro conocido (puede venir de un día anterior). */
export async function latestRates(db: Queryable): Promise<LatestRates | null> {
  const [usd] = await db
    .select()
    .from(schema.bcvRate)
    .orderBy(desc(schema.bcvRate.effectiveDate))
    .limit(1);
  if (!usd) return null;
  const [eur] = usd.rateEur
    ? [usd]
    : await db
        .select()
        .from(schema.bcvRate)
        .where(isNotNull(schema.bcvRate.rateEur))
        .orderBy(desc(schema.bcvRate.effectiveDate))
        .limit(1);
  // Un euro de hace semanas, con el bolívar devaluándose, cobraría de menos: más de 7 días de
  // diferencia con la tasa del dólar y se cobra a la tasa del dólar (el panel lo marca).
  const fresh =
    eur?.rateEur &&
    Date.parse(usd.effectiveDate) - Date.parse(eur.effectiveDate) <= EUR_MAX_AGE_DAYS * 86_400_000;
  return {
    effectiveDate: usd.effectiveDate,
    usd: new Decimal(usd.rate),
    eur: fresh && eur?.rateEur ? new Decimal(eur.rateEur) : null,
  };
}

export const EUR_MAX_AGE_DAYS = 7;

export function quote(
  plan: Plan,
  method: BillingMethod,
  months: number,
  rates: LatestRates | null,
  preferred: BillingRateKind = "bcv_eur",
  /** Precio fundador (0019): porcentaje de descuento sobre el precio del plan. */
  discountPct = 0,
): Quote | null {
  const usd = withDiscount(new Decimal(plan.priceUsd).mul(months), discountPct);
  return quoteUsd(usd, method, rates, preferred);
}

/** Precio con descuento, redondeado al centavo. */
export function withDiscount(usd: Decimal, pct: number): Decimal {
  if (!pct) return usd;
  return usd.mul(new Decimal(100).minus(pct)).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Cuánto pagar un monto en dólares por cada método (plan o recarga). */
export function quoteUsd(
  usd: Decimal,
  method: BillingMethod,
  rates: LatestRates | null,
  preferred: BillingRateKind = "bcv_eur",
): Quote | null {
  if (method === "zelle")
    return {
      method,
      currency: "USD",
      amount: usd,
      amountUsd: usd,
      rateKind: null,
      rateValue: null,
    };
  if (method === "binance")
    return {
      method,
      currency: "USDT",
      amount: usd,
      amountUsd: usd,
      rateKind: null,
      rateValue: null,
    };
  if (!rates) return null;
  // Sin euro conocido se cae a la tasa del dólar, y el panel lo muestra.
  const kind: BillingRateKind = preferred === "bcv_eur" && rates.eur ? "bcv_eur" : "bcv_usd";
  const rate = kind === "bcv_eur" ? (rates.eur as Decimal) : rates.usd;
  return {
    method,
    currency: "VES",
    amount: usd.mul(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    amountUsd: usd,
    rateKind: kind,
    rateValue: rate,
  };
}

/** Brecha de una tasa frente al dólar BCV, en porcentaje (para mostrar en el panel). */
export function premiumOverUsd(rates: LatestRates): Decimal | null {
  if (!rates.eur) return null;
  return rates.eur.div(rates.usd).minus(1).mul(100).toDecimalPlaces(1);
}
