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
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      log.warn({ source: source.name, err: msg }, "fuente de tasa falló");
    }
  }
  log.error({ errors }, "ninguna fuente de tasa respondió");
  return { source: null, stored: [], errors };
}
