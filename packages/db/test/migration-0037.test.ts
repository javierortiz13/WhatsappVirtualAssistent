import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/client";
import { pendingMigrations } from "../src/migrate";
import { createTestDb } from "../src/testing/pglite";

/**
 * 0037 (seguridad P4, F1 y F2): el código de invitación que espera la verificación del número y
 * el contador aparte de los +50 de los invitados. Y que el migrador aplica una migración con
 * número menor que llega después (0032–0034 de otra rama).
 */
describe("migración 0037", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  beforeAll(async () => {
    t = await createTestDb();
    const r = await t.pg.query<{ id: string }>(
      `insert into app.tenant (name, business_type) values ('N', 'retail') returning id`,
    );
    tenantId = r.rows[0]?.id as string;
  });
  afterAll(() => t.close());

  const asApp = <T>(
    fn: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<T>,
  ) =>
    t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role caja_app`);
      return fn(tx);
    });

  it("migrador: aplica por nombre lo que falta, aunque tenga un número menor", () => {
    const applied = new Set(["0031_signup_purge.sql", "0035_points.sql", "0036_referrals.sql"]);
    const files = [
      "0037_referrals_verify.sql",
      "0036_referrals.sql",
      "0033_b.sql",
      "0032_a.sql",
      "0035_points.sql",
      "0034_c.sql",
      "README.md",
      "0031_signup_purge.sql",
    ];
    expect(pendingMigrations(files, applied)).toEqual([
      "0032_a.sql",
      "0033_b.sql",
      "0034_c.sql",
      "0037_referrals_verify.sql",
    ]);
    // Con 0037 ya aplicada, las de la otra rama siguen pendientes.
    applied.add("0037_referrals_verify.sql");
    expect(pendingMigrations(files, applied)).toEqual(["0032_a.sql", "0033_b.sql", "0034_c.sql"]);
  });

  it("tenant.pending_ref_code: solo un código con la forma de §P4.7, o nada", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      tx.execute(sql`update app.tenant set pending_ref_code = 'ZZ22ZZ' where id = ${tenantId}`),
    );
    await expect(
      withTenant(t.db, tenantId, (tx) =>
        tx.execute(sql`update app.tenant set pending_ref_code = 'RK4M7O' where id = ${tenantId}`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(t.db, tenantId, (tx) =>
        tx.execute(sql`update app.tenant set pending_ref_code = 'PRUEBA' where id = ${tenantId}`),
      ),
    ).rejects.toThrow();
    await withTenant(t.db, tenantId, (tx) =>
      tx.execute(sql`update app.tenant set pending_ref_code = null where id = ${tenantId}`),
    );
  });

  it("app.book_referral_cost: suma por mes, valida y no toca el tope de los regalos", async () => {
    await asApp((tx) => tx.execute(sql`select app.book_referral_cost('2026-12', 1.05)`));
    await asApp((tx) => tx.execute(sql`select app.book_referral_cost('2026-12', 1.05)`));
    const r = await t.pg.query<{ month: string; booked_usd: string }>(
      `select month, booked_usd::text from app.referral_month`,
    );
    expect(r.rows).toEqual([{ month: "2026-12", booked_usd: "2.10" }]);
    expect((await t.pg.query(`select * from app.reward_month`)).rows).toEqual([]);
    await expect(
      asApp((tx) => tx.execute(sql`select app.book_referral_cost('2026-13', 1)`)),
    ).rejects.toThrow();
    await expect(
      asApp((tx) => tx.execute(sql`select app.book_referral_cost('2026-12', -1)`)),
    ).rejects.toThrow();
  });

  it("caja_app solo lee referral_month; la función no es de PUBLIC", async () => {
    await expect(
      asApp((tx) => tx.execute(sql`select * from app.referral_month`)),
    ).resolves.toBeTruthy();
    await expect(
      asApp((tx) => tx.execute(sql`insert into app.referral_month (month) values ('2027-01')`)),
    ).rejects.toThrow();
    await expect(
      asApp((tx) => tx.execute(sql`update app.referral_month set booked_usd = 0`)),
    ).rejects.toThrow();
    const acl = await t.pg.query<{ public_exec: boolean; app_exec: boolean }>(
      `select has_function_privilege('public', 'app.book_referral_cost(text, numeric)', 'execute')
                as public_exec,
              has_function_privilege('caja_app', 'app.book_referral_cost(text, numeric)', 'execute')
                as app_exec`,
    );
    expect(acl.rows[0]).toEqual({ public_exec: false, app_exec: true });
  });
});
