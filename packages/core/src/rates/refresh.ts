import type { Queryable } from "@caja/db";
import { type Logger, silentLogger } from "../log";
import type { FetchedRate, RateSource } from "./sources";
import { type StoreOutcome, storeRate } from "./store";

export type RefreshResult = {
  source: FetchedRate["source"] | null;
  stored: { effectiveDate: string; rate: string; outcome: StoreOutcome }[];
  errors: string[];
};

/**
 * Consulta las fuentes en orden y guarda la primera que responda. Si todas fallan, devuelve los
 * errores para que el cron los registre; las conversiones siguen usando la última tasa conocida.
 */
export async function refreshRates(deps: {
  db: Queryable;
  sources: RateSource[];
  log?: Logger;
  now?: () => Date;
}): Promise<RefreshResult> {
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const errors: string[] = [];
  for (const source of deps.sources) {
    try {
      const fetched = await source.fetch(now());
      const stored: RefreshResult["stored"] = [];
      for (const r of fetched) {
        const outcome = await storeRate(deps.db, r);
        stored.push({ effectiveDate: r.effectiveDate, rate: r.rate.toFixed(8), outcome });
      }
      log.info({ source: source.name, stored }, "tasa actualizada");
      return { source: source.name, stored, errors };
    } catch (err) {
      const msg = errorWithCause(err);
      errors.push(msg);
      log.warn({ source: source.name, err: msg }, "fuente de tasa falló");
    }
  }
  log.error({ errors }, "ninguna fuente de tasa respondió");
  return { source: null, stored: [], errors };
}

/**
 * "fetch failed" de undici no dice por qué: la causa real (certificado, DNS, tiempo agotado) va en
 * `err.cause`. Sin ella no se sabía por qué el BCV falla siempre en producción (04/10).
 */
export function errorWithCause(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const detail = cause ? String(cause.code ?? cause.message ?? "") : "";
  return detail ? `${msg} (${detail})` : msg;
}
