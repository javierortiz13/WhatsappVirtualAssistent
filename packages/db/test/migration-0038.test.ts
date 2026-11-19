import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../src/testing/pglite";

/**
 * 0038 (re-revisión de fdae0ce, V-1): app.attach_referral solo mira los números verificados para
 * decidir si el invitado «ya usó Rocco», y conserva sus permisos (sin PUBLIC, EXECUTE a caja_app).
 */
describe("migración 0038", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("el «ya usó Rocco» filtra por verified_at", async () => {
    const r = await t.pg.query<{ src: string }>(
      `select prosrc as src from pg_proc where proname = 'attach_referral'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.src).toContain("mine.verified_at IS NOT NULL");
  });

  it("sigue SECURITY DEFINER, sin PUBLIC y con EXECUTE para caja_app", async () => {
    const r = await t.pg.query<{ definer: boolean; acl: string; app: boolean }>(
      `select prosecdef as definer, proacl::text as acl,
              has_function_privilege('caja_app', oid, 'EXECUTE') as app
         from pg_proc where proname = 'attach_referral'`,
    );
    const row = r.rows[0];
    expect(row?.definer).toBe(true);
    expect(row?.app).toBe(true);
    // Una entrada de PUBLIC en el ACL empieza con «=» (sin rol).
    expect(row?.acl).not.toMatch(/[{,]=X/);
  });
});
