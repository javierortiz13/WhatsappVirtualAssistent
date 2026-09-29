import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows, schema, sql, withTenant } from "../src/index";
import { ensureOwnerAccount, seedTenant } from "../src/seed/index";
import { createTestDb } from "../src/testing/pglite";

/** Migración 0002: vincular Supabase Auth con user_account y listar membresías sin tenant fijado. */
describe("acceso al dashboard", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
  });
  afterAll(() => t.close());

  const memberships = async (userId: string) =>
    rows<{ tenant_id: string; role: string; tenant_name: string }>(
      await t.db.execute(sql`select * from app.memberships_for_user(${userId}::uuid)`),
    );

  it("ensureOwnerAccount es idempotente y claim_account re-vincula por correo", async () => {
    await ensureOwnerAccount(t.db, tenantId, "Dueno@Ejemplo.com");
    await ensureOwnerAccount(t.db, tenantId, "dueno@ejemplo.com");
    const accounts = await t.db.select().from(schema.userAccount);
    expect(accounts).toHaveLength(1);
    const provisional = accounts[0]?.id as string;
    expect(await memberships(provisional)).toHaveLength(1);

    // Primer login: Supabase Auth trae otro id para el mismo correo.
    const authId = randomUUID();
    await t.db.execute(sql`select app.claim_account(${authId}::uuid, ${"DUENO@ejemplo.com"})`);
    const after = await t.db.select().from(schema.userAccount);
    expect(after.map((a) => a.id)).toEqual([authId]);
    expect(after[0]?.email).toBe("dueno@ejemplo.com");
    const m = await memberships(authId);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tenant_id: tenantId, role: "owner", tenant_name: "Autolavado" });
    expect(await memberships(provisional)).toHaveLength(0);

    // Segundo login: no cambia nada.
    await t.db.execute(sql`select app.claim_account(${authId}::uuid, ${"dueno@ejemplo.com"})`);
    expect(await t.db.select().from(schema.userAccount)).toHaveLength(1);
  });

  it("un correo nuevo crea la cuenta sin membresías", async () => {
    const authId = randomUUID();
    await t.db.execute(sql`select app.claim_account(${authId}::uuid, ${"nuevo@ejemplo.com"})`);
    expect(await memberships(authId)).toHaveLength(0);
    const rowsAcc = await t.db.select().from(schema.userAccount);
    expect(rowsAcc.some((a) => a.id === authId)).toBe(true);
  });

  it("caja_app puede ejecutar las funciones pero no leer tenant_member sin tenant", async () => {
    await t.pg.exec("SET ROLE caja_app");
    try {
      const [acc] = await t.db.select().from(schema.userAccount);
      const m = await memberships(acc?.id as string);
      expect(m.length).toBeGreaterThanOrEqual(0);
      const direct = await t.db.select().from(schema.tenantMember);
      expect(direct).toHaveLength(0);
      const inTenant = await withTenant(t.db, tenantId, (tx) =>
        tx.select().from(schema.tenantMember),
      );
      expect(inTenant).toHaveLength(1);
    } finally {
      await t.pg.exec("RESET ROLE");
    }
  });
});
