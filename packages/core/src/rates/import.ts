import type { Queryable } from "@caja/db";
import { asIsoDate, type IsoDate, isIsoDate } from "../domain/dates";
import { parseVenezuelanAmount } from "../domain/money";
import type { FetchedRate } from "./sources";
import { type StoreOutcome, storeRate } from "./store";

/**
 * Carga de historia de tasas desde un CSV (ADR-013). El BCV publica su histórico como Excel en
 * "Estadísticas → Tipo de cambio de referencia (SMC)"; se exporta a CSV con dos columnas,
 * fecha valor y tasa USD, y se importa con `rates:import`. Acepta `;` o `,` como separador,
 * fechas `DD/MM/YYYY` o ISO, y decimales con coma. Nunca pisa una fila tomada del BCV en vivo.
 */
export type ParsedRow = { line: number; effectiveDate: IsoDate; rate: string };
export type ParseResult = { rows: ParsedRow[]; skipped: { line: number; reason: string }[] };

export function parseRatesCsv(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const skipped: ParseResult["skipped"] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    // `;` o tabulador separan columnas; si no hay, la primera coma separa (la segunda puede
    // ser decimal: "25/09/2026,850,12").
    const sep = trimmed.includes(";") ? ";" : trimmed.includes("\t") ? "\t" : ",";
    const cut = trimmed.indexOf(sep);
    const parts =
      cut < 0
        ? [trimmed]
        : [
            trimmed.slice(0, cut),
            trimmed.slice(cut + 1).split(sep === "," ? /\t|;/ : sep)[0] ?? "",
          ];
    const clean = parts.map((p) => p.replace(/^"|"$/g, "").trim());
    const [dateRaw, rateRaw] = clean;
    if (!dateRaw || !rateRaw) {
      skipped.push({ line, reason: "faltan columnas" });
      return;
    }
    const date = parseDate(dateRaw);
    if (!date) {
      if (i === 0) return; // encabezado
      skipped.push({ line, reason: `fecha inválida: ${dateRaw}` });
      return;
    }
    const rate = parseVenezuelanAmount(rateRaw);
    if (!rate || rate.lte(0)) {
      skipped.push({ line, reason: `tasa inválida: ${rateRaw}` });
      return;
    }
    rows.push({ line, effectiveDate: date, rate: rate.toFixed(8) });
  });
  // Última aparición gana si una fecha se repite (el histórico del BCV trae correcciones al final).
  const byDate = new Map<string, ParsedRow>();
  for (const r of rows) byDate.set(r.effectiveDate, r);
  return {
    rows: [...byDate.values()].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    skipped,
  };
}

function parseDate(s: string): IsoDate | null {
  if (isIsoDate(s)) return asIsoDate(s);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(iso) ? asIsoDate(iso) : null;
}

export async function importRates(
  db: Queryable,
  rows: ParsedRow[],
): Promise<Record<StoreOutcome, number>> {
  const counts: Record<StoreOutcome, number> = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    kept_bcv: 0,
  };
  for (const r of rows) {
    const fetched: FetchedRate = {
      rate:
        parseVenezuelanAmount(r.rate) ??
        (() => {
          throw new Error(`tasa inválida ${r.rate}`);
        })(),
      effectiveDate: r.effectiveDate,
      publishedAt: null,
      source: "import",
    };
    counts[await storeRate(db, fetched)] += 1;
  }
  return counts;
}
