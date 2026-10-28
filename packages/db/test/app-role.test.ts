import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRole, isAppRoleName } from "../src/health";
import { createTestDb } from "../src/testing/pglite";

/** Seguridad F6: el chequeo del rol al arrancar. */
describe("appRole", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("conectado como superusuario: falla", async () => {
    const r = await appRole(t.db);
    expect(r.ok).toBe(false);
    expect(r.superuser).toBe(true);
  });

  it("como caja_app: pasa (sin superusuario ni bypass de RLS)", async () => {
    const r = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role caja_app`);
      return appRole(tx);
    });
    expect(r).toEqual({ user: "caja_app", superuser: false, bypassRls: false, ok: true });
  });

  it("acepta el nombre del pooler", () => {
    expect(isAppRoleName("caja_app.abcd")).toBe(true);
    expect(isAppRoleName("postgres")).toBe(false);
    expect(isAppRoleName("caja_appx")).toBe(false);
  });
});
