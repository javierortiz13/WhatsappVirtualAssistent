import { readFile } from "node:fs/promises";
import { eq, schema } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Seguridad N7: 0032 deja en audit_log cada empleado que pasa a pendiente, y se deshace exacto. */
describe("migración 0032_employee_accept (N7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId = "";
  const file = new URL("../../db/migrations/0032_employee_accept.sql", import.meta.url);

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "A",
      businessType: "food",
      ownerPhone: "584121000001",
    });
  });
  afterAll(() => t.close());

  it("activo sin verificar → pendiente con su fila de auditoría; el verificado no cambia", async () => {
    const [never] = await t.db
      .insert(schema.phoneNumber)
      .values({ tenantId, e164: "584161000001", role: "employee", status: "active" })
      .returning();
    const [wrote] = await t.db
      .insert(schema.phoneNumber)
      .values({
        tenantId,
        e164: "584161000002",
        role: "employee",
        status: "active",
        verifiedAt: new Date(),
      })
      .returning();
    await t.pg.exec(await readFile(file, "utf8"));
    const row = async (id: string) =>
      (await t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, id)))[0];
    expect((await row(never?.id ?? ""))?.status).toBe("pending");
    expect((await row(wrote?.id ?? ""))?.status).toBe("active");
    const audits = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "employee_pending_0032"));
    expect(audits.map((a) => [a.entityId, a.before, a.after, a.actorType])).toEqual([
      [never?.id, { status: "active" }, { status: "pending" }, "system"],
    ]);
    // El reverso del comentario de la migración devuelve exactamente esa fila.
    await t.pg.exec(`UPDATE app.phone_number p SET status = 'active' FROM app.audit_log a
      WHERE a.action = 'employee_pending_0032' AND a.entity_id = p.id
        AND p.status = 'pending' AND p.verified_at IS NULL;`);
    expect((await row(never?.id ?? ""))?.status).toBe("active");
  });
});
