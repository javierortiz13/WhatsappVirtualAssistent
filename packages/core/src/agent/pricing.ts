import { Decimal } from "../domain/money";
import type { LlmUsage } from "./llm";

/**
 * Precios por millón de tokens, USD (Fase 6, verificados el 29/09/2026 en la referencia de la
 * API de Claude; escritura de 1 hora agregada el 02/10/2026). Se actualizan a mano; el costo por mensaje se guarda en `message.cost_usd`.
 */
type Price = {
  input: string;
  output: string;
  cacheRead: string;
  /** Escritura con TTL de 5 minutos: 1,25 veces la entrada. */
  cacheWrite: string;
  /** Escritura con TTL de 1 hora: 2 veces la entrada. */
  cacheWrite1h: string;
};

const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": {
    input: "2",
    output: "10",
    cacheRead: "0.20",
    cacheWrite: "2.50",
    cacheWrite1h: "4",
  },
  "claude-opus-5-5": {
    input: "4",
    output: "20",
    cacheRead: "0.20",
    cacheWrite: "5",
    cacheWrite1h: "8",
  },
  "claude-haiku-4-5": {
    input: "1",
    output: "5",
    cacheRead: "0.10",
    cacheWrite: "1.25",
    cacheWrite1h: "2",
  },
};

const MILLION = new Decimal(1_000_000);

export function costFor(model: string, u: LlmUsage): Decimal {
  const p = PRICES[model];
  if (!p) return new Decimal(0);
  const write1h = Math.min(u.cacheWrite1hTokens ?? 0, u.cacheWriteTokens);
  return new Decimal(u.inputTokens)
    .mul(p.input)
    .plus(new Decimal(u.outputTokens).mul(p.output))
    .plus(new Decimal(u.cacheReadTokens).mul(p.cacheRead))
    .plus(new Decimal(u.cacheWriteTokens - write1h).mul(p.cacheWrite))
    .plus(new Decimal(write1h).mul(p.cacheWrite1h))
    .div(MILLION)
    .toDecimalPlaces(6);
}

export function knownModels(): string[] {
  return Object.keys(PRICES);
}
