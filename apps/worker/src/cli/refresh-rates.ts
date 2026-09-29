import { bcvSource, dolarApiSource, refreshRates } from "@caja/core";
import { createDb } from "@caja/db";
import { loadEnv } from "../env.js";
import { createLogger } from "../logger.js";

/** Corre una actualización de tasa a mano: `pnpm --filter @caja/worker rates:refresh`. */
const env = loadEnv({
  ...process.env,
  META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN ?? "no-usado",
  META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID ?? "no-usado",
});
const log = createLogger(env.LOG_LEVEL, true);
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
refreshRates({ db, sources: [bcvSource(), dolarApiSource()], log })
  .then(async (r) => {
    console.log(JSON.stringify(r, null, 2));
    await close();
    process.exit(r.source ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await close();
    process.exit(1);
  });
