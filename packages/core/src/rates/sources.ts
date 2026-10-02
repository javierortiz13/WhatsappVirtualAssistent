import { addDays, asIsoDate, businessDateOf, type IsoDate, isWeekend } from "../domain/dates";
import { Decimal, parseVenezuelanAmount } from "../domain/money";

/**
 * Fuentes de la tasa oficial USD/VES (Fase 6). El BCV publica en la tarde la tasa que rige el
 * siguiente día hábil, con su "fecha valor". No hay API oficial: se parsea la página. DolarAPI es
 * el respaldo; no publica la fecha valor, así que se infiere por la hora de actualización.
 */
export type FetchedRate = {
  rate: Decimal;
  /** Euro oficial (Bs por euro) con la misma fecha valor; null si la fuente no lo dio. */
  rateEur?: Decimal | null;
  effectiveDate: IsoDate;
  publishedAt: Date | null;
  source: "bcv" | "dolarapi" | "import";
};

export interface RateSource {
  readonly name: FetchedRate["source"];
  fetch(now: Date): Promise<FetchedRate[]>;
}

export class RateSourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
  ) {
    super(`${source}: ${message}`);
    this.name = "RateSourceError";
  }
}

const BCV_URL = "https://www.bcv.org.ve/";

/**
 * Página principal del BCV. Estructura observada: un bloque `id="dolar"` con la tasa dentro de
 * `<strong>` y, en la misma sección, un `<span class="date-display-single" content="YYYY-MM-DD...">`
 * con la fecha valor. Si la página cambia, `parseBcvHtml` lanza y el respaldo entra.
 * Verificar contra la página real al desplegar (y el certificado TLS: NODE_EXTRA_CA_CERTS).
 */
export function parseBcvHtml(html: string): {
  rate: Decimal;
  rateEur: Decimal | null;
  effectiveDate: IsoDate;
} {
  const dolarBlock = html.match(/id="dolar"[\s\S]{0,2000}?<strong>\s*([\d.,]+)\s*<\/strong>/i);
  if (!dolarBlock?.[1]) throw new RateSourceError("bcv", "no se encontró el bloque del dólar");
  const rate = parseVenezuelanAmount(dolarBlock[1]);
  if (!rate || rate.lte(0)) throw new RateSourceError("bcv", `tasa ilegible: ${dolarBlock[1]}`);
  const date = html.match(/date-display-single[^>]*content="(\d{4}-\d{2}-\d{2})/i)?.[1];
  if (!date) throw new RateSourceError("bcv", "no se encontró la fecha valor");
  // El euro va en un bloque hermano `id="euro"`. Es opcional: sin él, la tasa del dólar basta.
  const euroRaw = html.match(/id="euro"[\s\S]{0,2000}?<strong>\s*([\d.,]+)\s*<\/strong>/i)?.[1];
  const euro = euroRaw ? parseVenezuelanAmount(euroRaw) : null;
  return {
    rate: rate.toDecimalPlaces(8),
    rateEur: euro?.gt(0) ? euro.toDecimalPlaces(8) : null,
    effectiveDate: asIsoDate(date),
  };
}

export function bcvSource(fetchImpl: typeof fetch = fetch, url = BCV_URL): RateSource {
  return {
    name: "bcv",
    async fetch(now) {
      const res = await fetchImpl(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; AsistenteDeCaja/0.1)",
          accept: "text/html",
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new RateSourceError("bcv", `HTTP ${res.status}`);
      const { rate, rateEur, effectiveDate } = parseBcvHtml(await res.text());
      return [{ rate, rateEur, effectiveDate, publishedAt: now, source: "bcv" }];
    },
  };
}

const DOLARAPI_URL = "https://ve.dolarapi.com/v1/dolares/oficial";
const DOLARAPI_EURO_URL = "https://ve.dolarapi.com/v1/euros/oficial";

type DolarApiBody = {
  promedio?: number | string;
  venta?: number | string;
  fechaActualizacion?: string;
};

/**
 * DolarAPI devuelve `promedio` y `fechaActualizacion` (hora de actualización, no fecha valor).
 * Regla de inferencia: si se actualizó después de las 15:00 hora Caracas en día hábil, la tasa
 * rige el siguiente día hábil; si no, rige el día de la actualización. Es una aproximación y por
 * eso esta fuente nunca pisa una fila del BCV (ver store).
 */
export function inferEffectiveDateFromUpdate(updatedAt: Date): IsoDate {
  const caracasHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Caracas",
      hour: "2-digit",
      hour12: false,
    }).format(updatedAt),
  );
  const day = businessDateOf(updatedAt);
  if (caracasHour >= 15 && !isWeekend(day)) return nextBusinessDay(day);
  return day;
}

export function nextBusinessDay(d: IsoDate): IsoDate {
  let n = addDays(d, 1);
  while (isWeekend(n)) n = addDays(n, 1);
  return n;
}

export function dolarApiSource(
  fetchImpl: typeof fetch = fetch,
  url = DOLARAPI_URL,
  euroUrl = DOLARAPI_EURO_URL,
): RateSource {
  return {
    name: "dolarapi",
    async fetch() {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new RateSourceError("dolarapi", `HTTP ${res.status}`);
      const j = (await res.json()) as DolarApiBody;
      const raw = j.promedio ?? j.venta;
      if (raw === undefined || raw === null) throw new RateSourceError("dolarapi", "sin promedio");
      const rate = new Decimal(raw);
      if (!rate.isFinite() || rate.lte(0))
        throw new RateSourceError("dolarapi", `tasa ilegible: ${raw}`);
      const updatedAt = j.fechaActualizacion ? new Date(j.fechaActualizacion) : null;
      if (!updatedAt || Number.isNaN(updatedAt.getTime()))
        throw new RateSourceError("dolarapi", "sin fechaActualizacion");
      const effectiveDate = inferEffectiveDateFromUpdate(updatedAt);
      return [
        {
          rate: rate.toDecimalPlaces(8),
          rateEur: await euroFor(fetchImpl, euroUrl, effectiveDate),
          effectiveDate,
          publishedAt: updatedAt,
          source: "dolarapi",
        },
      ];
    },
  };
}

/** Euro oficial de DolarAPI, solo si rige el mismo día que el dólar. Cualquier fallo: null. */
async function euroFor(
  fetchImpl: typeof fetch,
  url: string,
  effectiveDate: IsoDate,
): Promise<Decimal | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as DolarApiBody;
    const raw = j.promedio ?? j.venta;
    const updatedAt = j.fechaActualizacion ? new Date(j.fechaActualizacion) : null;
    if (raw === undefined || raw === null || !updatedAt || Number.isNaN(updatedAt.getTime()))
      return null;
    if (inferEffectiveDateFromUpdate(updatedAt) !== effectiveDate) return null;
    const v = new Decimal(raw);
    return v.isFinite() && v.gt(0) ? v.toDecimalPlaces(8) : null;
  } catch {
    return null;
  }
}
