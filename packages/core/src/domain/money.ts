import { Decimal } from "decimal.js";

/**
 * Dinero. Reglas de la Fase 2:
 * - Nunca `number`. `Decimal` en dominio, `string` hacia la base.
 * - Redondeo comercial half-up (ROUND_HALF_UP), nunca el bancario.
 * - Montos con 2 decimales; tasa con hasta 8.
 * - `convert` es la única función que multiplica o divide dinero.
 */
export type Currency = "USD" | "VES";

const MoneyDecimal = Decimal.clone({ rounding: Decimal.ROUND_HALF_UP, precision: 40 });

export type Money = { amount: Decimal; currency: Currency };

export function money(amount: Decimal.Value, currency: Currency): Money {
  const d = new MoneyDecimal(amount);
  if (!d.isFinite()) throw new Error("monto no finito");
  return { amount: d.toDecimalPlaces(2), currency };
}

export function isPositiveAmount(amount: Decimal.Value): boolean {
  const d = new MoneyDecimal(amount);
  return d.isFinite() && d.gt(0);
}

/** Tasa: bolívares por 1 USD. `id` apunta a `bcv_rate`; una tasa manual (ADR-013) no tiene fila. */
export type RateOrigin = "bcv" | "manual";
export type Rate = { value: Decimal; effectiveDate: string; id: string | null; source: RateOrigin };

export function rate(
  value: Decimal.Value,
  effectiveDate: string,
  id: string | null,
  source: RateOrigin = "bcv",
): Rate {
  const v = new MoneyDecimal(value);
  if (!v.isFinite() || v.lte(0)) throw new Error("tasa inválida");
  return { value: v.toDecimalPlaces(8), effectiveDate, id, source };
}

/** Tasa dicha por el dueño ("a tasa 850"): válida entre 1 y 1.000.000 Bs por dólar. */
export function manualRate(value: Decimal.Value, businessDate: string): Rate | null {
  const v = new MoneyDecimal(value);
  if (!v.isFinite() || v.lt(1) || v.gt(1_000_000)) return null;
  return rate(v, businessDate, null, "manual");
}

export type Converted = {
  amount: Decimal;
  currency: Currency;
  amountUsd: Decimal;
  amountVes: Decimal;
  rateValue: Decimal;
};

/** Devuelve ambos equivalentes ya redondeados a 2 decimales. */
export function convert(m: Money, r: Rate): Converted {
  if (m.currency === "USD") {
    return {
      amount: m.amount,
      currency: "USD",
      amountUsd: m.amount,
      amountVes: m.amount.mul(r.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      rateValue: r.value,
    };
  }
  return {
    amount: m.amount,
    currency: "VES",
    amountUsd: m.amount.div(r.value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    amountVes: m.amount,
    rateValue: r.value,
  };
}

/** Serialización hacia la base: string con 2 decimales, sin notación científica. */
export function toDbAmount(d: Decimal): string {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function toDbRate(d: Decimal): string {
  return d.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8);
}

export function sum(values: Decimal.Value[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(new MoneyDecimal(v)), new MoneyDecimal(0));
}

/**
 * Parsea un monto escrito a la venezolana: "15,50", "1.200", "450.000,75", "1200.50".
 * Regla: si hay coma, la coma es el decimal y los puntos son miles. Si solo hay puntos y el
 * último grupo tiene 3 dígitos, son miles; si tiene 1 o 2, es decimal.
 */
export function parseVenezuelanAmount(input: string): Decimal | null {
  const s = input.trim().replace(/\s+/g, "");
  if (!/^[\d.,]+$/.test(s)) return null;
  let normalized: string;
  if (s.includes(",")) {
    const parts = s.split(",");
    if (parts.length !== 2) return null;
    normalized = `${parts[0]?.replace(/\./g, "")}.${parts[1]}`;
  } else if (s.includes(".")) {
    const groups = s.split(".");
    const last = groups[groups.length - 1] ?? "";
    if (groups.length > 1 && last.length === 3 && groups.slice(1).every((g) => g.length === 3)) {
      normalized = groups.join("");
    } else if (groups.length === 2) {
      normalized = s;
    } else {
      return null;
    }
  } else {
    normalized = s;
  }
  const d = new MoneyDecimal(normalized);
  return d.isFinite() ? d : null;
}

/** Formato para WhatsApp y dashboard: $15,00 · Bs 12.870,00 · Bs 1,85 MM sobre 999.999.999. */
export function formatMoney(amount: Decimal.Value, currency: Currency): string {
  const d = new MoneyDecimal(amount);
  if (currency === "VES" && d.abs().gte(1_000_000_000)) {
    const mm = d.div(1_000_000).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return `Bs ${formatNumber(mm)} MM`;
  }
  const body = formatNumber(d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP));
  return currency === "USD" ? `$${body}` : `Bs ${body}`;
}

function formatNumber(d: Decimal): string {
  const negative = d.isNegative();
  const [int = "0", frac = "00"] = d.abs().toFixed(2).split(".");
  const withThousands = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "−" : ""}${withThousands},${frac}`;
}

export { Decimal };
