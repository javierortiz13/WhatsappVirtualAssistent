import { readFileSync } from "node:fs";
import { importRates, parseRatesCsv } from "@caja/core";
import { createDb } from "@caja/db";
import { loadEnv } from "../env";

/**
 * Carga historia de tasas desde un CSV: `pnpm --filter @caja/worker rates:import ../../tasas.csv`.
 * Columnas: fecha valor (DD/MM/YYYY o ISO) y tasa USD. Ver docs/runbooks/semana-1.md.
 */
const file = process.argv[2];
if (!file) {
  console.error("uso: rates:import <archivo.csv>");
  process.exit(2);
}
const env = loadEnv({
  ...process.env,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN ?? "no-usado",
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID ?? "no-usado",
});
const parsed = parseRatesCsv(readFileSync(file, "utf8"));
for (const s of parsed.skipped) console.warn(`línea ${s.line} omitida: ${s.reason}`);
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
importRates(db, parsed.rows)
  .then(async (counts) => {
    console.log(
      `${parsed.rows.length} fechas leídas (${parsed.rows[0]?.effectiveDate ?? "-"} a ${parsed.rows[parsed.rows.length - 1]?.effectiveDate ?? "-"}): ${JSON.stringify(counts)}`,
    );
    await close();
  })
  .catch(async (err) => {
    console.error(err);
    await close();
    process.exit(1);
  });
