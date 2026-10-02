import { eq, type Queryable, schema } from "@caja/db";
import { toDbRate } from "../domain/money";
import type { FetchedRate } from "./sources";

export type StoreOutcome = "inserted" | "updated" | "unchanged" | "kept_bcv";

/**
 * Guarda una tasa por fecha valor. Reglas: el BCV siempre manda; DolarAPI solo llena huecos y
 * nunca pisa una fila del BCV. Una fila del BCV con distinto valor se actualiza (corrección).
 * Lo llama un cron de baja frecuencia; no necesita ser atómico frente a sí mismo.
 */
export async function storeRate(db: Queryable, r: FetchedRate): Promise<StoreOutcome> {
  const value = toDbRate(r.rate);
  const eur = r.rateEur ? toDbRate(r.rateEur) : null;
  const [existing] = await db
    .select()
    .from(schema.bcvRate)
    .where(eq(schema.bcvRate.effectiveDate, r.effectiveDate));
  if (!existing) {
    await db
      .insert(schema.bcvRate)
      .values({
        effectiveDate: r.effectiveDate,
        rate: value,
        rateEur: eur,
        publishedAt: r.publishedAt,
        source: r.source,
      })
      .onConflictDoNothing({ target: schema.bcvRate.effectiveDate });
    return "inserted";
  }
  if (r.source !== "bcv" && existing.source === "bcv") {
    // El respaldo nunca pisa el dólar del BCV, pero sí completa un euro que falte.
    if (eur && !existing.rateEur)
      await db
        .update(schema.bcvRate)
        .set({ rateEur: eur })
        .where(eq(schema.bcvRate.id, existing.id));
    return "kept_bcv";
  }
  const sameEur = !eur || existing.rateEur === eur;
  if (existing.rate === value && existing.source === r.source && sameEur) return "unchanged";
  await db
    .update(schema.bcvRate)
    .set({
      rate: value,
      ...(eur ? { rateEur: eur } : {}),
      source: r.source,
      publishedAt: r.publishedAt,
      fetchedAt: new Date(),
    })
    .where(eq(schema.bcvRate.id, existing.id));
  return "updated";
}
