import { createDb } from "@caja/db";
import { afterAll, describe, expect, it } from "vitest";
import { allowUnknownReply } from "../src/identity/resolve";

/**
 * Contra Postgres real con el driver de producción (postgres-js). PGlite acepta un `Date` como
 * parámetro de SQL crudo y postgres-js no: el 30/09/2026 el rate limit de desconocidos falló en
 * producción sin que ningún test lo viera. Se salta si no hay TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rate limit de desconocidos en Postgres real", () => {
  const conn = url ? createDb(url, { max: 1 }) : null;
  afterAll(async () => conn?.close());

  it("inserta y actualiza el contador con fechas de JavaScript", async () => {
    if (!conn) return;
    const key = `test-${Date.now()}`;
    const opts = { max: 2, windowMs: 3_600_000, now: new Date() };
    expect(await allowUnknownReply(conn.db, key, opts)).toBe(true);
    expect(await allowUnknownReply(conn.db, key, opts)).toBe(true);
    expect(await allowUnknownReply(conn.db, key, opts)).toBe(false);
    const later = { ...opts, now: new Date(opts.now.getTime() + 2 * 3_600_000) };
    expect(await allowUnknownReply(conn.db, key, later)).toBe(true);
  });
});
