import { createDb, dueDraftTenantIds } from "@caja/db";
import { afterAll, describe, expect, it } from "vitest";

/**
 * El barrido del autoguardado (0022) contra Postgres real con postgres-js, que no serializa un
 * `Date` en SQL crudo (ver identity-pg). Se salta si no hay TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("autoguardado en Postgres real", () => {
  const conn = url ? createDb(url, { max: 1 }) : null;
  afterAll(async () => conn?.close());

  it("lista los negocios con borradores vencidos pasándole una fecha de JavaScript", async () => {
    if (!conn) return;
    const ids = await dueDraftTenantIds(conn.db, new Date());
    expect(Array.isArray(ids)).toBe(true);
  });
});
