import { schema } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRates, parseRatesCsv } from "../src/rates/import";

describe("importación de historia de tasas", () => {
  it("parsea encabezado, separadores, fechas DD/MM/YYYY y decimales con coma; la última fecha repetida gana", () => {
    const csv = [
      "Fecha;USD",
      "25/09/2026;850,12345678",
      '"26/09/2026";"851,50"',
      "2026-09-29,858.00",
      "29/09/2026;857,89",
      "",
      "# comentario",
      "basura;x",
      "30/09/2026;0",
    ].join("\n");
    const r = parseRatesCsv(csv);
    expect(r.rows.map((x) => [x.effectiveDate, x.rate])).toEqual([
      ["2026-09-25", "850.12345678"],
      ["2026-09-26", "851.50000000"],
      ["2026-09-29", "857.89000000"],
    ]);
    expect(r.skipped.map((s) => s.line)).toEqual([8, 9]);
  });

  describe("en base", () => {
    let t: Awaited<ReturnType<typeof createTestDb>>;
    beforeAll(async () => {
      t = await createTestDb();
      await t.db
        .insert(schema.bcvRate)
        .values({ effectiveDate: "2026-09-29", rate: "857.89000000", source: "bcv" });
    });
    afterAll(() => t.close());

    it("inserta huecos y nunca pisa una fila del BCV en vivo", async () => {
      const { rows } = parseRatesCsv("25/09/2026;850\n29/09/2026;999\n");
      const counts = await importRates(t.db, rows);
      expect(counts).toEqual({ inserted: 1, updated: 0, unchanged: 0, kept_bcv: 1 });
      const all = await t.db.select().from(schema.bcvRate).orderBy(schema.bcvRate.effectiveDate);
      expect(all.map((r) => [r.effectiveDate, r.rate, r.source])).toEqual([
        ["2026-09-25", "850.00000000", "import"],
        ["2026-09-29", "857.89000000", "bcv"],
      ]);
      expect(await importRates(t.db, rows)).toEqual({
        inserted: 0,
        updated: 0,
        unchanged: 1,
        kept_bcv: 1,
      });
    });
  });
});
