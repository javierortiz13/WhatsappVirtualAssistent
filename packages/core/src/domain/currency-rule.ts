import type { Decimal } from "decimal.js";
import type { Currency } from "./money.js";

/**
 * Regla determinista de moneda cuando el usuario no la indica (US-B2, aprobada en Fase 4):
 * - Monto >= umbral del tenant (1.000 por defecto) → VES.
 * - Monto < umbral → moneda por defecto del tenant.
 * - Sin moneda por defecto y bajo el umbral → preguntar.
 * Nunca la decide el LLM. El umbral vive en configuración porque una reconversión lo invalida.
 */
export type CurrencyInference =
  | { kind: "explicit"; currency: Currency }
  | { kind: "inferred"; currency: Currency; reason: "threshold" | "tenant_default" }
  | { kind: "ask" };

export function inferCurrency(input: {
  explicit: Currency | null;
  amount: Decimal;
  threshold: Decimal;
  tenantDefault: Currency | null;
}): CurrencyInference {
  if (input.explicit) return { kind: "explicit", currency: input.explicit };
  if (input.amount.gte(input.threshold))
    return { kind: "inferred", currency: "VES", reason: "threshold" };
  if (input.tenantDefault)
    return { kind: "inferred", currency: input.tenantDefault, reason: "tenant_default" };
  return { kind: "ask" };
}
